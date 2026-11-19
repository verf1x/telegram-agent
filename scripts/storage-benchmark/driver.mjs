import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { now } from "./metrics.mjs";

export const firstTopic = { userId: 2, topicId: 10 };
export const neighbour = { userId: 2, topicId: 11 };

export class BotProcess {
  #pending = new Map();
  #waiters = new Set();
  #id = 0;
  events = [];
  offset = 0;

  constructor(options, offset = 0) {
    this.options = options;
    this.offset = offset;
    this.child = fork(new URL("./bot-child.mjs", import.meta.url), {
      execArgv: [], serialization: "advanced", stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    this.exited = once(this.child, "exit");
    this.child.on("message", message => {
      if (message.event === "reply") {
        const pending = this.#pending.get(message.id);
        if (message.error) pending?.reject(new Error(message.error));
        else pending?.resolve(message.result);
        return;
      }
      this.events.push(message);
      for (const item of this.#waiters) {
        if (item.predicate(message)) item.resolve(message);
      }
    });
    this.child.on("exit", (code, signal) => {
      const error = new Error(`Benchmark bot exited (${signal ?? code})`);
      for (const pending of [...this.#pending.values(), ...this.#waiters]) pending.reject(error);
    });
  }

  async cmd(kind, data) {
    const id = ++this.#id;
    const pending = Promise.withResolvers();
    this.#pending.set(id, pending);
    const timer = setTimeout(() => pending.reject(new Error(`Bot did not reply to ${kind}`)), 70_000);
    try {
      this.child.send({ id, kind, data }, error => { if (error) pending.reject(error); });
      return await pending.promise;
    } finally {
      clearTimeout(timer);
      this.#pending.delete(id);
    }
  }

  async wait(predicate) {
    const found = this.events.find(predicate);
    if (found) return found;
    const item = { ...Promise.withResolvers(), predicate };
    this.#waiters.add(item);
    const timer = setTimeout(() => item.reject(new Error("Expected benchmark event did not arrive")), 30_000);
    try { return await item.promise; }
    finally { clearTimeout(timer); this.#waiters.delete(item); }
  }

  open() { return this.cmd("open", this.options); }

  update({ userId, topicId }, text, document) {
    const id = ++this.offset;
    return { update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000),
      chat: { id: userId, type: "private" }, from: { id: userId }, message_thread_id: topicId,
      ...(document ? { caption: text, document } : { text }) } };
  }

  async enqueue(updates) {
    const available = now();
    await this.cmd("enqueue", updates);
    return available;
  }

  accepted(update) {
    return this.wait(event => event.event === "accepted" && event.updateId === update.update_id);
  }

  delivered(address, name) {
    return this.wait(event => event.event === "delivered" && event.name === name &&
      event.userId === address.userId && event.topicId === address.topicId);
  }

  async submit(update) {
    await this.enqueue([update]);
    await this.accepted(update);
    await this.cmd("drain");
  }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    try {
      if (this.child.connected) await this.cmd("close");
    } catch (error) {
      this.child.kill("SIGKILL");
      throw error;
    } finally {
      await this.exited;
    }
  }

  async kill(alreadyArmed = false) {
    if (!alreadyArmed) this.child.kill("SIGKILL");
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; this.child.kill("SIGKILL"); }, 15_000);
    try {
      const [, signal] = await this.exited;
      assert.equal(signal, "SIGKILL");
      assert.equal(timedOut, false, "Expected crash did not occur");
    } finally { clearTimeout(timer); }
  }
}

function procIo(pid) {
  const data = readFileSync(`/proc/${pid}/io`, "utf8");
  return Object.fromEntries([...data.matchAll(/(\w+): (\d+)/g)].map(([, key, value]) => [key, Number(value)]));
}

function postgresResources(cgroup) {
  const counters = Object.fromEntries([...readFileSync(join(cgroup, "memory.stat"), "utf8").matchAll(/^(\w+) (\d+)$/gm)]
    .map(([, key, value]) => [key, Number(value)]));
  const cpuUs = Number(readFileSync(join(cgroup, "cpu.stat"), "utf8").match(/^usage_usec (\d+)/m)[1]);
  const io = { rbytes: 0, wbytes: 0 };
  for (const [, key, value] of readFileSync(join(cgroup, "io.stat"), "utf8").matchAll(/\b([rw]bytes)=(\d+)/g)) {
    io[key] += Number(value);
  }
  return { cpuUs, memory: counters.anon + counters.shmem, read: io.rbytes, write: io.wbytes };
}

export async function withResources(bot, cgroup, work) {
  const before = procIo(bot.child.pid);
  const pgBefore = cgroup && postgresResources(cgroup);
  let pgPeak = pgBefore?.memory ?? 0;
  const timer = cgroup && setInterval(() => {
    pgPeak = Math.max(pgPeak, postgresResources(cgroup).memory);
  }, 10);
  try {
    const result = await work();
    const after = procIo(bot.child.pid);
    const pgAfter = cgroup && postgresResources(cgroup);
    const pg = pgAfter && {
      cpuUs: pgAfter.cpuUs - pgBefore.cpuUs,
      read: pgAfter.read - pgBefore.read,
      write: pgAfter.write - pgBefore.write,
      peakBytes: Math.max(pgPeak, pgAfter.memory),
    };
    return { ...result, read: after.read_bytes - before.read_bytes, write: after.write_bytes - before.write_bytes, pg };
  } finally { if (timer) clearInterval(timer); }
}

export function sqliteSize(path) {
  function bytes(filename) {
    return statSync(filename, { throwIfNoEntry: false })?.size ?? 0;
  }
  return { bytes: bytes(path), wal: bytes(path + "-wal") };
}

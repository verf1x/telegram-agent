import { createCipheriv, createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { createBot } from "../../src/bot.ts";
import { SqliteStore } from "../../src/store.ts";
import { DEFAULT_MODEL_SELECTION } from "../../src/contracts.ts";
import { DirectoryPayloads } from "./payloads.mjs";
import { instrument, now, timedDatabase } from "./metrics.mjs";
import { PostgresDatabase } from "./postgres.mjs";

const send = (event, data = {}) => process.send({ event, at: now(), ...data });
const { measure, start, results } = instrument();
const parse = JSON.parse;
const stringify = JSON.stringify;
JSON.parse = (...args) => measure("json.parse", () => parse(...args));
JSON.stringify = (...args) => measure("json.stringify", () => stringify(...args));

const payloadsBySize = new Map();
function bytes(size) {
  if (!payloadsBySize.has(size)) {
    const cipher = createCipheriv("aes-128-ctr", Buffer.alloc(16), Buffer.alloc(16));
    payloadsBySize.set(size, cipher.update(Buffer.alloc(size)));
  }
  return payloadsBySize.get(size);
}

function file(size, name = "output.bin") {
  return { name, bytes: bytes(size), mime: "application/octet-stream" };
}

function crash() { process.kill(process.pid, "SIGKILL"); }

let store, bot, options, fault, poll, payloads;
let stopped = false;
let messageId = 0;
let queueWake = Promise.withResolvers();
let queue = [];
let writers = 0;
let held;
let gate;
const delivery = async (userId, name, opts, data = {}) => {
  if (fault === "partial-delivery" && data.size !== undefined) {
    send("blocked-delivery", { userId, topicId: opts?.message_thread_id, name });
    await new Promise(() => {});
  }
  send("delivered", { userId, topicId: opts?.message_thread_id, name,
    callback: opts?.reply_markup?.inline_keyboard[0]?.[0]?.callback_data, ...data });
  return ++messageId;
};

const telegram = {
  async getUpdates({ offset }) {
    while (!queue.length && !stopped) {
      await queueWake.promise;
      queueWake = Promise.withResolvers();
    }
    return queue.splice(0).filter(update => update.update_id >= offset);
  },
  sendPart: (userId, part, opts) => delivery(userId, part.text ?? part.name, opts),
  sendText: (userId, text, opts) => delivery(userId, text, opts),
  sendFile(userId, material, opts) {
    const expected = bytes(material.bytes.length);
    if (options.verifyBytes && !expected.equals(material.bytes)) throw new Error("File contents differ");
    return delivery(userId, material.name, opts, { size: material.bytes.length });
  },
  async downloadFile(id) {
    const size = Number(id);
    send("download", { size });
    return bytes(size);
  },
  async typing() {},
  async deleteTopic(userId, topicId) { send("deleted", { userId, topicId }); },
  async answerCallback() {},
};

const engine = {
  async run(request) {
    const { text, userId, topicId } = request;
    const [kind, sizeText, argument] = text.split(" ");
    const size = +sizeText;
    const threadId = request.threadId ?? `synthetic-${userId}-${topicId}`;
    await request.onThread(threadId);
    if (kind === "mixed") {
      if (++writers === 3) gate.resolve();
      await gate.promise;
    }
    if (kind === "held") {
      held = request;
      send("held");
      await new Promise(() => {});
    }
    if (kind === "write" || kind === "mixed" || kind === "attachment") {
      let output = file(size);
      if (kind === "attachment") {
        const original = request.files.find(material => material.name === "input.bin");
        if (!original) throw new Error("Missing attachment");
        output = { ...output, bytes: request.readFile(original.id) };
      }
      await request.onFile(output);
    }
    if (kind === "read") {
      const digest = createHash("sha256").update(request.readFile(sizeText)).digest("hex");
      if (digest !== argument) throw new Error("Restored bytes differ");
    }
    if (kind === "context" && !request.history.some(entry => entry.text.startsWith("seed-user-"))) {
      throw new Error("Seeded context missing");
    }
    return { text: "answer:" + text, threadId, images: [] };
  },
  async deleteThread() {},
  async summarize() { return "synthetic summary"; },
};

async function getUpdates() {
  while (!stopped) {
    const updates = await telegram.getUpdates({ offset: store.offset, timeout: 30 });
    for (const update of updates) await bot.handleUpdate(update);
  }
}

function seedAddresses(addresses) {
  const history = [
    { role: "user", text: "seed-user-" + "a".repeat(30 * 1024) },
    { role: "assistant", text: "seed-answer-" + "z".repeat(30 * 1024) },
  ];
  for (const address of addresses) store.put({ ...address, history });
}

async function configure(config) {
  options = config;
  const db = config.url ? new PostgresDatabase(config.url) : new DatabaseSync(config.path);
  const database = timedDatabase(db, measure, (sql, category) => {
    if ((fault === "file-insert" && category === "db.fileWrite") ||
        (fault === "offset" && /^INSERT INTO metadata\(key,value\) VALUES\('offset'/.test(sql))) crash();
  });
  if (config.directory) {
    payloads = new DirectoryPayloads(config.directory);
  }
  store = new SqliteStore(config.path, {
    database,
    payloads: payloads && {
      put: (id, data) => measure("file.write", () => {
        if (fault === "partial-payload") {
          payloads.put(id, data.subarray(0, Math.floor(data.length / 2)));
          crash();
        }
        payloads.put(id, data);
      }),
      read: id => measure("file.read", () => payloads.read(id)),
      remove: ids => measure("file.remove", () => payloads.remove(ids)),
      recover: ids => measure("file.recover", () => payloads.recover(ids)),
    },
  });
  const save = store.saveResponseFile.bind(store);
  store.saveResponseFile = (address, id, output, quota) => {
    if (output.bytes.length === config.mixedSize && writers === 3) {
      const coordinates = { userId: address.userId, topicId: address.topicId };
      send("saving", coordinates);
      try { return save(address, id, output, quota); }
      finally { send("saved", coordinates); }
    }
    return save(address, id, output, quota);
  };
  const accept = store.accept.bind(store);
  store.accept = (updateId, state) => {
    accept(updateId, state);
    send("accepted", { updateId, offset: store.offset, task: Boolean(state?.request) });
  };
  const botConfig = {
    ownerId: 1, allowedUserIds: Array.from({ length: 16 }, (_, i) => i + 2),
    maxConcurrentRequests: config.capacity ?? 4, requestTimeoutMs: 30_000,
    dialogueFileBytes: config.quota, defaultModel: DEFAULT_MODEL_SELECTION.model,
    defaultEffort: DEFAULT_MODEL_SELECTION.effort,
  };
  bot = createBot({ config: { snapshot: () => ({ valid: true, config: botConfig }) }, store, engine, telegram });
  if (config.preallocate) bytes(config.preallocate);
  await bot.recover();
  poll = getUpdates();
  poll.catch(error => { throw error; });
}

let resourceStart;
async function command(kind, data) {
  switch (kind) {
    case "open": await configure(data); return store.offset;
    case "seed": seedAddresses(data); return;
    case "start": {
      writers = 0;
      gate = Promise.withResolvers();
      start();
      resourceStart = process.cpuUsage();
      return;
    }
    case "enqueue": queue.push(...data); queueWake.resolve(); return;
    case "drain": await bot.drain(); return;
    case "stats": {
      await delay(2);
      return { ...results(data), cpuUs: process.cpuUsage(resourceStart), peakRssKiB: process.resourceUsage().maxRSS };
    }
    case "inspect": return { state: store.findDialogue(data), files: store.listFiles(data),
      directory: payloads && readdirSync(options.directory), offset: store.offset };
    case "cleanup":
      for (const address of data) store.remove(address);
      return;
    case "fault": fault = data; return;
    case "late-export": {
      try { await held.onFile(file(31, "late.bin")); return false; }
      catch { return true; }
    }
    case "close":
      stopped = true;
      queueWake.resolve();
      await poll;
      await bot?.shutdown();
      store?.close();
      return;
    default: throw new Error(`Unknown benchmark command: ${kind}`);
  }
}

process.on("message", async ({ id, kind, data }) => {
  try {
    const result = await command(kind, data);
    send("reply", { id, result });
    if (kind === "close") process.disconnect();
  } catch (error) {
    send("reply", { id, error: error.stack });
  }
});

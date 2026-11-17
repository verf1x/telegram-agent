import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

async function preload() {
  const enginePath = join(dirname(process.argv[1]), "codex", "engine.ts");
  const {CodexEngine} = await import(pathToFileURL(enginePath).href);
  for (const method of ["run", "summarize", "generateTopicTitle", "listModels", "deleteThread", "bindLegacyThread", "health"]) {
    CodexEngine.prototype[method] = async () => { throw new Error(`Unexpected Codex call during idle benchmark: ${method}`); };
  }
  let statements = 0;
  let fullScans = 0;
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) {
    statements++;
    if (/SELECT\s+state\s+FROM\s+dialogues\s+ORDER BY/i.test(sql)) fullScans++;
    return prepare.call(this, sql);
  };
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    statements++;
    return exec.call(this, sql);
  };
  process.on("message", () => process.send({statements, fullScans, cpu: process.cpuUsage(), time: performance.now()}));
  let ready = false;
  globalThis.fetch = async (url, options) => {
    const method = new URL(url).pathname.split("/").at(-1);
    if (method === "getMe") return Response.json({ok: true, result: {
      has_topics_enabled: true, allows_users_to_create_topics: true,
    }});
    if (method !== "getUpdates") throw new Error(`Unexpected method during idle benchmark: ${method}`);
    const {timeout} = JSON.parse(options.body);
    if (timeout && !ready) { ready = true; process.send("ready"); }
    await delay(timeout * 1000, undefined, {signal: options.signal});
    return Response.json({ok: true, result: []});
  };
}

function seed(dir, historyKiB) {
  writeFileSync(join(dir, ".env"), "TELEGRAM_BOT_TOKEN=123456:TEST\nOWNER_TELEGRAM_ID=1\nALLOWED_USER_IDS=2\nDATABASE_PATH=./bot.sqlite\n");
  const db = new DatabaseSync(join(dir, "bot.sqlite"));
  db.exec(`CREATE TABLE dialogues (user_id INTEGER NOT NULL, topic_id INTEGER NOT NULL,
    state TEXT NOT NULL, PRIMARY KEY(user_id,topic_id)); BEGIN`);
  const insert = db.prepare("INSERT INTO dialogues VALUES (?,?,?)");
  const history = [{role: "assistant", text: "a".repeat(historyKiB * 1024)}];
  for (let topicId = 1; topicId <= 80; topicId++) insert.run(2, topicId, JSON.stringify({userId: 2, topicId, history}));
  db.exec("COMMIT");
  db.close();
}

function childMessage(child) {
  return new Promise((resolveMessage, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onMessage = value => { cleanup(); resolveMessage(value); };
    const onExit = code => { cleanup(); reject(new Error(`Benchmark bot exited with ${code}`)); };
    const onError = error => { cleanup(); reject(error); };
    const timer = setTimeout(() => onError(new Error("Benchmark bot did not respond within 10 seconds")), 10_000);
    child.once("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function sample(child) {
  const update = childMessage(child);
  child.send("sample");
  const counters = await update;
  const io = Object.fromEntries(readFileSync(`/proc/${child.pid}/io`, "utf8").trim().split("\n").map(line => {
    const [key, value] = line.split(": ");
    return [key, Number(value)];
  }));
  return {...counters, io};
}

async function run(root, label, historyKiB, seconds) {
  const dir = mkdtempSync(join(tmpdir(), "verfix-idle-benchmark-"));
  let child;
  try {
    seed(dir, historyKiB);
    child = fork(join(root, "src/main.ts"), [], {
      cwd: dir, execArgv: ["--import", import.meta.filename],
      env: {...process.env, VERFIX_ISSUE34_BENCH_CHILD: "1"}, stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    if (await childMessage(child) !== "ready") throw new Error("Unexpected startup response");
    const before = await sample(child);
    await delay(seconds * 1000);
    const after = await sample(child);
    const elapsed = after.time - before.time;
    const cpuUs = after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system;
    return {label, topics: 80, historyKiB, seconds: +(elapsed / 1000).toFixed(2),
      cpuPercent: +(cpuUs / (10 * elapsed)).toFixed(2), statements: after.statements - before.statements,
      fullScans: after.fullScans - before.fullScans,
      ...Object.fromEntries(["syscr", "rchar", "read_bytes", "write_bytes"].map(key => [key, after.io[key] - before.io[key]]))};
  } finally {
    if (child?.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      if (child.connected) child.disconnect();
      await exit;
    }
    rmSync(dir, {recursive: true, force: true});
  }
}

if (process.env.VERFIX_ISSUE34_BENCH_CHILD === "1") await preload();
else {
  const [baseline, candidate = ".", duration = "60"] = process.argv.slice(2);
  const seconds = Number(duration);
  if (!baseline || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("Usage: node scripts/bench-issue-34-idle.mjs BASELINE_DIRECTORY [CANDIDATE_DIRECTORY] [SECONDS]");
  }
  const results = await Promise.all([baseline, candidate].flatMap((root, index) =>
    [1, 144].map(size => run(resolve(root), index === 0 ? "before" : "after", size, seconds))));
  console.table(results);
  if (results.some(result => result.label === "after" && (result.statements || result.fullScans))) process.exitCode = 1;
}

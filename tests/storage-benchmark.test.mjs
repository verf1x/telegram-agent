import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openLocalStore, SqliteStore } from "../src/store.ts";
import { DatabaseSync } from "node:sqlite";
import { DirectoryPayloads } from "../src/files/payloads.ts";

test("directory-backed materials survive reopen and are removed only from their own topic", t => {
  const root = mkdtempSync(join(tmpdir(), "verfix-storage-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "payloads");
  const open = () => new SqliteStore(join(root, "db.sqlite"), { payloads: new DirectoryPayloads(directory) });
  const first = { userId: 2, topicId: 10 };
  const second = { userId: 2, topicId: 11 };
  const file = { name: "material.txt", mime: "text/plain", bytes: Buffer.from("contents") };
  let store = open();
  const saved = store.saveFile(first, file);
  const neighbour = store.saveFile(second, file);
  store.close();
  writeFileSync(join(directory, "c2822f26-6e23-4141-891d-678ab4ebed87"), "interrupted write");

  store = open();
  try {
    assert.deepEqual(Buffer.from(store.readFile(first, saved.id)), file.bytes);
    assert.throws(() => store.readFile(second, saved.id), { name: "ResponseFileError" });
    assert.deepEqual(readdirSync(directory).filter(key => !key.startsWith(".")).sort(), [saved.id, neighbour.id].sort());
    store.deleteFiles(first);
    assert.throws(() => store.readFile(first, saved.id), { name: "ResponseFileError" });
    assert.deepEqual(Buffer.from(store.readFile(second, neighbour.id)), file.bytes);
    assert.deepEqual(readdirSync(directory).filter(key => !key.startsWith(".")), [neighbour.id]);
  } finally {
    store.close();
  }
});

test("a failed directory cleanup can be retried without touching another topic", t => {
  const root = mkdtempSync(join(tmpdir(), "verfix-storage-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "payloads");
  const payloads = new DirectoryPayloads(directory);
  const path = join(root, "db.sqlite");
  let store = new SqliteStore(path, { payloads });
  try {
    const first = { userId: 2, topicId: 10 };
    const second = { userId: 2, topicId: 11 };
    const file = { name: "material.txt", mime: "text/plain", bytes: Buffer.from("contents") };
    const firstFile = store.saveFile(first, file);
    const secondFile = store.saveFile(second, file);

    const fault = t.mock.method(payloads, "remove", () => { throw new Error("temporary unlink failure"); });
    assert.throws(() => store.remove(first), /temporary unlink failure/);
    fault.mock.restore();

    store.deleteFiles(second);
    assert.deepEqual(readdirSync(directory).filter(key => !key.startsWith(".")), [firstFile.id]);
    assert.throws(() => store.readFile(second, secondFile.id), { name: "ResponseFileError" });
    store.close();
    store = new SqliteStore(path, { payloads });
    assert.deepEqual(payloads.fileKeys(), [firstFile.id]);
    store.remove(first);
    assert.deepEqual(readdirSync(directory).filter(key => !key.startsWith(".")), []);
  } finally {
    store.close();
  }
});

test("the local store moves existing BLOBs to the directory without changing their references or offset", t => {
  const root = mkdtempSync(join(tmpdir(), "verfix-storage-upgrade-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "bot.sqlite");
  const address = { userId: 2, topicId: 10 };
  const bytes = Buffer.from("existing bytes");
  const previous = new SqliteStore(path);
  const original = previous.saveFile(address, { name: "original", mime: "text/plain", bytes });
  const empty = previous.saveFile(address, { name: "empty", mime: "text/plain", bytes: Buffer.alloc(0) });
  const state = { ...address, history: [], delivery: { parts: [{ kind: "file", id: original.id }], next: 0 } };
  previous.accept(17, state);
  previous.close();
  const legacySchema = new DatabaseSync(path);
  try { legacySchema.exec("ALTER TABLE dialogue_files DROP COLUMN file_key"); }
  finally { legacySchema.close(); }

  writeFileSync(join(root, ".env"), "TELEGRAM_BOT_TOKEN=123:TEST\nOWNER_TELEGRAM_ID=1\nALLOWED_USER_IDS=2\nDATABASE_PATH=./bot.sqlite\n");
  const telegram = `globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/sendDocument") && options.body.get("message_thread_id") === "10" &&
        await options.body.get("document").text() === "existing bytes") {
      console.log("Migrated document delivered");
      return Response.json({ok:true,result:{message_id:23}});
    }
    if (String(url).endsWith("/getMe")) return Response.json({ok:true,result:{
      has_topics_enabled:true,allows_users_to_create_topics:true}});
    if (String(url).endsWith("/getUpdates")) {
      process.emit("SIGTERM");
      return Response.json({ok:true,result:[]});
    }
    throw new Error("Unexpected Telegram request");
  };`;
  const entry = new URL("../src/main.ts", import.meta.url);
  const boot = spawnSync(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(telegram),
    entry.pathname], { cwd: root, encoding: "utf8", timeout: 10_000 });
  assert.equal(boot.status, 0, boot.stderr);
  assert.match(boot.stdout, /Бот запущен/);
  assert.match(boot.stdout, /Migrated document delivered/);

  let store = openLocalStore(path);
  try {
    assert.equal(store.offset, 18);
    assert.deepEqual(store.get(address), { ...address, history: [] });
    assert.deepEqual(store.listFiles(address), [original, empty]);
    assert.deepEqual(Buffer.from(store.readFile(address, original.id)), bytes);
    assert.equal(store.readFile(address, empty.id).length, 0);
  } finally { store.close(); }
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare("SELECT sum(length(bytes)) AS stored FROM dialogue_files").get();
    assert.equal(row.stored, 0);
  } finally { database.close(); }

  const restored = join(root, "restored.sqlite");
  copyFileSync(path, restored);
  cpSync(path + ".files", restored + ".files", { recursive: true });
  store = openLocalStore(restored);
  try {
    assert.deepEqual(Buffer.from(store.readFile(address, original.id)), bytes);
    assert.equal(store.readFile(address, empty.id).length, 0);
  } finally { store.close(); }

  renameSync(restored + ".files", restored + ".missing");
  assert.throws(() => openLocalStore(restored), /хранилище материалов/);
  assert.throws(() => new SqliteStore(path), /хранилище материалов/);
});

test("migration resumes after a crash between writing bytes and committing their reference", t => {
  const root = mkdtempSync(join(tmpdir(), "verfix-storage-interruption-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "legacy.sqlite");
  const address = { userId: 2, topicId: 10 };
  const bytes = Buffer.from("preserved");
  const previous = new SqliteStore(path);
  const first = previous.saveFile(address, { name: "first", mime: "text/plain", bytes });
  const second = previous.saveFile(address, { name: "second", mime: "text/plain", bytes });
  previous.close();

  const script = `
    import { SqliteStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
    import { DirectoryPayloads } from ${JSON.stringify(new URL("../src/files/payloads.ts", import.meta.url).href)};
    const path = process.argv[1];
    const payloads = new DirectoryPayloads(path + ".files");
    const put = payloads.put.bind(payloads);
    let count = 0;
    payloads.put = (key, bytes) => {
      put(key, bytes);
      if (++count === 2) process.kill(process.pid, "SIGKILL");
    };
    new SqliteStore(path, { payloads });
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, path], { timeout: 10_000 });
  assert.equal(child.signal, "SIGKILL", child.stderr?.toString());
  const store = openLocalStore(path);
  try {
    assert.deepEqual(store.listFiles(address), [first, second]);
    for (const file of [first, second]) assert.deepEqual(Buffer.from(store.readFile(address, file.id)), bytes);
    assert.equal(new DirectoryPayloads(path + ".files").fileKeys().length, 2);
  } finally { store.close(); }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdtempSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openLocalStore, SqliteStore } from "../src/store.ts";
import { DatabaseSync } from "node:sqlite";
import { DirectoryPayloads } from "../src/files/payloads.ts";

function runWithFakeTelegram(root, outgoing = "", preload = "") {
  const telegram = `${preload}
globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/getMe")) return Response.json({ok:true,result:{
      has_topics_enabled:true,allows_users_to_create_topics:true}});
    if (String(url).endsWith("/getUpdates")) {
      process.emit("SIGTERM");
      return Response.json({ok:true,result:[]});
    }
    ${outgoing}
    throw new Error("Unexpected Telegram request");
  };`;
  const entry = new URL("../src/main.ts", import.meta.url);
  return spawnSync(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(telegram),
    entry.pathname], { cwd: root, encoding: "utf8", timeout: 10_000 });
}

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
    assert.deepEqual(payloads.fileKeys(), []);
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
  const boot = runWithFakeTelegram(root, `
    if (String(url).endsWith("/sendDocument") && options.body.get("message_thread_id") === "10" &&
        await options.body.get("document").text() === "existing bytes") {
      console.log("Migrated document delivered");
      return Response.json({ok:true,result:{message_id:23}});
    }
  `);
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
    payloads.put = (key, bytes, onCreated) => {
      put(key, bytes, onCreated);
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

test("a rejected SQLite insert reclaims the bytes of the uncommitted file", t => {
  const root = mkdtempSync(join(tmpdir(), "verfix-storage-rollback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "db.sqlite");
  const address = { userId: 2, topicId: 10 };
  const neighbour = { ...address, topicId: 11 };
  const store = openLocalStore(path);
  t.after(() => store.close());
  const material = { name: "saved.txt", mime: "text/plain", bytes: Buffer.from("contents") };
  const retained = store.saveFile(neighbour, material);

  const database = new DatabaseSync(path);
  try {
    database.exec(`CREATE TRIGGER reject_file BEFORE INSERT ON dialogue_files
      WHEN NEW.name = 'rejected.txt' BEGIN SELECT RAISE(ABORT, 'test write rejected'); END`);
  } finally { database.close(); }

  assert.throws(() => store.saveFile(address, { ...material, name: "rejected.txt" }), /test write rejected/);
  assert.deepEqual(store.listFiles(address), []);
  assert.deepEqual(new DirectoryPayloads(path + ".files").fileKeys(), [retained.id]);
  store.deleteFiles(address);
  assert.deepEqual(Buffer.from(store.readFile(neighbour, retained.id)), material.bytes);
});

test("the bot starts when DATABASE_PATH is ./runtime/bot", t => {
  const root = mkdtempSync(join(tmpdir(), "verfix-storage-start-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, ".env"), "TELEGRAM_BOT_TOKEN=123:TEST\nOWNER_TELEGRAM_ID=1\nDATABASE_PATH=./runtime/bot\n");
  const boot = runWithFakeTelegram(root);
  assert.equal(boot.status, 0, boot.stderr);
  assert.match(boot.stdout, /Бот запущен/);
});

test("missing materials leave the remaining deliveries available after startup", t => {
  const root = mkdtempSync(join(tmpdir(), "verfix-storage-missing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "bot.sqlite");
  const first = { userId: 2, topicId: 10 };
  const second = { userId: 2, topicId: 11 };
  const third = { userId: 2, topicId: 12 };
  const store = openLocalStore(path);
  const file = { name: "saved.txt", mime: "text/plain", bytes: Buffer.from("intact bytes") };
  const lost = store.saveFile(first, file);
  const retained = store.saveFile(first, { ...file, name: "retained.txt" });
  const intact = store.saveFile(second, file);
  store.put({ ...first, history: [], delivery: { next: 0, parts: [
    { kind: "file", id: lost.id }, { kind: "text", text: "remaining text" },
  ] } });
  store.put({ ...second, history: [], delivery: { next: 0, parts: [{ kind: "file", id: intact.id }] } });
  store.put({ ...third, history: [], request: { id: "interrupted", text: "image task", started: 1 } });
  const lostImage = store.saveResponseImage(third, "interrupted", { ...file, mime: "image/png" });
  store.close();
  unlinkSync(join(path + ".files", lost.id));
  unlinkSync(join(path + ".files", lostImage.id));

  writeFileSync(join(root, ".env"), "TELEGRAM_BOT_TOKEN=123:TEST\nOWNER_TELEGRAM_ID=1\nALLOWED_USER_IDS=2\nDATABASE_PATH=./bot.sqlite\n");
  const boot = runWithFakeTelegram(root, `
    if (String(url).endsWith("/sendDocument") && options.body.get("message_thread_id") === "11" &&
        await options.body.get("document").text() === "intact bytes") {
      console.log("Other topic received its file");
      return Response.json({ok:true,result:{message_id:20}});
    }
    if (String(url).endsWith("/sendMessage")) {
      const message = JSON.parse(options.body);
      console.log("Text in " + message.message_thread_id + ": " + message.text);
      return Response.json({ok:true,result:{message_id:21}});
    }
  `);
  assert.equal(boot.status, 0, boot.stderr);
  assert.match(boot.stdout, /Other topic received its file/);
  assert.match(boot.stdout, /Text in 10: .*файл.*недоступен/);
  assert.match(boot.stdout, /Text in 10: remaining text/);
  assert.match(boot.stdout, /Text in 12: .*изображен.*недоступн/);

  const restarted = openLocalStore(path);
  try {
    assert.deepEqual(restarted.listFiles(first), [retained]);
    assert.deepEqual(restarted.listFiles(second), [intact]);
  } finally { restarted.close(); }
});

test("restart completes rollback cleanup that was blocked by a temporary unlink failure", t => {
  const root = mkdtempSync(join(tmpdir(), "verfix-storage-rollback-retry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "db.sqlite");
  const folder = new DirectoryPayloads(path + ".files");
  const open = () => new SqliteStore(path, { payloads: folder });
  const address = { userId: 2, topicId: 10 };
  const store = open();
  try {
    const database = new DatabaseSync(path);
    try {
      database.exec(`CREATE TRIGGER reject_file BEFORE INSERT ON dialogue_files
        BEGIN SELECT RAISE(ROLLBACK, 'test transaction rolled back'); END`);
    } finally { database.close(); }

    const failure = t.mock.method(folder, "remove", () => { throw new Error("test unlink failure"); });
    assert.throws(() => store.saveFile(address, { name: "test.txt", mime: "text/plain", bytes: Buffer.from("test") }),
      /test transaction rolled back/);
    failure.mock.restore();
    assert.equal(folder.fileKeys().length, 1);
  } finally { store.close(); }

  const restarted = open();
  try {
    assert.deepEqual(restarted.listFiles(address), []);
    assert.deepEqual(folder.fileKeys(), []);
  } finally { restarted.close(); }
});

for (const [outcome, reopen] of [
  ["is removed by a reset before restart", false],
  ["survives the queued cleanup at startup", true],
]) {
  test("a successfully retried archive " + outcome, t => {
    const root = mkdtempSync(join(tmpdir(), "verfix-storage-archive-retry-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "db.sqlite");
    const folder = new DirectoryPayloads(path + ".files");
    const open = () => new SqliteStore(path, { payloads: folder });
    const state = { userId: 2, topicId: 10, history: [] };
    const id = "c2822f26-6e23-4141-891d-678ab4ebed87";
    const attachment = { name: "retained", text: "original text", images: [] };
    const archive = [{ id, name: "retained", attachment }];
    const store = open();
    try {
      const database = new DatabaseSync(path);
      try {
        database.exec(`CREATE TRIGGER reject_archive_state BEFORE INSERT ON dialogues
          BEGIN SELECT RAISE(ABORT, 'test state rejected'); END`);
        const remove = folder.remove.bind(folder);
        const failure = t.mock.method(folder, "remove", keys => {
          remove(keys);
          throw new Error("test failure after unlink");
        });
        assert.throws(() => store.putCompacted(state, archive), /test state rejected/);
        failure.mock.restore();
        database.exec("DROP TRIGGER reject_archive_state");
      } finally { database.close(); }
      store.putCompacted(state, archive);
      if (!reopen) {
        store.deleteFiles(state);
        assert.deepEqual(folder.fileKeys(), []);
      }
    } finally { store.close(); }

    if (!reopen) return;
    const restarted = open();
    try {
      assert.deepEqual(JSON.parse(Buffer.from(restarted.readFile(state, id)).toString()), attachment);
    } finally { restarted.close(); }
  });
}


test("a temporary read failure leaves the original file queued for delivery", t => {
  const root = mkdtempSync(join(tmpdir(), "verfix-storage-read-retry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "bot.sqlite");
  const address = { userId: 2, topicId: 10 };
  const store = openLocalStore(path);
  const file = store.saveFile(address, { name: "file.txt", mime: "text/plain", bytes: Buffer.from("test") });
  const part = { kind: "file", id: file.id };
  store.put({ ...address, history: [], delivery: { next: 0, parts: [part] } });
  store.close();

  writeFileSync(join(root, ".env"), "TELEGRAM_BOT_TOKEN=123:TEST\nOWNER_TELEGRAM_ID=1\nALLOWED_USER_IDS=2\nDATABASE_PATH=./bot.sqlite\n");
  const stdout = runWithFakeTelegram(root, `
    if (String(url).endsWith("/sendMessage")) return Response.json({ok:true,result:{message_id:20}});
  `, `
    import { DirectoryPayloads } from ${JSON.stringify(new URL("../src/files/payloads.ts", import.meta.url).href)};
    DirectoryPayloads.prototype.read = () => { throw Object.assign(new Error("temporary I/O failure"), { code:"EIO" }); };
  `);
  assert.equal(stdout.status, 0, stdout.stderr);
  const restarted = openLocalStore(path);
  try {
    assert.deepEqual(restarted.get(address).delivery?.parts, [part]);
  } finally { restarted.close(); }
});

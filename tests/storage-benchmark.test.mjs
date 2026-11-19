import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteStore } from "../src/store.ts";
import { DirectoryPayloads } from "../scripts/storage-benchmark/payloads.mjs";

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
    assert.deepEqual(readdirSync(directory).sort(), [saved.id, neighbour.id].sort());
    store.deleteFiles(first);
    assert.throws(() => store.readFile(first, saved.id), { name: "ResponseFileError" });
    assert.deepEqual(Buffer.from(store.readFile(second, neighbour.id)), file.bytes);
    assert.deepEqual(readdirSync(directory), [neighbour.id]);
  } finally {
    store.close();
  }
});

test("a failed directory cleanup can be retried without touching another topic", t => {
  const root = mkdtempSync(join(tmpdir(), "verfix-storage-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "payloads");
  const payloads = new DirectoryPayloads(directory);
  const store = new SqliteStore(join(root, "db.sqlite"), { payloads });
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
    assert.deepEqual(readdirSync(directory), [firstFile.id]);
    assert.throws(() => store.readFile(second, secondFile.id), { name: "ResponseFileError" });
    store.remove(first);
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    store.close();
  }
});

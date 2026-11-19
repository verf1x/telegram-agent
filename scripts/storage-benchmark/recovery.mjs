import assert from "node:assert/strict";
import { copyFileSync, cpSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BotProcess, firstTopic, neighbour } from "./driver.mjs";
import { now } from "./metrics.mjs";

const otherUser = { userId: 3, topicId: 10 };
// SHA-256 of the fixed synthetic payloads, generated independently with OpenSSL.
const expectedDigest = {
  17: "ac822e174d44d224bdf0afe4a49c950edd60fd1c3ab16b3a2ee628e3e292f550",
  31: "aae6cf2634d393f4e4051923fde04d67d85df649cc0d07c5a6ec1694fafb56ea",
  5000000: "604a0103aa529a7b385ef711956ab1cbceff72d03b72afd9b089e0159faa17ed",
};

export async function checkRecovery(options, makeRestored, backupDir, postgres) {
  const config = { ...options, quota: 120, verifyBytes: true };
  // Only connection settings cross IPC. Functions from the cluster manager stay in the driver.
  delete config.db;
  let bot = new BotProcess(config);
  const timings = {};
  const inspect = (address = firstTopic) => bot.cmd("inspect", address);
  const delivered = () => bot.events.filter(event => event.event === "delivered");
  async function reopen(label) {
    const offset = bot.offset;
    const started = now();
    bot = new BotProcess(config, offset);
    const confirmedOffset = await bot.open();
    timings[label] = now() - started;
    return confirmedOffset;
  }
  async function run(address, text, document) {
    await bot.submit(bot.update(address, text, document));
    await bot.delivered(address, "answer:" + text);
  }
  async function interrupt(kind, update) {
    await bot.cmd("fault", kind);
    await bot.enqueue([update]);
    await bot.kill(true);
    return reopen(kind);
  }
  async function readSaved(address, id, size) {
    await run(address, `read ${id} ${expectedDigest[size]}`);
  }

  try {
    await bot.open();
    await run(firstTopic, "attachment 17 restore", {
      file_id: "17", file_size: 17, file_name: "input.bin", mime_type: "application/octet-stream",
    });
    assert.equal((await bot.delivered(firstTopic, "output.bin")).size, 17);
    assert.equal(bot.events.filter(event => event.event === "download").length, 1);
    await run(neighbour, "write 31 neighbour");
    await run(otherUser, "write 31 another-user");
    const confirmed = (await inspect()).files;
    assert.deepEqual(confirmed.map(file => file.name), ["input.bin", "output.bin"]);
    const expectedDirectory = (await inspect()).directory?.sort();

    const faults = options.directory ? ["file-insert", "partial-payload"] : ["file-insert"];
    for (const fault of faults) {
      const update = bot.update(firstTopic, "write 32 interrupted");
      assert.equal(await interrupt(fault, update), update.update_id + 1);
      const recovered = await inspect();
      assert.deepEqual(recovered.files, confirmed);
      assert.deepEqual(recovered.directory?.sort(), expectedDirectory);
      assert.ok(delivered().some(event => event.name.includes("Обработка запроса прервалась")));
      assert.ok(delivered().every(event => event.size === undefined));
    }
    for (const material of confirmed) await readSaved(firstTopic, material.id, 17);
    assert.ok(bot.events.every(event => event.event !== "download"));
    for (const address of [neighbour, otherUser]) {
      const mark = bot.events.length;
      await bot.submit(bot.update(address, `read ${confirmed[0].id} ${expectedDigest[17]}`));
      assert.ok(bot.events.slice(mark).some(event => event.event === "delivered" &&
        event.userId === address.userId && event.topicId === address.topicId &&
        event.name.includes("Файл недоступен")));
    }

    bot.events.length = 0;
    await bot.submit(bot.update(firstTopic, "write 100 quota"));
    assert.deepEqual((await inspect()).files, confirmed);
    assert.ok(delivered().some(event => event.name.includes("Хранилище файлов диалога заполнено")));
    const beforeOffset = await inspect();
    const unfinished = bot.update(firstTopic, "short atomic");
    assert.equal(await interrupt("offset", unfinished), beforeOffset.offset);
    assert.deepEqual((await inspect()).state, beforeOffset.state);
    await bot.submit(unfinished); // Telegram can offer the unacknowledged update again.
    await bot.delivered(firstTopic, "answer:short atomic");

    bot.events.length = 0;
    await bot.cmd("fault", "partial-delivery");
    const partial = bot.update(firstTopic, "write 31 partial");
    await bot.enqueue([partial]);
    await bot.wait(event => event.event === "blocked-delivery");
    assert.deepEqual(delivered().map(event => event.name), ["answer:write 31 partial"]);
    assert.equal((await inspect()).state.delivery.next, 1);
    await bot.kill();
    assert.equal(await reopen("partialDelivery"), partial.update_id + 1);
    assert.deepEqual(delivered().map(event => [event.name, event.size]), [["output.bin", 31]]);
    assert.equal((await inspect()).state.delivery, undefined);

    const inFlight = bot.update(firstTopic, "held");
    await bot.enqueue([inFlight]);
    await bot.wait(event => event.event === "held");
    await bot.submit(bot.update(firstTopic, "/new"));
    assert.equal(await bot.cmd("late-export"), true);
    assert.equal((await inspect()).files.length, 0);
    assert.equal((await inspect()).state.history.length, 0);
    assert.equal((await inspect(neighbour)).files.length, 1);
    assert.equal((await inspect(otherUser)).files.length, 1);

    await bot.submit(bot.update(neighbour, "/delete"));
    const confirmation = delivered().find(event => event.topicId === neighbour.topicId && event.callback?.startsWith("delete:yes:"));
    assert.ok(confirmation);
    const base = bot.update(neighbour, "");
    await bot.submit({ update_id: base.update_id, callback_query: {
      id: "confirm", data: confirmation.callback, from: { id: neighbour.userId }, message: base.message,
    } });
    assert.ok(bot.events.some(event => event.event === "deleted" && event.topicId === neighbour.topicId));
    assert.equal((await inspect(neighbour)).state, undefined);
    assert.equal((await inspect(neighbour)).files.length, 0);
    const retained = await inspect(otherUser);
    assert.equal(retained.files.length, 1);
    if (options.directory) assert.deepEqual(retained.directory, [retained.files[0].id]);

    // Save a larger synthetic file before taking the consistent, quiescent backup.
    await bot.close();
    const backupConfig = { ...config, quota: undefined };
    bot = new BotProcess(backupConfig, bot.offset);
    await bot.open();
    await run(otherUser, "write 5000000 backup");
    const snapshot = await inspect(otherUser);
    const lastId = bot.offset;
    await bot.close();
    mkdirSync(backupDir, { mode: 0o700 });
    const backupPath = join(backupDir, options.db ? "backup.dump" : "backup.sqlite");
    let started = now();
    if (options.db) writeFileSync(backupPath, postgres.dump(options.db.name));
    else copyFileSync(options.path, backupPath);
    if (options.directory) cpSync(options.directory, join(backupDir, "files"), { recursive: true });
    timings.backup = now() - started;

    started = now();
    const restored = await makeRestored();
    try {
      if (options.db) postgres.restore(restored.db.name, readFileSync(backupPath));
      else copyFileSync(backupPath, restored.path);
      if (options.directory) cpSync(join(backupDir, "files"), restored.directory, { recursive: true });
      const { db, ...restoredConfig } = restored;
      bot = new BotProcess({ ...restoredConfig, verifyBytes: true }, lastId);
      await bot.open();
      timings.restore = now() - started;
      assert.deepEqual((await inspect(otherUser)).state, snapshot.state);
      assert.deepEqual((await inspect(otherUser)).files, snapshot.files);
      assert.equal((await inspect(otherUser)).offset, snapshot.offset);
      assert.equal((await inspect(neighbour)).state, undefined);
      await readSaved(otherUser, snapshot.files[0].id, 31);
      await readSaved(otherUser, snapshot.files[1].id, 5_000_000);
    } finally {
      await bot.close();
      await restored.db?.drop();
    }
    return { ...timings, backupBytes: statSync(backupPath).size + (options.directory ? 5_000_031 : 0) };
  } finally { await bot.close(); }
}

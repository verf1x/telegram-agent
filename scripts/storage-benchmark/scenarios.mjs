import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { BotProcess, withResources, sqliteSize } from "./driver.mjs";
import { now, percentile, percentiles } from "./metrics.mjs";

export const mixed = [
  { name: "text-1", tasks: 1 },
  { name: "mixed-5MB", tasks: 1, bytes: 5_000_000 },
  { name: "mixed-50MB", tasks: 1, bytes: 50_000_000 },
];
export const databaseCases = [
  { name: "idle", idle: true },
  ...mixed,
  { name: "text-2", tasks: 2 },
  { name: "text-4", tasks: 4 },
  { name: "context-60KiB", tasks: 1, context: true },
  { name: "attachment-5MB", tasks: 1, attachment: 5_000_000 },
  { name: "growth-8", tasks: 8 },
  { name: "growth-16", tasks: 16 },
];

const userTopic = index => ({ userId: index + 2, topicId: 10 });
const document = size => ({ file_id: String(size), file_size: size,
  file_name: "input.bin", mime_type: "application/octet-stream" });

async function round(bot, scenario, count) {
  bot.events.length = 0;
  const addresses = Array.from({ length: scenario.tasks }, (_, index) => userTopic(index));
  const writers = scenario.bytes ? [1, 2, 3].map(userTopic) : [];
  const text = scenario.attachment ? `attachment ${scenario.attachment} ${count}` :
    scenario.context ? `context ${count}` : `short ${count}`;
  const queries = addresses.map(address => bot.update(address, text, scenario.attachment && document(scenario.attachment)));
  let availability;
  if (writers.length) {
    const updates = writers.map(address => bot.update(address, `mixed ${scenario.bytes} ${count}`));
    // Reserve the short update ID after the already available writer updates.
    queries[0].update_id = ++bot.offset;
    queries[0].message.message_id = bot.offset;
    const writing = bot.wait(event => event.event === "saving");
    await bot.enqueue(updates);
    await writing;
    availability = await bot.enqueue(queries);
  } else availability = await bot.enqueue(queries);

  const accept = await Promise.all(queries.map(query => bot.accepted(query)));
  const delivered = await Promise.all(addresses.map(address => bot.delivered(address, "answer:" + text)));
  await bot.cmd("drain");
  let uploadMs;
  if (scenario.attachment) {
    const upload = await bot.delivered(addresses[0], "output.bin");
    assert.equal(upload.size, scenario.attachment);
    uploadMs = upload.at - availability;
  }
  const overlap = writers.map(address => {
    const match = (event, kind) => event.event === kind && event.userId === address.userId && event.topicId === address.topicId;
    const start = bot.events.find(event => match(event, "saving")).at - availability;
    const end = bot.events.find(event => match(event, "saved")).at - availability;
    const reply = delivered[0].at - availability;
    assert.equal(bot.events.find(event => match(event, "delivered") && event.name === "output.bin")?.size, scenario.bytes);
    return { start, end, overlaps: start < reply && end > 0, beforeAccept: start < accept[0].at - availability };
  });
  assert.ok(accept.every(event => event.task), "An update was acknowledged without admitting its task");
  const replyMs = delivered.map(event => event.at - availability);
  const end = Math.max(...delivered.map(event => event.at));
  return { acceptMs: accept.map(event => event.at - availability), replyMs, uploadMs, overlap,
    elapsedMs: uploadMs ?? end - availability, events: await bot.cmd("stats", { start: availability, end }),
    cleanup: [...addresses, ...writers] };
}

export async function runScenario(options, scenario, samples, idleMs, db) {
  const bot = new BotProcess({
    ...options, capacity: Math.max(4, scenario.tasks || 0),
    mixedSize: scenario.bytes, preallocate: scenario.bytes ?? scenario.attachment,
  });
  const dbSize = () => db ? db.sample() : sqliteSize(options.path);
  const results = [];
  let missedOverlap = 0;
  try {
    await bot.open();
    if (scenario.idle) {
      await bot.cmd("seed", Array.from({ length: 80 }, (_, index) => ({ userId: 2, topicId: index + 1 })));
      await bot.cmd("drain");
      await bot.cmd("start");
      const idle = await withResources(bot, options.cgroup, async () => {
        const started = now();
        await delay(idleMs);
        return { elapsedMs: now() - started, events: await bot.cmd("stats") };
      });
      assert.ok(!Object.keys(idle.events.counts).some(key => key.startsWith("db.")), "Unexpected database activity in idle");
      results.push({ ...idle, db: await dbSize() });
    } else {
      for (let index = -1; results.length < samples; index++) {
        if (scenario.context) await bot.cmd("seed", [userTopic(0)]);
        await bot.cmd("start");
        const { cleanup, ...result } = await withResources(bot, options.cgroup, () => round(bot, scenario, index));
        const db = await dbSize();
        await bot.cmd("cleanup", cleanup);
        if (index >= 0) {
          if (result.overlap.every(write => write.overlaps && write.beforeAccept)) results.push({ ...result, db });
          else missedOverlap++;
        }
        if (index >= Math.max(20, samples * 5)) throw new Error("Could not reproduce overlap for " + scenario.name);
      }
    }
    return { rows: results, missedOverlap };
  } finally { await bot.close(); }
}

export function summarize(repetitions) {
  const rows = repetitions.flat();
  const accept = rows.flatMap(row => row.acceptMs ?? []);
  const reply = rows.flatMap(row => row.replyMs ?? []);
  const elapsedMs = rows.reduce((total, row) => total + row.elapsedMs, 0);
  const count = rows.length;
  const totals = rows.reduce((result, row) => {
    for (const [key, entry] of Object.entries(row.events.counts)) {
      const prior = result[key] ??= { calls: 0, ms: 0 };
      prior.calls += entry.calls;
      prior.ms += entry.ms;
    }
    return result;
  }, {});
  const loopP99 = rows.flatMap(row => row.events.loopMs ? [row.events.loopMs.p99] : []);
  const loopMax = rows.flatMap(row => row.events.loopMs ? [row.events.loopMs.max] : []);
  const cpuMs = rows.reduce((sum, row) => sum + (row.events.cpuUs.user + row.events.cpuUs.system + (row.pg?.cpuUs ?? 0)) / 1000, 0);
  return {
    samples: count, replies: reply.length, acceptMs: percentiles(accept), replyMs: percentiles(reply),
    uploadMs: percentiles(rows.flatMap(row => row.uploadMs === undefined ? [] : [row.uploadMs])),
    criticalMedianMs: Object.fromEntries(["db", "file", "json", "other"].map(category =>
      [category, percentile(rows.flatMap(row => row.events.critical ? [row.events.critical[category]] : []), 0.5)])),
    acceptP95ByRun: repetitions.map(run => percentile(run.flatMap(row => row.acceptMs ?? []), 0.95)),
    replyP95ByRun: repetitions.map(run => percentile(run.flatMap(row => row.replyMs ?? []), 0.95)),
    repliesPerSecond: 1000 * reply.length / elapsedMs,
    cpuMsPerSample: cpuMs / count,
    cpuPercent: 100 * cpuMs / elapsedMs,
    peakBotRssKiB: Math.max(...rows.map(row => row.events.peakRssKiB)),
    peakPgMemoryBytes: Math.max(...rows.map(row => row.pg?.peakBytes ?? 0)),
    readBytesPerSample: rows.reduce((sum, row) => sum + row.read + (row.pg?.read ?? 0), 0) / count,
    writeBytesPerSample: rows.reduce((sum, row) => sum + row.write + (row.pg?.write ?? 0), 0) / count,
    dbBytes: Math.max(...rows.map(row => row.db.bytes)),
    walBytes: Math.max(...rows.map(row => row.db.wal)),
    deadlocks: Math.max(...rows.map(row => row.db.deadlocks ?? 0)),
    rollbacks: Math.max(...rows.map(row => row.db.xact_rollback ?? 0)),
    waiting: Math.max(...rows.map(row => row.db.waiting ?? 0)),
    loopP99MedianMs: percentile(loopP99, 0.5), loopMaxMs: Math.max(0, ...loopMax),
    timings: Object.fromEntries(Object.entries(totals).map(([key, entry]) =>
      [key, { calls: entry.calls, msPerSample: entry.ms / count }])),
  };
}

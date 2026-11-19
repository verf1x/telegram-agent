import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { startPostgres } from "./storage-benchmark/postgres-server.mjs";
import { checkRecovery } from "./storage-benchmark/recovery.mjs";
import { databaseCases, mixed, runScenario, summarize } from "./storage-benchmark/scenarios.mjs";

const { values: flags } = parseArgs({ options: {
  stage: { type: "string", default: "all" },
  storage: { type: "string" },
  samples: { type: "string", default: "20" },
  repeats: { type: "string", default: "3" },
  "idle-ms": { type: "string", default: "3000" },
  "data-root": { type: "string", default: "." },
  "postgres-image": { type: "string", default: "postgres:18-alpine" },
  output: { type: "string" },
} });
const stage = flags.stage;
const samples = Number(flags.samples);
const repeats = Number(flags.repeats);
const idleMs = Number(flags["idle-ms"]);
if (!["all", "files", "database"].includes(stage) ||
    (stage === "database" ? !["blob", "directory"].includes(flags.storage) : flags.storage !== undefined) ||
    ![samples, repeats, idleMs].every(value => Number.isSafeInteger(value) && value > 0)) {
  throw new Error("Use --stage files|database|all, --storage blob|directory (only for database), and positive --samples, --repeats, --idle-ms.");
}

const dataRoot = resolve(flags["data-root"]);
const root = mkdtempSync(join(dataRoot, ".verfix-storage-"));
const findmnt = () => execFileSync("findmnt", ["-n", "-o", "SOURCE,FSTYPE", "-T", root], { encoding: "utf8" }).trim();
const probe = new DatabaseSync(":memory:");
const sqliteVersion = probe.prepare("SELECT sqlite_version() AS version").get().version;
probe.close();
const result = {
  environment: { node: process.version, sqliteVersion, kernel: release(), storage: findmnt(),
    cpus: cpus().length, cpu: cpus()[0].model, ramBytes: totalmem(), samples, repeats, idleMs },
  stages: {},
};

let postgres, sequence = 0;
async function testCase(backend, storage) {
  const directory = join(root, "case-" + ++sequence);
  mkdirSync(directory, { mode: 0o700 });
  const db = backend === "postgres" ? await postgres.createDatabase() : undefined;
  return {
    path: join(directory, "bot.sqlite"),
    directory: storage === "directory" ? join(directory, "payloads") : undefined,
    db, url: db?.url,
    cgroup: db ? postgres.cgroup : undefined,
  };
}

async function comparison(name, variants, cases) {
  const report = Object.fromEntries(variants.map(([backend, storage]) => [backend + "-" + storage, {
    readings: Object.fromEntries(cases.map(({ name }) => [name, { raw: [], missedOverlap: 0 }])),
  }]));
  for (let index = 0; index < repeats; index++) {
    const order = index % 2 === 0 ? variants : variants.toReversed();
    for (const scenario of cases) {
      for (const [backend, storage] of order) {
        const label = backend + "-" + storage;
        console.error(`${name} ${label} ${scenario.name}, run ${index + 1}/${repeats}`);
        const config = await testCase(backend, storage);
        const { db, ...options } = config;
        try {
          const { rows, missedOverlap } = await runScenario(options, scenario, samples, idleMs, db);
          const entry = report[label].readings[scenario.name];
          entry.raw.push(rows);
          entry.missedOverlap += missedOverlap;
          if (db) (entry.lockWaitsByRun ??= []).push(await db.lockWaits());
        } finally {
          await db?.drop();
          rmSync(config.path, { force: true });
        }
      }
    }
  }
  for (const [backend, storage] of variants) {
    const label = backend + "-" + storage;
    console.error(`${name} ${label} recovery and backup`);
    const measurement = report[label];
    const config = await testCase(backend, storage);
    try {
      measurement.recovery = await checkRecovery(config, () => testCase(backend, storage),
        join(root, `backup-${name}-${label}`), postgres);
    } finally { await config.db?.drop(); }
    for (const entry of Object.values(measurement.readings)) entry.summary = summarize(entry.raw);
    const baseline = measurement.readings["text-1"].summary;
    for (const [caseName, entry] of Object.entries(measurement.readings)) {
      if (caseName.startsWith("mixed-")) {
        entry.summary.deltaP95Ms = {
          accept: entry.summary.acceptMs.p95 - baseline.acceptMs.p95,
          reply: entry.summary.replyMs.p95 - baseline.replyMs.p95,
        };
      }
    }
  }
  return report;
}

try {
  let storage = flags.storage;
  if (stage !== "database") {
    const report = await comparison("files", [["sqlite", "blob"], ["sqlite", "directory"]], mixed);
    result.stages.files = report;
    const p95 = variant => report[variant].readings["mixed-50MB"].summary.replyMs.p95;
    result.recommendedStorage = p95("sqlite-directory") < p95("sqlite-blob") ? "directory" : "blob";
    storage = result.recommendedStorage;
    if (flags.output) writeFileSync(flags.output, JSON.stringify(result, null, 2) + "\n");
  }
  if (stage !== "files") {
    postgres = await startPostgres(root, flags["postgres-image"]);
    result.environment.postgres = postgres.info;
    result.databaseStorage = storage;
    result.stages.database = await comparison("database", [["sqlite", storage], ["postgres", storage]], databaseCases);
  }
  const output = JSON.stringify(result, null, 2) + "\n";
  if (flags.output) writeFileSync(flags.output, output);
  else process.stdout.write(output);
} finally {
  try { await postgres?.close(); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

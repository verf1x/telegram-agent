import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

function docker(args, options) {
  const output = execFileSync("docker", args, { encoding: "utf8", timeout: 60_000, ...options });
  return typeof output === "string" ? output.trim() : output;
}

export async function startPostgres(root, image) {
  const data = join(root, "pgdata");
  mkdirSync(data, { mode: 0o700 });
  const password = randomBytes(24).toString("hex");
  const container = docker([
    "run", "--detach", "--rm", "--user", `${process.getuid()}:${process.getgid()}`,
    "--mount", `type=bind,src=${data},dst=/var/lib/postgresql`,
    "--publish", "127.0.0.1::5432",
    "--env", "PGDATA=/var/lib/postgresql/benchmark", "--env", "POSTGRES_USER=benchmark",
    "--env", "POSTGRES_DB=postgres", "--env", "POSTGRES_PASSWORD",
    image, "-c", "fsync=on", "-c", "synchronous_commit=on",
    "-c", "full_page_writes=on", "-c", "shared_buffers=128MB", "-c", "lc_messages=C",
    "-c", "logging_collector=on", "-c", "log_destination=jsonlog", "-c", "log_filename=benchmark.log",
    "-c", "log_rotation_age=0", "-c", "log_rotation_size=0", "-c", "log_lock_waits=on", "-c", "deadlock_timeout=10ms",
  ], { env: { ...process.env, POSTGRES_PASSWORD: password } });
  const stop = () => docker(["stop", "--time", "5", container]);
  let admin;
  try {
    const host = docker(["port", container, "5432/tcp"]);
    const url = `postgresql://benchmark:${password}@${host}`;
    for (let attempt = 0; attempt < 100; attempt++) {
      admin = new pg.Client({ connectionString: url + "/postgres", connectionTimeoutMillis: 500 });
      try {
        await admin.connect();
        break;
      } catch (error) {
        await admin.end();
        admin = undefined;
        if (attempt === 99) throw error;
        await delay(100);
      }
    }
    const pid = docker(["inspect", "--format", "{{.State.Pid}}", container]);
    const cgroup = readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().split("::")[1];
    if (!cgroup) throw new Error("The PostgreSQL benchmark requires Linux cgroup v2");
    const info = (await admin.query(`SELECT version(), current_setting('fsync') AS fsync,
      current_setting('synchronous_commit') AS synchronous_commit,
      current_setting('full_page_writes') AS full_page_writes,
      current_setting('shared_buffers') AS shared_buffers, current_setting('wal_sync_method') AS wal_sync_method,
      current_setting('wal_compression') AS wal_compression, current_setting('max_wal_size') AS max_wal_size,
      current_setting('deadlock_timeout') AS lock_wait_log_threshold`)).rows[0];
    info.image = docker(["inspect", "--format", "{{.Image}}", container]);
    let sequence = 0;
    return {
      info, cgroup: join("/sys/fs/cgroup", cgroup),
      async createDatabase() {
        const name = `bench_${++sequence}`;
        await admin.query(`CREATE DATABASE ${name}`);
        return {
          name, url: url + "/" + name,
          async sample() {
            const result = await admin.query(`SELECT pg_database_size(datname)::bigint AS bytes,
              (SELECT coalesce(sum(size),0)::bigint FROM pg_ls_waldir()) AS wal,
              deadlocks, conflicts, xact_rollback,
              (SELECT count(*) FROM pg_locks WHERE NOT granted AND database=d.datid) AS waiting
              FROM pg_stat_database d WHERE datname=$1`, [name]);
            return Object.fromEntries(Object.entries(result.rows[0]).map(([key, value]) => [key, Number(value)]));
          },
          async lockWaits() {
            const barrier = "verfix lock logs ready " + randomBytes(8).toString("hex");
            await admin.query(`DO $$ BEGIN RAISE LOG '${barrier}'; END $$`);
            const path = join(data, "benchmark", "log", "benchmark.json");
            for (let attempt = 0; attempt < 100; attempt++) {
              // Wait for the collector to persist the barrier and any preceding messages.
              const log = readFileSync(path, "utf8");
              const entries = log.split("\n").slice(0, -1).map(line => JSON.parse(line));
              const boundary = entries.findIndex(entry => entry.message === barrier);
              if (boundary !== -1) {
                let completed = 0, cancelled = 0, maxCompletedMs = null;
                const waiting = new Set();
                for (const entry of entries.slice(0, boundary)) {
                  if (entry.dbname !== name) continue;
                  if (["55P03", "57014", "40P01"].includes(entry.state_code) && waiting.delete(String(entry.pid))) {
                    cancelled++;
                  }
                  const match = /^process (\d+) (still waiting for|acquired) .* after ([\d.]+) ms$/.exec(entry.message);
                  if (!match) continue;
                  const [, pid, event, duration] = match;
                  if (event === "still waiting for") waiting.add(pid);
                  else {
                    waiting.delete(pid);
                    completed++;
                    maxCompletedMs = Math.max(maxCompletedMs ?? 0, Number(duration));
                  }
                }
                return { waits: completed + cancelled + waiting.size, cancelled, maxCompletedMs };
              }
              await delay(20);
            }
            throw new Error("PostgreSQL did not finish collecting lock logs");
          },
          async drop() { await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); },
        };
      },
      dump(name) {
        return docker(["exec", container, "pg_dump", "-U", "benchmark", "-Fc", name],
          { encoding: null, maxBuffer: 512 * 1024 * 1024 });
      },
      restore(name, archive) {
        docker(["exec", "-i", container, "pg_restore", "--exit-on-error", "-U", "benchmark", "-d", name],
          { input: archive });
      },
      async close() { try { await admin.end(); } finally { stop(); } },
    };
  } catch (error) {
    try { await admin?.end(); }
    finally {
      console.error(docker(["logs", container]));
      stop();
    }
    throw error;
  }
}

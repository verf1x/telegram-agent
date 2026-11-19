import { monitorEventLoopDelay } from "node:perf_hooks";

export const now = () => Number(process.hrtime.bigint()) / 1e6;
export const percentile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
};
export const percentiles = values => Object.fromEntries(
  [50, 95, 99].map(p => [`p${p}`, percentile(values, p / 100)]),
);

export function instrument() {
  let counts = {};
  let spans;
  const lag = monitorEventLoopDelay({ resolution: 1 });
  lag.enable();
  function measure(name, operation) {
    const start = now();
    try { return operation(); }
    catch (error) {
      if ([5, 6].includes(error.errcode & 0xff) || /^(55P03|40P01|40001)$/.test(error.code ?? "")) {
        const entry = counts.lockErrors ??= { calls: 0, ms: 0 };
        entry.calls++;
      }
      throw error;
    } finally {
      const entry = counts[name] ??= { calls: 0, ms: 0 };
      entry.calls++;
      const end = now();
      entry.ms += end - start;
      if (spans) spans.push({ category: name.split(".")[0], start, end });
    }
  }
  return {
    measure,
    start() { counts = {}; spans = []; lag.reset(); },
    results(window) {
      let critical;
      if (window) {
        critical = { db: 0, file: 0, json: 0 };
        for (const span of spans) {
          const overlap = Math.min(span.end, window.end) - Math.max(span.start, window.start);
          if (overlap > 0) critical[span.category] += overlap;
        }
        critical.other = Math.max(0, window.end - window.start - critical.db - critical.file - critical.json);
      }
      spans = undefined;
      return { counts, critical, loopMs: lag.count ? { p50: lag.percentile(50) / 1e6,
        p95: lag.percentile(95) / 1e6, p99: lag.percentile(99) / 1e6, max: lag.max / 1e6 } : null };
    },
  };
}

export function timedDatabase(db, measure, afterStatement) {
  return {
    close: () => db.close(),
    exec: sql => measure(sql === "COMMIT" ? "db.commit" : "db.exec", () => db.exec(sql)),
    prepare(sql) {
      const statement = measure("db.prepare", () => db.prepare(sql));
      let category = "db.other";
      if (/SELECT state FROM dialogues/.test(sql)) category = "db.contextRead";
      if (/INSERT INTO dialogues/.test(sql)) category = "db.contextWrite";
      if (/ORDER BY (due_at|preview_at),user_id,topic_id/.test(sql)) category = "db.ready";
      if (/INSERT INTO dialogue_files/.test(sql)) category = "db.fileWrite";
      if (/SELECT bytes FROM dialogue_files/.test(sql)) category = "db.fileRead";
      function call(method, args) {
        const result = measure(category, () => statement[method](...args));
        afterStatement(sql, category);
        return result;
      }
      return {
        get: (...args) => call("get", args),
        run: (...args) => call("run", args),
        all: (...args) => call("all", args),
        *iterate(...args) {
          const rows = call("iterate", args)[Symbol.iterator]();
          try {
            while (true) {
              const next = measure(category, () => rows.next());
              if (next.done) return;
              yield next.value;
            }
          } finally { rows.return?.(); }
        },
      };
    },
  };
}

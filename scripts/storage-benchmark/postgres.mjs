import { MessageChannel, Worker, receiveMessageOnPort, workerData } from "node:worker_threads";
import pg from "pg";

// The experiment keeps the current synchronous Store API and one database connection.
export class PostgresDatabase {
  constructor(connectionString) {
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.done = new Int32Array(new SharedArrayBuffer(4));
    this.worker = new Worker(new URL(import.meta.url), {
      workerData: { connectionString, port: port2, done: this.done },
      execArgv: [],
      transferList: [port2],
    });
    this.worker.unref();
    this.port.unref();
  }

  query(text, values = []) {
    Atomics.store(this.done, 0, 0);
    this.port.postMessage({ text, values });
    if (Atomics.wait(this.done, 0, 0, 60_000) === "timed-out") throw new Error("PostgreSQL worker timed out");
    const { result, error } = receiveMessageOnPort(this.port).message;
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    return result;
  }

  exec(sql) {
    const translated = translate(sql);
    if (translated) this.query(translated);
  }

  prepare(sql) {
    const text = translate(sql);
    const query = values => this.query(text, values);
    return {
      all: (...values) => query(values).rows,
      get: (...values) => query(values).rows[0],
      iterate: (...values) => query(values).rows,
      run: (...values) => ({ changes: query(values).rowCount, lastInsertRowid: 0 }),
    };
  }

  close() {
    this.port.close();
    void this.worker.terminate();
  }
}

function translate(sql) {
  const columns = /^PRAGMA table_info\((\w+)\)$/.exec(sql);
  if (columns) {
    return `SELECT column_name AS name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='${columns[1]}'`;
  }
  let parameter = 0;
  return sql
    .replace(/PRAGMA wal_checkpoint\(TRUNCATE\)/g, "")
    .replace(/PRAGMA \w+=\w+;\s*/g, "")
    .replace(/BEGIN IMMEDIATE/g, "BEGIN")
    .replace(/\bINTEGER\b/g, "BIGINT")
    .replace(/\bBLOB\b/g, "BYTEA")
    .replace(/(CREATE TABLE IF NOT EXISTS (?:dialogue_files|broadcasts) \()/g,
      "$1rowid BIGINT GENERATED ALWAYS AS IDENTITY, ")
    .replace(/\?/g, () => `$${++parameter}`);
}

if (workerData?.connectionString) {
  const { port, done, connectionString } = workerData;
  pg.types.setTypeParser(20, Number); // BIGINT
  pg.types.setTypeParser(1700, Number); // SUM(BIGINT)
  const connection = new pg.Client({
    connectionString, connectionTimeoutMillis: 5_000, statement_timeout: 45_000,
    lock_timeout: 5_000, application_name: "verfix-storage-benchmark",
  });
  // Wake the caller on query errors, including connection failures.
  connection.on("error", () => {});
  const started = connection.connect().then(() => undefined, error => error);
  port.on("message", async ({ text, values }) => {
    try {
      const startError = await started;
      if (startError) throw startError;
      const response = await connection.query(text, values.map(value =>
        value instanceof Uint8Array ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : value));
      const result = Array.isArray(response) ? response.at(-1) : response;
      port.postMessage({ result: { rows: result.rows, rowCount: result.rowCount } });
    } catch (error) {
      port.postMessage({ error: { message: error.message, code: error.code } });
    } finally {
      Atomics.store(done, 0, 1);
      Atomics.notify(done, 0);
    }
  });
  port.on("close", () => { void connection.end(); });
}

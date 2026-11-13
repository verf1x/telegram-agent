import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BotConfig, ConfigSnapshot, ConfigSource } from "./contracts.ts";

/** Reads only the explicit private configuration file, never the parent process environment. */
export class FileConfigSource implements ConfigSource {
  private current: ConfigSnapshot;
  private readonly listeners = new Set<(snapshot: ConfigSnapshot) => void>();
  private readonly timer: ReturnType<typeof setInterval>;
  private lastContents = "";
  private readonly initial: BotConfig;
  private readonly path: string;
  constructor(path = ".env") {
    this.path = path;
    this.initial = this.read();
    this.current = { valid: true, config: this.initial };
    this.timer = setInterval(
      () => this.reload(),
      this.initial.configReloadIntervalMs,
    );
    this.timer.unref();
  }
  snapshot(): ConfigSnapshot {
    return this.current;
  }
  watch(listener: (snapshot: ConfigSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close(): void {
    clearInterval(this.timer);
    this.listeners.clear();
  }
  private read(): BotConfig {
    let contents: string;
    try {
      contents = readFileSync(this.path, "utf8");
    } catch {
      throw new Error("Cannot read .env configuration file");
    }
    const env: Record<string, string> = {};
    for (const source of contents.split(/\r?\n/)) {
      const line = source.trim();
      if (!line || line.startsWith("#")) continue;
      const match = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) throw new Error("Invalid .env syntax");
      let value = match[2]!.trim();
      if (value.startsWith('"') || value.startsWith("'")) {
        const quote = value[0]!;
        const end = value.indexOf(quote, 1);
        if (end < 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1)))
          throw new Error("Invalid .env quoting");
        value = value.slice(1, end);
      } else value = value.replace(/\s+#.*$/, "").trim();
      env[match[1]!] = value;
    }
    const positive = (
      key: string,
      fallback?: number,
      max = Number.MAX_SAFE_INTEGER,
    ): number => {
      const raw = env[key];
      if (raw === undefined && fallback !== undefined) return fallback;
      if (!raw || !/^\d+$/.test(raw))
        throw new Error(
          `Invalid configuration: ${key} must be a positive integer`,
        );
      const n = Number(raw);
      if (!Number.isSafeInteger(n) || n < 1 || n > max)
        throw new Error(`Invalid configuration: ${key} is out of range`);
      return n;
    };
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(env.TELEGRAM_BOT_TOKEN ?? ""))
      throw new Error("Invalid configuration: TELEGRAM_BOT_TOKEN is required");
    const allowed = (env.ALLOWED_USER_IDS ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => {
        if (
          !/^\d+$/.test(x) ||
          !Number.isSafeInteger(Number(x)) ||
          Number(x) < 1
        )
          throw new Error(
            "Invalid configuration: ALLOWED_USER_IDS must contain positive numeric IDs",
          );
        return Number(x);
      });
    const config: BotConfig = {
      botToken: env.TELEGRAM_BOT_TOKEN!,
      ownerId: positive("OWNER_TELEGRAM_ID"),
      allowedUserIds: [...new Set(allowed)],
      databasePath: resolve(env.DATABASE_PATH || "./runtime/bot.sqlite"),
      runtimeDir: resolve(env.RUNTIME_DIR || "./runtime"),
      maxConcurrentRequests: positive("MAX_CONCURRENT_REQUESTS", 4),
      requestTimeoutMs: positive("REQUEST_TIMEOUT_MS", 900000),
      dialogueFileBytes: positive("DIALOGUE_FILE_BYTES", 500_000_000),
      pollTimeoutSeconds: positive("POLL_TIMEOUT_SECONDS", 30, 50),
      configReloadIntervalMs: positive("CONFIG_RELOAD_INTERVAL_MS", 500),
      defaultModel: "gpt-6.1-sol",
      defaultEffort: "medium",
    };
    this.lastContents = contents;
    return config;
  }
  private reload(): void {
    const previous = this.current;
    try {
      if (
        readFileSync(this.path, "utf8") === this.lastContents &&
        this.current.valid
      )
        return;
      const config = this.read();
      for (const key of [
        "botToken",
        "ownerId",
        "databasePath",
        "runtimeDir",
      ] as const)
        if (config[key] !== this.initial[key])
          throw new Error(
            `Configuration ${key} changed; restore the original value or restart the bot`,
          );
      this.current = { valid: true, config };
    } catch (error) {
      this.current = {
        valid: false,
        error: error instanceof Error ? error.message : "Invalid configuration",
        lastValid: this.current.valid
          ? this.current.config
          : (this.current.lastValid ?? this.initial),
      };
    }
    if (
      !this.current.valid &&
      (previous.valid || previous.error !== this.current.error)
    )
      console.error(this.current.error);
    for (const listener of this.listeners) listener(this.current);
  }
}

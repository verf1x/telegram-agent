import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_MODEL_SELECTION } from "./contracts.ts";
import type { BotConfig, ConfigSource } from "./contracts.ts";

/** Reads only the explicit private configuration file, never the parent process environment. */
export class FileConfigSource implements ConfigSource {
  private readonly current: { valid: true; config: BotConfig };
  constructor(path = ".env") {
    this.current = { valid: true, config: this.read(path) };
  }
  snapshot(): { valid: true; config: BotConfig } {
    return this.current;
  }
  private read(path: string): BotConfig {
    let contents: string;
    try {
      contents = readFileSync(path, "utf8");
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
      requestTimeoutMs: positive("REQUEST_TIMEOUT_MS", 1_200_000),
      dialogueFileBytes: positive("DIALOGUE_FILE_BYTES", 500_000_000),
      pollTimeoutSeconds: positive("POLL_TIMEOUT_SECONDS", 30, 50),
      defaultModel: DEFAULT_MODEL_SELECTION.model,
      defaultEffort: DEFAULT_MODEL_SELECTION.effort,
    };
    return config;
  }
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileConfigSource } from "../src/config.ts";
import { SqliteStore } from "../src/store.ts";
import { createBot } from "../src/bot.ts";
import type {
  ModelEngine,
  TelegramTransport,
  OutgoingPart,
  TelegramUpdate,
} from "../src/contracts.ts";

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "verfix-bot-"));
  const env = join(dir, ".env");
  const configText = (allowed = "2", extra = "") =>
    `TELEGRAM_BOT_TOKEN=123456:TEST\nOWNER_TELEGRAM_ID=1\nALLOWED_USER_IDS=${allowed}\nDATABASE_PATH=${join(dir, "db.sqlite")}\nRUNTIME_DIR=${dir}\nCONFIG_RELOAD_INTERVAL_MS=20\n${extra}`;
  writeFileSync(env, configText());
  const config = new FileConfigSource(env);
  let store = new SqliteStore(join(dir, "db.sqlite"));
  const sent: Array<{
    chatId: number;
    text: string;
    part?: OutgoingPart;
    options?: any;
  }> = [];
  const requests: any[] = [];
  const telegram: TelegramTransport = {
    getUpdates: async () => [],
    sendText: async (chatId, text, options) => {
      sent.push({ chatId, text, options });
      return sent.length;
    },
    sendPart: async (chatId, part) => {
      sent.push({
        chatId,
        text: part.kind === "image" ? part.name : part.text,
        part,
      });
      return sent.length;
    },
    typing: async () => {},
    answerCallback: async () => {},
  };
  const engine: ModelEngine = {
    run: async (r) => {
      requests.push(r);
      await r.onThread(`thread-${r.userId}`);
      return {
        text: `answer ${r.text}`,
        threadId: `thread-${r.userId}`,
        images: [],
      };
    },
    listModels: async () => [
      { id: "gpt-6.1-sol", supportedEfforts: ["medium", "high"] },
    ],
    deleteThread: async () => {},
    health: async () => ({ available: true }),
    close: async () => {},
  };
  let bot = createBot({ config, store, engine, telegram });
  t.after(async () => {
    await bot.shutdown();
    config.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let id = 0;
  const update = (userId: number, text: string): TelegramUpdate => ({
    update_id: ++id,
    message: {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: userId, type: "private" },
      from: { id: userId },
      text,
    },
  });
  return {
    dir,
    env,
    config,
    configText,
    sent,
    requests,
    telegram,
    engine,
    update,
    get store() {
      return store;
    },
    get bot() {
      return bot;
    },
    reopen: async () => {
      await bot.shutdown();
      store.close();
      store = new SqliteStore(join(dir, "db.sqlite"));
      bot = createBot({ config, store, engine, telegram });
      await bot.recover();
    },
  };
}

test("approved users receive independent answers and their dialogue survives SQLite reopen", async (t) => {
  const f = fixture(t);
  await f.bot.handleUpdate(f.update(99, "secret"));
  await f.bot.handleUpdate(f.update(2, "hello"));
  await f.bot.handleUpdate(f.update(1, "owner"));
  await f.bot.drain();
  assert.deepEqual(
    f.sent.map((x) => [x.chatId, x.text]),
    [
      [2, "answer hello"],
      [1, "answer owner"],
    ],
  );
  await f.reopen();
  await f.bot.handleUpdate(f.update(2, "continue"));
  await f.bot.drain();
  assert.equal(f.requests.at(-1).threadId, "thread-2");
  assert.equal(f.requests[0].model, "gpt-6.1-sol");
  assert.equal(f.requests[0].effort, "medium");
});

test("one user remains busy until response delivery and other users continue", async (t) => {
  const f = fixture(t);
  let release!: () => void;
  const pending = new Promise<void>((r) => (release = r));
  f.engine.run = async (r) => {
    f.requests.push(r);
    if (r.userId === 2) await pending;
    return { text: "done", threadId: `thread-${r.userId}`, images: [] };
  };
  await f.bot.handleUpdate(f.update(2, "first"));
  await f.bot.handleUpdate(f.update(2, "second"));
  await f.bot.handleUpdate(f.update(1, "owner"));
  await new Promise((r) => setTimeout(r, 5));
  const observed = [...f.sent];
  release();
  await f.bot.drain();
  assert.ok(observed.some((x) => x.chatId === 2 && /дождитесь/i.test(x.text)));
  assert.ok(observed.some((x) => x.chatId === 1 && x.text === "done"));
  assert.equal(f.requests.filter((x) => x.userId === 2).length, 1);
  release();
  await f.bot.drain();
});

test("restart never repeats an interrupted turn and rebuilds only committed dialogue", async (t) => {
  const f = fixture(t);
  await f.bot.handleUpdate(f.update(2, "committed"));
  await f.bot.drain();
  f.engine.run = async (r) => {
    f.requests.push(r);
    await r.onThread("poisoned-thread");
    return new Promise((_, reject) =>
      r.signal.addEventListener("abort", () => reject(new Error("stopped")), {
        once: true,
      }),
    );
  };
  await f.bot.handleUpdate(f.update(2, "interrupted"));
  await new Promise((r) => setTimeout(r, 5));
  await f.reopen();
  assert.match(f.sent.at(-1)!.text, /прервалась/);
  f.engine.run = async (r) => {
    f.requests.push(r);
    return { text: "fresh answer", threadId: "fresh-thread", images: [] };
  };
  await f.bot.handleUpdate(f.update(2, "next"));
  await f.bot.drain();
  const next = f.requests.at(-1);
  assert.equal(next.threadId, undefined);
  assert.deepEqual(next.history, [
    { role: "user", text: "committed" },
    { role: "assistant", text: "answer committed" },
  ]);
  assert.equal(f.requests.filter((r) => r.text === "interrupted").length, 1);
});

test("long saved answers resume after restart without resending acknowledged parts", async (t) => {
  const f = fixture(t);
  const text = "Long answer. ".repeat(1500);
  f.engine.run = async (r) => {
    f.requests.push(r);
    return { text, threadId: "long-thread", images: [] };
  };
  let sends = 0;
  const original = f.telegram.sendPart;
  f.telegram.sendPart = async (...args) => {
    sends++;
    if (sends > 1) throw new Error("network unavailable");
    return original(...args);
  };
  await f.bot.handleUpdate(f.update(2, "long"));
  await f.bot.drain();
  assert.ok(f.sent[0]!.text.length < text.length);
  const first = f.sent[0]!.text;
  f.telegram.sendPart = original;
  await f.reopen();
  await new Promise((r) => setTimeout(r, 1300));
  await f.bot.drain();
  assert.equal(f.requests.length, 1);
  assert.equal(f.sent.filter((x) => x.text === first).length, 1);
  assert.equal(f.sent.map((x) => x.text).join(""), text);
});

test("owner picker binds model identity when catalog order changes and survives reset/restart", async (t) => {
  const f = fixture(t);
  const a = { id: "model-a", supportedEfforts: ["medium", "high"] },
    b = { id: "model-b", supportedEfforts: ["low"] };
  f.engine.listModels = async () => [a, b];
  await f.bot.handleUpdate(f.update(1, "/model"));
  const modelData =
    f.sent.at(-1)!.options.reply_markup.inline_keyboard[0][0].callback_data;
  f.engine.listModels = async () => [b, a];
  const callback = (data: string): TelegramUpdate => ({
    ...f.update(1, ""),
    callback_query: {
      id: "cb",
      from: { id: 1 },
      message: { message_id: 1, date: 0, chat: { id: 1, type: "private" } },
      data,
    },
  });
  await f.bot.handleUpdate(callback(modelData));
  assert.match(f.sent.at(-1)!.text, /model-a/);
  const effortData =
    f.sent.at(-1)!.options.reply_markup.inline_keyboard[1][0].callback_data;
  await f.bot.handleUpdate(callback(effortData));
  await f.bot.handleUpdate(f.update(1, "/new"));
  await f.bot.drain();
  await f.reopen();
  await f.bot.handleUpdate(f.update(1, "question"));
  await f.bot.drain();
  assert.equal(f.requests.at(-1).model, "model-a");
  assert.equal(f.requests.at(-1).effort, "high");
});

test("permanent Telegram delivery failure releases the user without repeated sends", async (t) => {
  const f = fixture(t);
  let attempts = 0;
  f.telegram.sendPart = async () => {
    attempts++;
    throw Object.assign(new Error("blocked"), { permanent: true, code: 403 });
  };
  await f.bot.handleUpdate(f.update(2, "first"));
  await f.bot.drain();
  await f.bot.handleUpdate(f.update(2, "second"));
  await f.bot.drain();
  assert.equal(f.requests.length, 2);
  assert.equal(attempts, 2);
});

test("Telegram retry_after delays delivery and resumes automatically without an incoming message", async (t) => {
  const f = fixture(t);
  const original = f.telegram.sendPart;
  let attempts = 0;
  f.telegram.sendPart = async (...args) => {
    attempts++;
    if (attempts === 1)
      throw Object.assign(new Error("slow down"), { retryAfter: 1 });
    return original(...args);
  };
  await f.bot.handleUpdate(f.update(2, "retry"));
  await f.bot.drain();
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(attempts, 1);
  await new Promise((r) => setTimeout(r, 1000));
  await f.bot.drain();
  assert.equal(attempts, 2);
  assert.equal(f.sent.at(-1)!.text, "answer retry");
});

test("invalid runtime configuration pauses accepted output and owner diagnostics recover automatically", async (t) => {
  const f = fixture(t);
  let finish!: (value: any) => void;
  f.engine.run = async (r) => {
    f.requests.push(r);
    return new Promise((resolve) => (finish = resolve));
  };
  await f.bot.handleUpdate(f.update(2, "pending"));
  await new Promise((r) => setTimeout(r, 5));
  writeFileSync(
    f.env,
    "TELEGRAM_BOT_TOKEN=do-not-expose-this-secret\nOWNER_TELEGRAM_ID=1",
  );
  await new Promise((r) => setTimeout(r, 60));
  finish({ text: "saved during pause", threadId: "paused", images: [] });
  await f.bot.drain();
  assert.equal(f.sent.length, 0);
  await f.bot.handleUpdate(f.update(1, "/status"));
  assert.match(f.sent.at(-1)!.text, /приостановлена/);
  assert.ok(!f.sent.at(-1)!.text.includes("do-not-expose"));
  await f.bot.handleUpdate(f.update(2, "not accepted"));
  writeFileSync(f.env, f.configText());
  await new Promise((r) => setTimeout(r, 80));
  await f.bot.drain();
  assert.equal(f.sent.at(-1)!.text, "saved during pause");
  assert.equal(f.requests.length, 1);
});

test("revocation cancels pending output permanently while granting access preserves committed dialogue", async (t) => {
  const f = fixture(t);
  let finish!: (value: any) => void;
  f.engine.run = async (r) => {
    f.requests.push(r);
    return new Promise((resolve) => (finish = resolve));
  };
  await f.bot.handleUpdate(f.update(2, "before revoke"));
  await new Promise((r) => setTimeout(r, 5));
  writeFileSync(f.env, f.configText(""));
  await new Promise((r) => setTimeout(r, 60));
  writeFileSync(f.env, f.configText("2"));
  await new Promise((r) => setTimeout(r, 60));
  finish({ text: "cancelled answer", threadId: "retained", images: [] });
  await f.bot.drain();
  assert.equal(f.sent.length, 0);
  f.engine.run = async (r) => {
    f.requests.push(r);
    return { text: "continued", threadId: r.threadId!, images: [] };
  };
  await f.bot.handleUpdate(f.update(2, "after grant"));
  await f.bot.drain();
  assert.equal(f.requests.at(-1).threadId, "retained");
  assert.equal(f.sent.at(-1)!.text, "continued");
});

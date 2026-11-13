import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileConfigSource } from "../src/config.ts";
import { SqliteStore } from "../src/store.ts";
import { AttachmentError, ImageGenerationError } from "../src/contracts.ts";
import { createBot } from "../src/bot.ts";
import type {
  AttachmentReader,
  ModelEngine,
  TelegramTransport,
  OutgoingPart,
  TelegramUpdate,
} from "../src/contracts.ts";

const generatedPng = readFileSync(new URL("./fixtures/attachments/tiny.png", import.meta.url));

function fixture(t: any, attachments?: AttachmentReader) {
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
  let bot = createBot({ config, store, engine, telegram, attachments });
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
      bot = createBot({ config, store, engine, telegram, attachments });
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

test("an approved user receives a safe image generation limit error and can explicitly retry", async (t) => {
  const f = fixture(t);
  await f.bot.handleUpdate(f.update(2, "previous request"));
  await f.bot.drain();
  const run = f.engine.run;
  const message = "Лимит генерации изображений исчерпан. Повторите запрос позже.";
  f.engine.run = async (request) => {
    f.requests.push(request);
    await request.onThread("failed-image-thread");
    throw new ImageGenerationError(message);
  };
  await f.bot.handleUpdate(f.update(2, "Нарисуй кота-космонавта"));
  await f.bot.drain();
  assert.equal(f.sent.at(-1)!.text, message);
  f.engine.run = run;
  await f.bot.handleUpdate(f.update(2, "Попробуем ещё раз"));
  await f.bot.drain();
  assert.equal(f.sent.at(-1)!.text, "answer Попробуем ещё раз");
  assert.equal(f.requests.at(-1).threadId, undefined);
  assert.deepEqual(f.requests.at(-1).history, [
    { role: "user", text: "previous request" },
    { role: "assistant", text: "answer previous request" },
  ]);
});

test("an ordinary approved user receives generated images in order in their existing dialogue", async (t) => {
  const f = fixture(t);
  await f.bot.handleUpdate(f.update(2, "Начнём диалог"));
  await f.bot.drain();
  f.sent.length = 0;
  f.engine.run = async (request) => {
    f.requests.push(request);
    return {
      text: "Два варианта кота-космонавта.",
      threadId: "thread-2",
      images: ["first.png", "second.png"].map((name) => ({ name, mime: "image/png", bytes: generatedPng })),
    };
  };
  await f.bot.handleUpdate(f.update(99, "Нарисуй секретную картинку"));
  assert.equal(f.requests.length, 1);
  await f.bot.handleUpdate(f.update(2, "Нарисуй кота-космонавта в двух вариантах"));
  await f.bot.drain();
  assert.deepEqual(f.sent.map(({ chatId, part }) => ({ chatId, part })), [
    { chatId: 2, part: { kind: "rich", text: "Два варианта кота-космонавта." } },
    { chatId: 2, part: { kind: "image", name: "first.png", mime: "image/png", base64: generatedPng.toString("base64") } },
    { chatId: 2, part: { kind: "image", name: "second.png", mime: "image/png", base64: generatedPng.toString("base64") } },
  ]);
  assert.equal(f.requests.at(-1).threadId, "thread-2");
  assert.equal(f.requests.at(-1).model, "gpt-6.1-sol");
  assert.equal(f.requests.at(-1).effort, "medium");
});

test("a safe generation failure resumes error delivery after SQLite reopen without repeating generation", async (t) => {
  const f = fixture(t);
  const message = "Не удалось создать изображение. Повторите запрос позже.";
  const run = f.engine.run;
  f.engine.run = async (request) => {
    f.requests.push(request);
    throw new ImageGenerationError(message);
  };
  const send = f.telegram.sendPart;
  f.telegram.sendPart = async () => { throw new Error("network unavailable"); };
  await f.bot.handleUpdate(f.update(2, "Нарисуй постер"));
  await f.bot.drain();
  assert.equal(f.sent.length, 0);
  f.telegram.sendPart = send;
  await f.reopen();
  await new Promise((resolve) => setTimeout(resolve, 1300));
  await f.bot.drain();
  assert.deepEqual(f.sent.map(({ chatId, text }) => [chatId, text]), [[2, message]]);
  assert.equal(f.requests.length, 1);
  f.engine.run = run;
  await f.bot.handleUpdate(f.update(2, "Другое задание"));
  await f.bot.drain();
  assert.equal(f.sent.at(-1)!.text, "answer Другое задание");
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

test("a pending owner model catalog does not block another user's accepted update", async (t) => {
  const f = fixture(t);
  let release!: () => void;
  const catalog = new Promise<void>((resolve) => (release = resolve));
  let catalogs = 0;
  f.engine.listModels = async () => {
    catalogs++;
    await catalog;
    return [{ id: "gpt-6.1-sol", supportedEfforts: ["medium"] }];
  };
  const command = f.update(1, "/model");
  const following = f.update(2, "independent");
  const polling = (async () => {
    await f.bot.handleUpdate(command);
    await f.bot.handleUpdate(command); // A redelivered update cannot repeat control work.
    await f.bot.handleUpdate(following);
  })();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const deliveredWhileCatalogPending = f.sent.some(
    (message) => message.chatId === 2 && message.text === "answer independent",
  );
  release();
  await polling;
  await f.bot.drain();
  assert.equal(deliveredWhileCatalogPending, true);
  assert.equal(catalogs, 1);
});

test("reset invalidates a model callback whose catalog finishes after the reset", async (t) => {
  const f = fixture(t);
  await f.bot.handleUpdate(f.update(1, "/model"));
  await f.bot.drain();
  const data = f.sent.at(-1)!.options.reply_markup.inline_keyboard[0][0].callback_data;
  let release!: () => void;
  const catalog = new Promise<void>((resolve) => (release = resolve));
  f.engine.listModels = async () => {
    await catalog;
    return [{ id: "gpt-6.1-sol", supportedEfforts: ["medium", "high"] }];
  };
  await f.bot.handleUpdate({
    ...f.update(1, ""),
    callback_query: {
      id: "pending-choice", from: { id: 1 }, data,
      message: { message_id: 1, date: 0, chat: { id: 1, type: "private" } },
    },
  });
  await f.bot.handleUpdate(f.update(1, "/new"));
  await f.bot.handleUpdate(f.update(2, "independent"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const resetDelivered = f.sent.some((message) => /Диалог сброшен/.test(message.text));
  release();
  await f.bot.drain();
  assert.equal(resetDelivered, true);
  assert.ok(f.sent.some((message) => message.text === "answer independent"));
  assert.equal(f.sent.filter((message) => /Выберите уровень/.test(message.text)).length, 0);
});

test("a pending Telegram command response leaves polling free and drain waits for it", async (t) => {
  const f = fixture(t);
  let release!: () => void;
  const response = new Promise<void>((resolve) => (release = resolve));
  const send = f.telegram.sendText;
  f.telegram.sendText = async (...args) => {
    if (args[0] === 1) await response;
    return send(...args);
  };
  const polling = (async () => {
    await f.bot.handleUpdate(f.update(1, "/help"));
    await f.bot.handleUpdate(f.update(2, "independent"));
  })();
  let drained = false;
  const draining = f.bot.drain().then(() => { drained = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const delivered = f.sent.some((message) => message.text === "answer independent");
  const waitedForResponse = !drained;
  release();
  await polling;
  await draining;
  await f.bot.drain();
  assert.equal(delivered, true);
  assert.equal(waitedForResponse, true);
});

test("owner health diagnostics do not replace an active request or block other users", async (t) => {
  const f = fixture(t);
  let finish!: () => void, report!: () => void;
  const pendingRequest = new Promise<void>((resolve) => (finish = resolve));
  const pendingHealth = new Promise<void>((resolve) => (report = resolve));
  const run = f.engine.run;
  f.engine.run = async (request) => {
    if (request.userId === 1) await pendingRequest;
    return run(request);
  };
  f.engine.health = async () => { await pendingHealth; return { available: true }; };
  await f.bot.handleUpdate(f.update(1, "owner request"));
  const polling = (async () => {
    await f.bot.handleUpdate(f.update(1, "/status"));
    await f.bot.handleUpdate(f.update(1, "must remain busy"));
    await f.bot.handleUpdate(f.update(2, "independent"));
  })();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const delivered = f.sent.some((message) => message.text === "answer independent");
  report();
  await polling;
  await f.bot.handleUpdate(f.update(1, "still busy after status"));
  finish();
  await f.bot.drain();
  assert.equal(delivered, true);
  assert.deepEqual(f.requests.filter((request) => request.userId === 1).map((request) => request.text), ["owner request"]);
  assert.ok(f.sent.some((message) => /Запрос обрабатывается/.test(message.text)));
});

test("shutdown aborts a pending Telegram command response and waits for it to settle", async (t) => {
  const f = fixture(t);
  let signal: AbortSignal | undefined;
  let settled = false;
  f.telegram.sendText = async (_id, _text, options) => {
    signal = options?.signal;
    await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => {
      settled = true;
      reject(new Error("stopped"));
    }, { once: true }));
    return 1;
  };
  await f.bot.handleUpdate(f.update(1, "/help"));
  await f.bot.shutdown();
  assert.equal(signal?.aborted, true);
  assert.equal(settled, true);
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

test("saved generated images resume in order after SQLite reopen without resending acknowledged images or calling the model", async (t) => {
  const f = fixture(t);
  f.engine.run = async (request) => {
    f.requests.push(request);
    return {
      text: "Три иллюстрации.",
      threadId: "illustration-thread",
      images: ["first.png", "second.png", "third.png"].map((name) => ({ name, mime: "image/png", bytes: generatedPng })),
    };
  };
  const send = f.telegram.sendPart;
  f.telegram.sendPart = async (...args) => {
    if (args[1].kind === "image" && args[1].name === "second.png") throw new Error("network unavailable");
    return send(...args);
  };
  await f.bot.handleUpdate(f.update(2, "Нарисуй три иллюстрации"));
  await f.bot.drain();
  assert.deepEqual(f.sent.map(({ text }) => text), ["Три иллюстрации.", "first.png"]);
  f.telegram.sendPart = send;
  await f.reopen();
  await new Promise((resolve) => setTimeout(resolve, 1300));
  await f.bot.drain();
  assert.deepEqual(f.sent.map(({ chatId, text }) => [chatId, text]), [
    [2, "Три иллюстрации."], [2, "first.png"], [2, "second.png"], [2, "third.png"],
  ]);
  assert.ok(f.sent.filter(({ part }) => part?.kind === "image").every(({ part }) =>
    part?.kind === "image" && part.base64 === generatedPng.toString("base64") && part.mime === "image/png",
  ));
  assert.equal(f.requests.length, 1);
});

test("owner picker binds model identity when catalog order changes and survives reset/restart", async (t) => {
  const f = fixture(t);
  const a = { id: "model-a", supportedEfforts: ["medium", "high"] },
    b = { id: "model-b", supportedEfforts: ["low"] };
  f.engine.listModels = async () => [a, b];
  await f.bot.handleUpdate(f.update(1, "/model"));
  await f.bot.drain();
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
  await f.bot.drain();
  assert.match(f.sent.at(-1)!.text, /model-a/);
  const effortData =
    f.sent.at(-1)!.options.reply_markup.inline_keyboard[1][0].callback_data;
  await f.bot.handleUpdate(callback(effortData));
  await f.bot.drain();
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
  await f.bot.drain();
  assert.match(f.sent.at(-1)!.text, /приостановлена/);
  assert.ok(!f.sent.at(-1)!.text.includes("do-not-expose"));
  await f.bot.handleUpdate(f.update(2, "not accepted"));
  writeFileSync(f.env, f.configText());
  await new Promise((r) => setTimeout(r, 80));
  await f.bot.drain();
  assert.equal(f.sent.at(-1)!.text, "saved during pause");
  assert.equal(f.requests.length, 1);
});

test("revocation during image generation permanently cancels all output while granting access preserves committed dialogue", async (t) => {
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
  finish({ text: "cancelled answer", threadId: "retained", images: [{ name: "private.png", mime: "image/png", bytes: generatedPng }] });
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

function fileUpdate(update: TelegramUpdate, name = "notes.txt", caption?: string, album?: string): TelegramUpdate {
  delete update.message!.text;
  update.message!.document = { file_id: name, file_name: name, mime_type: "text/plain", file_size: 4 };
  if (caption !== undefined) update.message!.caption = caption;
  if (album) update.message!.media_group_id = album;
  return update;
}

test("files wait for a task and pending materials survive restart without a model call", async (t) => {
  const f = fixture(t, { prepare: async (files) => files.map((file) => ({ name: file.name, text: new TextDecoder().decode(file.bytes), images: [] })) });
  const downloads: string[] = [];
  f.telegram.downloadFile = async (id) => { downloads.push(id); return new TextEncoder().encode("note"); };
  const first = fileUpdate(f.update(2, ""));
  await f.bot.handleUpdate(first);
  await f.bot.handleUpdate(first);
  await f.bot.drain();
  assert.equal(f.requests.length, 0);
  assert.deepEqual(downloads, []);
  assert.match(f.sent.at(-1)!.text, /задани/i);
  await f.reopen();
  await f.bot.handleUpdate(f.update(2, "Explain my notes"));
  await f.bot.drain();
  assert.deepEqual(downloads, ["notes.txt"]);
  assert.deepEqual(f.requests[0].attachments, [{ name: "notes.txt", text: "note", images: [] }]);
  assert.equal(f.requests[0].text, "Explain my notes");
});

test("an album waits for its last member and all captions describe the entire ordered group", async (t) => {
  const f = fixture(t, { prepare: async (files) => files.map((file) => ({ name: file.name, text: "material", images: [] })) });
  const downloads: string[] = [];
  f.telegram.downloadFile = async (id) => { downloads.push(id); return new Uint8Array(4); };
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "first.txt", "Compare these", "album-a"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "second.txt", undefined, "album-a"));
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "third.txt", "and find differences", "album-a"));
  assert.equal(f.requests.length, 0);
  assert.deepEqual(downloads, []);
  await f.bot.drain();
  assert.deepEqual(downloads, ["first.txt", "second.txt", "third.txt"]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].text, "Compare these\n\nand find differences");
  assert.deepEqual(f.requests[0].attachments.map((a: any) => a.name), ["first.txt", "second.txt", "third.txt"]);
});

test("attachment limits reject a batch before downloads and leave accepted files available for the task", async (t) => {
  const f = fixture(t, { prepare: async (files) => files.map((file) => ({ name: file.name, text: "ok", images: [] })) });
  const downloads: string[] = [];
  f.telegram.downloadFile = async (id) => { downloads.push(id); return new Uint8Array(4); };
  for (let i = 0; i < 10; i++) await f.bot.handleUpdate(fileUpdate(f.update(2, ""), `${i}.txt`));
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "overflow.txt"));
  await f.bot.drain();
  assert.ok(f.sent.some((m) => /10|раздел/i.test(m.text)));
  await f.bot.handleUpdate(f.update(2, "Use all accepted files"));
  await f.bot.drain();
  assert.equal(downloads.length, 10);
  assert.ok(!downloads.includes("overflow.txt"));
  assert.equal(f.requests[0].attachments.length, 10);
});

test("actual oversized downloads never start partial analysis and pending materials can be retried", async (t) => {
  const f = fixture(t, { prepare: async (files) => files.map((file) => ({ name: file.name, text: "ok", images: [] })) });
  f.telegram.downloadFile = async () => new Uint8Array(20_000_001);
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "large.txt", "Explain"));
  await f.bot.drain();
  assert.equal(f.requests.length, 0);
  assert.match(f.sent.at(-1)!.text, /раздел|20|размер/i);
  f.telegram.downloadFile = async () => new Uint8Array(4);
  await f.bot.handleUpdate(f.update(2, "Try again"));
  await f.bot.drain();
  assert.equal(f.requests[0].attachments[0].name, "large.txt");
});

test("prepared text over the batch limit is rejected without silently truncating the document", async (t) => {
  const f = fixture(t, { prepare: async (files) => files.map((file) => ({ name: file.name, text: "x".repeat(500_001), images: [] })) });
  f.telegram.downloadFile = async () => new Uint8Array(4);
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "long.txt", "Summarize"));
  await f.bot.drain();
  assert.equal(f.requests.length, 0);
  assert.match(f.sent.at(-1)!.text, /раздел|\/new/i);
});

test("prepared images respect batch size and count limits before model analysis", async (t) => {
  let images = [{ name: "scan.png", mime: "image/png" as const, base64: Buffer.alloc(6_000_001).toString("base64") }];
  const f = fixture(t, { prepare: async () => [{ name: "scan.pdf", text: "", images }] });
  f.telegram.downloadFile = async () => new Uint8Array(4);
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "scan.pdf", "Read"));
  await f.bot.drain();
  assert.equal(f.requests.length, 0);
  images = Array.from({ length: 21 }, (_, i) => ({ name: `page-${i}.png`, mime: "image/png" as const, base64: "AA==" }));
  await f.bot.handleUpdate(f.update(2, "Retry"));
  await f.bot.drain();
  assert.equal(f.requests.length, 0);
  assert.match(f.sent.at(-1)!.text, /раздел|\/new/i);
});

test("cumulative serialized material context is bounded and /new makes room for a fresh task", async (t) => {
  const f = fixture(t, { prepare: async (files) => files.map((file) => ({ name: file.name, text: "", images: [{ name: "scan.png", mime: "image/png", base64: Buffer.alloc(3_000_000).toString("base64") }] })) });
  f.telegram.downloadFile = async () => new Uint8Array(4);
  for (let i = 0; i < 3; i++) {
    await f.bot.handleUpdate(fileUpdate(f.update(2, ""), `${i}.pdf`, "Read"));
    await f.bot.drain();
  }
  assert.equal(f.requests.length, 2);
  assert.match(f.sent.at(-1)!.text, /\/new/);
  await f.bot.handleUpdate(f.update(2, "/new"));
  await f.bot.drain();
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "new.pdf", "Read"));
  await f.bot.drain();
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.requests[2].history, []);
});

test("revocation during download cancels the batch before the next file and pending refs remain isolated", async (t) => {
  const f = fixture(t, { prepare: async (files) => files.map((file) => ({ name: file.name, text: "ok", images: [] })) });
  const downloads: string[] = [];
  let signal: AbortSignal | undefined;
  let finishDownload!: (bytes: Uint8Array) => void;
  f.telegram.downloadFile = async (id, _max, abortSignal) => {
    downloads.push(id);
    signal = abortSignal;
    if (downloads.length === 1) return new Promise<Uint8Array>((resolve) => { finishDownload = resolve; });
    return new Uint8Array(4);
  };
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "first.txt"));
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "second.txt"));
  await f.bot.handleUpdate(f.update(2, "Explain both"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  writeFileSync(f.env, f.configText(""));
  await new Promise((resolve) => setTimeout(resolve, 60));
  const cancelled = signal?.aborted;
  finishDownload(new Uint8Array(4));
  assert.equal(cancelled, true);
  await f.bot.drain();
  assert.deepEqual(downloads, ["first.txt"]);
  assert.equal(f.requests.length, 0);
  writeFileSync(f.env, f.configText());
  await new Promise((resolve) => setTimeout(resolve, 60));
  f.telegram.downloadFile = async (id) => { downloads.push(id); return new Uint8Array(4); };
  await f.bot.handleUpdate(f.update(1, "Owner continues independently"));
  await f.bot.drain();
  assert.equal(f.requests[0].attachments, undefined);
  await f.bot.handleUpdate(f.update(2, "Repeat the task"));
  await f.bot.drain();
  assert.deepEqual(f.requests[1].attachments.map((a: any) => a.name), ["first.txt", "second.txt"]);
});

test("restart before album dispatch keeps files but requires the text task again", async (t) => {
  const f = fixture(t, { prepare: async (files) => files.map((file) => ({ name: file.name, text: "ok", images: [] })) });
  let downloads = 0;
  f.telegram.downloadFile = async () => { downloads++; return new Uint8Array(4); };
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "first.txt", "Old task", "group"));
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "second.txt", undefined, "group"));
  await f.reopen();
  assert.equal(downloads, 0);
  assert.equal(f.requests.length, 0);
  assert.match(f.sent.at(-1)!.text, /повторите текст задания/i);
  await f.bot.handleUpdate(f.update(2, "Repeated task"));
  await f.bot.drain();
  assert.equal(f.requests[0].text, "Repeated task");
  assert.deepEqual(f.requests[0].attachments.map((a: any) => a.name), ["first.txt", "second.txt"]);
});

test("committed images and text survive restart and a failed follow-up rebuilds the same material context", async (t) => {
  const prepared = [{ name: "scan.pdf", text: "The total is 42", images: [{ name: "page.png", mime: "image/png" as const, base64: "aW1hZ2U=" }] }];
  const f = fixture(t, { prepare: async () => prepared });
  f.telegram.downloadFile = async () => new Uint8Array(4);
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "scan.pdf", "Read"));
  await f.bot.drain();
  await f.reopen();
  const original = f.engine.run;
  f.engine.run = async () => { throw new Error("provider failed"); };
  await f.bot.handleUpdate(f.update(2, "Failed clarification"));
  await f.bot.drain();
  await f.reopen();
  f.engine.run = original;
  await f.bot.handleUpdate(f.update(2, "What is the total?"));
  await f.bot.drain();
  assert.equal(f.requests.at(-1).threadId, undefined);
  assert.deepEqual(f.requests.at(-1).history, [
    { role: "user", text: "Read", attachments: prepared },
    { role: "assistant", text: "answer Read" },
  ]);
});

test("/model leaves pending files for the task and /new removes both pending and historical materials", async (t) => {
  const f = fixture(t, { prepare: async (files) => files.map((file) => ({ name: file.name, text: "ok", images: [] })) });
  const downloads: string[] = [];
  f.telegram.downloadFile = async (id) => { downloads.push(id); return new Uint8Array(4); };
  await f.bot.handleUpdate(fileUpdate(f.update(1, ""), "kept.txt"));
  await f.bot.handleUpdate(f.update(1, "/model"));
  await f.bot.drain();
  await f.bot.handleUpdate(f.update(1, "Read"));
  await f.bot.drain();
  assert.equal(f.requests[0].attachments[0].name, "kept.txt");
  await f.bot.handleUpdate(fileUpdate(f.update(1, ""), "discarded.txt"));
  await f.bot.handleUpdate(f.update(1, "/new"));
  await f.bot.drain();
  await f.reopen();
  await f.bot.handleUpdate(f.update(1, "Fresh"));
  await f.bot.drain();
  assert.deepEqual(downloads, ["kept.txt"]);
  assert.equal(f.requests.at(-1).attachments, undefined);
  assert.deepEqual(f.requests.at(-1).history, []);
});

test("/help explains how several photos and files receive a task", async (t) => {
  const f = fixture(t);
  await f.bot.handleUpdate(f.update(2, "/help"));
  await f.bot.drain();
  assert.match(f.sent.at(-1)!.text, /фото|файл/i);
  assert.match(f.sent.at(-1)!.text, /подпис/i);
  assert.match(f.sent.at(-1)!.text, /задани/i);
});

test("offline photos and documents receive a repeat notice without downloads or analysis", async (t) => {
  const f = fixture(t);
  let downloads = 0;
  f.telegram.downloadFile = async () => { downloads++; return new Uint8Array(4); };
  const outsider = fileUpdate(f.update(99, ""));
  const photo = f.update(2, "");
  delete photo.message!.text;
  photo.message!.photo = [{ file_id: "photo", width: 800, height: 600 }];
  await f.bot.discardOfflineUpdates([outsider, photo, fileUpdate(f.update(1, ""))]);
  assert.equal(downloads, 0);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.sent.map((m) => m.chatId).sort(), [1, 2]);
  assert.ok(f.sent.every((m) => /повторите/i.test(m.text)));
});

test("a rejected album member cancels automatic analysis of the accepted subset", async (t) => {
  const f = fixture(t, { prepare: async (files) => files.map((file) => ({ name: file.name, text: "ok", images: [] })) });
  const downloads: string[] = [];
  f.telegram.downloadFile = async (id) => { downloads.push(id); return new Uint8Array(4); };
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "good.txt", "Read everything", "album-limit"));
  const oversized = fileUpdate(f.update(2, ""), "large.txt", undefined, "album-limit");
  oversized.message!.document!.file_size = 20_000_001;
  await f.bot.handleUpdate(oversized);
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "later.txt", "A second caption", "album-limit"));
  await f.bot.drain();
  assert.equal(f.requests.length, 0);
  assert.deepEqual(downloads, []);
  await f.bot.handleUpdate(f.update(2, "Read the two accepted files"));
  await f.bot.drain();
  assert.deepEqual(downloads, ["good.txt", "later.txt"]);
  assert.equal(f.requests[0].text, "Read the two accepted files");
});

test("invalid configuration pauses an album before download and valid reload resumes its accepted task", async (t) => {
  const f = fixture(t, { prepare: async (files) => files.map((file) => ({ name: file.name, text: "ok", images: [] })) });
  const downloads: string[] = [];
  f.telegram.downloadFile = async (id) => { downloads.push(id); return new Uint8Array(4); };
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "album.txt", "Read", "paused"));
  writeFileSync(f.env, "OWNER_TELEGRAM_ID=1\n");
  await new Promise((resolve) => setTimeout(resolve, 1550));
  assert.deepEqual(downloads, []);
  writeFileSync(f.env, f.configText());
  await new Promise((resolve) => setTimeout(resolve, 80));
  await f.bot.drain();
  assert.deepEqual(downloads, ["album.txt"]);
  assert.equal(f.requests[0].text, "Read");
});

test("unauthorized, group, and mismatched senders are rejected before inspecting attachment refs", async (t) => {
  const f = fixture(t);
  for (const [user, type, sender] of [[99, "private", 99], [2, "group", 2], [2, "private", 99]] as const) {
    const update = f.update(user, "");
    update.message!.chat.type = type;
    update.message!.from!.id = sender;
    Object.defineProperty(update.message, "document", { get() { throw new Error("attachment inspected before authorization"); } });
    await f.bot.handleUpdate(update);
  }
  await f.bot.drain();
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.requests, []);
});

test("the largest photo is analyzed as an image and a caption starting with slash is a task", async (t) => {
  const f = fixture(t, { prepare: async (files) => files.map((file) => ({ name: file.name, text: "", images: [{ name: file.name, mime: "image/jpeg", base64: "aW1hZ2U=" }] })) });
  const downloads: string[] = [];
  f.telegram.downloadFile = async (id) => { downloads.push(id); return new Uint8Array(4); };
  const photo = f.update(2, "");
  delete photo.message!.text;
  photo.message!.photo = [{ file_id: "small", width: 100, height: 100 }, { file_id: "large", width: 1200, height: 1200 }];
  photo.message!.caption = "/new is printed in the screenshot; explain it";
  await f.bot.handleUpdate(photo);
  await f.bot.drain();
  assert.deepEqual(downloads, ["large"]);
  assert.equal(f.requests[0].text, "/new is printed in the screenshot; explain it");
  assert.equal(f.requests[0].attachments[0].images[0].base64, "aW1hZ2U=");
});

test("a busy user's new files are rejected without download or inclusion in a later task", async (t) => {
  const f = fixture(t, { prepare: async (files) => files.map((file) => ({ name: file.name, text: "ok", images: [] })) });
  const downloads: string[] = [];
  f.telegram.downloadFile = async (id) => { downloads.push(id); return new Uint8Array(4); };
  let finish!: (value: any) => void;
  f.engine.run = async (request) => { f.requests.push(request); return new Promise((resolve) => { finish = resolve; }); };
  await f.bot.handleUpdate(f.update(2, "Running task"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "rejected.txt", "Another task"));
  finish({ text: "done", threadId: "busy-thread", images: [] });
  await f.bot.drain();
  f.engine.run = async (request) => { f.requests.push(request); return { text: "ok", threadId: "busy-thread", images: [] }; };
  await f.bot.handleUpdate(f.update(2, "Next task"));
  await f.bot.drain();
  assert.deepEqual(downloads, []);
  assert.equal(f.requests.at(-1).attachments, undefined);
  assert.ok(f.sent.some((m) => /Дождитесь/i.test(m.text)));
});

test("the request deadline also bounds an unresponsive attachment download", async (t) => {
  const f = fixture(t, { prepare: async () => [] });
  writeFileSync(f.env, f.configText("2", "REQUEST_TIMEOUT_MS=20"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  let signal: AbortSignal | undefined;
  f.telegram.downloadFile = async (_id, _max, abortSignal) => { signal = abortSignal; return new Promise(() => {}); };
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "slow.txt", "Read"));
  await f.bot.drain();
  assert.equal(signal?.aborted, true);
  assert.equal(f.requests.length, 0);
  assert.match(f.sent.at(-1)!.text, /Время обработки/i);
});

test("a reader that omits a failed file cannot start analysis of a partial batch", async (t) => {
  const f = fixture(t, { prepare: async (files) => [{ name: files[0]!.name, text: "only first file", images: [] }] });
  f.telegram.downloadFile = async () => new Uint8Array(4);
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "first.txt"));
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "second.txt"));
  await f.bot.handleUpdate(f.update(2, "Compare both"));
  await f.bot.drain();
  assert.equal(f.requests.length, 0);
  assert.match(f.sent.at(-1)!.text, /все|материал|повтор/i);
});

test("safe reader and model attachment errors retain the whole batch for an explicit retry", async (t) => {
  let readerFails = true;
  const f = fixture(t, { prepare: async (files) => {
    if (readerFails) throw new AttachmentError("Документ повреждён. Исправьте материалы и повторите задание.");
    return files.map((file) => ({ name: file.name, text: "ok", images: [] }));
  } });
  f.telegram.downloadFile = async () => new Uint8Array(4);
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "notes.txt", "Read"));
  await f.bot.drain();
  assert.equal(f.requests.length, 0);
  assert.match(f.sent.at(-1)!.text, /Документ повреждён/);
  readerFails = false;
  const original = f.engine.run;
  f.engine.run = async () => { throw new AttachmentError("Выбранная модель не принимает изображения. Выберите другую модель."); };
  await f.bot.handleUpdate(f.update(2, "Retry"));
  await f.bot.drain();
  assert.match(f.sent.at(-1)!.text, /не принимает изображения/);
  f.engine.run = original;
  await f.bot.handleUpdate(f.update(2, "Retry once more"));
  await f.bot.drain();
  assert.deepEqual(f.requests[0].history, []);
  assert.equal(f.requests[0].attachments[0].name, "notes.txt");
});

test("a captioned album rejected by the global capacity limit never becomes an implicit request queue", async (t) => {
  const f = fixture(t, { prepare: async (files) => files.map((file) => ({ name: file.name, text: "ok", images: [] })) });
  writeFileSync(f.env, f.configText("2", "MAX_CONCURRENT_REQUESTS=1"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  f.telegram.downloadFile = async () => new Uint8Array(4);
  const original = f.engine.run;
  let finish!: (value: any) => void;
  f.engine.run = async (request) => {
    f.requests.push(request);
    return new Promise((resolve) => { finish = resolve; });
  };
  await f.bot.handleUpdate(f.update(1, "Occupy the only slot"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "waiting.txt", "Caption task", "full"));
  await new Promise((resolve) => setTimeout(resolve, 1550));
  finish({ text: "done", threadId: "owner-thread", images: [] });
  await f.bot.drain();
  f.engine.run = original;
  await new Promise((resolve) => setTimeout(resolve, 300));
  await f.bot.drain();
  assert.equal(f.requests.length, 1);
  assert.ok(f.sent.some((m) => m.chatId === 2 && /заняты|Повторите/i.test(m.text)));
  await f.bot.handleUpdate(f.update(2, "Explicit repeated task"));
  await f.bot.drain();
  assert.equal(f.requests[1].text, "Explicit repeated task");
  assert.equal(f.requests[1].attachments[0].name, "waiting.txt");
});

test('completed response files survive timeout, restart and are available only in their dialogue', async(t)=>{
 const f=fixture(t);
 const documents:any[]=[];
 f.telegram.sendFile=async(chatId,file)=>{documents.push({chatId,...file});return 100;};
 f.engine.run=async(request)=>{
  await request.onThread('thread-'+request.userId);
  await request.onFile!({name:'table.csv',mime:'text/csv',bytes:Buffer.from('a,b\n1,2')});
  throw new Error('provider failed after export');
 };
 await f.bot.handleUpdate(f.update(2,'create CSV'));
 await f.bot.drain();
 assert.equal(documents.length,1);
 assert.equal(documents[0].name,'table.csv');
 await f.reopen();
 f.engine.run=async(request)=>{
  assert.equal(request.files?.length,request.userId===2?1:0);
  if(request.userId===2)assert.equal(Buffer.from(request.readFile!(request.files![0]!.id)).toString(),'a,b\n1,2');
  return {text:'done',threadId:'thread-'+request.userId,images:[]};
 };
 await f.bot.handleUpdate(f.update(2,'edit previous'));
 await f.bot.drain();
 await f.bot.handleUpdate(f.update(1,'other dialogue'));
 await f.bot.drain();
 await f.bot.handleUpdate(f.update(2,'/new'));
 await f.bot.drain();
 assert.equal(f.store.listFiles(2).length,0);
});

test('an exported file in an interrupted request is delivered on recovery without rerunning Codex',async(t)=>{
 const f=fixture(t);const sent:string[]=[];
 const file=f.store.saveFile(2,{name:'ready.csv',mime:'text/csv',bytes:Buffer.from('ready')});
 f.store.put({userId:2,history:[],request:{id:'interrupted',text:'task',started:Date.now(),fileIds:[file.id]}});
 f.telegram.sendFile=async(chatId,file)=>{assert.equal(chatId,2);sent.push(file.name);return 1;};
 await f.reopen();
 assert.deepEqual(sent,['ready.csv']);assert.equal(f.requests.length,0);
});

test('a timed-out turn delivers the completed file and enforces the ten-file limit',async(t)=>{
 const f=fixture(t);writeFileSync(f.env,f.configText('2','REQUEST_TIMEOUT_MS=250'));
 await new Promise(r=>setTimeout(r,60));
 const sent:string[]=[];
 f.telegram.sendFile=async(chatId,file)=>{sent.push(file.name);return sent.length;};
 f.engine.run=async(request)=>{
  for(let n=0;n<10;n++)await request.onFile!({name:n+'.csv',mime:'text/csv',bytes:Buffer.from('ready')});
  await assert.rejects(request.onFile!({name:'11.csv',mime:'text/csv',bytes:Buffer.from('overflow')}),/10 файлов/);
  return new Promise(()=>{});
 };
 await f.bot.handleUpdate(f.update(2,'create files'));
 await f.bot.drain();
 assert.equal(sent.length,10);assert.ok(f.sent.some(message=>message.text.includes('Время обработки')));
});

test('quota rejecting a later generated image still delivers earlier persisted images and assistant explanation',async(t)=>{
 const f=fixture(t);writeFileSync(f.env,f.configText('2','DIALOGUE_FILE_BYTES='+generatedPng.length));
 await new Promise(r=>setTimeout(r,60));
 f.engine.run=async()=>({text:'Chart and illustration',threadId:'thread-2',images:[{name:'one.png',mime:'image/png',bytes:generatedPng},{name:'two.png',mime:'image/png',bytes:generatedPng}]});
 await f.bot.handleUpdate(f.update(2,'two images'));await f.bot.drain();
 const images=f.sent.flatMap(message=>message.part?.kind==='image'?[message.part]:[]);
 assert.deepEqual(images.map(image=>image.name),['one.png']);
 assert.ok(f.sent.some(message=>message.text.includes('Chart and illustration')));
 assert.ok(f.sent.some(message=>message.text.includes('заполнено')));
});

test('saved original documents are reused after a failed request and restart without another Telegram download',async(t)=>{
 const f=fixture(t,{prepare:async files=>files.map(file=>({name:file.name,text:'Source',images:[]}))});
 let downloads=0;
 f.telegram.downloadFile=async()=>{downloads++;return Buffer.from('source');};
 f.engine.run=async()=>{throw new Error('interrupted');};
 const update=f.update(2,'');delete update.message!.text;
 update.message!.document={file_id:'source-id',file_name:'source.txt',mime_type:'text/plain'};
 update.message!.caption='edit';
 await f.bot.handleUpdate(update);await f.bot.drain();await f.reopen();
 f.engine.run=async request=>({text:'done',threadId:'thread-2',images:[]});
 await f.bot.handleUpdate(f.update(2,'retry edit'));await f.bot.drain();
 assert.equal(downloads,1);assert.equal(f.store.listFiles(2).length,1);
});

test('a permanent error for one document reports it and still delivers the remaining ready files',async(t)=>{
 const f=fixture(t);const sent:string[]=[];
 f.engine.run=async request=>{
  for(const name of ['one.csv','two.csv'])await request.onFile!({name,mime:'text/csv',bytes:Buffer.from('ready')});
  return {text:'Files ready',threadId:'thread-2',images:[]};
 };
 f.telegram.sendFile=async(chatId,file)=>{
  if(file.name==='one.csv')throw Object.assign(new Error('Telegram rejected document'),{permanent:true,code:400});
  sent.push(file.name);return 1;
 };
 await f.bot.handleUpdate(f.update(2,'create files'));await f.bot.drain();
 assert.deepEqual(sent,['two.csv']);assert.ok(f.sent.some(message=>message.text.includes('Не удалось доставить один')));
});

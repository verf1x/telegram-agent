import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileConfigSource } from "../src/config.ts";
import { openLocalStore, SqliteStore } from "../src/store.ts";
import { AttachmentError, ImageGenerationError, ModelContextError, ModelSelectionError } from "../src/contracts.ts";
import { createBot } from "../src/bot.ts";
import { SandboxedAttachmentReader } from "../src/attachments/reader.ts";
import { TelegramError } from "../src/telegram/transport.ts";
import type {
  AttachmentReader,
  ConfigSnapshot,
  ModelEngine,
  TelegramTransport,
  OutgoingPart,
  TelegramUpdate,
} from "../src/contracts.ts";

const generatedPng = readFileSync(new URL("./fixtures/attachments/tiny.png", import.meta.url));

test("file configuration applies access changes only when a process starts", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "verfix-config-"));
  const env = join(dir, ".env");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const initial = "TELEGRAM_BOT_TOKEN=123456:TEST\nOWNER_TELEGRAM_ID=1\nCONFIG_RELOAD_INTERVAL_MS=5\n";
  writeFileSync(env, initial + "ALLOWED_USER_IDS=2\n");
  const running = new FileConfigSource(env);
  writeFileSync(env, initial + "ALLOWED_USER_IDS=3\n");
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(running.snapshot().config.allowedUserIds, [2]);
  const restarted = new FileConfigSource(env);
  assert.deepEqual(restarted.snapshot().config.allowedUserIds, [3]);
});

function fixture(t: any, attachments?: AttachmentReader, openStore = (path: string) => new SqliteStore(path)) {
  const dir = mkdtempSync(join(tmpdir(), "verfix-bot-"));
  const env = join(dir, ".env");
  const configText = (allowed = "2", extra = "") =>
    `TELEGRAM_BOT_TOKEN=123456:TEST\nOWNER_TELEGRAM_ID=1\nALLOWED_USER_IDS=${allowed}\nDATABASE_PATH=${join(dir, "db.sqlite")}\nRUNTIME_DIR=${dir}\n${extra}`;
  writeFileSync(env, configText());
  let snapshot: ConfigSnapshot = new FileConfigSource(env).snapshot();
  const listeners = new Set<(value: ConfigSnapshot) => void>();
  const config = {
    snapshot: () => snapshot,
    watch: (listener: (value: ConfigSnapshot) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  const writeConfig = (contents: string) => {
    writeFileSync(env, contents);
    const lastValid = snapshot.valid ? snapshot.config : snapshot.lastValid;
    try { snapshot = new FileConfigSource(env).snapshot(); }
    catch (error) { snapshot = {valid: false, error: (error as Error).message, lastValid}; }
    for (const listener of listeners) listener(snapshot);
  };
  let store = openStore(join(dir, "db.sqlite"));
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
    sendPart: async (chatId, part, options) => {
      sent.push({
        chatId,
        text: part.kind === "image" ? part.name : part.text,
        part,
        options,
      });
      return sent.length;
    },
    typing: async () => {},
    createTopic: async () => 77,
    renameTopic: async () => {},
    deleteTopic: async () => {},
    answerCallback: async () => {},
  };
  const engine: ModelEngine = {
    summarize: async ({summary, text}) => summary ?? text.slice(0, 1000),
    generateTopicTitle: async () => undefined,
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
      { id: "gpt-6.2-sol", supportedEfforts: ["medium", "high"] },
    ],
    deleteThread: async () => {},
    bindLegacyThread: async () => {},
    health: async () => ({ available: true }),
    close: async () => {},
  };
  let bot = createBot({ config, store, engine, telegram, attachments });
  t.after(async () => {
    await bot.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let id = 0;
  const update = (userId: number, text: string): TelegramUpdate => ({
    update_id: ++id,
    message: {
      message_thread_id: 10,
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: userId, type: "private" },
      from: { id: userId },
      text,
    },
  });
  return {
    dir,
    configText,
    writeConfig,
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
      store = openStore(join(dir, "db.sqlite"));
      bot = createBot({ config, store, engine, telegram, attachments });
      await bot.recover();
    },
  };
}

test("one live draft grows in its topic before the formatted answer is delivered", async (t) => {
  const f = fixture(t);
  const drafts: Array<{id: number; topic: number; text: string; thinking: boolean}> = [];
  const streamed = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  t.after(() => finish.resolve());
  f.telegram.sendDraft = async (_chat, id, text, topic, options) => {
    drafts.push({id, topic, text, thinking: options?.thinking === true});
    if (text === "Вычислим сумму") streamed.resolve();
  };
  f.engine.run = async (r) => {
    r.onProgress?.({kind: "text", delta: "Вычислим "});
    r.onProgress?.({kind: "text", delta: "сумму"});
    await finish.promise;
    return {text: "Вычислим сумму $1+2$", threadId: "thread-2", images: []};
  };
  await f.bot.handleUpdate(f.update(2, "show how"));
  try {
    await Promise.race([streamed.promise, new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("live text was never shown")), 2500).unref();
    })]);
    assert.equal(f.sent.length, 0);
    assert.deepEqual(drafts.map(draft => [draft.id, draft.topic, draft.text, draft.thinking]), [
      [drafts[0]!.id, 10, "Готовлю ответ", true],
      [drafts[0]!.id, 10, "Вычислим сумму", false],
    ]);
  } finally { finish.resolve(); }
  await f.bot.drain();
  assert.deepEqual(f.sent.map(message => [message.options.message_thread_id, message.text]), [[10, "Вычислим сумму $1+2$"]]);
});

test("topic notices restore the same Stop control when Telegram clears the visible draft", {timeout: 5000}, async (t) => {
  const f = fixture(t);
  const visible = Promise.withResolvers<void>();
  const restored = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  t.after(() => finish.resolve());
  const drafts: number[] = [];
  f.telegram.sendDraft = async (_chat, id) => {
    drafts.push(id);
    if (drafts.length === 1) visible.resolve();
    else restored.resolve();
  };
  f.engine.run = async () => {
    await finish.promise;
    return {text: "Done", threadId: "thread-2", images: []};
  };
  await f.bot.handleUpdate(f.update(2, "long task"));
  await visible.promise;
  await f.bot.handleUpdate(f.update(2, "another task"));
  await restored.promise;
  assert.deepEqual(drafts, [drafts[0], drafts[0]]);
  assert.match(f.sent[0]!.text, /ещё обрабатывается/);
  finish.resolve();
  await f.bot.drain();
});

test("a long live draft keeps showing new text within Telegram's limit", {timeout: 5000}, async (t) => {
  const f = fixture(t);
  const visible = Promise.withResolvers<string>();
  const finish = Promise.withResolvers<void>();
  t.after(() => finish.resolve());
  const long = "Opening\n" + "😀".repeat(2500) + "\nLatest line";
  f.telegram.sendDraft = async (_chat, _id, text) => {
    if (text.endsWith("Latest line")) visible.resolve(text);
  };
  f.engine.run = async request => {
    request.onProgress?.({kind: "text", delta: long});
    await finish.promise;
    return {text: long, threadId: "thread-2", images: []};
  };
  await f.bot.handleUpdate(f.update(2, "long answer"));
  const preview = await visible.promise;
  assert.ok(preview.length <= 4096);
  assert.ok(long.endsWith(preview));
  assert.equal(preview, preview.toWellFormed());
  finish.resolve();
  await f.bot.drain();
  assert.equal(f.sent.map(message => message.text).join(""), long);
});

test("Stop during PDF preparation preserves the source for an explicit retry", {timeout: 5000}, async (t) => {
  const reading = Promise.withResolvers<number>();
  let prepares = 0;
  let preparationSignal: AbortSignal | undefined;
  const f = fixture(t, {prepare: async (files, signal) => {
    if (++prepares === 1) {
      preparationSignal = signal;
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), {once: true}));
    }
    return files.map(file => ({name: file.name, text: "saved source", images: []}));
  }});
  let downloads = 0;
  f.telegram.downloadFile = async () => { downloads++; return Buffer.from("PDF source"); };
  f.telegram.sendDraft = async (_chat, id, text) => { if (text === "Читаю PDF") reading.resolve(id); };
  const task = f.update(2, "");
  delete task.message!.text;
  task.message!.caption = "stop while reading";
  task.message!.document = {file_id: "source", file_name: "lecture.pdf", mime_type: "application/pdf"};
  await f.bot.handleUpdate(task);
  await f.bot.handleUpdate({update_id: f.update(2, "").update_id, stopped_message_generation: {
    chat: {id: 2, type: "private"}, message_thread_id: 10, draft_id: await reading.promise,
  }});
  await f.bot.drain();
  assert.equal(preparationSignal?.aborted, true);
  assert.equal(f.requests.length, 0);
  assert.equal(f.sent.length, 0);
  await f.bot.handleUpdate(f.update(2, "/retry"));
  await f.bot.drain();
  assert.equal(downloads, 1);
  assert.equal(f.requests[0].attachments[0].text, "saved source");
  assert.equal(f.sent.at(-1)!.text, "answer stop while reading");
});

test("a stopped turn keeps earlier context and saved files while late results and stops are ignored", {timeout: 7000}, async (t) => {
  const f = fixture(t);
  await f.bot.handleUpdate(f.update(2, "previous answer"));
  await f.bot.drain();
  f.sent.length = 0;
  const oldDraft = Promise.withResolvers<number>();
  const saved = Promise.withResolvers<void>();
  const releaseOld = Promise.withResolvers<void>();
  const nextDraft = Promise.withResolvers<number>();
  const releaseNew = Promise.withResolvers<void>();
  t.after(() => { releaseOld.resolve(); releaseNew.resolve(); });
  let activeDraft = oldDraft;
  f.telegram.sendDraft = async (_chat, id, _text, topic) => { if (topic === 10) activeDraft.resolve(id); };
  f.engine.restoreStoppedThread = async () => true;
  let oldSignal: AbortSignal | undefined;
  let newSignal: AbortSignal | undefined;
  f.engine.run = async (request) => {
    f.requests.push(request);
    const id = `thread-${request.userId}`;
    await request.onThread(id);
    if (request.text === "cancel me") {
      oldSignal = request.signal;
      await request.onFile!({name: "saved.csv", mime: "text/csv", bytes: Buffer.from("saved before stop")});
      saved.resolve();
      await releaseOld.promise;
      request.onProgress?.({kind: "text", delta: "late fragment"});
      await assert.rejects(request.onFile!({name: "late.csv", mime: "text/csv", bytes: Buffer.from("late")}));
    }
    if (request.text === "new task") {
      newSignal = request.signal;
      await releaseNew.promise;
    }
    return {text: `answer ${request.text}`, threadId: id, images: []};
  };
  const stop = (draft: number, topic: number) => f.bot.handleUpdate({
    update_id: f.update(2, "").update_id,
    stopped_message_generation: {chat: {id: 2, type: "private"}, message_thread_id: topic, draft_id: draft},
  });
  await f.bot.handleUpdate(f.update(2, "cancel me"));
  await saved.promise;
  const stale = await oldDraft.promise;
  await stop(stale, 10);
  await f.bot.drain();
  assert.equal(oldSignal?.aborted, true);
  assert.equal(f.sent.length, 0);
  activeDraft = nextDraft;
  await f.bot.handleUpdate(f.update(2, "new task"));
  const neighbour = f.update(2, "neighbour");
  neighbour.message!.message_thread_id = 11;
  await f.bot.handleUpdate(neighbour);
  const current = await nextDraft.promise;
  assert.notEqual(current, stale);
  await stop(stale, 10);
  await stop(current, 11);
  assert.equal(newSignal?.aborted, false);
  releaseOld.resolve();
  releaseNew.resolve();
  await f.bot.drain();
  assert.deepEqual(f.sent.map(message => [message.options.message_thread_id, message.text]).sort(), [
    [10, "answer new task"], [11, "answer neighbour"],
  ]);
  const followUp = f.requests.find(request => request.text === "new task");
  assert.equal(followUp.threadId, "thread-2");
  assert.deepEqual(followUp.history.map((message: {text:string}) => message.text), ["previous answer", "answer previous answer"]);
  assert.deepEqual(followUp.files.map((file: {name:string}) => file.name), ["saved.csv"]);
});

test("unsupported drafts use a temporary Stop button that is removed after cancellation", {timeout: 5000}, async (t) => {
  const f = fixture(t);
  f.telegram.sendDraft = async () => { throw new TelegramError(404, "unsupported"); };
  const button = Promise.withResolvers<string>();
  const removed: number[] = [];
  const callback: string[] = [];
  f.telegram.sendText = async (_chat, _text, options) => {
    assert.equal(options?.message_thread_id, 10);
    const stop = options?.reply_markup?.inline_keyboard[0]?.[0];
    assert.equal(stop?.text, "Стоп");
    button.resolve(stop!.callback_data);
    return 365;
  };
  f.telegram.deleteMessage = async (_chat, id) => { removed.push(id); };
  f.telegram.answerCallback = async (id) => { callback.push(id); };
  f.engine.run = async request => {
    f.requests.push(request);
    await new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve(), {once: true}));
    return {text: "discarded", threadId: "cancelled", images: []};
  };
  await f.bot.handleUpdate(f.update(2, "start"));
  const update = f.update(2, "");
  await f.bot.handleUpdate({update_id: update.update_id, callback_query: {
    id: "button-365", from: {id: 2}, message: update.message!, data: await button.promise,
  }});
  await f.bot.drain();
  assert.equal(f.requests[0].signal.aborted, true);
  assert.deepEqual(callback, ["button-365"]);
  assert.deepEqual(removed, [365]);
  assert.deepEqual(f.sent, []);
});

test("the temporary Stop message is removed before delivering a completed answer", async (t) => {
  const f = fixture(t);
  const events: string[] = [];
  f.telegram.sendDraft = async () => { throw new TelegramError(404, "unsupported"); };
  f.telegram.sendText = async () => { events.push("temporary"); return 365; };
  f.telegram.deleteMessage = async (_chat, id) => { events.push(`removed ${id}`); };
  f.telegram.sendPart = async (_chat, part) => { events.push(part.kind); return 366; };
  await f.bot.handleUpdate(f.update(2, "show how"));
  await f.bot.drain();
  assert.deepEqual(events, ["temporary", "removed 365", "rich"]);
});

test("a throttled draft leaves final delivery recoverable after restart", async (t) => {
  const f = fixture(t);
  let previews = 0;
  f.telegram.sendDraft = async () => { previews++; throw new TelegramError(429, "slow down", 20); };
  const original = f.telegram.sendPart;
  f.telegram.sendPart = async () => { throw new TelegramError(503, "offline"); };
  await f.bot.handleUpdate(f.update(2, "persist this"));
  await f.bot.drain();
  assert.equal(previews, 1);
  assert.deepEqual(f.sent, []);
  f.telegram.sendPart = original;
  await f.reopen();
  await new Promise(resolve => setTimeout(resolve, 1300));
  await f.bot.drain();
  assert.equal(previews, 1);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.sent.map(message => [message.options.message_thread_id, message.text]), [[10, "answer persist this"]]);
});

test("a Stop racing with final delivery leaves the completed answer and file intact", {timeout: 5000}, async (t) => {
  const f = fixture(t);
  const draft = Promise.withResolvers<number>();
  const sending = Promise.withResolvers<void>();
  const deliver = Promise.withResolvers<void>();
  const files: string[] = [];
  t.after(() => deliver.resolve());
  f.telegram.sendDraft = async (_chat, id) => { draft.resolve(id); };
  f.telegram.sendFile = async (_chat, file, options) => {
    assert.equal(options?.message_thread_id, 10);
    files.push(file.name);
    return 50;
  };
  const original = f.telegram.sendPart;
  f.telegram.sendPart = async (...args) => {
    sending.resolve();
    await deliver.promise;
    return original(...args);
  };
  f.engine.run = async request => {
    f.requests.push(request);
    if (request.text === "make the file") {
      await request.onFile!({name: "result.csv", mime: "text/csv", bytes: Buffer.from("ready")});
      return {text: "Готовый ответ", threadId: "thread-2", images: []};
    }
    return {text: "Продолжаю", threadId: "thread-2", images: []};
  };
  await f.bot.handleUpdate(f.update(2, "make the file"));
  await sending.promise;
  await f.bot.handleUpdate({update_id: f.update(2, "").update_id, stopped_message_generation: {
    chat: {id: 2, type: "private"}, message_thread_id: 10, draft_id: await draft.promise,
  }});
  deliver.resolve();
  await f.bot.drain();
  assert.deepEqual(f.sent.map(message => message.text), ["Готовый ответ"]);
  assert.deepEqual(files, ["result.csv"]);
  await f.bot.handleUpdate(f.update(2, "continue"));
  await f.bot.drain();
  assert.equal(f.requests.at(-1).threadId, "thread-2");
  assert.equal(f.requests.at(-1).history.at(-1).text, "Готовый ответ");
});

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
  assert.equal(f.requests[0].model, "gpt-6.2-sol");
  assert.equal(f.requests.at(-1).model, "gpt-6.2-sol");
  assert.equal(f.requests[0].effort, "medium");
});

test("an unavailable model error reaches the approved user and their completed thread remains usable", async (t) => {
  const f = fixture(t);
  await f.bot.handleUpdate(f.update(2, "first answer"));
  await f.bot.drain();
  const run = f.engine.run;
  const message = "Модель этого диалога недоступна для учётной записи Codex.";
  f.engine.run = async () => { throw new ModelSelectionError(message); };

  await f.bot.handleUpdate(f.update(2, "unavailable"));
  await f.bot.drain();
  assert.equal(f.sent.at(-1)!.chatId, 2);
  assert.equal(f.sent.at(-1)!.options.message_thread_id, 10);
  assert.equal(f.sent.at(-1)!.text, message);

  f.engine.run = run;
  await f.bot.handleUpdate(f.update(2, "continue"));
  await f.bot.drain();
  assert.equal(f.requests.at(-1).threadId, "thread-2");
  assert.equal(f.sent.at(-1)!.text, "answer continue");
});

test("a request timing out before Codex opens the thread preserves the completed dialogue", async (t) => {
  const f = fixture(t);
  await f.bot.handleUpdate(f.update(2, "first answer"));
  await f.bot.drain();
  const run = f.engine.run;
  f.writeConfig(f.configText("2", "REQUEST_TIMEOUT_MS=20"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  f.engine.run = async () => new Promise(() => {});

  await f.bot.handleUpdate(f.update(2, "catalog waits"));
  await f.bot.drain();
  assert.match(f.sent.at(-1)!.text, /Время обработки/);

  f.engine.run = run;
  await f.bot.handleUpdate(f.update(2, "continue"));
  await f.bot.drain();
  assert.equal(f.requests.at(-1).threadId, "thread-2");
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
  assert.equal(f.requests.at(-1).model, "gpt-6.2-sol");
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
    return [{ id: "gpt-6.2-sol", supportedEfforts: ["medium"] }];
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
    return [{ id: "gpt-6.2-sol", supportedEfforts: ["medium", "high"] }];
  };
  await f.bot.handleUpdate({
    ...f.update(1, ""),
    callback_query: {
      id: "pending-choice", from: { id: 1 }, data,
      message: { message_thread_id: 10, message_id: 1, date: 0, chat: { id: 1, type: "private" } },
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
  const a = { id: "gpt-6.2-sol", supportedEfforts: ["medium", "high"] },
    b = { id: "gpt-6.1-sol", supportedEfforts: ["low"] };
  f.engine.listModels = async () => [a, b];
  await f.bot.handleUpdate(f.update(1, "/model"));
  await f.bot.drain();
  assert.match(f.sent.at(-1)!.text, /gpt-6\.2-sol, рассуждение: medium/);
  const modelData =
    f.sent.at(-1)!.options.reply_markup.inline_keyboard[0][0].callback_data;
  f.engine.listModels = async () => [b, a];
  const callback = (data: string): TelegramUpdate => ({
    ...f.update(1, ""),
    callback_query: {
      id: "cb",
      from: { id: 1 },
      message: { message_thread_id: 10, message_id: 1, date: 0, chat: { id: 1, type: "private" } },
      data,
    },
  });
  await f.bot.handleUpdate(callback(modelData));
  await f.bot.drain();
  assert.match(f.sent.at(-1)!.text, /gpt-6\.2-sol/);
  const effortData =
    f.sent.at(-1)!.options.reply_markup.inline_keyboard[1][0].callback_data;
  await f.bot.handleUpdate(callback(effortData));
  await f.bot.drain();
  await f.bot.handleUpdate(f.update(1, "/new"));
  await f.bot.drain();
  await f.reopen();
  await f.bot.handleUpdate(f.update(1, "question"));
  await f.bot.drain();
  assert.equal(f.requests.at(-1).model, "gpt-6.2-sol");
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

test("an earlier operation wakes the bot without opening inactive histories or sending a cancelled answer", async (t) => {
  const f = fixture(t);
  const history = [{role: "assistant" as const, text: "a".repeat(144 * 1024)}];
  for (let topicId = 20; topicId < 100; topicId++) f.store.put({userId: 2, topicId, history});
  const saved = (topicId: number, text: string, retryAt: number) => ({userId: 2, topicId, history: [],
    delivery: {parts: [{kind: "text" as const, text}], next: 0, retryAt}});
  f.store.put(saved(10, "cancelled", Date.now() + 30_000));
  const fullScans = t.mock.method(f.store, "all");
  const read = t.mock.method(f.store, "findDialogue");
  await f.bot.recover();
  assert.equal(read.mock.callCount(), 0);

  const early = Promise.withResolvers<void>();
  const sendPart = f.telegram.sendPart;
  f.telegram.sendPart = async (...args) => {
    const result = await sendPart(...args);
    early.resolve();
    return result;
  };
  f.store.put(saved(11, "earlier", Date.now() + 25));
  f.store.put(saved(12, "ready", 0));
  const watchdog = setTimeout(() => early.reject(new Error("ready delivery did not wake up")), 1000);
  try { await early.promise; } finally { clearTimeout(watchdog); }
  await f.bot.drain();
  assert.equal(f.sent[0]?.text, "ready");
  assert.ok(read.mock.calls.every(call => [11, 12].includes(call.arguments[0].topicId)));

  await f.bot.handleUpdate(f.update(2, "/new"));
  await new Promise(resolve => setTimeout(resolve, 100));
  await f.bot.drain();
  assert.equal(f.store.get(2, 10).delivery, undefined);
  assert.deepEqual(f.sent.map(item => item.text).filter(text => ["ready", "earlier", "cancelled"].includes(text)), ["ready", "earlier"]);
  assert.equal(fullScans.mock.callCount(), 0);
});

test("startup applies the access list before resuming a saved delivery", async (t) => {
  const f = fixture(t);
  await f.bot.shutdown();
  f.store.put({userId: 2, topicId: 10, history: [{role: "user", text: "retained"}],
    delivery: {parts: [{kind: "text", text: "restricted"}], next: 0}});
  f.writeConfig(f.configText(""));
  await f.reopen();
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.get(2, 10).delivery, undefined);
  assert.equal(f.store.get(2, 10).history[0]?.text, "retained");
});

test("after restart the saved retry deadline gates the remaining answer and a pending deletion", async (t) => {
  const f = fixture(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  await f.bot.shutdown();
  f.store.put({userId: 2, topicId: 10, history: [], delivery: {next: 1, retryAt: now + 30_000,
    parts: [{kind: "text", text: "acknowledged"}, {kind: "text", text: "remaining"}]}});
  f.store.put({userId: 2, topicId: 11, history: [], deleting: {threadIds: [], retryAt: now + 30_000}});
  const deletes: number[] = [];
  f.telegram.deleteTopic = async (_userId, topicId) => { deletes.push(topicId); };
  await f.reopen();
  assert.deepEqual(f.sent, []);
  assert.deepEqual(deletes, []);

  now += 30_000;
  await f.reopen();
  assert.deepEqual(f.sent.map(item => item.text), ["remaining"]);
  assert.deepEqual(deletes, [11]);
  await f.reopen();
  assert.equal(f.sent.length, 1);
  assert.deepEqual(deletes, [11]);
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
  f.writeConfig(
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
  f.writeConfig(f.configText());
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
  f.writeConfig(f.configText(""));
  await new Promise((r) => setTimeout(r, 60));
  f.writeConfig(f.configText("2"));
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

test("a small lecture PDF reaches the model with every page after a separate summary request and restart", {skip: !process.env.VERFIX_TEST_PYTHON}, async (t) => {
  const f = fixture(t, new SandboxedAttachmentReader({pythonPath: process.env.VERFIX_TEST_PYTHON!}));
  const bytes = readFileSync(new URL("./fixtures/attachments/twenty-one-pages.pdf", import.meta.url));
  const upload = fileUpdate(f.update(2, ""), "lecture.pdf");
  upload.message!.document!.mime_type = "application/pdf";
  upload.message!.document!.file_size = bytes.length;
  f.telegram.downloadFile = async () => bytes;
  await f.bot.handleUpdate(upload);
  await f.bot.drain();
  assert.match(f.sent.at(-1)!.text, /Материалы сохранены/);
  assert.equal(f.requests.length, 0);
  await f.reopen();
  await f.bot.handleUpdate(f.update(2, "Напиши конспект"));
  await f.bot.drain();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].text, "Напиши конспект");
  assert.equal(f.requests[0].attachments[0].images.length, 21);
  assert.match(f.requests[0].attachments[0].text, /Page 21\n/);
  await f.reopen();
  assert.equal(f.store.get(2,10).history[0]!.attachments![0]!.images.length, 21);
  assert.equal(f.store.get(2,10).pending, undefined);
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

test("a caption starts a new task after an ungrouped file was rejected", async t => {
  const f = fixture(t, {prepare: async files => files.map(file => ({name: file.name, text: "ok", images: []}))});
  f.telegram.downloadFile = async id => Buffer.from(id);
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "first.txt"));
  const rejected = fileUpdate(f.update(2, ""), "rejected.txt");
  rejected.message!.document!.file_size = 20_000_001;
  await f.bot.handleUpdate(rejected);
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "second.txt", "Compare the accepted files"));
  await f.bot.drain();
  assert.equal(f.requests[0].text, "Compare the accepted files");
  assert.deepEqual(f.requests[0].attachments.map((file: {name: string}) => file.name), ["first.txt", "second.txt"]);
});

test("an oversized download leaves the next text as a standalone task in the same topic", async (t) => {
  const f = fixture(t, { prepare: async () => [] });
  const downloads: string[] = [];
  f.telegram.downloadFile = async (id) => {
    downloads.push(id);
    return new Uint8Array(20_000_001);
  };
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "large.txt", "Explain"));
  await f.bot.drain();
  assert.equal(f.requests.length, 0);
  assert.match(f.sent.at(-1)!.text, /раздел|20|размер/i);
  await f.reopen();
  await f.bot.handleUpdate(f.update(2, "Привет"));
  await f.bot.drain();
  assert.deepEqual(f.requests.map(request => [request.text, request.attachments]), [["Привет", undefined]]);
  assert.deepEqual(downloads, ["large.txt"]);
});

test("prepared text over the batch budget falls back to the original and keeps earlier prepared text", async (t) => {
  const f = fixture(t, { prepare: async (files) => files.map((file) => ({ name: file.name, text: "x".repeat(250_001), images: [] })) });
  f.telegram.downloadFile = async () => new Uint8Array(4);
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "first.txt"));
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "long.txt", "Summarize"));
  await f.bot.drain();
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  const original = request.files.find((file: any) => file.name === "long.txt");
  assert.equal(request.attachments[0].text.length, 250_001);
  assert.deepEqual(request.attachments[1], {name: "long.txt", text: "", images: [], originalFileId: original.id});
  assert.match(f.sent.at(-1)!.text, /long\.txt.*лимита.*новом задании/);
});

test("oversized prepared images fall back to the original while many small pages still reach the model", async (t) => {
  let images = [{ name: "scan.png", mime: "image/png" as const, base64: Buffer.alloc(6_000_001).toString("base64") }];
  const f = fixture(t, { prepare: async () => [{ name: "scan.pdf", text: "", images }] });
  f.telegram.downloadFile = async () => new Uint8Array(4);
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "scan.pdf", "Read"));
  await f.bot.drain();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].attachments[0], {
    name: "scan.pdf", text: "", images: [], originalFileId: f.requests[0].files[0].id,
  });
  images = Array.from({ length: 101 }, (_, i) => ({ name: `page-${i}.png`, mime: "image/png" as const, base64: "AA==" }));
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "scan.pdf", "Read again"));
  await f.bot.drain();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].attachments[0].images.length, 101);
});

test("large earlier scans do not block new files, and remain readable after compaction and restart", async (t) => {
  const f = fixture(t, { prepare: async (files) => files.map((file) => ({ name: file.name, text: "", images: [{ name: "scan.png", mime: "image/png", base64: Buffer.alloc(file.name === "0.pdf" || file.name === "1.pdf" ? 4_480_000 : 50_000).toString("base64") }] })) });
  f.engine.summarize = async ({summary, text}) => summary ?? (text.includes("Compare by invoice date") ? "Compare by invoice date" : "Earlier scans read");
  f.telegram.downloadFile = async (id) => Buffer.from(id);
  for (let i = 0; i < 8; i++) {
    if (i === 2) await f.reopen();
    if (i === 0) {
      await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "0.pdf", "Compare by invoice date"));
      await f.bot.drain();
      continue;
    }
    await f.bot.handleUpdate(fileUpdate(f.update(2, ""), `${i}.pdf`, "Read"));
    await f.bot.drain();
  }
  assert.equal(f.requests.length, 8);
  assert.equal(f.store.get(2, 10).summary, "Compare by invoice date");
  assert.ok(Buffer.byteLength(JSON.stringify(f.store.get(2, 10).history)) < 4_000_000);
  const request = f.requests.at(-1);
  const original = request.files.find((file: any) => file.name === "0.pdf");
  assert.ok(original);
  assert.equal(Buffer.from(request.readFile(original.id)).toString(), "0.pdf");
  assert.equal(Buffer.from(f.requests[2].attachments[0].images[0].base64, "base64").length, 50_000);
  assert.equal(f.requests[2].summary, "Compare by invoice date");
  await f.bot.handleUpdate(f.update(2, "/new"));
  await f.bot.drain();
  assert.equal(f.store.get(2, 10).summary, undefined);
  assert.deepEqual(f.store.listFiles({userId: 2, topicId: 10}), []);
});

test("text summaries survive a failed update, multiple compactions, restart and confirmed deletion", async (t) => {
  const f = fixture(t);
  const address = {userId: 2, topicId: 10};
  const original = "Use Samara time in the final report";
  const clarification = "Record the date as 17 November";
  const summaries: Array<string | undefined> = [];
  f.engine.summarize = async ({summary, text}) => {
    summaries.push(summary);
    assert.ok(text.length <= 12_000);
    return summary ?? original;
  };
  for (const text of [original, "Two", "Three", "Four", "Five", "Six"]) {
    await f.bot.handleUpdate(f.update(2, text));
    await f.bot.drain();
  }
  const completed = f.store.get(address);
  const summarize = f.engine.summarize;
  f.engine.summarize = async () => { throw new Error("interrupted compaction"); };
  await f.bot.handleUpdate(f.update(2, "Try to update"));
  await f.bot.drain();
  assert.match(f.sent.at(-1)!.text, /Не удалось обновить сводку/);
  assert.deepEqual(f.store.get(address).history, completed.history);
  assert.equal(f.store.get(address).threadId, completed.threadId);

  f.engine.summarize = summarize;
  for (const text of ["Seven", "Eight", "Nine", "Ten", "Eleven", clarification]) {
    await f.bot.handleUpdate(f.update(2, text));
    await f.bot.drain();
  }
  assert.ok(summaries.includes(original));
  assert.ok(f.store.get(address).history.length <= 14);
  await f.reopen();
  const run = f.engine.run;
  f.engine.run = async () => { throw new Error("interrupted turn"); };
  await f.bot.handleUpdate(f.update(2, "Interrupt native thread"));
  await f.bot.drain();
  f.engine.run = run;
  await f.bot.handleUpdate(f.update(2, "What were the instructions?"));
  await f.bot.drain();
  const request = f.requests.at(-1);
  assert.equal(request.threadId, undefined);
  assert.equal(request.summary, original);
  assert.ok(request.history.some((message: any) => message.text === clarification));

  await f.bot.handleUpdate(f.update(2, "/delete"));
  await f.bot.drain();
  const confirmation = f.sent.at(-1)!.options.reply_markup.inline_keyboard[0][0].callback_data;
  const callback = f.update(2, "");
  await f.bot.handleUpdate({update_id: callback.update_id, callback_query: {
    id: "confirm-summary-delete", from: {id: 2}, message: callback.message!, data: confirmation,
  }});
  await f.bot.drain();
  assert.equal(f.store.get(address).summary, undefined);
  assert.deepEqual(f.store.get(address).history, []);
});

test("a context-window error on a resumed turn retries the same task with a compacted thread", async (t) => {
  const f = fixture(t);
  const address = {userId: 2, topicId: 10};
  await f.bot.handleUpdate(f.update(2, "Use Samara time"));
  await f.bot.drain();
  const firstThread = f.store.get(address).threadId;
  const retired: string[] = [];
  f.engine.deleteThread = async id => { retired.push(id); };
  f.engine.summarize = async ({text}) => {
    assert.match(text, /Use Samara time/);
    return "Use Samara time";
  };
  const run = f.engine.run;
  let attempts = 0;
  f.engine.run = async request => {
    if (++attempts === 1) {
      assert.equal(request.threadId, firstThread);
      await request.onThread(firstThread!);
      throw new ModelContextError();
    }
    assert.equal(request.threadId, undefined);
    assert.deepEqual(request.history, []);
    assert.equal(request.summary, "Use Samara time");
    return run(request);
  };
  await f.bot.handleUpdate(f.update(2, "What time zone?"));
  await f.bot.drain();
  assert.equal(attempts, 2);
  assert.deepEqual(retired, [firstThread]);
  assert.equal(f.sent.at(-1)!.text, "answer What time zone?");
});

test("compacting an existing topic keeps prepared scans and retries an already saved upload", async (t) => {
  const f = fixture(t, {prepare: async files => files.map(file => ({
    name: file.name, text: Buffer.from(file.bytes).toString(), images: [],
  }))});
  const address = {userId: 2, topicId: 10};
  const pending = f.store.saveFile(address, {name: "pending.pdf", mime: "application/pdf", bytes: Buffer.from("already uploaded")});
  let downloads = 0;
  f.telegram.downloadFile = async () => { downloads++; throw new Error("not needed"); };
  const attachment = {
    name: "legacy-scan.pdf", text: "Earlier total",
    images: [{name: "legacy.png", mime: "image/png" as const, base64: Buffer.alloc(4_480_000).toString("base64")}],
  };
  f.store.put({...address, threadId: "old-native", pending: {
    refs: [{fileId: "telegram-pending", name: pending.name, mime: pending.mime, source: "document"}],
    captions: [], savedFiles: {"telegram-pending": pending.id},
  }, history: [
    {role: "user", text: "Read the old scan", attachments: [attachment]},
    {role: "assistant", text: "Old scan read"},
    {role: "user", text: "Read the second scan", attachments: [{...attachment, name: "other.pdf"}]},
    {role: "assistant", text: "Second scan read"},
  ]});
  const retired: string[] = [];
  f.engine.deleteThread = async id => { retired.push(id); };
  f.engine.summarize = async ({text}) => {
    assert.match(text, /legacy-scan\.pdf/);
    return "Refer to legacy-scan.pdf for the old total.";
  };
  await f.bot.handleUpdate(f.update(2, "Compare to the old scan"));
  await f.bot.drain();
  const request = f.requests[0];
  assert.equal(request.threadId, undefined);
  assert.equal(downloads, 0);
  assert.equal(request.attachments[0].text, "already uploaded");
  assert.deepEqual(retired, ["old-native"]);
  assert.match(request.summary, /legacy-scan\.pdf/);
  const saved = request.files.find((file: any) => file.name === attachment.name);
  assert.equal(saved.prepared, true);
  assert.deepEqual(JSON.parse(Buffer.from(request.readFile(saved.id)).toString()), attachment);
  assert.deepEqual(f.store.listFiles({userId: 2, topicId: 11}), []);
  assert.throws(() => f.store.readFile({userId: 2, topicId: 11}, saved.id), /недоступен/);
  assert.throws(() => f.store.readFile({userId: 1, topicId: 10}, saved.id), /недоступен/);
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
  f.writeConfig(f.configText(""));
  await new Promise((resolve) => setTimeout(resolve, 60));
  const cancelled = signal?.aborted;
  finishDownload(new Uint8Array(4));
  assert.equal(cancelled, true);
  await f.bot.drain();
  assert.deepEqual(downloads, ["first.txt"]);
  assert.equal(f.requests.length, 0);
  f.writeConfig(f.configText());
  await new Promise((resolve) => setTimeout(resolve, 60));
  f.telegram.downloadFile = async (id) => { downloads.push(id); return new Uint8Array(4); };
  await f.bot.handleUpdate(f.update(1, "Owner continues independently"));
  await f.bot.drain();
  assert.equal(f.requests[0].attachments, undefined);
  await f.bot.handleUpdate(f.update(2, "/retry"));
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
    { role: "user", text: "Read", attachments: prepared, materials: [
      {id: f.store.listFiles({userId: 2, topicId: 10})[0]!.id, name: "scan.pdf"},
    ] },
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
  f.writeConfig("OWNER_TELEGRAM_ID=1\n");
  await new Promise((resolve) => setTimeout(resolve, 1550));
  assert.deepEqual(downloads, []);
  f.writeConfig(f.configText());
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
  f.writeConfig(f.configText("2", "REQUEST_TIMEOUT_MS=20"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  let signal: AbortSignal | undefined;
  f.telegram.downloadFile = async (_id, _max, abortSignal) => { signal = abortSignal; return new Promise(() => {}); };
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "slow.txt", "Read"));
  await f.bot.drain();
  assert.equal(signal?.aborted, true);
  assert.equal(f.requests.length, 0);
  assert.match(f.sent.at(-1)!.text, /Время обработки/i);
});

test("a corrupt PDF is rejected and the next text is a standalone task", {skip: !process.env.VERFIX_TEST_PYTHON}, async (t) => {
  const f = fixture(t, new SandboxedAttachmentReader({pythonPath: process.env.VERFIX_TEST_PYTHON}));
  const downloads: string[] = [];
  f.telegram.downloadFile = async id => {
    downloads.push(id);
    return Buffer.from("%PDF-1.7\ntruncated");
  };
  const upload = fileUpdate(f.update(2, ""), "broken.pdf", "Read");
  upload.message!.document!.mime_type = "application/pdf";
  await f.bot.handleUpdate(upload);
  await f.bot.drain();
  assert.equal(f.requests.length, 0);
  assert.match(f.sent.at(-1)!.text, /broken\.pdf.*поврежд[её]н/i);
  await f.reopen();
  await f.bot.handleUpdate(f.update(2, "Привет"));
  await f.bot.drain();
  assert.equal(f.requests[0].text, "Привет");
  assert.equal(f.requests[0].attachments, undefined);
  assert.deepEqual(f.requests[0].files, []);
  assert.deepEqual(downloads, ["broken.pdf"]);
});

test("a damaged workbook does not prevent analysis of an intact file", {skip: !process.env.VERFIX_TEST_PYTHON}, async t => {
  const f = fixture(t, new SandboxedAttachmentReader({pythonPath: process.env.VERFIX_TEST_PYTHON}));
  const broken = readFileSync(new URL("./fixtures/attachments/invalid-shared-string.xlsx", import.meta.url));
  f.telegram.downloadFile = async id => id.endsWith(".xlsx") ? broken : Buffer.from("Intact");
  const upload = fileUpdate(f.update(2, ""), "broken.xlsx");
  upload.message!.document!.file_size = broken.length;
  await f.bot.handleUpdate(upload);
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "notes.txt", "Compare the files"));
  await f.bot.drain();
  assert.deepEqual(f.requests[0].attachments, [{name: "notes.txt", text: "Intact", images: []}]);
  assert.deepEqual(f.requests[0].files.map((file: {name: string}) => file.name), ["notes.txt"]);
  assert.match(f.sent.at(-1)!.text, /broken\.xlsx.*повреждён/);
});

test("the actual batch limit excludes overflow and analyzes the files that fit", async t => {
  const f = fixture(t, {prepare: async files => files.map(file => ({name: file.name, text: "ok", images: []}))});
  f.telegram.downloadFile = async () => new Uint8Array(17_000_000);
  for (const name of ["first.txt", "second.txt", "overflow.txt"])
    await f.bot.handleUpdate(fileUpdate(f.update(2, ""), name));
  await f.bot.handleUpdate(f.update(2, "Compare"));
  await f.bot.drain();
  assert.deepEqual(f.requests[0].attachments.map((file: {name: string}) => file.name), ["first.txt", "second.txt"]);
  assert.match(f.sent.at(-1)!.text, /overflow\.txt.*50 МБ.*отдельно/);
});

test("an unreadable HTML file reaches the engine as an original alongside successfully prepared text", {skip: !process.env.VERFIX_TEST_PYTHON}, async (t) => {
  const f = fixture(t, new SandboxedAttachmentReader({pythonPath: process.env.VERFIX_TEST_PYTHON!}));
  const html = Buffer.from("<html>\xcf\xf0\xe8\xe2\xe5\xf2</html>", "latin1");
  const downloads: string[] = [];
  f.telegram.downloadFile = async (id) => {
    downloads.push(id);
    return id === "page.html" ? html : Buffer.from("readable notes");
  };
  const upload = fileUpdate(f.update(2, ""), "page.html");
  upload.message!.document!.mime_type = "text/html";
  upload.message!.document!.file_size = html.length;
  await f.bot.handleUpdate(upload);
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "notes.txt"));
  await f.bot.handleUpdate(f.update(2, "Compare both"));
  await f.bot.drain();
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  const original = request.files.find((file: any) => file.name === "page.html");
  assert.deepEqual(request.attachments, [
    {name: "page.html", text: "", images: [], originalFileId: original.id},
    {name: "notes.txt", text: "readable notes", images: []},
  ]);
  assert.deepEqual(Buffer.from(request.readFile(original.id)), html);
  await f.reopen();
  await f.bot.handleUpdate(f.update(2, "Привет"));
  await f.bot.drain();
  assert.equal(f.requests[1].attachments, undefined);
  assert.deepEqual(downloads, ["page.html", "notes.txt"]);
});

test("an explicit retry after a Telegram outage uses the original text and saved files only in its topic", async (t) => {
  const f = fixture(t, {prepare: async files => files.map(file => ({name: file.name, text: "ok", images: []}))});
  const downloads: string[] = [];
  let available = false;
  f.telegram.downloadFile = async (id) => {
    downloads.push(id);
    if (id === "second.txt" && !available) throw new TelegramError(503, "offline");
    return Buffer.from(id);
  };
  await f.bot.handleUpdate(f.update(2, "Earlier question"));
  await f.bot.drain();
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "first.txt"));
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "second.txt", "Compare the files"));
  await f.bot.drain();
  assert.match(f.sent.at(-1)!.text, /\/retry/);
  await f.reopen();

  available = true;
  const other = f.update(2, "/retry");
  other.message!.message_thread_id = 11;
  await f.bot.handleUpdate(other);
  await f.bot.handleUpdate(f.update(2, "Привет"));
  await f.bot.drain();
  assert.deepEqual(downloads, ["first.txt", "second.txt"]);
  assert.equal(f.requests[1].text, "Привет");
  assert.equal(f.requests[1].attachments, undefined);
  assert.deepEqual(f.requests[1].files, []);
  assert.equal(f.requests[1].history[0].text, "Earlier question");

  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "fresh.txt"));
  await f.bot.drain();
  await f.bot.handleUpdate(f.update(2, "/retry"));
  await f.bot.drain();
  assert.equal(f.requests[2].text, "Compare the files");
  assert.deepEqual(f.requests[2].attachments.map((file: {name: string}) => file.name), ["first.txt", "second.txt"]);
  assert.deepEqual(downloads, ["first.txt", "second.txt", "second.txt"]);

  await f.bot.handleUpdate(f.update(2, "Read the new file"));
  await f.bot.drain();
  assert.deepEqual(f.requests[3].attachments.map((file: {name: string}) => file.name), ["fresh.txt"]);
  assert.equal(f.requests[3].files.filter((file: {name: string}) => file.name === "first.txt").length, 1);
});

test("a pre-upgrade interrupted attachment task retries with its saved original", async t => {
  const f = fixture(t, {prepare: async files => files.map(file => ({
    name: file.name, text: Buffer.from(file.bytes).toString(), images: [],
  }))});
  const address = {userId: 2, topicId: 10};
  const alreadySaved = f.store.saveFile(address, {name: "notes.txt", mime: "text/plain", bytes: Buffer.from("Saved before upgrade")});
  const refs = [{fileId: "old-upload", name: alreadySaved.name, mime: alreadySaved.mime, source: "document" as const}];
  f.store.put({...address, history: [], pending: {refs, savedFiles: {"old-upload": alreadySaved.id}},
    request: {id: "old-job", text: "Read", started: Date.now(), attachments: refs}});
  await f.reopen();
  assert.match(f.sent.at(-1)!.text, /\/retry/);

  await f.bot.handleUpdate(f.update(2, "Привет"));
  await f.bot.drain();
  assert.deepEqual(f.requests[0].files, []);
  await f.bot.handleUpdate(f.update(2, "/retry"));
  await f.bot.drain();
  assert.equal(f.requests[1].text, "Read");
  assert.deepEqual(f.requests[1].attachments, [{name: "notes.txt", text: "Saved before upgrade", images: []}]);
});

test("a malformed saved attachment request leaves neighboring topics available after restart", async t => {
  const f = fixture(t);
  f.store.put({userId: 2, topicId: 10, history: [], request: {
    id: "broken", text: "Read", started: Date.now(), attachments: {length: 1} as never,
  }});
  await f.reopen();
  const update = f.update(2, "Hello from a different topic");
  update.message!.message_thread_id = 11;
  await f.bot.handleUpdate(update);
  await f.bot.drain();
  assert.equal(f.requests[0].topicId, 11);
  assert.equal(f.requests[0].text, "Hello from a different topic");
});

test("a newer failed attachment task does not expose older failed originals to a plain message", async t => {
  const f = fixture(t, {prepare: async () => []});
  f.telegram.downloadFile = async id => {
    if (id.startsWith("offline")) throw new TelegramError(503, "offline");
    return Buffer.from(id);
  };
  for (const task of ["first", "second"]) {
    await f.bot.handleUpdate(fileUpdate(f.update(2, ""), task + ".txt"));
    await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "offline-" + task + ".txt", task));
    await f.bot.drain();
  }
  await f.bot.handleUpdate(f.update(2, "Привет"));
  await f.bot.drain();
  assert.equal(f.requests[0].attachments, undefined);
  assert.deepEqual(f.requests[0].files, []);
});

test("an unavailable attachment reader keeps the file for /retry", {skip: !process.env.VERFIX_TEST_PYTHON}, async t => {
  let reader = new SandboxedAttachmentReader({pythonPath: "/nonexistent/verfix-test-python"});
  const f = fixture(t, {prepare: (files, signal) => reader.prepare(files, signal)});
  f.telegram.downloadFile = async () => Buffer.from("Ready for analysis");
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "notes.txt", "Read"));
  await f.bot.drain();
  assert.equal(f.requests.length, 0);
  assert.match(f.sent.at(-1)!.text, /временно недоступен.*\/retry/);

  reader = new SandboxedAttachmentReader({pythonPath: process.env.VERFIX_TEST_PYTHON});
  await f.bot.handleUpdate(f.update(2, "/retry"));
  await f.bot.drain();
  assert.equal(f.requests[0].text, "Read");
  assert.equal(f.requests[0].attachments[0].text, "Ready for analysis");
});

test("a model attachment error can be retried explicitly after switching models", async (t) => {
  const f = fixture(t, {prepare: async (files) => files.map((file) => ({name: file.name, text: "ok", images: []}))});
  f.telegram.downloadFile = async () => new Uint8Array(4);
  const original = f.engine.run;
  f.engine.run = async () => { throw new AttachmentError("Выбранная модель не принимает изображения. Выберите другую модель."); };
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "notes.txt", "Read"));
  await f.bot.drain();
  assert.match(f.sent.at(-1)!.text, /не принимает изображения/);
  f.engine.run = original;
  await f.bot.handleUpdate(f.update(2, "/retry"));
  await f.bot.drain();
  assert.deepEqual(f.requests[0].history, []);
  assert.equal(f.requests[0].text, "Read");
  assert.equal(f.requests[0].attachments[0].name, "notes.txt");
});

test("a captioned album rejected by the global capacity limit never becomes an implicit request queue", async (t) => {
  const f = fixture(t, { prepare: async (files) => files.map((file) => ({ name: file.name, text: "ok", images: [] })) });
  f.writeConfig(f.configText("2", "MAX_CONCURRENT_REQUESTS=1"));
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

test('topics of one user run concurrently with separate history, outboxes and busy slots', async (t) => {
  const f=fixture(t);
  let finish!: () => void;
  const waiting=new Promise<void>(r=>finish=r);
  f.engine.run=async r=>{
    f.requests.push(r);
    if(r.text==='work') await waiting;
    return {text:`answer ${r.text}`,threadId:`topic-${r.topicId}`,images:[]};
  };
  const topic=(text:string,id:number)=>{const u=f.update(2,text);u.message!.message_thread_id=id;return u;};
  await f.bot.handleUpdate(topic('work',11));
  await f.bot.handleUpdate(topic('study',12));
  await f.bot.handleUpdate(topic('reject',11));
  await new Promise(r=>setImmediate(r));
  assert.equal(f.requests.length,2);
  assert.equal(f.requests.find(r=>r.text==='study').topicId,12);
  finish(); await f.bot.drain();
  assert.deepEqual(f.sent.filter(s=>s.part).map(s=>[s.options.message_thread_id,s.text]).sort(),[[11,'answer work'],[12,'answer study']]);
  await f.reopen();
  await f.bot.handleUpdate(topic('continue',12));await f.bot.drain();
  assert.equal(f.requests.at(-1).threadId,'topic-12');
  assert.equal(f.store.get(2,11).history[0]?.text,'work');
  assert.equal(f.store.get(2,12).history[0]?.text,'study');
});

test('/new cancels a running topic and ignores late completion while its neighbour continues', async (t) => {
  const f=fixture(t);let finish!:()=>void;
  const wait=new Promise<void>(r=>finish=r);
  f.engine.run=async r=>{
    f.requests.push(r);
    await r.onThread(`thread-${r.topicId}`);
    if(r.text==='slow') await wait;
    return {text:`answer ${r.text}`,threadId:`thread-${r.topicId}`,images:[]};
  };
  const topic=(text:string,id:number)=>{const u=f.update(2,text);u.message!.message_thread_id=id;return u;};
  await f.bot.handleUpdate(topic('slow',11));
  await new Promise(r=>setImmediate(r));
  await f.bot.handleUpdate(topic('neighbour',12));
  await f.bot.handleUpdate(topic('/new',11));
  finish();await f.bot.drain();
  assert.equal(f.requests[0].signal.aborted,true);
  assert.equal(f.sent.some(s=>s.text==='answer slow'),false);
  assert.equal(f.store.get(2,11).history.length,0);
  assert.equal(f.store.get(2,12).history[0]?.text,'neighbour');
  assert.match(f.sent.find(s=>s.options?.message_thread_id===11 && s.part)?.text??'',/сброшен/);
});

test('/delete binds confirmation to user and topic, supports cancellation, and consumes it once', async (t) => {
  const f=fixture(t);const deleted:Array<[number,number]>=[];
  f.telegram.deleteTopic=async (u,id)=>{deleted.push([u,id]);};
  await f.bot.handleUpdate(f.update(2,'keep until confirmed'));await f.bot.drain();
  await f.bot.handleUpdate(f.update(2,'/delete'));await f.bot.drain();
  const buttons=f.sent.at(-1)!.options.reply_markup.inline_keyboard[0];
  const callback=(user:number,topic:number,data:string):TelegramUpdate=>{
    const u=f.update(user,'');return {update_id:u.update_id,callback_query:{id:String(u.update_id),from:{id:user},message:{...u.message!,message_thread_id:topic},data}};
  };
  await f.bot.handleUpdate(callback(1,10,buttons[0].callback_data));
  await f.bot.handleUpdate(callback(2,11,buttons[0].callback_data));await f.bot.drain();
  assert.deepEqual(deleted,[]);
  await f.bot.handleUpdate(callback(2,10,buttons[1].callback_data));await f.bot.drain();
  assert.equal(f.store.get(2,10).history.length,2);
  await f.bot.handleUpdate(callback(2,10,buttons[0].callback_data));await f.bot.drain();
  assert.deepEqual(deleted,[]);
  await f.bot.handleUpdate(f.update(2,'/delete'));await f.bot.drain();
  const confirm=f.sent.at(-1)!.options.reply_markup.inline_keyboard[0][0].callback_data;
  await f.bot.handleUpdate(callback(2,10,confirm));await f.bot.drain();
  assert.deepEqual(deleted,[[2,10]]);
  assert.equal(f.store.get(2,10).history.length,0);
  await f.bot.handleUpdate(callback(2,10,confirm));await f.bot.drain();
  assert.deepEqual(deleted,[[2,10]]);
});

test('plain text outside topics gives guidance without creating a common dialogue or calling Codex', async(t)=>{
  const f=fixture(t);const u=f.update(2,'outside');delete u.message!.message_thread_id;
  await f.bot.handleUpdate(u);await f.bot.drain();
  assert.equal(f.requests.length,0);
  assert.equal(f.store.all().length,0);
  assert.match(f.sent.at(-1)!.text,/тем/);
});

test('legacy migration preserves pending materials and outbox without duplicating history or topics',async(t)=>{
  const f=fixture(t);let created=0;const bound:string[]=[];
  f.telegram.createTopic=async()=>{created++;return 77;};
  f.engine.bindLegacyThread=async(id,address)=>{bound.push(`${id}:${address.topicId}`);};
  f.store.put({userId:2,threadId:'old',history:[{role:'user',text:'old fact'}],pending:{refs:[{fileId:'file',name:'x',mime:'text/plain',source:'document'}],captions:[]},delivery:{parts:[{kind:'text',text:'remaining answer'}],next:0}});
  await f.bot.recover();
  assert.equal(created,1);
  assert.deepEqual(bound,['old:77']);
  assert.equal(f.store.get(2,77).history[0]?.text,'old fact');
  assert.equal(f.store.get(2,77).pending?.refs[0]?.fileId,'file');
  assert.equal(f.sent.filter(s=>s.text==='remaining answer').length,1);
  assert.equal(f.sent.find(s=>s.text==='remaining answer')?.options.message_thread_id,77);
  assert.equal(f.sent.some(s=>s.text==='old fact'),false);
  await f.reopen();assert.equal(created,1);
  const u=f.update(2,'continue');u.message!.message_thread_id=77;
  // Pending material is intact; clear it here to exercise the old native context.
  const state=f.store.get(2,77);delete state.pending;f.store.put(state);
  await f.bot.handleUpdate(u);await f.bot.drain();
  assert.equal(f.requests.at(-1).threadId,'old');
});

test('ambiguous topic creation waits across restart and adopts its service event without a second API call',async(t)=>{
  const f=fixture(t);let created=0;
  f.telegram.createTopic=async()=>{created++;throw new Error('response lost');};
  f.store.put({userId:2,history:[{role:'user',text:'old fact'}]});
  await f.bot.recover();await f.reopen();
  assert.equal(created,1);
  assert.equal(f.store.get(2).history[0]?.text,'old fact');
  const event=f.update(2,'');event.message!.message_thread_id=77;event.message!.forum_topic_created={name:'Предыдущий диалог'};
  await f.bot.discardOfflineUpdates([event]);await f.bot.drain();
  assert.equal(f.store.get(2,77).history[0]?.text,'old fact');
  assert.equal(f.requests.length,0);
  await f.reopen();assert.equal(created,1);
});

test('reset during delivery aborts its send and never emits the remaining images',async(t)=>{
  const f=fixture(t);let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(r=>entered=r),blocked=new Promise<void>(r=>release=r);
  const sentPart=f.telegram.sendPart;let deliverySignal:AbortSignal|undefined;
  f.telegram.sendPart=async(u,p,o)=>{
    if(p.kind==='rich'){deliverySignal=o?.signal;entered();await blocked;}
    return sentPart(u,p,o);
  };
  f.engine.run=async()=>({text:'old answer',threadId:'old',images:[{bytes:generatedPng,name:'late.png',mime:'image/png'}]});
  await f.bot.handleUpdate(f.update(2,'old'));await started;
  await f.bot.handleUpdate(f.update(2,'/new'));await f.bot.drain();
  assert.equal(deliverySignal?.aborted,true);
  release();await new Promise(r=>setImmediate(r));
  assert.equal(f.sent.some(s=>s.part?.kind==='image'),false);
  assert.equal(f.store.get(2,10).history.length,0);
});

test('deletion stops a running task and a failed Telegram delete stays pending with an honest error',async(t)=>{
  const f=fixture(t);let finish!:()=>void;const blocked=new Promise<void>(r=>finish=r);
  f.engine.run=async r=>{f.requests.push(r);await r.onThread('old');await blocked;return {text:'late answer',threadId:'old',images:[]};};
  f.telegram.deleteTopic=async()=>{throw new Error('failure');};
  await f.bot.handleUpdate(f.update(2,'slow'));await new Promise(r=>setImmediate(r));
  await f.bot.handleUpdate(f.update(2,'/delete'));await new Promise(r=>setImmediate(r));
  const confirm=f.sent.at(-1)!.options.reply_markup.inline_keyboard[0][0].callback_data;
  const u=f.update(2,'');
  await f.bot.handleUpdate({update_id:u.update_id,callback_query:{id:'delete',from:{id:2},message:u.message!,data:confirm}});
  finish();await f.bot.drain();
  assert.equal(f.requests[0].signal.aborted,true);
  assert.equal(f.sent.some(s=>s.text==='late answer'),false);
  assert.match(f.sent.at(-1)!.text,/Не удалось удалить.*Полное удаление не завершено/);
  assert.ok(f.store.get(2,10).deleting);
  f.telegram.deleteTopic=async()=>{};
  const state=f.store.get(2,10);state.deleting!.retryAt=0;f.store.put(state);
  await f.reopen();
  assert.equal(f.store.all().length,0);
});

test('pending files, albums and fresh model defaults are scoped to topics',async(t)=>{
  const f=fixture(t,{prepare:async files=>files.map(x=>({name:x.name,text:Buffer.from(x.bytes).toString(),images:[]}))});
  f.telegram.downloadFile=async id=>Buffer.from(id);
  const topic=(text:string,id:number)=>{const u=f.update(1,text);u.message!.message_thread_id=id;return u;};
  const file=topic('',11);file.message!.document={file_id:'PRIVATE-WORK',file_name:'work.txt',mime_type:'text/plain'};
  await f.bot.handleUpdate(file);await f.bot.drain();
  const state=f.store.get(1,11);state.selection={model:'chosen-model',effort:'high'};f.store.put(state);
  await f.bot.handleUpdate(topic('study',12));await f.bot.drain();
  assert.equal(f.requests.at(-1).model,'gpt-6.2-sol');
  assert.equal(f.requests.at(-1).attachments,undefined);
  await f.bot.handleUpdate(topic('work',11));await f.bot.drain();
  assert.equal(f.requests.at(-1).model,'chosen-model');
  assert.equal(f.requests.at(-1).attachments[0].text,'PRIVATE-WORK');
  await f.reopen();
  assert.equal(f.store.get(1,11).selection?.model,'chosen-model');
  assert.equal(f.store.get(1,12).selection,undefined);
});

test('a displayed delete confirmation survives completion of legacy binding and reset cleanup',async(t)=>{
  for(const operation of ['binding','reset']) {
    const f=fixture(t);let started!:()=>void,release!:()=>void;
    const entered=new Promise<void>(r=>started=r),blocked=new Promise<void>(r=>release=r);
    if(operation==='binding'){
      f.engine.bindLegacyThread=async()=>{started();await blocked;};
      f.store.put({userId:2,topicId:10,threadId:'legacy',legacyBinding:true,history:[]});
      void f.bot.recover();
    }else{
      f.engine.deleteThread=async()=>{started();await blocked;};
      f.store.put({userId:2,topicId:10,threadId:'old',history:[]});
      await f.bot.handleUpdate(f.update(2,'/new'));
    }
    await entered;
    await f.bot.handleUpdate(f.update(2,'/delete'));
    await new Promise(r=>setImmediate(r));
    const token=f.store.get(2,10).deleteConfirmation!.token;
    release();await f.bot.drain();
    assert.equal(f.store.get(2,10).deleteConfirmation?.token,token,operation);
    const u=f.update(2,'');let deleted=0;f.telegram.deleteTopic=async()=>{deleted++;};
    await f.bot.handleUpdate({update_id:u.update_id,callback_query:{id:'confirm',from:{id:2},message:u.message!,data:`delete:yes:${token}`}});
    await f.bot.drain();assert.equal(deleted,1,operation);
  }
});

test('reset retries cleanup of native contexts left by an earlier failed turn',async(t)=>{
  const f=fixture(t);const cleaned:string[]=[];
  f.engine.run=async r=>{await r.onThread('failed-context');throw new Error('failed turn');};
  f.engine.deleteThread=async()=>{throw new Error('temporary filesystem failure');};
  await f.bot.handleUpdate(f.update(2,'fail'));await f.bot.drain();
  f.engine.deleteThread=async id=>{cleaned.push(id);};
  await f.bot.handleUpdate(f.update(2,'/new'));await f.bot.drain();
  assert.ok(cleaned.includes('failed-context'));
  assert.equal(f.store.get(2,10).history.length,0);
});

test('native topic renaming is acknowledged without an unsolicited task or error',async(t)=>{
  const f=fixture(t);const u=f.update(2,'');u.message!.forum_topic_edited={name:'Работа'};
  await f.bot.handleUpdate(u);await f.bot.drain();
  assert.equal(f.requests.length,0);assert.equal(f.sent.length,0);
});

function topicEvent(f: ReturnType<typeof fixture>, topicId: number, kind: 'forum_topic_created' | 'forum_topic_edited', name: string) {
  const update = f.update(2, '');
  update.message!.message_thread_id = topicId;
  update.message![kind] = {name};
  return update;
}

test('the first successful request gives a confirmed new topic a single title across replay, restart and reset', async (t) => {
  const f = fixture(t);
  const renamed: unknown[][] = [];
  f.telegram.renameTopic = async (userId, topicId, title) => { renamed.push([userId, topicId, title]); };
  f.engine.generateTopicTitle = async text => {
    assert.equal(text, 'Помоги подготовиться к экзамену по матанализу');
    return 'Подготовка к экзамену по матанализу';
  };
  const created = topicEvent(f, 10, 'forum_topic_created', 'Новый диалог');
  await f.bot.handleUpdate(created);
  const run = f.engine.run;
  f.engine.run = async () => { throw new Error('model failed'); };
  await f.bot.handleUpdate(f.update(2, 'failed'));
  await f.bot.drain();
  assert.equal(renamed.length, 0);
  f.engine.run = async () => ({text: 'partial answer', threadId: 'partial', images: [], incomplete: true});
  await f.bot.handleUpdate(f.update(2, 'partial'));
  await f.bot.drain();
  assert.equal(renamed.length, 0);
  f.engine.run = run;
  const first = f.update(2, 'Помоги подготовиться к экзамену по матанализу');
  await f.bot.handleUpdate(first);
  await f.bot.drain();
  await f.bot.handleUpdate(first);
  await f.reopen();
  await f.bot.handleUpdate(f.update(2, '/new'));
  await f.bot.drain();
  await f.bot.handleUpdate(topicEvent(f, 10, 'forum_topic_created', 'Новый диалог'));
  await f.bot.handleUpdate(f.update(2, 'another request'));
  await f.bot.drain();
  assert.deepEqual(renamed, [[2, 10, 'Подготовка к экзамену по матанализу']]);
  assert.match(f.sent.at(-1)!.text, /another request/);
});

test('parallel topics get titles from their own tasks, including an attachment caption', {timeout: 5000}, async (t) => {
  const f = fixture(t, {prepare: async files => files.map(file => ({name: file.name, text: 'private document', images: []}))});
  f.telegram.downloadFile = async () => new Uint8Array([1, 2, 3]);
  const renamed = new Map<number, string>();
  f.telegram.renameTopic = async (userId, topicId, title) => {
    assert.equal(userId, 2);
    renamed.set(topicId, title);
  };
  const first = Promise.withResolvers<string>();
  const second = Promise.withResolvers<string>();
  t.after(() => { first.resolve(''); second.resolve(''); });
  const firstNaming = Promise.withResolvers<void>();
  const bothAnswered = Promise.withResolvers<void>();
  const sendPart = f.telegram.sendPart;
  f.telegram.sendPart = async (...args) => {
    const result = await sendPart(...args);
    if (f.sent.filter(sent => sent.part).length === 2) bothAnswered.resolve();
    return result;
  };
  const inputs: string[] = [];
  f.engine.generateTopicTitle = text => {
    inputs.push(text);
    if (inputs.length === 1) {
      firstNaming.resolve();
      return first.promise;
    }
    return second.promise;
  };
  await f.bot.handleUpdate(topicEvent(f, 10, 'forum_topic_created', 'Новый диалог'));
  const implicit = topicEvent(f, 11, 'forum_topic_created', 'New Topic');
  implicit.message!.forum_topic_created!.is_name_implicit = true;
  await f.bot.handleUpdate(implicit);
  await f.bot.handleUpdate(f.update(2, 'Составь план тренировки'));
  const upload = fileUpdate(f.update(2, ''), 'private-name.txt', 'Изучи таблицу');
  upload.message!.message_thread_id = 11;
  await f.bot.handleUpdate(upload);
  await Promise.all([bothAnswered.promise, firstNaming.promise]);
  assert.equal(inputs.length, 1);
  assert.deepEqual(f.sent.filter(sent => sent.part).map(sent => sent.options.message_thread_id).sort(), [10, 11]);
  assert.equal(renamed.size, 0);
  const captionFirst = inputs[0] === 'Изучи таблицу';
  first.resolve(captionFirst ? 'Разбор таблицы' : 'План тренировки');
  second.resolve(captionFirst ? 'План тренировки' : 'Разбор таблицы');
  await f.bot.drain();
  assert.deepEqual(inputs.sort(), ['Изучи таблицу', 'Составь план тренировки']);
  assert.equal(renamed.get(10), 'План тренировки');
  assert.equal(renamed.get(11), 'Разбор таблицы');
});

test('custom, existing unknown and migrated topic titles are preserved', async (t) => {
  const f = fixture(t);
  const named: string[] = [];
  f.engine.generateTopicTitle = async text => { named.push(text); return 'Заголовок'; };
  await f.bot.handleUpdate(topicEvent(f, 11, 'forum_topic_created', 'Учеба'));
  f.store.put({userId: 2, topicId: 12, history: []});
  await f.bot.handleUpdate(topicEvent(f, 12, 'forum_topic_created', 'Новый диалог'));
  f.store.put({userId: 2, history: [{role: 'user', text: 'legacy content'}], migration: {phase: 'creating'}});
  await f.bot.handleUpdate(topicEvent(f, 77, 'forum_topic_created', 'Предыдущий диалог'));
  for (const topicId of [10, 11, 12, 77]) {
    const request = f.update(2, 'request');
    request.message!.message_thread_id = topicId;
    await f.bot.handleUpdate(request);
    await f.bot.drain();
  }
  assert.equal(f.sent.filter(sent => sent.part).length, 4);
  assert.deepEqual(named, []);
});

test('service edits received before or during title generation preserve the user title', {timeout: 5000}, async (t) => {
  const f = fixture(t);
  const started = Promise.withResolvers<AbortSignal>();
  const proposal = Promise.withResolvers<string>();
  f.engine.generateTopicTitle = async (_text, signal) => { started.resolve(signal); return proposal.promise; };
  const renamed: number[] = [];
  f.telegram.renameTopic = async (_user, topicId) => { renamed.push(topicId); };
  await f.bot.handleUpdate(topicEvent(f, 11, 'forum_topic_created', 'Новый диалог'));
  await f.bot.discardOfflineUpdates([topicEvent(f, 11, 'forum_topic_edited', 'Мой заголовок')]);
  const request = f.update(2, 'Existing manual name');
  request.message!.message_thread_id = 11;
  await f.bot.handleUpdate(request);
  await f.bot.drain();

  await f.bot.handleUpdate(topicEvent(f, 10, 'forum_topic_created', 'Новый диалог'));
  await f.bot.handleUpdate(f.update(2, 'Manual rename in progress'));
  const signal = await started.promise;
  await f.bot.handleUpdate(topicEvent(f, 10, 'forum_topic_edited', 'Новый диалог'));
  proposal.resolve('Автоматический заголовок');
  await f.bot.drain();
  assert.equal(signal.aborted, true);
  assert.equal(f.sent.filter(sent => sent.part).length, 2);
  assert.deepEqual(renamed, []);
});

test('an empty title or a Telegram rename failure leaves the already delivered answer and consumes the attempt', async (t) => {
  const f = fixture(t);
  const inputs: string[] = [];
  const renamed: string[] = [];
  f.engine.generateTopicTitle = async text => {
    inputs.push(text);
    if (text === 'пустой заголовок') return ' ';
    return 'Логин @private_handle и номер 123456';
  };
  f.telegram.renameTopic = async (_user, topicId, title) => {
    assert.ok(f.sent.some(sent => sent.part && sent.options.message_thread_id === topicId));
    renamed.push(title);
    throw new TelegramError(400, 'TOPIC_DELETED');
  };
  const tasks = [
    {topicId: 10, text: 'пустой заголовок'},
    {topicId: 11, text: 'Проверь @private_handle 123456 test@example.com проект Магнолия для Ивана Петрова\nПароль: hidden'},
  ];
  for (const {topicId, text} of tasks) {
    await f.bot.handleUpdate(topicEvent(f, topicId, 'forum_topic_created', 'Новый диалог'));
    for (const input of [text, 'follow-up']) {
      const request = f.update(2, input);
      request.message!.message_thread_id = topicId;
      await f.bot.handleUpdate(request);
      await f.bot.drain();
    }
  }
  assert.deepEqual(inputs, ['пустой заголовок', 'Проверь для']);
  assert.deepEqual(renamed, ['Обсуждение задания']);
  assert.equal(f.sent.filter(sent => sent.part).length, 4);
});

test('revoking access, resetting the dialogue and confirming deletion cancel pending title generation', {timeout: 5000}, async (t) => {
  for (const action of ['revoke', 'reset', 'delete']) {
    await t.test(action, async (subtest) => {
      const f = fixture(subtest);
      const started = Promise.withResolvers<AbortSignal>();
      const title = Promise.withResolvers<string>();
      f.engine.generateTopicTitle = async (_text, signal) => { started.resolve(signal); return title.promise; };
      const renamed: number[] = [];
      f.telegram.renameTopic = async (_user, topicId) => { renamed.push(topicId); };
      await f.bot.handleUpdate(topicEvent(f, 10, 'forum_topic_created', 'Новый диалог'));
      await f.bot.handleUpdate(f.update(2, 'Первое задание'));
      const signal = await started.promise;
      const cancelled = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true}));
      if (action === 'revoke') f.writeConfig(f.configText(''));
      else if (action === 'reset') await f.bot.handleUpdate(f.update(2, '/new'));
      else {
        await f.bot.handleUpdate(f.update(2, '/delete'));
        const token = f.sent.at(-1)!.options.reply_markup.inline_keyboard[0][0].callback_data;
        const update = f.update(2, '');
        await f.bot.handleUpdate({update_id: update.update_id, callback_query: {id: 'yes', from: {id: 2}, message: update.message!, data: token}});
      }
      await cancelled;
      title.resolve('Автоматический заголовок');
      await f.bot.drain();
      assert.match(f.sent.find(sent => sent.part)?.text ?? '', /Первое задание/);
      assert.deepEqual(renamed, []);
    });
  }
});

test('expired delete confirmation cannot delete a topic, including after restart',async(t)=>{
  const f=fixture(t);let deletes=0;f.telegram.deleteTopic=async()=>{deletes++;};
  await f.bot.handleUpdate(f.update(2,'context'));await f.bot.drain();
  await f.bot.handleUpdate(f.update(2,'/delete'));await f.bot.drain();
  const state=f.store.get(2,10),token=state.deleteConfirmation!.token;
  state.deleteConfirmation!.expires=1;f.store.put(state);await f.reopen();
  const u=f.update(2,'');
  await f.bot.handleUpdate({update_id:u.update_id,callback_query:{id:'expired',from:{id:2},message:u.message!,data:`delete:yes:${token}`}});
  await f.bot.drain();assert.equal(deletes,0);assert.equal(f.store.get(2,10).history[0]?.text,'context');
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
 assert.equal(f.store.listFiles({userId:2,topicId:10}).length,0);
});

test('an exported file in an interrupted request is delivered on recovery without rerunning Codex',async(t)=>{
 const f=fixture(t);const sent:string[]=[];
 const file=f.store.saveFile({userId:2,topicId:10},{name:'ready.csv',mime:'text/csv',bytes:Buffer.from('ready')});
 f.store.put({userId:2,topicId:10,history:[],request:{id:'interrupted',text:'task',started:Date.now(),fileIds:[file.id]}});
 f.telegram.sendFile=async(chatId,file)=>{assert.equal(chatId,2);sent.push(file.name);return 1;};
 await f.reopen();
 assert.deepEqual(sent,['ready.csv']);assert.equal(f.requests.length,0);
});

test('a timed-out turn delivers the completed file and enforces the ten-file limit',async(t)=>{
 const f=fixture(t);f.writeConfig(f.configText('2','REQUEST_TIMEOUT_MS=250'));
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
 const f=fixture(t);f.writeConfig(f.configText('2','DIALOGUE_FILE_BYTES='+generatedPng.length));
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
 assert.equal(downloads,1);assert.equal(f.store.listFiles({userId:2,topicId:10}).length,1);
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

test('response files route to their topic and stay isolated after restart, reset and confirmed deletion',async t=>{
 const f=fixture(t);const documents:Array<{topicId:number|undefined;name:string;bytes:string}>=[];
 const ids=new Map<number,string>();
 f.telegram.sendFile=async(chatId,file,options)=>{assert.equal(chatId,2);documents.push({topicId:options?.message_thread_id,name:file.name,bytes:Buffer.from(file.bytes).toString()});return 1;};
 f.engine.run=async request=>{
  await request.onThread('topic-'+request.topicId);
  if(request.text==='create'){
   assert.equal(request.files!.length,0);
   const file=await request.onFile!({name:'topic-'+request.topicId+'.csv',mime:'text/csv',bytes:Buffer.from('private-'+request.topicId)});
   ids.set(request.topicId!,file.id);
  } else {
   assert.equal(request.files!.length,1);
   assert.equal(Buffer.from(request.readFile!(request.files![0]!.id)).toString(),'private-'+request.topicId);
   assert.throws(()=>request.readFile!(ids.get(request.topicId===11?12:11)!));
  }
  return {text:'done',threadId:'topic-'+request.topicId,images:[]};
 };
 const topic=(text:string,id:number)=>{const update=f.update(2,text);update.message!.message_thread_id=id;return update;};
 await f.bot.handleUpdate(topic('create',11));await f.bot.handleUpdate(topic('create',12));await f.bot.drain();
 assert.deepEqual(documents.sort((a,b)=>a.topicId!-b.topicId!),[{topicId:11,name:'topic-11.csv',bytes:'private-11'},{topicId:12,name:'topic-12.csv',bytes:'private-12'}]);
 await f.reopen();await f.bot.handleUpdate(topic('edit',11));await f.bot.handleUpdate(topic('edit',12));await f.bot.drain();
 await f.bot.handleUpdate(topic('/new',11));await f.bot.drain();
 assert.equal(f.store.listFiles({userId:2,topicId:11}).length,0);
 assert.equal(f.store.listFiles({userId:2,topicId:12}).length,1);
 await f.bot.handleUpdate(topic('/delete',12));await f.bot.drain();
 const confirmation=f.sent.at(-1)!.options.reply_markup.inline_keyboard[0][0].callback_data;
 const update=topic('',12);
 await f.bot.handleUpdate({update_id:update.update_id,callback_query:{id:'delete-files',from:{id:2},message:update.message!,data:confirmation}});await f.bot.drain();
 assert.equal(f.store.listFiles({userId:2,topicId:12}).length,0);
});

test('reset cancels late file exports and clears only the running topic',async t=>{
 const f=fixture(t);let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);
 let lateExport!:()=>Promise<any>;
 f.telegram.sendFile=async()=>{throw new Error('cancelled files must not be sent');};
 f.engine.run=async request=>{
  await request.onThread('running');
  await request.onFile!({name:'ready.csv',mime:'text/csv',bytes:Buffer.from('ready')});
  lateExport=()=>request.onFile!({name:'late.csv',mime:'text/csv',bytes:Buffer.from('late')});entered();
  return new Promise(()=>{});
 };
 const other={userId:2,topicId:12};
 f.store.saveFile(other,{name:'other.csv',mime:'text/csv',bytes:Buffer.from('other')});
 await f.bot.handleUpdate(f.update(2,'run'));await started;
 await f.bot.handleUpdate(f.update(2,'/new'));await f.bot.drain();
 await assert.rejects(lateExport());
 assert.equal(f.store.listFiles({userId:2,topicId:10}).length,0);
 assert.equal(f.store.listFiles(other).length,1);
});

function broadcastCommand(f: ReturnType<typeof fixture>, userId: number, text: string, topicId: number | null = 10) {
  const update = f.update(userId, text);
  if (topicId === null) delete update.message!.message_thread_id;
  else update.message!.message_thread_id = topicId;
  return update;
}

function pressBroadcast(f: ReturnType<typeof fixture>, userId: number, data: string, topicId: number | null = 10) {
  const update = broadcastCommand(f, userId, "", topicId);
  return f.bot.handleUpdate({ update_id: update.update_id, callback_query: {
    id: `broadcast-${update.update_id}`, from: { id: userId }, message: update.message!, data,
  } });
}

test("broadcast requires an owner confirmation for the newest unexpired preview in its original chat", async t => {
  const f = fixture(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const answers: Array<string | undefined> = [];
  f.telegram.answerCallback = async (_id, answer) => { answers.push(answer); };

  await f.bot.handleUpdate(broadcastCommand(f, 2, "/broadcast чужой текст"));
  await f.bot.handleUpdate(broadcastCommand(f, 1, "/broadcast\n  ", null));
  await f.bot.drain();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.text, /Использование/);

  await f.bot.handleUpdate(broadcastCommand(f, 1, "/broadcast Первый"));
  const first = f.sent.at(-1)!.options.reply_markup.inline_keyboard[0];
  await pressBroadcast(f, 2, first[0].callback_data);
  await pressBroadcast(f, 1, first[0].callback_data, 11);
  await pressBroadcast(f, 1, first[1].callback_data);
  await pressBroadcast(f, 1, first[0].callback_data);
  assert.equal(answers.filter(answer => answer === "Рассылка отменена.").length, 1);

  await f.bot.handleUpdate(broadcastCommand(f, 1, "/broadcast Заменить"));
  const superseded = f.sent.at(-1)!.options.reply_markup.inline_keyboard[0][0].callback_data;
  await f.bot.handleUpdate(broadcastCommand(f, 1, "/broadcast Устареет", null));
  const expired = f.sent.at(-1)!.options.reply_markup.inline_keyboard[0][0].callback_data;
  await pressBroadcast(f, 1, superseded);
  now += 300_000;
  await pressBroadcast(f, 1, expired, null);

  const text = "Строка 1\n\nСтрока 2  ";
  await f.bot.handleUpdate(broadcastCommand(f, 1, `/broadcast ${text}`, null));
  const preview = f.sent.at(-1)!;
  assert.equal(preview.text, `Получателей: 1\n\n${text}`);
  assert.equal(preview.options.message_thread_id, undefined);
  const confirmation = preview.options.reply_markup.inline_keyboard[0][0].callback_data;
  await pressBroadcast(f, 1, confirmation, null);
  await pressBroadcast(f, 1, confirmation, null);
  await f.bot.drain();
  const deliveries = f.sent.filter(message => message.chatId === 2);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.text, text);
  assert.equal(deliveries[0]!.options?.message_thread_id, undefined);
  assert.match(f.sent.at(-1)!.text, /Доставлено: 1/);
  assert.equal(answers.filter(answer => answer === "Рассылка запущена.").length, 1);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.store.all(), []);
});

test("broadcast rechecks access, continues after a refusal or timeout and leaves active dialogue work alone", async t => {
  const f = fixture(t);
  f.writeConfig(f.configText("1,2,3,4,5,7,7"));
  const topic = { userId: 5, topicId: 10 };
  f.store.put({ ...topic, history: [{ role: "user", text: "existing context" }] });
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const engine = f.engine.run;
  f.engine.run = async request => {
    started.resolve();
    await release.promise;
    return engine(request);
  };
  const reported = Promise.withResolvers<void>();
  const attempts: number[] = [];
  const send = f.telegram.sendText;
  f.telegram.sendText = async (userId, text, options) => {
    if (userId !== 1) {
      attempts.push(userId);
      assert.equal(options?.message_thread_id, undefined);
      if (userId === 2) throw new TelegramError(403, "blocked");
      if (userId === 4) throw new TelegramError(0, "response lost");
    }
    const result = await send(userId, text, options);
    if (text.startsWith("Рассылка завершена")) reported.resolve();
    return result;
  };

  await f.bot.handleUpdate(f.update(5, "active task"));
  await started.promise;
  try {
    const previous = f.store.get(topic);
    await f.bot.handleUpdate(f.update(1, "/broadcast Объявление\nВторая строка"));
    assert.match(f.sent.at(-1)!.text, /Получателей: 5/);
    const confirmation = f.sent.at(-1)!.options.reply_markup.inline_keyboard[0][0].callback_data;
    f.writeConfig(f.configText("1,2,4,5,6,7,7"));
    await pressBroadcast(f, 1, confirmation);
    await reported.promise;

    assert.deepEqual(attempts, [2, 4, 5, 7]);
    assert.deepEqual(f.sent.filter(message => message.chatId !== 1).map(message => [message.chatId, message.text]), [
      [5, "Объявление\nВторая строка"], [7, "Объявление\nВторая строка"],
    ]);
    assert.match(f.sent.at(-1)!.text, /Доставлено: 2\nПропущено: 1\nНе доставлено: 1\nДоставка неизвестна: 1/);
    assert.equal(f.sent.at(-1)!.options.message_thread_id, 10);
    assert.deepEqual(f.store.get(topic), previous);
  } finally { release.resolve(); }
  await f.bot.drain();
  assert.equal(f.requests.length, 1);
  assert.equal(f.sent.at(-1)!.text, "answer active task");
  assert.equal(f.sent.at(-1)!.options.message_thread_id, 10);
});

test("broadcast keeps retry_after across reopen, rechecks revoked access and skips previously confirmed deliveries", async t => {
  const f = fixture(t);
  f.writeConfig(f.configText("2,3,4,5"));
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const attempts: number[] = [];
  const send = f.telegram.sendText;
  f.telegram.sendText = async (userId, text, options) => {
    if (userId !== 1) {
      attempts.push(userId);
      if (userId === 3 && attempts.filter(id => id === 3).length === 1)
        throw new TelegramError(429, "flood control", 2);
    }
    return send(userId, text, options);
  };

  await f.bot.handleUpdate(f.update(1, "/broadcast Продолжение"));
  const confirmation = f.sent.at(-1)!.options.reply_markup.inline_keyboard[0][0].callback_data;
  await pressBroadcast(f, 1, confirmation);
  await f.bot.drain();
  assert.deepEqual(attempts, [2, 3]);
  const saved = f.store.nextBroadcast(1)!;
  assert.equal(saved.retryAt, now + 2000);
  // Model a crash after a send began and before Telegram's result was recorded.
  saved.recipients.find(recipient => recipient.userId === 4)!.status = "sending";
  f.store.putBroadcast(saved);

  f.writeConfig(f.configText("2,3,4"));
  now += 1999;
  await f.reopen();
  await f.bot.drain();
  assert.deepEqual(attempts, [2, 3]);
  now += 1;
  const reported = Promise.withResolvers<void>();
  const retrySend = f.telegram.sendText;
  f.telegram.sendText = async (...args) => {
    const result = await retrySend(...args);
    if (args[1].startsWith("Рассылка завершена")) reported.resolve();
    return result;
  };
  await f.bot.recover();
  await reported.promise;
  await f.bot.drain();
  assert.deepEqual(attempts, [2, 3, 3]);
  assert.match(f.sent.at(-1)!.text, /Доставлено: 2\nПропущено: 1\nНе доставлено: 0\nДоставка неизвестна: 1/);
  assert.equal(f.store.nextBroadcast(1), undefined);
  await f.reopen();
  await f.bot.drain();
  assert.deepEqual(attempts, [2, 3, 3]);
});

function repeatButton(f: ReturnType<typeof fixture>, label = "Другой вариант") {
  const sent = f.sent.findLast(item =>
    item.options?.reply_markup?.inline_keyboard[0]?.[0]?.text === label);
  assert.ok(sent, `Expected button "${label}"`);
  return sent.options.reply_markup.inline_keyboard[0][0].callback_data as string;
}

function repeatPress(f: ReturnType<typeof fixture>, data: string, userId = 2, topicId = 10): TelegramUpdate {
  const update = f.update(userId, "");
  return { update_id: update.update_id, callback_query: {
    id: String(update.update_id), from: { id: userId },
    message: { ...update.message!, message_thread_id: topicId }, data,
  } };
}

test("another variant rebuilds the context from before the task and becomes the active answer", async (t) => {
  const f = fixture(t, { prepare: async (files) => files.map(file => ({
    name: file.name, text: Buffer.from(file.bytes).toString(), images: [],
  })) });
  const downloads: string[] = [];
  f.telegram.downloadFile = async id => { downloads.push(id); return Buffer.from(id); };
  f.telegram.sendFile = async (chatId, file, options) => {
    f.sent.push({ chatId, text: file.name, options });
    return f.sent.length;
  };
  f.engine.run = async r => {
    const number = f.requests.push(r);
    const threadId = r.threadId ?? `thread-${number}`;
    await r.onThread(threadId);
    if (r.text === "compare")
      await r.onFile!({ name: `answer-${number}.txt`, mime: "text/plain", bytes: Buffer.from(String(number)) });
    const images = number === 1 ? [{ name: "earlier.png", mime: "image/png", bytes: generatedPng }] : [];
    return { text: `answer ${number}`, threadId, images };
  };
  await f.bot.handleUpdate(f.update(2, "earlier question"));
  await f.bot.drain();
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "first.txt"));
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "second.txt"));
  await f.bot.handleUpdate(f.update(2, "compare"));
  await f.bot.drain();
  const button = repeatButton(f);
  await f.reopen();
  const press = repeatPress(f, button);
  await f.bot.handleUpdate(press);
  await f.bot.handleUpdate(press);
  await f.bot.handleUpdate(repeatPress(f, button));
  await f.bot.drain();
  assert.equal(f.requests.length, 3);
  const repeat = f.requests[2];
  assert.equal(repeat.text, "compare");
  assert.equal(repeat.threadId, undefined);
  const earlierImage = repeat.files[0];
  assert.deepEqual(repeat.readFile(earlierImage.id), new Uint8Array(generatedPng));
  assert.deepEqual(repeat.history, [
    { role: "user", text: "earlier question" },
    { role: "assistant", text: "answer 1", imageIds: [earlierImage.id], materials: [{id: earlierImage.id, name: "earlier.png"}] },
  ]);
  assert.deepEqual(repeat.attachments.map((a: any) => a.text), ["first.txt", "second.txt"]);
  assert.deepEqual(repeat.files.map((file: any) => file.name), ["earlier.png", "first.txt", "second.txt"]);
  assert.deepEqual(downloads, ["first.txt", "second.txt"]);
  await f.bot.handleUpdate(f.update(2, "/text"));
  await f.bot.drain();
  assert.match(f.sent.at(-1)!.text, /answer 3/);
  assert.ok(f.sent.some(message => message.text === "answer 2"));
  await f.bot.handleUpdate(f.update(2, "continue"));
  await f.bot.drain();
  assert.equal(f.requests[3].threadId, "thread-3");
  assert.deepEqual(f.requests[3].files.map((file: any) => file.name), ["earlier.png", "first.txt", "second.txt", "answer-3.txt"]);
});

function editMessage(f: ReturnType<typeof fixture>, original: TelegramUpdate, text: string): TelegramUpdate {
  const message = { ...original.message! };
  if (message.document || message.photo) message.caption = text;
  else message.text = text;
  return { update_id: f.update(message.from!.id, "").update_id, edited_message: message };
}

test("a stopped variant of a task with compacted history keeps the active answer and can be retried", {timeout: 8000}, async (t) => {
  const f = fixture(t, {prepare: async files => files.map(({name}) => ({name, text: "new notes", images: []}))});
  f.telegram.downloadFile = async () => Buffer.from("new notes");
  f.store.put({userId: 2, topicId: 10, threadId: "old-thread", contextPressure: true, history: [
    {role: "user", text: "remember old notes", attachments: [{name: "old.txt", text: "old notes", images: []}]},
    {role: "assistant", text: "old answer"},
  ]});
  f.engine.summarize = async () => "Remember the old notes";
  const draft = Promise.withResolvers<number>();
  const secondStarted = Promise.withResolvers<void>();
  f.engine.run = async request => {
    const number = f.requests.push(request);
    const threadId = `thread-${number}`;
    await request.onThread(threadId);
    if (number === 2) {
      await request.onFile!({name: "stopped.txt", mime: "text/plain", bytes: Buffer.from("partial")});
      secondStarted.resolve();
      await new Promise<void>(resolve => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener("abort", () => resolve(), {once: true});
      });
    }
    return {threadId, text: `answer ${number}`, images: []};
  };
  const task = fileUpdate(f.update(2, ""), "new.txt", "original task");
  await f.bot.handleUpdate(task);
  await f.bot.drain();
  await f.reopen();
  f.telegram.sendDraft = async (_chat, id) => { draft.resolve(id); };
  await f.bot.handleUpdate(repeatPress(f, repeatButton(f)));
  await secondStarted.promise;
  await f.bot.handleUpdate({
    update_id: f.update(2, "").update_id,
    stopped_message_generation: {chat: {id: 2, type: "private"}, message_thread_id: 10, draft_id: await draft.promise},
  });
  await f.bot.drain();
  await f.bot.handleUpdate(f.update(2, "/text"));
  await f.bot.drain();
  assert.equal(f.sent.at(-1)!.text, "answer 1");
  await f.bot.handleUpdate(editMessage(f, task, "new wording"));
  await f.bot.drain();
  await f.bot.handleUpdate(repeatPress(f, repeatButton(f, "Запустить снова")));
  await f.bot.drain();
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[2].text, "new wording");
  for (const request of f.requests.slice(1)) {
    assert.equal(request.threadId, undefined);
    assert.equal(request.summary, "Remember the old notes");
    assert.deepEqual(request.history, []);
    assert.equal(request.attachments[0].text, "new notes");
    assert.deepEqual(request.files.map(({name}: {name: string}) => name), ["new.txt", "old.txt"]);
  }
  assert.equal(f.sent.at(-1)!.text, "answer 3");
});

test("only the latest caption edit runs and the original album stays in order", async (t) => {
  const f = fixture(t, { prepare: async files => files.map(file => ({ name: file.name, text: "material", images: [] })) });
  f.telegram.downloadFile = async () => new Uint8Array(4);
  const caption = fileUpdate(f.update(2, ""), "first.txt", "Compare", "album");
  await f.bot.handleUpdate(caption);
  await f.bot.handleUpdate(fileUpdate(f.update(2, ""), "second.txt", "by date", "album"));
  await f.bot.drain();
  assert.equal(f.requests[0].text, "Compare\n\nby date");

  const edit = editMessage(f, caption, "Sort");
  await f.bot.handleUpdate(edit);
  await f.bot.handleUpdate(edit);
  await f.bot.drain();
  const old = repeatButton(f, "Запустить снова");
  await f.bot.handleUpdate(editMessage(f, caption, "Summarize"));
  await f.bot.drain();
  const latest = repeatButton(f, "Запустить снова");
  assert.notEqual(latest, old);
  assert.equal(f.requests.length, 1);

  await f.reopen();
  await f.bot.handleUpdate(repeatPress(f, old));
  await f.bot.handleUpdate(repeatPress(f, latest, 2, 11));
  await f.bot.handleUpdate(repeatPress(f, latest, 1));
  await f.bot.handleUpdate(repeatPress(f, latest, 99));
  assert.equal(f.requests.length, 1);
  await f.bot.handleUpdate(repeatPress(f, latest));
  await f.bot.drain();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].text, "Summarize\n\nby date");
  assert.deepEqual(f.requests[1].attachments.map((a: any) => a.name), ["first.txt", "second.txt"]);
});

test("an edited separate text reuses the attached file, and a failed rerun leaves the active answer and context", async (t) => {
  const f = fixture(t, { prepare: async files => files.map(file => ({ name: file.name, text: "notes", images: [] })) });
  f.telegram.downloadFile = async () => new Uint8Array(4);
  await f.bot.handleUpdate(fileUpdate(f.update(2, "")));
  const original = f.update(2, "Read my notes");
  await f.bot.handleUpdate(original);
  await f.bot.drain();
  await f.bot.handleUpdate(editMessage(f, original, "List the key points"));
  await f.bot.drain();
  const button = repeatButton(f, "Запустить снова");
  const run = f.engine.run;
  f.engine.run = async r => {
    f.requests.push(r);
    await r.onThread("failed-variant");
    throw new ModelSelectionError("Модель недоступна.");
  };
  await f.bot.handleUpdate(repeatPress(f, button));
  await f.bot.drain();
  assert.equal(f.requests[1].text, "List the key points");
  assert.equal(f.requests[1].attachments[0].text, "notes");
  assert.match(f.sent.at(-1)!.text, /Модель недоступна/);
  await f.bot.handleUpdate(f.update(2, "/text"));
  await f.bot.drain();
  assert.equal(f.sent.at(-1)!.text, "answer Read my notes");
  const retry = repeatButton(f, "Запустить снова");
  f.engine.run = run;
  await f.bot.handleUpdate(f.update(2, "continue"));
  await f.bot.drain();
  await f.bot.handleUpdate(repeatPress(f, retry));
  await f.bot.handleUpdate(editMessage(f, original, "ignored edit"));
  await f.bot.drain();
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[2].threadId, "thread-2");
});

test("reset and confirmed topic deletion invalidate earlier variant buttons", async (t) => {
  const f = fixture(t);
  await f.bot.handleUpdate(f.update(2, "first task"));
  await f.bot.drain();
  const beforeReset = repeatButton(f);
  await f.bot.handleUpdate(f.update(2, "/new"));
  await f.bot.drain();
  await f.bot.handleUpdate(repeatPress(f, beforeReset));
  await f.bot.handleUpdate(f.update(2, "second task"));
  await f.bot.drain();
  const beforeDeletion = repeatButton(f);
  await f.bot.handleUpdate(f.update(2, "/delete"));
  await f.bot.drain();
  const confirmation = f.sent.at(-1)!.options.reply_markup.inline_keyboard[0][0].callback_data;
  await f.bot.handleUpdate(repeatPress(f, confirmation));
  await f.bot.drain();
  await f.bot.handleUpdate(repeatPress(f, beforeDeletion));
  await f.bot.drain();
  assert.equal(f.requests.length, 2);
});

test("recovery delivers a saved partial image and keeps the active context without restarting the model", async (t) => {
  const f = fixture(t);
  await f.bot.handleUpdate(f.update(2, "original"));
  await f.bot.drain();
  const button = repeatButton(f);
  const run = f.engine.run;
  let allocated!: () => void;
  const running = new Promise<void>(resolve => { allocated = resolve; });
  f.engine.run = async r => {
    f.requests.push(r);
    await r.onThread("incomplete-repeat");
    allocated();
    return new Promise(() => {});
  };
  await f.bot.handleUpdate(repeatPress(f, button));
  await running;
  const address = { userId: 2, topicId: 10 };
  const requestId = f.store.get(address).request!.id;
  f.store.saveResponseImage(address, requestId, { name: "partial.png", mime: "image/png", bytes: generatedPng });
  await f.bot.handleUpdate(repeatPress(f, button));
  await f.reopen();
  assert.equal(f.requests.length, 2);
  assert.equal(f.sent.at(-1)!.part?.kind, "image");
  assert.equal(f.sent.at(-1)!.text, "partial.png");
  assert.notEqual(repeatButton(f), button);
  f.engine.run = run;
  await f.bot.handleUpdate(f.update(2, "continue"));
  await f.bot.drain();
  assert.equal(f.requests[2].threadId, "thread-2");
  assert.deepEqual(f.requests[2].files, []);
});

test("removing the only caption invalidates the previous variant and edited-text buttons", async (t) => {
  const f = fixture(t, { prepare: async files => files.map(file => ({ name: file.name, text: "notes", images: [] })) });
  f.telegram.downloadFile = async () => new Uint8Array(4);
  const original = fileUpdate(f.update(2, ""), "notes.txt", "Read my notes");
  await f.bot.handleUpdate(original);
  await f.bot.drain();
  const variant = repeatButton(f);
  await f.bot.handleUpdate(editMessage(f, original, "List the key points"));
  await f.bot.drain();
  const rerun = repeatButton(f, "Запустить снова");
  await f.bot.handleUpdate(editMessage(f, original, ""));
  await f.bot.drain();
  assert.match(f.sent.at(-1)!.text, /Текст задания удалён/);
  assert.equal(f.sent.at(-1)!.options.reply_markup, undefined);
  await f.bot.handleUpdate(repeatPress(f, variant));
  await f.bot.handleUpdate(repeatPress(f, rerun));
  await f.bot.drain();
  assert.equal(f.requests.length, 1);
});

test("a partial variant can deliver its files without becoming the active answer", async (t) => {
  const f = fixture(t);
  await f.bot.handleUpdate(f.update(2, "original"));
  await f.bot.drain();
  const run = f.engine.run;
  f.telegram.sendFile = async (chatId, file, options) => {
    f.sent.push({ chatId, text: file.name, options });
    return f.sent.length;
  };
  f.engine.run = async r => {
    await r.onThread("incomplete-variant");
    await r.onFile!({ name: "partial.txt", mime: "text/plain", bytes: Buffer.from("partial") });
    return { text: "Только часть ответа готова.", threadId: "incomplete-variant", images: [], incomplete: true };
  };
  await f.bot.handleUpdate(repeatPress(f, repeatButton(f)));
  await f.bot.drain();
  assert.ok(f.sent.some(message => message.text === "partial.txt"));
  await f.bot.handleUpdate(f.update(2, "/text"));
  await f.bot.drain();
  assert.equal(f.sent.at(-1)!.text, "answer original");
  f.engine.run = run;
  await f.bot.handleUpdate(f.update(2, "continue"));
  await f.bot.drain();
  assert.equal(f.requests[1].threadId, "thread-2");
  assert.deepEqual(f.requests[1].files, []);
});

test("a mixed batch uses the intact attachment and reports the lost file", async t => {
  const f = fixture(t, undefined, openLocalStore);
  const address = { userId: 2, topicId: 10 };
  const lost = f.store.saveFile(address, { name: "missing.txt", mime: "text/plain", bytes: Buffer.from("lost") });
  const retained = f.store.saveFile(address, { name: "retained.txt", mime: "text/plain", bytes: Buffer.from("intact") });
  f.store.put({ ...address, history: [], pending: {
    refs: [lost, retained].map(file => ({ fileId: file.name, name: file.name, mime: file.mime, source: "document" })),
    savedFiles: { [lost.name]: lost.id, [retained.name]: retained.id },
  } });
  f.telegram.downloadFile = async () => { throw new Error("No original should be downloaded in this test"); };
  unlinkSync(join(f.dir, "db.sqlite.files", lost.id));
  await f.reopen();
  await f.bot.handleUpdate(f.update(2, "Read both files"));
  await f.bot.drain();
  assert.match(f.sent.at(-1)!.text, /missing\.txt.*недоступна.*заново/);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].attachments.map((file: {name: string}) => file.name), [retained.name]);

  await f.bot.handleUpdate(f.update(2, "Привет"));
  await f.bot.drain();
  assert.equal(f.requests[1].attachments, undefined);
  assert.deepEqual(f.requests[1].files.map((file: {name: string}) => file.name), [retained.name]);
  assert.equal(f.sent.at(-1)!.text, "answer Привет");
});

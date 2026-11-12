import { randomBytes, randomUUID } from "node:crypto";
import type {
  AttachmentReader,
  AttachmentRef,
  PreparedAttachment,
  Bot,
  BotConfig,
  ConfigSource,
  ConfigSnapshot,
  ModelEngine,
  ModelInfo,
  OutgoingPart,
  TelegramTransport,
  TelegramUpdate,
} from "./contracts.ts";
import { ATTACHMENT_LIMITS, AttachmentError } from "./contracts.ts";
import { formatAnswer, formatText } from "./telegram/format.ts";
import { SqliteStore } from "./store.ts";
import type { DialogueState } from "./store.ts";
interface Dependencies {
  config: ConfigSource;
  store: SqliteStore;
  engine: ModelEngine;
  telegram: TelegramTransport;
  attachments?: AttachmentReader;
}
const REPEAT = "Обработка запроса прервалась. Пожалуйста, повторите запрос.";
const BUSY =
  "Запрос ещё обрабатывается или доставляется. Дождитесь завершения и повторите сообщение.";
export function createBot(deps: Dependencies): BotController {
  return new BotController(deps);
}
export class BotController implements Bot {
  private readonly deps: Dependencies;
  private readonly jobs = new Map<number, Promise<void>>();
  private readonly controlJobs = new Set<Promise<void>>();
  private readonly controlAbort = new AbortController();
  private readonly preparing = new Set<number>();
  private readonly controllers = new Map<number, AbortController>();
  private readonly albums = new Map<number, { timer: ReturnType<typeof setTimeout>; done: Promise<void>; resolve: () => void }>();
  private readonly offlineNotified = new Set<number>();
  private readonly unsubscribe: () => void;
  private readonly retryTimer: ReturnType<typeof setInterval>;
  private closed = false;
  private pickerRevision = 0;
  private readonly picker = new Map<
    string,
    { model: string; effort?: string }
  >();
  constructor(deps: Dependencies) {
    this.deps = deps;
    this.unsubscribe = deps.config.watch((snapshot) => this.reloaded(snapshot));
    this.retryTimer = setInterval(() => this.resume(), 250);
    this.retryTimer.unref();
  }
  private allowed(userId: number, config: BotConfig): boolean {
    return userId === config.ownerId || config.allowedUserIds.includes(userId);
  }
  private busy(state: DialogueState): boolean {
    return Boolean(
      state.request ||
      state.delivery ||
      state.reset ||
      this.jobs.has(state.userId),
    );
  }
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (this.closed || update.update_id < this.deps.store.offset) return;
    const snapshot = this.deps.config.snapshot();
    const config = snapshot.valid ? snapshot.config : snapshot.lastValid;
    const callback = update.callback_query;
    const message = callback?.message ?? update.message;
    const from = callback?.from ?? message?.from;
    if (
      !config ||
      !message ||
      message.chat.type !== "private" ||
      from?.id !== message.chat.id ||
      !this.allowed(from.id, config)
    ) {
      this.deps.store.accept(update.update_id);
      return;
    }
    const userId = from.id;
    if (!snapshot.valid) {
      this.deps.store.accept(update.update_id);
      if (
        !callback &&
        userId === config.ownerId &&
        /^\/status(?:@\w+)?(?:\s|$)/.test(message.text ?? "")
      )
        this.control(() => this.safeText(
          userId,
          `Работа приостановлена: ${snapshot.error}`,
          true,
        ));
      return;
    }
    if (callback) {
      this.deps.store.accept(update.update_id);
      if (userId === config.ownerId) this.pickerRevision++;
      this.control(() => this.modelCallback(userId, callback.id, callback.data, config));
      return;
    }
    const photo = message.photo?.at(-1), document = message.document;
    const ref: AttachmentRef | undefined = document
      ? {
          fileId: document.file_id,
          name: document.file_name ?? "document",
          mime: document.mime_type ?? "application/octet-stream",
          ...(document.file_size === undefined ? {} : { size: document.file_size }),
          source: "document",
        }
      : photo
        ? {
            fileId: photo.file_id,
            name: `photo-${message.message_id}.jpg`,
            mime: "image/jpeg",
            ...(photo.file_size === undefined ? {} : { size: photo.file_size }),
            source: "photo",
          }
        : undefined;
    if (!message.text && !ref) {
      this.deps.store.accept(update.update_id);
      this.control(() => this.safeText(userId, "Отправьте текст, фото или файл: JPEG, PNG, WebP, PDF, DOCX, XLSX, PPTX либо текстовый UTF-8 документ."));
      return;
    }
    const state = this.deps.store.get(userId);
    if (from.username) state.username = from.username;
    const command = /^\/(\w+)(?:@\w+)?(?:\s|$)/
      .exec(message.text ?? "")?.[1]
      ?.toLowerCase();
    if (command) {
      if (command === "new" && !this.busy(state)) {
        if (userId === config.ownerId) this.invalidatePicker();
        this.cancelAlbum(userId);
        state.reset = { threadIds: state.threadId ? [state.threadId] : [] };
        this.deps.store.accept(update.update_id, state);
        this.launch(userId, () => this.reset(userId));
        return;
      }
      if (command === "text" && !this.busy(state) && state.lastResponse) {
        if (userId === config.ownerId) this.invalidatePicker();
        state.delivery = { parts: formatText(state.lastResponse), next: 0 };
        this.deps.store.accept(update.update_id, state);
        this.launch(userId, () => this.deliver(userId));
        return;
      }
      this.deps.store.accept(update.update_id, state);
      if (command === "model" && userId === config.ownerId && !this.busy(state))
        this.invalidatePicker();
      this.control(() => this.command(command, state, config));
      return;
    }
    if (this.busy(state)) {
      this.deps.store.accept(update.update_id, state);
      this.control(() => this.safeText(userId, BUSY));
      return;
    }
    if (ref) {
      const refs = [...(state.pending?.refs ?? []), ref];
      if (
        refs.length > ATTACHMENT_LIMITS.files ||
        refs.some((r) => r.size !== undefined && (
          !Number.isFinite(r.size) || r.size < 0 || r.size > ATTACHMENT_LIMITS.fileBytes
        )) ||
        refs.reduce((n, r) => n + (r.size ?? 0), 0) > ATTACHMENT_LIMITS.batchBytes
      ) {
        this.cancelAlbum(userId);
        state.pending ??= { refs: [], captions: [] };
        state.pending.captions = [];
        delete state.pending.readyAt;
        state.pending.awaitingTask = true;
        this.deps.store.accept(update.update_id, state);
        this.control(() => this.safeText(userId, "Не более 10 вложений, 20 МБ на файл и 50 МБ на задание. Вложение отклонено; остальные материалы сохранены. Разделите материалы и повторите текст задания или очистите их через /new."));
        return;
      }
      state.pending ??= { refs: [], captions: [] };
      state.pending.refs.push(ref);
    }
    const text = message.text ?? (
      state.pending?.awaitingTask ? undefined : message.caption
    );
    if (state.pending) {
      if (message.text?.trim()) delete state.pending.awaitingTask;
      if (text?.trim()) state.pending.captions.push(text);
      if (ref && !state.pending.awaitingTask && (message.media_group_id || state.pending.readyAt))
        state.pending.readyAt = Date.now() + ATTACHMENT_LIMITS.albumQuietMs;
      if (state.pending.readyAt) {
        this.deps.store.accept(update.update_id, state);
        this.scheduleAlbum(userId, state.pending.readyAt);
        return;
      }
    }
    if (!text?.trim()) {
      this.deps.store.accept(update.update_id, state);
      this.control(() => this.safeText(userId, "Материалы сохранены. Отправьте текст задания; /new — удалить материалы."));
      return;
    }
    this.dispatch(state, text, config, update.update_id);
  }
  private dispatch(
    state: DialogueState,
    text: string,
    config: BotConfig,
    updateId?: number,
  ): void {
    const userId = state.userId;
    if (this.busy(state)) return;
    if (this.deps.store.all().filter((s) => this.busy(s)).length >= config.maxConcurrentRequests) {
      if (state.pending) {
        state.pending.captions = [];
        delete state.pending.readyAt;
      }
      if (updateId === undefined) this.deps.store.put(state);
      else this.deps.store.accept(updateId, state);
      this.control(() => this.safeText(userId, "Все места обработки заняты. Повторите запрос позже."));
      return;
    }
    state.request = {
      id: randomUUID(),
      text,
      started: Date.now(),
      ...(state.pending?.refs.length ? { attachments: state.pending.refs } : {}),
    };
    if (state.pending) {
      state.pending.captions = [];
      delete state.pending.readyAt;
    }
    if (userId === config.ownerId) this.invalidatePicker();
    if (updateId === undefined) this.deps.store.put(state);
    else this.deps.store.accept(updateId, state);
    this.launch(userId, () => this.process(userId, config));
  }
  private cancelAlbum(userId: number): void {
    const album = this.albums.get(userId);
    if (!album) return;
    clearTimeout(album.timer);
    this.albums.delete(userId);
    album.resolve();
  }
  private scheduleAlbum(userId: number, readyAt: number): void {
    this.cancelAlbum(userId);
    let resolve!: () => void;
    const done = new Promise<void>((r) => { resolve = r; });
    const timer = setTimeout(() => {
      this.albums.delete(userId);
      try {
        const snapshot = this.deps.config.snapshot();
        const state = this.deps.store.get(userId);
        if (!snapshot.valid || !this.allowed(userId, snapshot.config) || !state.pending) return;
        if (this.busy(state)) {
          state.pending.captions = [];
          delete state.pending.readyAt;
          this.deps.store.put(state);
          this.control(() => this.safeText(userId, BUSY));
          return;
        }
        const text = state.pending.captions.join("\n\n");
        state.pending.captions = [];
        delete state.pending.readyAt;
        this.deps.store.put(state);
        if (text.trim()) this.dispatch(state, text, snapshot.config);
        else this.control(() => this.safeText(userId, "Материалы сохранены. Отправьте текст задания; /new — удалить материалы."));
      } finally { resolve(); }
    }, Math.max(0, readyAt - Date.now()));
    this.albums.set(userId, { timer, done, resolve });
  }
  private control(work: () => Promise<void>): void {
    // Controls start after durable acceptance, but never occupy a user's request slot.
    const task = work().catch(() => {}).finally(() => this.controlJobs.delete(task));
    this.controlJobs.add(task);
  }
  private launch(userId: number, work: () => Promise<void>): void {
    if (this.closed || this.jobs.has(userId)) return;
    // Defer work so the busy marker is installed before any adapter callback can re-enter.
    const task = Promise.resolve()
      .then(work)
      .catch(() => {})
      .finally(() => {
        this.jobs.delete(userId);
        this.controllers.delete(userId);
      });
    this.jobs.set(userId, task);
  }
  private async process(userId: number, config: BotConfig): Promise<void> {
    const state = this.deps.store.get(userId),
      request = state.request;
    if (!request) return;
    const controller = new AbortController();
    this.controllers.set(userId, controller);
    const timer = setTimeout(
      () => controller.abort(new Error("Request timed out")),
      config.requestTimeoutMs,
    );
    const typing = setInterval(() => {
      const s = this.deps.config.snapshot();
      if (s.valid && this.allowed(userId, s.config))
        void this.deps.telegram
          .typing(userId, controller.signal)
          .catch(() => {});
    }, 4000);
    const selection = (userId === config.ownerId
      ? state.selection
      : undefined) ?? {
      model: config.defaultModel,
      effort: config.defaultEffort,
    };
    let engineStarted = false;
    try {
      this.ensureActive(userId, request.id, controller.signal);
      void this.deps.telegram.typing(userId, controller.signal).catch(() => {});
      let attachments: PreparedAttachment[] | undefined;
      if (request.attachments?.length) {
        this.preparing.add(userId);
        if (!this.deps.attachments || !this.deps.telegram.downloadFile)
          throw new AttachmentError("Обработка вложений сейчас недоступна. Повторите задание позже.");
        const files = [];
        let total = 0;
        for (const [index, ref] of request.attachments.entries()) {
          this.ensureActive(userId, request.id, controller.signal);
          const bytes = await this.abortable(this.deps.telegram.downloadFile(ref.fileId, ATTACHMENT_LIMITS.fileBytes, controller.signal), controller.signal);
          this.ensureActive(userId, request.id, controller.signal);
          total += bytes.byteLength;
          const remaining = request.attachments.slice(index + 1).reduce((n, r) => n + (r.size ?? 0), 0);
          if (bytes.byteLength > ATTACHMENT_LIMITS.fileBytes || total + remaining > ATTACHMENT_LIMITS.batchBytes)
            throw new AttachmentError("Превышен размер материалов: 20 МБ на файл, 50 МБ на задание. Разделите материалы или используйте /new.");
          files.push({ name: ref.name, mime: ref.mime, bytes });
        }
        this.ensureActive(userId, request.id, controller.signal);
        attachments = await this.abortable(this.deps.attachments.prepare(files, controller.signal), controller.signal);
        this.ensureActive(userId, request.id, controller.signal);
        if (attachments.length !== files.length)
          throw new AttachmentError("Не удалось подготовить все материалы. Файлы сохранены; повторите текст задания или используйте /new.");
        const context = [...state.history.flatMap((m) => m.attachments ?? []), ...attachments];
        if (Buffer.byteLength(JSON.stringify(context)) > ATTACHMENT_LIMITS.dialogueBytes || context.reduce((n, a) => n + a.images.length, 0) > ATTACHMENT_LIMITS.images)
          throw new AttachmentError("Материалы заняли весь контекст диалога. Начните новый диалог через /new и разделите материалы.");
        const images = attachments.flatMap((a) => a.images);
        if (images.length > ATTACHMENT_LIMITS.images || images.reduce((n, i) => n + Buffer.byteLength(i.base64, "base64"), 0) > ATTACHMENT_LIMITS.imageBytes)
          throw new AttachmentError("Слишком много изображений во вложениях. Разделите материалы или очистите диалог через /new.");
        if (attachments.reduce((n, a) => n + Buffer.byteLength(a.text), 0) > ATTACHMENT_LIMITS.textBytes)
          throw new AttachmentError("Слишком много текста во вложениях. Разделите материалы или очистите диалог через /new.");
      }
      this.preparing.delete(userId);
      this.ensureActive(userId, request.id, controller.signal);
      engineStarted = true;
      const response = await Promise.race([
        this.deps.engine.run({
          userId,
          text: request.text,
          ...(attachments ? { attachments } : {}),
          ...selection,
          ...(state.threadId
            ? { threadId: state.threadId }
            : { history: state.history }),
          signal: controller.signal,
          onThread: (id) => {
            const current = this.deps.store.get(userId);
            if (current.request?.id === request.id) {
              current.request.threadId = id;
              this.deps.store.put(current);
            }
          },
        }),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener(
            "abort",
            () => reject(controller.signal.reason),
            { once: true },
          ),
        ),
      ]);
      const current = this.deps.store.get(userId);
      if (current.request?.id !== request.id) return;
      current.threadId = response.threadId;
      current.history.push(
        { role: "user", text: request.text, ...(attachments ? { attachments } : {}) },
        { role: "assistant", text: response.text },
      );
      if (attachments) delete current.pending;
      current.lastResponse = response.text;
      const revoked = current.request.revoked;
      delete current.request;
      if (!revoked)
        current.delivery = { parts: formatAnswer(response), next: 0 };
      this.deps.store.put(current);
    } catch (error) {
      if (this.closed) return;
      const current = this.deps.store.get(userId);
      if (current.request?.id !== request.id) return;
      const poisoned = engineStarted ? current.request?.threadId ?? current.threadId : undefined;
      const revoked = current.request?.revoked;
      delete current.request;
      if (engineStarted) delete current.threadId;
      if (!revoked)
        current.delivery = {
          parts: [
            {
              kind: "text",
              text: error instanceof AttachmentError ? error.message : controller.signal.aborted
                ? "Время обработки запроса истекло. Пожалуйста, повторите запрос."
                : "Не удалось обработать запрос. Пожалуйста, повторите позже.",
            },
          ],
          next: 0,
        };
      this.deps.store.put(current);
      if (poisoned)
        void this.deps.engine.deleteThread(poisoned).catch(() => {});
    } finally {
      this.preparing.delete(userId);
      clearTimeout(timer);
      clearInterval(typing);
      this.controllers.delete(userId);
    }
    if (!this.closed) await this.deliver(userId);
  }
  private ensureActive(userId: number, requestId: string, signal: AbortSignal): void {
    signal.throwIfAborted();
    const snapshot = this.deps.config.snapshot();
    const request = this.deps.store.get(userId).request;
    if (!snapshot.valid || !this.allowed(userId, snapshot.config) || request?.id !== requestId || request.revoked)
      throw new AttachmentError("Обработка приостановлена. Повторите текст задания позже; материалы сохранены.");
  }
  private abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
  }
  private async deliver(userId: number): Promise<void> {
    while (!this.closed) {
      const snapshot = this.deps.config.snapshot();
      if (!snapshot.valid) return;
      const state = this.deps.store.get(userId),
        delivery = state.delivery;
      if (!delivery) return;
      if (delivery.retryAt && delivery.retryAt > Date.now()) return;
      if (!this.allowed(userId, snapshot.config)) {
        delete state.delivery;
        this.deps.store.put(state);
        return;
      }
      const part = delivery.parts[delivery.next];
      if (!part) {
        delete state.delivery;
        this.deps.store.put(state);
        return;
      }
      const controller = new AbortController();
      this.controllers.set(userId, controller);
      try {
        await this.deps.telegram.sendPart(userId, part, {
          signal: controller.signal,
        });
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "permanent" in error &&
          error.permanent
        ) {
          const current = this.deps.store.get(userId);
          delete current.delivery;
          this.deps.store.put(current);
        } else {
          const current = this.deps.store.get(userId);
          if (current.delivery) {
            const failures = (current.delivery.failures ?? 0) + 1;
            const retryAfter =
              error &&
              typeof error === "object" &&
              "retryAfter" in error &&
              typeof error.retryAfter === "number"
                ? error.retryAfter * 1000
                : 0;
            current.delivery.failures = failures;
            current.delivery.retryAt =
              Date.now() +
              Math.max(
                retryAfter,
                Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5)),
              );
            this.deps.store.put(current);
          }
        }
        return;
      } finally {
        this.controllers.delete(userId);
      }
      // Reload state: access/config watcher may have cancelled this exact outbox while send was pending.
      const current = this.deps.store.get(userId);
      if (current.delivery) {
        delete current.delivery.retryAt;
        delete current.delivery.failures;
        current.delivery.next++;
        if (current.delivery.next >= current.delivery.parts.length)
          delete current.delivery;
        this.deps.store.put(current);
      }
    }
  }
  private async safeText(
    userId: number,
    text: string,
    diagnostic = false,
  ): Promise<void> {
    const snapshot = this.deps.config.snapshot(),
      config = snapshot.valid ? snapshot.config : snapshot.lastValid;
    if (
      this.closed ||
      !config ||
      !this.allowed(userId, config) ||
      (!snapshot.valid && !(diagnostic && userId === config.ownerId))
    )
      return;
    try {
      await this.deps.telegram.sendText(userId, text, { signal: this.controlAbort.signal });
    } catch {}
  }
  private async command(
    command: string,
    state: DialogueState,
    config: BotConfig,
  ): Promise<void> {
    const id = state.userId;
    switch (command) {
      case "start":
      case "help":
        await this.safeText(
          id,
          "Отправьте текст для Codex или до 10 фото и файлов. Текст задания можно добавить в подписи или отправить отдельным сообщением после материалов. /new — сброс диалога и материалов; /text — последний ответ текстом; /status — состояние." +
            (id === config.ownerId
              ? " /users — список доступа; /model — выбор модели."
              : ""),
        );
        break;
      case "status": {
        let text = this.busy(state)
          ? "Запрос обрабатывается или доставляется."
          : "Ваш диалог готов к новому запросу.";
        if (id === config.ownerId) {
          let health;
          try {
            health = await this.deps.engine.health(this.controlAbort.signal);
          } catch {
            health = { available: false };
          }
          text += `\nАктивных запросов: ${this.deps.store.all().filter((s) => this.busy(s)).length}/${config.maxConcurrentRequests}. Codex: ${health.available ? "доступен" : "недоступен"}.`;
        }
        await this.safeText(id, text);
        break;
      }
      case "users":
        if (id === config.ownerId)
          await this.safeText(
            id,
            [...new Set([config.ownerId, ...config.allowedUserIds])]
              .map((userId) => {
                const u = this.deps.store.get(userId);
                return `${userId}${u.username ? ` @${u.username}` : ""}${userId === config.ownerId ? " (владелец)" : ""}`;
              })
              .join("\n"),
          );
        break;
      case "new":
        await this.safeText(id, BUSY);
        break;
      case "text":
        await this.safeText(
          id,
          this.busy(state) ? BUSY : "В текущем диалоге ещё нет ответа.",
        );
        break;
      case "model":
        if (id === config.ownerId) {
          if (this.busy(state)) {
            await this.safeText(id, BUSY);
            break;
          }
          await this.showModels(id);
        }
        break;
      default:
        await this.safeText(id, "Неизвестная команда. Список команд: /help.");
    }
  }
  private async reset(userId: number): Promise<void> {
    const state = this.deps.store.get(userId);
    if (!state.reset) return;
    try {
      for (const id of state.reset.threadIds)
        await this.deps.engine.deleteThread(id);
    } catch {
      return;
    }
    delete state.reset;
    delete state.threadId;
    delete state.lastResponse;
    state.history = [];
    delete state.pending;
    state.delivery = {
      parts: [
        { kind: "text", text: "Диалог сброшен. Отправьте новый запрос." },
      ],
      next: 0,
    };
    this.deps.store.put(state);
    await this.deliver(userId);
  }
  private async models(): Promise<ModelInfo[]> {
    return this.deps.engine.listModels(this.controlAbort.signal);
  }
  private ownerIdle(userId: number): boolean {
    const snapshot = this.deps.config.snapshot();
    return (
      snapshot.valid &&
      !this.closed &&
      snapshot.config.ownerId === userId &&
      !this.busy(this.deps.store.get(userId))
    );
  }
  private pick(model: string, effort?: string): string {
    const token = randomBytes(8).toString("hex");
    this.picker.set(token, { model, ...(effort ? { effort } : {}) });
    return `pick:${token}`;
  }
  private invalidatePicker(): void {
    this.pickerRevision++;
    this.picker.clear();
  }
  private async showModels(userId: number): Promise<void> {
    const revision = this.pickerRevision;
    try {
      const models = await this.models(),
        selection = this.deps.store.get(userId).selection ?? {
          model: "gpt-6.1-sol",
          effort: "medium",
        };
      if (revision !== this.pickerRevision || !this.ownerIdle(userId)) return;
      this.picker.clear();
      await this.deps.telegram.sendText(
        userId,
        `Текущая модель: ${selection.model}, рассуждение: ${selection.effort}. Выберите модель:`,
        {
          signal: this.controlAbort.signal,
          reply_markup: {
            inline_keyboard: models
              .slice(0, 100)
              .map((m) => [
                { text: m.displayName ?? m.id, callback_data: this.pick(m.id) },
              ]),
          },
        },
      );
    } catch {
      await this.safeText(
        userId,
        "Каталог моделей сейчас недоступен. Повторите /model позже.",
      );
    }
  }
  private async modelCallback(
    userId: number,
    callbackId: string,
    data: string | undefined,
    config: BotConfig,
  ): Promise<void> {
    if (userId !== config.ownerId) return;
    const revision = this.pickerRevision;
    if (!this.ownerIdle(userId)) {
      try {
        await this.deps.telegram.answerCallback(callbackId, BUSY, this.controlAbort.signal);
      } catch {}
      return;
    }
    try {
      const token = /^pick:([a-f0-9]{16})$/.exec(data ?? "")?.[1],
        choice = token ? this.picker.get(token) : undefined;
      if (!choice) throw new Error("Invalid selection");
      const models = await this.models(),
        model = models.find((m) => m.id === choice.model);
      if (!model || revision !== this.pickerRevision || !this.ownerIdle(userId))
        throw new Error("Invalid selection");
      if (!choice.effort) {
        this.picker.clear();
        await this.deps.telegram.sendText(
          userId,
          `Модель ${model.id}. Выберите уровень рассуждения:`,
          {
            signal: this.controlAbort.signal,
            reply_markup: {
              inline_keyboard: model.supportedEfforts.map((effort) => [
                { text: effort, callback_data: this.pick(model.id, effort) },
              ]),
            },
          },
        );
      } else {
        if (!model.supportedEfforts.includes(choice.effort))
          throw new Error("Invalid selection");
        const current = this.deps.store.get(userId);
        current.selection = { model: model.id, effort: choice.effort };
        this.deps.store.put(current);
        this.picker.clear();
        await this.safeText(userId, `Выбраны ${model.id}, ${choice.effort}.`);
      }
      await this.deps.telegram.answerCallback(callbackId, undefined, this.controlAbort.signal);
    } catch {
      try {
        await this.deps.telegram.answerCallback(
          callbackId,
          "Выбор недоступен. Повторите /model.",
          this.controlAbort.signal,
        );
      } catch {}
    }
  }
  private reloaded(snapshot: ConfigSnapshot): void {
    if (!snapshot.valid) {
      for (const [id, controller] of this.controllers)
        if (this.preparing.has(id)) controller.abort(new AttachmentError("Обработка приостановлена. После исправления настроек повторите текст задания; материалы сохранены."));
        else if (!this.deps.store.get(id).request) controller.abort();
      return;
    }
    for (const state of this.deps.store.all())
      if (!this.allowed(state.userId, snapshot.config)) {
        this.cancelAlbum(state.userId);
        if (state.pending) {
          state.pending.captions = [];
          delete state.pending.readyAt;
          state.pending.awaitingTask = true;
        }
        if (state.request) state.request.revoked = true;
        delete state.delivery;
        this.deps.store.put(state);
        if (!state.request || this.preparing.has(state.userId)) this.controllers.get(state.userId)?.abort();
      }
    for (const state of this.deps.store.all())
      if (this.allowed(state.userId, snapshot.config) && state.pending?.readyAt && !this.albums.has(state.userId))
        this.scheduleAlbum(state.userId, state.pending.readyAt);
    this.resume();
  }
  private resume(): void {
    if (this.closed || !this.deps.config.snapshot().valid) return;
    for (const state of this.deps.store.all())
      if (!this.jobs.has(state.userId)) {
        if (state.reset)
          this.launch(state.userId, () => this.reset(state.userId));
        else if (state.delivery)
          this.launch(state.userId, () => this.deliver(state.userId));
      }
  }
  async discardOfflineUpdates(updates: TelegramUpdate[]): Promise<void> {
    for (const update of updates) {
      if (update.update_id < this.deps.store.offset) continue;
      const snapshot = this.deps.config.snapshot(),
        message = update.message,
        from = message?.from;
      if (
        snapshot.valid &&
        message?.chat.type === "private" &&
        from?.id === message.chat.id &&
        this.allowed(from.id, snapshot.config) &&
        (message.text || message.photo?.length || message.document) &&
        !this.offlineNotified.has(from.id)
      ) {
        this.offlineNotified.add(from.id);
        const state = this.deps.store.get(from.id);
        const notice: OutgoingPart = {
          kind: "text",
          text: "Бот был недоступен. Пожалуйста, повторите пропущенный запрос.",
        };
        if (state.delivery) state.delivery.parts.push(notice);
        else state.delivery = { parts: [notice], next: 0 };
        this.deps.store.accept(update.update_id, state);
      } else this.deps.store.accept(update.update_id);
    }
    this.resume();
    await this.drain();
  }
  async recover(): Promise<void> {
    for (const state of this.deps.store.all()) {
      if (state.pending) {
        state.pending.captions = [];
        delete state.pending.readyAt;
        if (!state.request && !state.delivery)
          state.delivery = { parts: [{ kind: "text", text: "Материалы сохранены. После перезапуска повторите текст задания." }], next: 0 };
        this.deps.store.put(state);
      }
      if (state.request) {
        const threadId = state.request.threadId ?? state.threadId,
          revoked = state.request.revoked;
        delete state.request;
        delete state.threadId;
        if (!revoked)
          state.delivery = { parts: [{ kind: "text", text: REPEAT }], next: 0 };
        this.deps.store.put(state);
        if (threadId)
          void this.deps.engine.deleteThread(threadId).catch(() => {});
      }
    }
    this.reloaded(this.deps.config.snapshot());
    await this.drain();
  }
  async drain(): Promise<void> {
    while (this.jobs.size || this.controlJobs.size || this.albums.size)
      await Promise.all([...this.jobs.values(), ...this.controlJobs, ...[...this.albums.values()].map((a) => a.done)]);
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    for (const id of this.albums.keys()) this.cancelAlbum(id);
    clearInterval(this.retryTimer);
    this.unsubscribe();
    this.controlAbort.abort(new Error("Bot shutting down"));
    for (const controller of this.controllers.values())
      controller.abort(new Error("Bot shutting down"));
    await this.drain();
  }
}

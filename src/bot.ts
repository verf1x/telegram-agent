import { randomBytes, randomUUID } from "node:crypto";
import type {
  AttachmentReader,
  DialogueAddress,
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
import { dialogueKey, ATTACHMENT_LIMITS, AttachmentError, ImageGenerationError, ResponseFileError } from "./contracts.ts";
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
const OPEN_TOPIC = "Откройте или создайте тему в личном чате и отправьте запрос в ней. Каждая тема хранит отдельный диалог.";
const BUSY =
  "Запрос ещё обрабатывается или доставляется. Дождитесь завершения и повторите сообщение.";
export function createBot(deps: Dependencies): BotController {
  return new BotController(deps);
}
export class BotController implements Bot {
  private readonly deps: Dependencies;
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly controlJobs = new Set<Promise<void>>();
  private readonly controlAbort = new AbortController();
  private readonly topicControls = new Map<string, AbortController>();
  private readonly preparing = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly albums = new Map<string, { timer: ReturnType<typeof setTimeout>; done: Promise<void>; resolve: () => void }>();
  private readonly offlineNotified = new Set<string>();
  private readonly unsubscribe: () => void;
  private readonly retryTimer: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly pickerRevision = new Map<string, number>();
  private readonly picker = new Map<
    string,
    { model: string; effort?: string; key: string }
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
      state.deleting ||
      state.legacyBinding ||
      this.jobs.has(dialogueKey(state)),
    );
  }
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (this.closed || update.update_id < this.deps.store.offset) return;
    const snapshot = this.deps.config.snapshot();
    const config = snapshot.valid ? snapshot.config : snapshot.lastValid;
    const callback = update.callback_query;
    const message = callback?.message ?? update.message;
    const from = callback?.from ?? message?.from;
    if (snapshot.valid && !callback && message?.chat.type === "private" && message.forum_topic_created && message.message_thread_id && this.allowed(message.chat.id, snapshot.config)) {
      const legacy = this.deps.store.get(message.chat.id);
      if (legacy.migration && message.forum_topic_created.name === "Предыдущий диалог") {
        this.adoptLegacy(message.chat.id, message.message_thread_id);
      }
      this.deps.store.accept(update.update_id);
      return;
    }
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
    const address: DialogueAddress = {userId, ...(message.message_thread_id ? {topicId: message.message_thread_id} : {})};
    if (!snapshot.valid) {
      this.deps.store.accept(update.update_id);
      if (
        !callback &&
        userId === config.ownerId &&
        /^\/status(?:@\w+)?(?:\s|$)/.test(message.text ?? "")
      )
        this.control(() => this.safeText(
          address,
          `Работа приостановлена: ${snapshot.error}`,
          true,
        ));
      return;
    }
    if (callback) {
      if (callback.data?.startsWith("delete:")) {
        this.deleteCallback(address, callback.id, callback.data, update.update_id);
        return;
      }
      this.deps.store.accept(update.update_id);
      if (userId === config.ownerId) this.bumpPicker(address);
      this.control(() => this.modelCallback(address, callback.id, callback.data, config));
      return;
    }
    if (!callback && message.forum_topic_edited) {
      this.deps.store.accept(update.update_id);
      return;
    }
    this.startLegacyMigrations(userId);
    if (!address.topicId) {
      this.deps.store.accept(update.update_id);
      const command = /^\/(start|help|status|users)(?:@\w+)?(?:\s|$)/.exec(message.text ?? "")?.[1];
      if (command) this.control(() => this.command(command, {userId, history: []}, config));
      else this.control(() => this.safeText(address, OPEN_TOPIC));
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
      this.control(() => this.safeText(address, "Отправьте текст, фото или файл: JPEG, PNG, WebP, PDF, DOCX, XLSX, PPTX либо текстовый UTF-8 документ."));
      return;
    }
    const state = this.deps.store.get(address);
    if (from.username) state.username = from.username;
    const command = /^\/(\w+)(?:@\w+)?(?:\s|$)/
      .exec(message.text ?? "")?.[1]
      ?.toLowerCase();
    if (command) {
      if (command === "delete") {
        if (state.deleting) {
          this.deps.store.accept(update.update_id);
          this.control(() => this.safeText(address, state.deleting?.error ?? "Удаление ещё выполняется."));
        } else {
          const token = randomBytes(8).toString("hex");
          state.deleteConfirmation = {token, expires: Date.now() + 300_000};
          this.deps.store.accept(update.update_id, state);
          this.control(() => this.confirmDelete(state, token));
        }
        return;
      }
      if (command === "new" && !state.deleting) {
        this.beginClear(state, update.update_id, false);
        return;
      }
      if (command === "text" && !this.busy(state) && state.lastResponse) {
        if (userId === config.ownerId) this.invalidatePicker(address);
        state.delivery = { parts: formatText(state.lastResponse), next: 0 };
        this.deps.store.accept(update.update_id, state);
        this.launch(address, () => this.deliver(address));
        return;
      }
      this.deps.store.accept(update.update_id, state);
      if (command === "model" && userId === config.ownerId && !this.busy(state))
        this.invalidatePicker(address);
      this.control(() => this.command(command, state, config));
      return;
    }
    if (this.busy(state)) {
      this.deps.store.accept(update.update_id, state);
      this.control(() => this.safeText(address, BUSY));
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
        this.cancelAlbum(address);
        state.pending ??= { refs: [], captions: [] };
        state.pending.captions = [];
        delete state.pending.readyAt;
        state.pending.awaitingTask = true;
        this.deps.store.accept(update.update_id, state);
        this.control(() => this.safeText(address, "Не более 10 вложений, 20 МБ на файл и 50 МБ на задание. Вложение отклонено; остальные материалы сохранены. Разделите материалы и повторите текст задания или очистите их через /new."));
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
        this.scheduleAlbum(address, state.pending.readyAt);
        return;
      }
    }
    if (!text?.trim()) {
      this.deps.store.accept(update.update_id, state);
      this.control(() => this.safeText(address, "Материалы сохранены. Отправьте текст задания; /new — удалить материалы."));
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
    const address = state;
    const userId = state.userId;
    if (this.busy(state)) return;
    if (this.deps.store.all().filter((s) => this.busy(s)).length >= config.maxConcurrentRequests) {
      if (state.pending) {
        state.pending.captions = [];
        delete state.pending.readyAt;
      }
      if (updateId === undefined) this.deps.store.put(state);
      else this.deps.store.accept(updateId, state);
      this.control(() => this.safeText(address, "Все места обработки заняты. Повторите запрос позже."));
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
    if (userId === config.ownerId) this.invalidatePicker(address);
    if (updateId === undefined) this.deps.store.put(state);
    else this.deps.store.accept(updateId, state);
    this.launch(address, () => this.process(address, config));
  }
  private cancelAlbum(address: DialogueAddress): void {
    const album = this.albums.get(dialogueKey(address));
    if (!album) return;
    clearTimeout(album.timer);
    this.albums.delete(dialogueKey(address));
    album.resolve();
  }
  private scheduleAlbum(address: DialogueAddress, readyAt: number): void {
    const userId = address.userId;
    this.cancelAlbum(address);
    let resolve!: () => void;
    const done = new Promise<void>((r) => { resolve = r; });
    const timer = setTimeout(() => {
      this.albums.delete(dialogueKey(address));
      try {
        const snapshot = this.deps.config.snapshot();
        const state = this.deps.store.get(address);
        if (!snapshot.valid || !this.allowed(userId, snapshot.config) || !state.pending) return;
        if (this.busy(state)) {
          state.pending.captions = [];
          delete state.pending.readyAt;
          this.deps.store.put(state);
          this.control(() => this.safeText(address, BUSY));
          return;
        }
        const text = state.pending.captions.join("\n\n");
        state.pending.captions = [];
        delete state.pending.readyAt;
        this.deps.store.put(state);
        if (text.trim()) this.dispatch(state, text, snapshot.config);
        else this.control(() => this.safeText(address, "Материалы сохранены. Отправьте текст задания; /new — удалить материалы."));
      } finally { resolve(); }
    }, Math.max(0, readyAt - Date.now()));
    this.albums.set(dialogueKey(address), { timer, done, resolve });
  }
  private control(work: () => Promise<void>): void {
    // Controls start after durable acceptance, but never occupy a user's request slot.
    const task = work().catch(() => {}).finally(() => this.controlJobs.delete(task));
    this.controlJobs.add(task);
  }
  private launch(address: DialogueAddress, work: () => Promise<void>): void {
    if (this.closed || this.jobs.has(dialogueKey(address))) return;
    // Defer work so the busy marker is installed before any adapter callback can re-enter.
    const task = Promise.resolve()
      .then(work)
      .catch(() => {})
      .finally(() => {
        this.jobs.delete(dialogueKey(address));
        this.controllers.delete(dialogueKey(address));
        this.resume();
      });
    this.jobs.set(dialogueKey(address), task);
  }
  private async process(address: DialogueAddress, config: BotConfig): Promise<void> {
    const userId = address.userId;
    const state = this.deps.store.get(address),
      request = state.request;
    if (!request) return;
    const controller = new AbortController();
    this.controllers.set(dialogueKey(address), controller);
    const timer = setTimeout(
      () => controller.abort(new Error("Request timed out")),
      config.requestTimeoutMs,
    );
    const typing = setInterval(() => {
      const s = this.deps.config.snapshot();
      if (s.valid && this.allowed(userId, s.config))
        void this.deps.telegram
          .typing(userId, controller.signal, address.topicId)
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
      this.ensureActive(address, request.id, controller.signal);
      void this.deps.telegram.typing(userId, controller.signal, address.topicId).catch(() => {});
      let attachments: PreparedAttachment[] | undefined;
      if (request.attachments?.length) {
        this.preparing.add(dialogueKey(address));
        if (!this.deps.attachments || !this.deps.telegram.downloadFile)
          throw new AttachmentError("Обработка вложений сейчас недоступна. Повторите задание позже.");
        const files = [];
        let total = 0;
        for (const [index, ref] of request.attachments.entries()) {
          this.ensureActive(address, request.id, controller.signal);
          const savedId = state.pending?.savedFiles?.[ref.fileId];
          const bytes = savedId ? this.deps.store.readFile(address,savedId)
            : await this.abortable(this.deps.telegram.downloadFile(ref.fileId, ATTACHMENT_LIMITS.fileBytes, controller.signal), controller.signal);
          this.ensureActive(address, request.id, controller.signal);
          total += bytes.byteLength;
          const remaining = request.attachments.slice(index + 1).reduce((n, r) => n + (r.size ?? 0), 0);
          if (bytes.byteLength > ATTACHMENT_LIMITS.fileBytes || total + remaining > ATTACHMENT_LIMITS.batchBytes)
            throw new AttachmentError("Превышен размер материалов: 20 МБ на файл, 50 МБ на задание. Разделите материалы или используйте /new.");
          files.push({ name: ref.name, mime: ref.mime, bytes });
          const current = this.deps.store.get(address);
          if (current.pending && !current.pending.savedFiles?.[ref.fileId]) {
            const saved = this.deps.store.saveFile(address,{name:ref.name,mime:ref.mime,bytes},config.dialogueFileBytes);
            (current.pending.savedFiles ??= {})[ref.fileId] = saved.id;
            this.deps.store.put(current);
          }
        }
        this.ensureActive(address, request.id, controller.signal);
        try {
          attachments = await this.abortable(this.deps.attachments.prepare(files, controller.signal), controller.signal);
        } catch (error) {
          if (!(error instanceof AttachmentError) || !error.message.includes("Экспортируйте его в PDF")) throw error;
          // Complex Office layouts still have their original bytes available to
          // document tools. Never present an incomplete extraction as complete.
          attachments = files.map(file=>({name:file.name,text:"Предварительное чтение оформления недоступно. Исходный файл сохранён в материалах диалога; изучите его инструментами среды документов. Сообщите о потерях оформления, если они неизбежны.",images:[]}));
        }
        this.ensureActive(address, request.id, controller.signal);
        if (attachments.length !== files.length)
          throw new AttachmentError("Не удалось подготовить все материалы. Файлы сохранены; повторите текст задания или используйте /new.");
        const context = [...state.history.flatMap((m) => m.attachments ?? []), ...attachments];
        if (Buffer.byteLength(JSON.stringify(context)) > ATTACHMENT_LIMITS.dialogueBytes)
          throw new AttachmentError("Материалы заняли весь контекст диалога. Начните новый диалог через /new и разделите материалы.");
        const images = attachments.flatMap((a) => a.images);
        if (images.reduce((n, i) => n + Buffer.byteLength(i.base64, "base64"), 0) > ATTACHMENT_LIMITS.imageBytes)
          throw new AttachmentError("Слишком большой объём изображений во вложениях. Разделите материалы или очистите диалог через /new.");
        if (attachments.reduce((n, a) => n + Buffer.byteLength(a.text), 0) > ATTACHMENT_LIMITS.textBytes)
          throw new AttachmentError("Слишком много текста во вложениях. Разделите материалы или очистите диалог через /new.");
      }
      this.preparing.delete(dialogueKey(address));
      this.ensureActive(address, request.id, controller.signal);
      engineStarted = true;
      const response = await Promise.race([
        this.deps.engine.run({
          userId,
          topicId: address.topicId,
          text: request.text,
          ...(attachments ? { attachments } : {}),
          ...selection,
          ...(state.threadId
            ? { threadId: state.threadId }
            : { history: state.history }),
          files: this.deps.store.listFiles(address),
          readFile: (id) => this.deps.store.readFile(address,id),
          onFile: async (file) => {
            this.ensureActive(address,request.id,controller.signal);
            return this.deps.store.saveResponseFile(address,request.id,file,config.dialogueFileBytes);
          },
          signal: controller.signal,
          onThread: (id) => {
            const current = this.deps.store.get(address);
            if (current.request?.id === request.id) {
              current.request.threadId = id;
              this.deps.store.put(current);
            } else {
              // The engine awaits this callback before creating native files.
              throw new Error("Dialogue allocation cancelled");
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
      const current = this.deps.store.get(address);
      if (current.request?.id !== request.id) return;
      current.threadId = response.threadId;
      current.history.push(
        { role: "user", text: request.text, ...(attachments ? { attachments } : {}) },
        { role: "assistant", text: response.text },
      );
      if (attachments) delete current.pending;
      const fileIds = current.request.fileIds ?? [];
      const readyImages = [];
      let imageWarning = "";
      for (const image of response.images) {
        try { this.deps.store.saveFile(address,image,config.dialogueFileBytes); readyImages.push(image); }
        catch (error) {
          if (!(error instanceof ResponseFileError)) throw error;
          imageWarning = "\n\nГотова только часть изображений. " + error.message;
        }
      }
      const answer = {...response,text:response.text+imageWarning,images:readyImages};
      current.lastResponse = answer.text;
      const revoked = current.request.revoked;
      delete current.request;
      if (!revoked)
        current.delivery = { parts: [...formatAnswer(answer),...fileIds.map(id=>({kind:"file" as const,id}))], next: 0 };
      this.deps.store.put(current);
    } catch (error) {
      if (this.closed) return;
      const current = this.deps.store.get(address);
      if (current.request?.id !== request.id) return;
      const poisoned = engineStarted ? current.request?.threadId ?? current.threadId : undefined;
      const revoked = current.request?.revoked;
      const fileIds = current.request?.fileIds ?? [];
      delete current.request;
      if (engineStarted) delete current.threadId;
      if (poisoned) current.retiredThreadIds = [...new Set([...(current.retiredThreadIds ?? []), poisoned])];
      if (!revoked)
        current.delivery = {
          parts: [
            {
              kind: "text",
              text: (fileIds.length ? "Готова только часть задания; созданные файлы приложены. " : "") + (error instanceof AttachmentError || error instanceof ImageGenerationError || error instanceof ResponseFileError ? error.message : controller.signal.aborted
                ? "Время обработки запроса истекло. Пожалуйста, повторите запрос."
                : "Не удалось обработать запрос. Пожалуйста, повторите позже."),
            },
            ...fileIds.map(id=>({kind:"file" as const,id})),
          ],
          next: 0,
        };
      this.deps.store.put(current);
      if (poisoned)
        void this.deps.engine.deleteThread(poisoned).catch(() => {});
    } finally {
      this.preparing.delete(dialogueKey(address));
      clearTimeout(timer);
      clearInterval(typing);
      this.controllers.delete(dialogueKey(address));
    }
    if (!this.closed) await this.deliver(address);
  }
  private ensureActive(address: DialogueAddress, requestId: string, signal: AbortSignal): void {
    const userId = address.userId;
    signal.throwIfAborted();
    const snapshot = this.deps.config.snapshot();
    const request = this.deps.store.get(address).request;
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
  private async deliver(address: DialogueAddress): Promise<void> {
    const userId = address.userId;
    while (!this.closed) {
      const snapshot = this.deps.config.snapshot();
      if (!snapshot.valid) return;
      const state = this.deps.store.get(address),
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
      this.controllers.set(dialogueKey(address), controller);
      try {
        if (part.kind === "file") {
          const file = this.deps.store.listFiles(address).find(file=>file.id===part.id);
          if (!file || !this.deps.telegram.sendFile) throw new Error("File delivery unavailable");
          await this.abortable(this.deps.telegram.sendFile(userId,{...file,bytes:this.deps.store.readFile(address,file.id)},{signal:controller.signal,message_thread_id:address.topicId}),controller.signal);
        } else await this.abortable(this.deps.telegram.sendPart(userId, part, {
          signal: controller.signal,
          message_thread_id: address.topicId,
        }), controller.signal);
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "permanent" in error &&
          error.permanent
        ) {
          const current = this.deps.store.get(address);
          if (part.kind === "file" && current.delivery && "code" in error && error.code === 400) {
            current.delivery.parts[current.delivery.next] = {kind:"text",text:"Не удалось доставить один из файлов. Он сохранён в диалоге; попросите отправить его повторно."};
            this.deps.store.put(current);
            continue;
          }
          delete current.delivery;
          this.deps.store.put(current);
        } else {
          const current = this.deps.store.get(address);
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
        this.controllers.delete(dialogueKey(address));
      }
      // Reload state: access/config watcher may have cancelled this exact outbox while send was pending.
      const current = this.deps.store.get(address);
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
  private topicSignal(address: DialogueAddress): AbortSignal {
    const key = dialogueKey(address);
    let controller = this.topicControls.get(key);
    if (!controller) { controller = new AbortController(); this.topicControls.set(key, controller); }
    return AbortSignal.any([this.controlAbort.signal, controller.signal]);
  }
  private async safeText(
    address: DialogueAddress,
    text: string,
    diagnostic = false,
  ): Promise<void> {
    const userId = address.userId;
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
      await this.deps.telegram.sendText(userId, text, { signal: this.topicSignal(address), message_thread_id: address.topicId });
    } catch {}
  }
  private async command(
    command: string,
    state: DialogueState,
    config: BotConfig,
  ): Promise<void> {
    const address = state;
    const id = state.userId;
    switch (command) {
      case "start":
      case "help":
        await this.safeText(
          address,
          OPEN_TOPIC + " Создание и переименование доступны в интерфейсе Telegram. /delete — удалить текущую тему и данные после подтверждения; штатное удаление темы не гарантирует немедленную очистку данных бота. Отправьте текст для Codex или до 10 фото и файлов. Текст задания можно добавить в подписи или отправить отдельным сообщением после материалов. Для получения документа попросите PDF, Word, Excel, презентацию или другой файл; до 10 файлов по 50 МБ. Для создания изображения напишите, например, «Нарисуй кота-космонавта»; образцы присылайте в этот диалог. Действуют возможности модели и лимиты подписки. /new — сброс диалога и материалов; /text — последний ответ текстом; /status — состояние." +
            (id === config.ownerId
              ? " /users — список доступа; /model — выбор модели."
              : ""),
        );
        break;
      case "status": {
        let text = !state.topicId ? OPEN_TOPIC : this.busy(state)
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
        const incomplete = this.deps.store.all().filter(s => s.userId === state.userId && s.deleting?.error).length;
        if (incomplete) text += `\nНезавершённых удалений: ${incomplete}. Полная очистка ещё не подтверждена; бот повторяет попытки.`;
        await this.safeText(address, text);
        break;
      }
      case "users":
        if (id === config.ownerId)
          await this.safeText(
            address,
            [...new Set([config.ownerId, ...config.allowedUserIds])]
              .map((userId) => {
                const u = this.deps.store.all().find(s => s.userId === userId);
                return `${userId}${u?.username ? ` @${u?.username}` : ""}${userId === config.ownerId ? " (владелец)" : ""}`;
              })
              .join("\n"),
          );
        break;
      case "new":
        await this.safeText(address, BUSY);
        break;
      case "text":
        await this.safeText(
          address,
          this.busy(state) ? BUSY : "В текущем диалоге ещё нет ответа.",
        );
        break;
      case "model":
        if (id === config.ownerId) {
          if (this.busy(state)) {
            await this.safeText(address, BUSY);
            break;
          }
          await this.showModels(address);
        }
        break;
      default:
        await this.safeText(address, "Неизвестная команда. Список команд: /help.");
    }
  }
  private async confirmDelete(state: DialogueState, token: string): Promise<void> {
    if (this.deps.store.get(state).deleteConfirmation?.token !== token) return;
    try {
      await this.deps.telegram.sendText(state.userId,
        "Удалить эту тему со всеми сообщениями, контекстом и материалами? Это действие необратимо.", {
          signal: this.topicSignal(state), message_thread_id: state.topicId,
          reply_markup: {inline_keyboard: [[
            {text: "Удалить тему", callback_data: `delete:yes:${token}`},
            {text: "Отмена", callback_data: `delete:no:${token}`},
          ]]},
        });
    } catch {}
  }
  private deleteCallback(address: DialogueAddress, callbackId: string, data: string, updateId: number): void {
    const match = /^delete:(yes|no):([a-f0-9]{16})$/.exec(data);
    const state = this.deps.store.get(address), confirmation = state.deleteConfirmation;
    let text = "Подтверждение устарело. Повторите /delete в нужной теме.";
    if (address.topicId && match && confirmation && confirmation.token === match[2] && confirmation.expires > Date.now() && !state.deleting) {
      if (match[1] === "yes") {
        this.beginClear(state, updateId, true);
        text = "Удаление начато.";
      } else {
        delete state.deleteConfirmation;
        this.deps.store.accept(updateId, state);
        text = "Удаление отменено.";
      }
    } else this.deps.store.accept(updateId);
    this.control(() => this.deps.telegram.answerCallback(callbackId, text, this.controlAbort.signal));
  }
  private async deleteDialogue(address: DialogueAddress): Promise<void> {
    const state = this.deps.store.get(address), deleting = state.deleting;
    if (!deleting || !address.topicId) return;
    try {
      if (!deleting.telegramDeleted) {
        await this.deps.telegram.deleteTopic(address.userId, address.topicId, this.controlAbort.signal);
        deleting.telegramDeleted = true;
        delete deleting.error;
        this.deps.store.put(state);
      }
      for (const id of deleting.threadIds) await this.deps.engine.deleteThread(id);
      this.deps.store.remove(address);
    } catch {
      const firstFailure = !deleting.error;
      deleting.error = deleting.telegramDeleted
        ? "Тема удалена из Telegram, очистка сохранённых данных ещё не завершена. Бот повторит очистку."
        : "Не удалось удалить тему из Telegram. Полное удаление не завершено; бот повторит попытку.";
      deleting.retryAt = Date.now() + 5000;
      this.deps.store.put(state);
      if (firstFailure && !deleting.telegramDeleted) await this.safeText(address, deleting.error);
    }
  }
  private beginClear(state: DialogueState, updateId: number, deleting: boolean): void {
    const threadIds = [...new Set([state.threadId, state.request?.threadId, ...(state.retiredThreadIds ?? []), ...(state.reset?.threadIds ?? [])].filter((id): id is string => Boolean(id)))];
    const cleared: DialogueState = {
      userId: state.userId, topicId: state.topicId, history: [],
      ...(state.username ? {username: state.username} : {}),
      ...(state.selection ? {selection: state.selection} : {}),
      ...(deleting ? {deleting: {id: randomUUID(), threadIds}} : {reset: {id: randomUUID(), threadIds}}),
    };
    // Durable cancellation precedes abort: every late callback sees the tombstone.
    this.deps.store.accept(updateId, cleared);
    this.cancelAlbum(state);
    this.topicControls.get(dialogueKey(state))?.abort();
    this.topicControls.delete(dialogueKey(state));
    this.invalidatePicker(state);
    this.controllers.get(dialogueKey(state))?.abort(new Error("Dialogue cleared"));
    this.resume();
  }
  private async reset(address: DialogueAddress): Promise<void> {
    let state = this.deps.store.get(address);
    if (!state.reset) return;
    const operationId = state.reset.id;
    try {
      for (const id of state.reset.threadIds)
        await this.deps.engine.deleteThread(id);
    } catch {
      state = this.deps.store.get(address);
      if (!state.reset || state.reset.id !== operationId) return;
      state.reset.retryAt = Date.now() + 5000;
      this.deps.store.put(state);
      await this.safeText(address, "Не удалось полностью очистить диалог. Повторяем очистку; тема временно занята.");
      return;
    }
    state = this.deps.store.get(address);
    if (!state.reset || state.reset.id !== operationId) return;
    this.deps.store.deleteFiles(address);
    delete state.reset;
    delete state.threadId;
    delete state.retiredThreadIds;
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
    await this.deliver(address);
  }
  private async models(): Promise<ModelInfo[]> {
    return this.deps.engine.listModels(this.controlAbort.signal);
  }
  private ownerIdle(address: DialogueAddress): boolean {
    const userId = address.userId;
    const snapshot = this.deps.config.snapshot();
    return (
      snapshot.valid &&
      !this.closed &&
      snapshot.config.ownerId === userId &&
      !this.busy(this.deps.store.get(address))
    );
  }
  private pick(address: DialogueAddress, model: string, effort?: string): string {
    const token = randomBytes(8).toString("hex");
    this.picker.set(token, { key: dialogueKey(address), model, ...(effort ? { effort } : {}) });
    return `pick:${token}`;
  }
  private bumpPicker(address: DialogueAddress): void {
    const key = dialogueKey(address);
    this.pickerRevision.set(key, (this.pickerRevision.get(key) ?? 0) + 1);
  }
  private clearPicker(address: DialogueAddress): void {
    for (const [token, choice] of this.picker) if (choice.key === dialogueKey(address)) this.picker.delete(token);
  }
  private invalidatePicker(address: DialogueAddress): void {
    this.bumpPicker(address);
    this.clearPicker(address);
  }
  private async showModels(address: DialogueAddress): Promise<void> {
    const userId = address.userId;
    const signal = this.topicSignal(address);
    const revision = this.pickerRevision.get(dialogueKey(address));
    try {
      const models = await this.models(),
        selection = this.deps.store.get(address).selection ?? {
          model: "gpt-6.1-sol",
          effort: "medium",
        };
      if (revision !== this.pickerRevision.get(dialogueKey(address)) || !this.ownerIdle(address)) return;
      this.clearPicker(address);
      await this.deps.telegram.sendText(
        userId,
        `Текущая модель: ${selection.model}, рассуждение: ${selection.effort}. Выберите модель:`,
        {
          signal,
          message_thread_id: address.topicId,
          reply_markup: {
            inline_keyboard: models
              .slice(0, 100)
              .map((m) => [
                { text: m.displayName ?? m.id, callback_data: this.pick(address, m.id) },
              ]),
          },
        },
      );
    } catch {
      await this.safeText(
        address,
        "Каталог моделей сейчас недоступен. Повторите /model позже.",
      );
    }
  }
  private async modelCallback(
    address: DialogueAddress,
    callbackId: string,
    data: string | undefined,
    config: BotConfig,
  ): Promise<void> {
    const userId = address.userId;
    if (userId !== config.ownerId) return;
    const signal = this.topicSignal(address);
    const revision = this.pickerRevision.get(dialogueKey(address));
    if (!this.ownerIdle(address)) {
      try {
        await this.deps.telegram.answerCallback(callbackId, BUSY, this.controlAbort.signal);
      } catch {}
      return;
    }
    try {
      const token = /^pick:([a-f0-9]{16})$/.exec(data ?? "")?.[1],
        choice = token ? this.picker.get(token) : undefined;
      if (!choice || choice.key !== dialogueKey(address)) throw new Error("Invalid selection");
      const models = await this.models(),
        model = models.find((m) => m.id === choice.model);
      if (!model || revision !== this.pickerRevision.get(dialogueKey(address)) || !this.ownerIdle(address))
        throw new Error("Invalid selection");
      if (!choice.effort) {
        this.clearPicker(address);
        await this.deps.telegram.sendText(
          userId,
          `Модель ${model.id}. Выберите уровень рассуждения:`,
          {
            signal,
            message_thread_id: address.topicId,
            reply_markup: {
              inline_keyboard: model.supportedEfforts.map((effort) => [
                { text: effort, callback_data: this.pick(address, model.id, effort) },
              ]),
            },
          },
        );
      } else {
        if (!model.supportedEfforts.includes(choice.effort))
          throw new Error("Invalid selection");
        const current = this.deps.store.get(address);
        current.selection = { model: model.id, effort: choice.effort };
        this.deps.store.put(current);
        this.clearPicker(address);
        await this.safeText(address, `Выбраны ${model.id}, ${choice.effort}.`);
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
        else if (!this.deps.store.all().find(s => dialogueKey(s) === id)?.request) controller.abort();
      return;
    }
    for (const state of this.deps.store.all())
      if (!this.allowed(state.userId, snapshot.config)) {
        this.cancelAlbum(state);
        if (state.pending) {
          state.pending.captions = [];
          delete state.pending.readyAt;
          state.pending.awaitingTask = true;
        }
        if (state.request) state.request.revoked = true;
        delete state.delivery;
        this.deps.store.put(state);
        if (!state.request || this.preparing.has(dialogueKey(state))) this.controllers.get(dialogueKey(state))?.abort();
      }
    for (const state of this.deps.store.all())
      if (this.allowed(state.userId, snapshot.config) && state.pending?.readyAt && !this.albums.has(dialogueKey(state)))
        this.scheduleAlbum(state, state.pending.readyAt);
    this.resume();
  }
  private startLegacyMigrations(userId?: number): void {
    const snapshot = this.deps.config.snapshot();
    if (!snapshot.valid || this.closed) return;
    for (const state of this.deps.store.all()) {
      if (state.topicId || state.migration?.phase === "creating" || (userId !== undefined && state.userId !== userId) || !this.allowed(state.userId, snapshot.config)) continue;
      // Persist intent before Telegram. Ambiguous failures wait for the service update,
      // never blindly call non-idempotent createForumTopic a second time.
      state.migration = {phase: "creating"};
      this.deps.store.put(state);
      this.control(async () => {
        try {
          const topicId = await this.deps.telegram.createTopic(state.userId, "Предыдущий диалог", this.controlAbort.signal);
          this.adoptLegacy(state.userId, topicId);
        } catch (error) {
          const current = this.deps.store.get(state.userId);
          if (!current.migration) return;
          if (error && typeof error === "object" && "code" in error && typeof error.code === "number" && error.code >= 400 && error.code < 500) {
            current.migration.phase = "retry";
            this.deps.store.put(current);
          }
          await this.safeText({userId: state.userId}, "Не удалось завершить перенос прежнего диалога. История и материалы сохранены. Если тема «Предыдущий диалог» уже появилась, не создавайте её повторно. Если её нет, создайте тему с этим именем для завершения переноса.");
        }
      });
    }
  }
  private adoptLegacy(userId: number, topicId: number): void {
    this.deps.store.moveLegacy(userId, topicId);
    this.resume();
  }
  private async bindLegacy(address: DialogueAddress): Promise<void> {
    const state = this.deps.store.get(address);
    if (!state.legacyBinding) return;
    try {
      if (state.threadId) {
        await this.deps.engine.bindLegacyThread(state.threadId, address);
      }
      const current = this.deps.store.get(address);
      if (!current.legacyBinding || current.threadId !== state.threadId) return;
      delete current.legacyBinding;
      delete current.bindingRetryAt;
      this.deps.store.put(current);
    } catch {
      const current = this.deps.store.get(address);
      if (!current.legacyBinding) return;
      current.bindingRetryAt = Date.now() + 30_000;
      this.deps.store.put(current);
      // Keep the original snapshot intact; a later recovery retries the binding.
      await this.safeText(address, "Прежний контекст сохранён, но перенос ещё не завершён. Повторите после перезапуска бота.");
    }
  }
  private resume(): void {
    if (this.closed || !this.deps.config.snapshot().valid) return;
    for (const state of this.deps.store.all())
      if (state.topicId && !this.jobs.has(dialogueKey(state))) {
        if (state.legacyBinding) {
          if (!state.bindingRetryAt || state.bindingRetryAt <= Date.now()) this.launch(state, () => this.bindLegacy(state));
        } else if (state.deleting && (!state.deleting.retryAt || state.deleting.retryAt <= Date.now()))
          this.launch(state, () => this.deleteDialogue(state));
        else if (state.reset && (!state.reset.retryAt || state.reset.retryAt <= Date.now()))
          this.launch(state, () => this.reset(state));
        else if (state.delivery && (!state.delivery.retryAt || state.delivery.retryAt <= Date.now()))
          this.launch(state, () => this.deliver(state));
      }
  }
  async discardOfflineUpdates(updates: TelegramUpdate[]): Promise<void> {
    for (const update of updates) {
      if (update.update_id < this.deps.store.offset) continue;
      if (update.message?.forum_topic_created) { await this.handleUpdate(update); continue; }
      const snapshot = this.deps.config.snapshot(),
        message = update.message,
        from = message?.from;
      if (
        snapshot.valid &&
        message?.chat.type === "private" &&
        from?.id === message.chat.id &&
        this.allowed(from.id, snapshot.config) &&
        (message.text || message.photo?.length || message.document) &&
        !this.offlineNotified.has(dialogueKey({userId:from.id,topicId:message.message_thread_id}))
      ) {
        this.offlineNotified.add(dialogueKey({userId:from.id,topicId:message.message_thread_id}));
        if (!message.message_thread_id) {
          this.deps.store.accept(update.update_id);
          this.control(() => this.safeText({userId: from.id}, OPEN_TOPIC));
          continue;
        }
        const state = this.deps.store.get(from.id,message.message_thread_id);
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
        const fileIds = state.request.fileIds ?? [];
        delete state.request;
        delete state.threadId;
        if (threadId) state.retiredThreadIds = [...new Set([...(state.retiredThreadIds ?? []), threadId])];
        if (!revoked)
          state.delivery = { parts: [{ kind: "text", text: REPEAT },...fileIds.map(id=>({kind:"file" as const,id}))], next: 0 };
        this.deps.store.put(state);
        if (threadId)
          void this.deps.engine.deleteThread(threadId).catch(() => {});
      }
    }
    this.startLegacyMigrations();
    this.reloaded(this.deps.config.snapshot());
    await this.drain();
  }
  async drain(): Promise<void> {
    while (this.jobs.size || this.controlJobs.size || this.albums.size)
      await Promise.all([...this.jobs.values(), ...this.controlJobs, ...[...this.albums.values()].map((a) => a.done)]);
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    for (const state of this.deps.store.all()) this.cancelAlbum(state);
    clearInterval(this.retryTimer);
    this.unsubscribe();
    this.controlAbort.abort(new Error("Bot shutting down"));
    for (const controller of this.controllers.values())
      controller.abort(new Error("Bot shutting down"));
    await this.drain();
  }
}

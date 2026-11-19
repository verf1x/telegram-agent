import { randomBytes, randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type {
  AttachmentReader,
  DialogueAddress,
  AttachmentRef,
  MaterialReference,
  PreparedAttachment,
  Bot,
  BotConfig,
  ConfigSource,
  ConfigSnapshot,
  ModelEngine,
  ModelInfo,
  ModelSelection,
  ModelResponse,
  OutgoingPart,
  SendOptions,
  TelegramMessage,
  TelegramTransport,
  TelegramUpdate,
} from "./contracts.ts";
import {
  dialogueKey,
  ATTACHMENT_LIMITS,
  AttachmentBatchError,
  AttachmentError,
  AttachmentFileError,
  AttachmentReaderUnavailableError,
  ModelContextError,
  ModelSelectionError,
  ResponseFileError,
  RequestStopped,
  isUserFacingRequestError,
} from "./contracts.ts";
import { BROADCAST_CALLBACK, BROADCAST_COMMAND, BroadcastController } from "./broadcast.ts";
import { formatAnswer, formatText } from "./telegram/format.ts";
import { DraftRateLimit, RequestPreview, STOP_CALLBACK } from "./telegram/preview.ts";
import { TelegramError } from "./telegram/transport.ts";
import { dialogueOperations, DialogueFileQuotaError, SqliteStore, StoredDialogueError, StoredFileUnavailableError } from "./store.ts";
import type { AttachmentTask, DialogueState, TaskSource } from "./store.ts";
import { compactionInput, recentHistoryStart, SUMMARY_BYTES } from "./dialogue-context.ts";
import { DEFAULT_TOPIC_TITLE, GENERIC_TOPIC_TITLE, safeTopicTitle, topicTitleInput } from "./topic-title.ts";
interface Dependencies {
  config: ConfigSource;
  store: SqliteStore;
  engine: ModelEngine;
  telegram: TelegramTransport;
  attachments?: AttachmentReader;
}
const REPEAT_CALLBACK = "repeat:";
const CAPACITY = "Все места обработки заняты. Повторите запрос позже.";
const REPEAT = "Обработка запроса прервалась. Пожалуйста, повторите запрос.";
const OPEN_TOPIC = "Откройте или создайте тему в личном чате и отправьте запрос в ней. Каждая тема хранит отдельный диалог.";
const BUSY =
  "Запрос ещё обрабатывается или доставляется. Дождитесь завершения и повторите сообщение.";
function taskText(sources: TaskSource[] = []): string {
  return sources.map(source => source.text).filter(text => text.trim()).join("\n\n");
}
function pendingSources(pending: NonNullable<DialogueState["pending"]>): TaskSource[] {
  return pending.sources ?? pending.captions?.map(text => ({ text })) ?? [];
}
function clearPendingPrompt(pending: NonNullable<DialogueState["pending"]>): void {
  delete pending.sources;
  delete pending.captions;
  delete pending.readyAt;
}
function attachmentName(name: string): string {
  return name.replace(/[\x00-\x1f\x7f]/g, "_").slice(0, 180);
}
function attachmentWarnings(task: AttachmentTask): string[] {
  return (task.attachments ?? []).flatMap((ref, index) => {
    const reason = task.excludedAttachments?.[index];
    return reason ? [`«${attachmentName(ref.name)}»: ${reason}`] : [];
  });
}
export function createBot(deps: Dependencies): BotController {
  return new BotController(deps);
}
export class BotController implements Bot {
  private readonly deps: Dependencies;
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly controlJobs = new Set<Promise<void>>();
  private readonly controlAbort = new AbortController();
  private readonly broadcasts: BroadcastController;
  private readonly topicControls = new Map<string, AbortController>();
  private readonly topicTitles = new Map<string, AbortController>();
  // At most one background naming turn, outside the slots reserved for user requests.
  private topicTitleQueue = Promise.resolve();
  private readonly preparing = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly previews = new Map<string, RequestPreview>();
  private readonly draftRateLimit = new DraftRateLimit();
  private readonly previewCleanups = new Set<string>();
  private readonly albums = new Map<string, { timer: ReturnType<typeof setTimeout>; done: Promise<void>; resolve: () => void }>();
  private readonly offlineNotified = new Set<string>();
  private readonly unsubscribeConfig: (() => void) | undefined;
  private readonly unsubscribeWork: () => void;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryAt = Infinity;
  private resumeQueued = false;
  private recovering = false;
  private readonly dialogueRetries = new Map<string, number>();
  private readonly previewRetries = new Map<string, number>();
  private closed = false;
  private backgroundErrorReported = false;
  private pendingReload: ConfigSnapshot | undefined;
  private readonly pickerRevision = new Map<string, number>();
  private readonly picker = new Map<
    string,
    { model: string; effort?: string; key: string }
  >();
  constructor(deps: Dependencies) {
    this.deps = deps;
    this.broadcasts = new BroadcastController({ ...deps, signal: this.controlAbort.signal, wake: () => this.resume() });
    this.unsubscribeWork = deps.store.watchWork(() => this.resume());
    this.unsubscribeConfig = deps.config.watch?.((snapshot) => { this.pendingReload = snapshot; this.resume(); });
  }
  private allowed(userId: number, config: BotConfig): boolean {
    return userId === config.ownerId || config.allowedUserIds.includes(userId);
  }
  private busy(state: DialogueState): boolean {
    return Boolean(
      state.request ||
      dialogueOperations(state).length ||
      this.jobs.has(dialogueKey(state)),
    );
  }
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (this.closed || update.update_id < this.deps.store.offset) return;
    try { await this.processUpdate(update); }
    catch (error) {
      if (!(error instanceof StoredDialogueError)) throw error;
      this.deps.store.accept(update.update_id);
    }
  }
  private async processUpdate(update: TelegramUpdate): Promise<void> {
    const snapshot = this.deps.config.snapshot();
    const config = snapshot.valid ? snapshot.config : snapshot.lastValid;
    const stopped = update.stopped_message_generation;
    if (stopped) {
      const address = {userId: stopped.chat.id, topicId: stopped.message_thread_id};
      const preview = this.previews.get(dialogueKey(address));
      if (snapshot.valid && stopped.chat.type === "private" && address.topicId &&
          this.allowed(address.userId, snapshot.config) && preview?.draftId === stopped.draft_id)
        this.stopRequest(address, preview.requestId, update.update_id);
      else this.deps.store.accept(update.update_id);
      return;
    }
    const callback = update.callback_query;
    const message = callback?.message ?? update.edited_message ?? update.message;
    const from = callback?.from ?? message?.from;
    if (update.message && !callback && message?.chat.type === "private" && message.message_thread_id &&
        (message.forum_topic_created || message.forum_topic_edited)) {
      const address = {userId: message.chat.id, topicId: message.message_thread_id};
      const created = message.forum_topic_created;
      if (created && snapshot.valid && this.allowed(address.userId, snapshot.config)) {
        if (created.name === "Предыдущий диалог" && this.deps.store.get(address.userId).migration) {
          this.deps.store.moveLegacy(address.userId, address.topicId);
          this.deps.store.accept(update.update_id);
        } else if (created.name === "Предыдущий диалог") {
          // The createTopic response can arrive before the migration service event.
          this.deps.store.accept(update.update_id);
        } else {
          const eligible = created.name === DEFAULT_TOPIC_TITLE || created.is_name_implicit === true;
          this.deps.store.acceptTopicCreation(update.update_id, address, eligible);
        }
      } else if (message.forum_topic_edited?.name !== undefined) {
        const state = this.deps.store.get(address);
        this.topicTitles.get(dialogueKey(address))?.abort();
        if (state.autoNameTopic) {
          delete state.autoNameTopic;
          this.deps.store.accept(update.update_id, state);
        } else this.deps.store.accept(update.update_id);
      } else this.deps.store.accept(update.update_id);
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
        update.message && !callback &&
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
      const data = callback.data;
      if (data?.startsWith(STOP_CALLBACK)) {
        const stopped = this.stopRequest(address, data.slice(STOP_CALLBACK.length), update.update_id);
        this.control(() => this.deps.telegram.answerCallback(callback.id, stopped ? "Задание остановлено" : "Задание уже завершилось", this.controlAbort.signal));
        return;
      }
      if (data?.startsWith(REPEAT_CALLBACK)) {
        const text = this.repeatTask(address, data, config, update.update_id);
        this.control(() => this.deps.telegram.answerCallback(callback.id, text, this.controlAbort.signal));
        return;
      }
      if (data?.startsWith(BROADCAST_CALLBACK)) {
        const answer = this.broadcasts.confirm(address, config.ownerId, data, update.update_id);
        if (answer) this.control(() => this.deps.telegram.answerCallback(callback.id, answer, this.controlAbort.signal));
        return;
      }
      if (callback.data?.startsWith("delete:")) {
        this.deleteCallback(address, callback.id, callback.data, update.update_id);
        return;
      }
      this.deps.store.accept(update.update_id);
      if (userId === config.ownerId) this.bumpPicker(address);
      this.control(() => this.modelCallback(address, callback.id, callback.data, config));
      return;
    }
    if (update.edited_message) {
      if (address.topicId) this.editTask(address, message, update.update_id);
      else this.deps.store.accept(update.update_id);
      return;
    }
    const broadcast = BROADCAST_COMMAND.exec(message.text ?? "");
    if (broadcast) {
      this.deps.store.accept(update.update_id);
      const text = message.text?.slice(broadcast[0].length + 1) ?? "";
      this.control(() => this.broadcasts.preview(address, config, text));
      return;
    }
    if (message.forum_topic_edited) {
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
      this.control(() => this.safeText(address, "Отправьте текст, фото или файл: JPEG, PNG, WebP, PDF, DOCX, XLSX, XLSM, PPTX либо текстовый UTF-8 документ."));
      return;
    }
    const state = this.deps.store.get(address);
    if (from.username) state.username = from.username;
    const command = /^\/(\w+)(?:@\w+)?(?:\s|$)/
      .exec(message.text ?? "")?.[1]
      ?.toLowerCase();
    if (command) {
      if (command === "retry") {
        this.retryAttachments(state, config, update.update_id);
        return;
      }
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
      const fileTooLarge = ref.size !== undefined && (
        !Number.isSafeInteger(ref.size) || ref.size < 0 || ref.size > ATTACHMENT_LIMITS.fileBytes
      );
      const batchTooLarge = refs.length > ATTACHMENT_LIMITS.files ||
        refs.reduce((n, r) => n + (r.size ?? 0), 0) > ATTACHMENT_LIMITS.batchBytes;
      if (fileTooLarge || batchTooLarge) {
        this.cancelAlbum(address);
        if (message.media_group_id) {
          state.pending ??= {refs: []};
          state.pending.blockedAlbumId = message.media_group_id;
        }
        if (state.pending) {
          clearPendingPrompt(state.pending);
          state.pending.awaitingTask = true;
        }
        this.deps.store.accept(update.update_id, state);
        const reason = fileTooLarge ? "Лимит на файл составляет 20 МБ. Пришлите файл меньшего размера."
          : "Лимит на задание составляет 10 вложений и 50 МБ. Отправьте этот файл в отдельном задании.";
        const remaining = state.pending?.refs.length ? " Отправьте текст задания, чтобы продолжить с принятыми файлами." : "";
        this.control(() => this.safeText(address, `Файл «${attachmentName(ref.name)}» отклонён. ${reason}${remaining}`));
        return;
      }
      state.pending ??= { refs: [] };
      state.pending.refs.push(ref);
    }
    const blockedAlbum = message.media_group_id && message.media_group_id === state.pending?.blockedAlbumId;
    const text = message.text ?? (blockedAlbum ? undefined : message.caption);
    if (state.pending) {
      const collectingAlbum = ref && !blockedAlbum && (message.media_group_id || state.pending.readyAt);
      if (text?.trim() || collectingAlbum) delete state.pending.awaitingTask;
      if (text?.trim() || collectingAlbum)
        (state.pending.sources ??= pendingSources(state.pending)).push({ messageId: message.message_id, text: text ?? "" });
      if (collectingAlbum) state.pending.readyAt = Date.now() + ATTACHMENT_LIMITS.albumQuietMs;
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
    this.dispatch(state, state.pending?.sources ?? [{ messageId: message.message_id, text }], config, update.update_id);
  }
  private dispatch(
    state: DialogueState,
    sources: TaskSource[],
    config: BotConfig,
    updateId?: number,
  ): void {
    const address = state;
    if (this.busy(state)) return;
    if (this.atCapacity(config)) {
      if (state.pending) {
        clearPendingPrompt(state.pending);
      }
      if (updateId === undefined) this.deps.store.put(state);
      else this.deps.store.accept(updateId, state);
      this.control(() => this.safeText(address, CAPACITY));
      return;
    }
    state.latestTask = { sources, historyIndex: state.history.length };
    state.request = {
      id: randomUUID(),
      text: taskText(sources),
      started: Date.now(),
      ...(state.pending?.refs.length ? {attachments: state.pending.refs, savedAttachments: state.pending.savedFiles ?? {}} : {}),
    };
    delete state.pending;
    this.startRequest(state, config, updateId);
  }
  private retryAttachments(state: DialogueState, config: BotConfig, updateId: number): void {
    const blocked = this.busy(state) || state.pending?.readyAt ? BUSY : this.atCapacity(config) ? CAPACITY : undefined;
    const retry = state.attachmentRetry;
    if (blocked || !retry) {
      this.deps.store.accept(updateId);
      this.control(() => this.safeText(state, blocked ?? "В этом топике нет задания с вложениями для повтора."));
      return;
    }
    const {sources, ...task} = retry;
    delete state.attachmentRetry;
    state.latestTask = {sources, historyIndex: state.history.length};
    state.request = {...task, id: randomUUID(), started: Date.now()};
    this.startRequest(state, config, updateId);
  }
  private rememberAttachmentRetry(state: DialogueState): boolean {
    const request = state.request;
    if (!request?.attachments?.some((_, index) => !request.excludedAttachments?.[index]))
      return false;
    const {text, attachments, savedAttachments, excludedAttachments} = request;
    this.hideFiles(state, Object.values(state.attachmentRetry?.savedAttachments ?? {}));
    state.attachmentRetry = {text, attachments, savedAttachments: savedAttachments ?? {},
      ...(excludedAttachments ? {excludedAttachments} : {}), sources: state.latestTask?.sources ?? [{text}]};
    return true;
  }
  private atCapacity(config: BotConfig): boolean {
    return this.busyCount() >= config.maxConcurrentRequests;
  }
  private busyCount(): number {
    const keys = new Set(this.jobs.keys());
    for (const address of this.deps.store.busyAddresses()) keys.add(dialogueKey(address));
    return keys.size;
  }
  private editTask(address: DialogueAddress, message: TelegramMessage, updateId: number): void {
    const state = this.deps.store.get(address);
    const task = state.latestTask;
    const pending = state.pending?.sources?.find(source => source.messageId === message.message_id);
    const source = pending ?? task?.sources.find(source => source.messageId === message.message_id);
    const text = message.text ?? message.caption ?? "";
    if (!source || source.text === text) {
      this.deps.store.accept(updateId);
      return;
    }
    const previous = taskText(task?.sources);
    source.text = text;
    const edited = taskText(task?.sources);
    if (!pending && task?.completed && !state.request && previous !== edited) {
      state.delivery ??= { parts: [], next: 0 };
      state.delivery.parts.push({
        kind: "text",
        text: edited ? "Формулировка задания изменена." : "Текст задания удалён. Добавьте его снова или отправьте новое задание.",
      });
      this.armRepeat(state);
    }
    this.deps.store.accept(updateId, state);
    this.resume();
  }
  private repeatTask(address: DialogueAddress, data: string, config: BotConfig, updateId: number): string | undefined {
    const state = this.deps.store.get(address);
    const task = state.latestTask;
    const text = taskText(task?.sources);
    if (!address.topicId || !task?.completed || !text || !task.button || data !== REPEAT_CALLBACK + task.button) {
      this.deps.store.accept(updateId);
      return "Кнопка устарела. Используйте кнопку под последним ответом.";
    }
    const blocked = this.busy(state) || state.pending?.readyAt ? BUSY : this.atCapacity(config) ? CAPACITY : undefined;
    if (blocked) {
      this.deps.store.accept(updateId);
      return blocked;
    }
    delete task.button;
    state.request = { id: randomUUID(), text, started: Date.now(), repeat: true };
    this.startRequest(state, config, updateId);
  }
  private startRequest(state: DialogueState, config: BotConfig, updateId?: number): void {
    if (state.userId === config.ownerId) this.invalidatePicker(state);
    if (updateId === undefined) this.deps.store.put(state);
    else this.deps.store.accept(updateId, state);
    this.launch(state, () => this.process(state, config));
  }
  private armRepeat(state: DialogueState): void {
    const task = state.latestTask;
    if (!task?.completed || !state.delivery?.parts.length) return;
    if (taskText(task.sources)) {
      task.button = randomUUID();
      state.delivery.buttonAt = state.delivery.parts.length - 1;
    } else {
      delete task.button;
      delete state.delivery.buttonAt;
    }
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
      try { this.background(() => {
        const snapshot = this.deps.config.snapshot();
        const state = this.deps.store.get(address);
        if (!snapshot.valid || !this.allowed(userId, snapshot.config) || !state.pending) return;
        if (this.busy(state)) {
          clearPendingPrompt(state.pending);
          this.deps.store.put(state);
          this.control(() => this.safeText(address, BUSY));
          return;
        }
        const sources = pendingSources(state.pending);
        if (taskText(sources)) this.dispatch(state, sources, snapshot.config);
        else {
          clearPendingPrompt(state.pending);
          this.deps.store.put(state);
          this.control(() => this.safeText(address, "Материалы сохранены. Отправьте текст задания; /new — удалить материалы."));
        }
      }); } finally { resolve(); }
    }, Math.max(0, readyAt - Date.now()));
    this.albums.set(dialogueKey(address), { timer, done, resolve });
  }
  private control(work: () => Promise<void>): void {
    // Controls start after durable acceptance, but never occupy a user's request slot.
    const task = work().catch(() => {}).finally(() => this.controlJobs.delete(task));
    this.controlJobs.add(task);
  }
  private launch(address: DialogueAddress, work: () => Promise<void>, failed: (error: unknown) => void = () => {}): void {
    if (this.closed || this.jobs.has(dialogueKey(address))) return;
    // Defer work so the busy marker is installed before any adapter callback can re-enter.
    const task = Promise.resolve()
      .then(work)
      .catch(failed)
      .finally(() => {
        this.jobs.delete(dialogueKey(address));
        this.controllers.delete(dialogueKey(address));
        this.resume();
      });
    this.jobs.set(dialogueKey(address), task);
  }
  private stopRequest(address: DialogueAddress, requestId: string, updateId: number): boolean {
    const key = dialogueKey(address);
    const state = this.deps.store.get(address);
    const controller = this.controllers.get(key);
    if (this.previews.get(key)?.requestId !== requestId || state.request?.id !== requestId ||
        state.request.stopped || state.request.revoked || !controller || controller.signal.aborted) {
      this.deps.store.accept(updateId);
      return false;
    }
    state.request.stopped = true;
    this.deps.store.accept(updateId, state);
    controller.abort(new RequestStopped());
    return true;
  }

  private async finishStopped(address: DialogueAddress, requestId: string): Promise<void> {
    const state = this.deps.store.get(address);
    if (state.request?.id !== requestId || !state.request.stopped) return;
    const threadId = state.request.threadId;
    const restored = threadId && threadId === state.threadId &&
      await this.deps.engine.restoreStoppedThread?.(threadId, requestId, address).catch(() => false);
    const current = this.deps.store.get(address);
    if (current.request?.id !== requestId || !current.request.stopped) return;
    if (current.request.repeat) {
      this.hideFiles(current, [...(current.request.fileIds ?? []), ...(current.request.imageIds ?? [])]);
      if (!current.request.revoked) {
        current.delivery = {parts: [{kind: "text", text: "Задание остановлено."}], next: 0};
        this.armRepeat(current);
      }
    }
    this.rememberAttachmentRetry(current);
    delete current.request;
    if (threadId && !restored) {
      if (current.threadId === threadId) delete current.threadId;
      this.retireThread(current, threadId);
    }
    this.deps.store.put(current);
    if (threadId && !restored) void this.cleanRetiredThreads(address).catch(() => {});
  }

  private async cleanPreviews(address: DialogueAddress, messageId?: number): Promise<void> {
    const telegram = this.deps.telegram;
    if (!telegram.deleteMessage) return;
    const entries = this.deps.store.get(address).previewCleanup ?? [];
    for (const {id, retryAt} of entries) {
      if (messageId !== undefined && id !== messageId) continue;
      if (this.closed || (retryAt && retryAt > Date.now())) continue;
      let retryIn = 0;
      try { await telegram.deleteMessage(address.userId, id, this.controlAbort.signal); }
      catch (error) {
        if (error instanceof TelegramError) retryIn = error.permanent ? 0 : (error.retryAfter ?? 5) * 1000;
        else retryIn = 5000;
      }
      if (this.closed) return;
      const state = this.deps.store.get(address);
      const entry = state.previewCleanup?.find(message => message.id === id);
      if (!entry) continue;
      if (retryIn) entry.retryAt = Date.now() + retryIn;
      else state.previewCleanup = state.previewCleanup!.filter(message => message.id !== id);
      if (!state.previewCleanup?.length) delete state.previewCleanup;
      this.deps.store.put(state);
    }
  }

  private async process(address: DialogueAddress, config: BotConfig): Promise<void> {
    const userId = address.userId;
    const key = dialogueKey(address);
    let state = this.deps.store.get(address);
    const request = state.request;
    if (!request) return;
    const controller = new AbortController();
    this.controllers.set(key, controller);
    const timer = setTimeout(
      () => controller.abort(new Error("Request timed out")),
      config.requestTimeoutMs,
    );
    let preview: RequestPreview | undefined;
    let fallbackMessageId: number | undefined;
    const sendTyping = () => {
      const s = this.deps.config.snapshot();
      if (s.valid && this.allowed(userId, s.config))
        void this.deps.telegram
          .typing(userId, controller.signal, address.topicId)
          .catch(() => {});
    };
    let typing: ReturnType<typeof setInterval> | undefined;
    const selection = (userId === config.ownerId
      ? state.selection
      : undefined) ?? {
      model: config.defaultModel,
      effort: config.defaultEffort,
    };
    let engineStarted = false;
    try {
      this.ensureActive(address, request.id, controller.signal);
      if (address.topicId && this.deps.telegram.sendDraft) {
        const live = new RequestPreview({telegram: this.deps.telegram, chatId: userId, topicId: address.topicId,
          draftId: this.deps.store.nextDraftId(), requestId: request.id, rateLimit: this.draftRateLimit,
          signal: controller.signal,
          isAllowed: () => {
            const snapshot = this.deps.config.snapshot();
            return snapshot.valid && this.allowed(userId, snapshot.config);
          },
          rememberFallback: (id) => {
            const current = this.deps.store.get(address);
            (current.previewCleanup ??= []).push({id});
            this.deps.store.put(current);
            fallbackMessageId = id;
          },
        });
        preview = live;
        this.previews.set(key, live);
        live.stage(request.attachments?.length ? "Загружаю вложения" : "Готовлю ответ");
      } else {
        sendTyping();
        typing = setInterval(sendTyping, 4000);
      }
      const previousTask = request.repeat ? state.latestTask : undefined;
      const previousResult = previousTask?.completed;
      if (request.repeat && !previousResult) throw new Error("Repeat context unavailable");
      const original = previousTask ? state.history[previousTask.historyIndex] : undefined;
      if (request.repeat && original?.role !== "user") throw new Error("Repeat task unavailable");
      let attachments = original?.attachments;
      const materials: MaterialReference[] = [];
      const preparationNotes: string[] = [];
      if (request.attachments?.length) {
        this.preparing.add(dialogueKey(address));
        const files: Array<{name: string; mime: string; bytes: Uint8Array; originalFileId: string; index: number}> = [];
        let total = 0;
        for (const [index, ref] of request.attachments.entries()) {
          if (request.excludedAttachments?.[index]) continue;
          this.ensureActive(address, request.id, controller.signal);
          const saved = this.deps.store.get(address).request?.savedAttachments;
          const savedId = saved && Object.hasOwn(saved, ref.fileId) ? saved[ref.fileId] : undefined;
          try {
            let bytes: Uint8Array;
            if (savedId) {
              bytes = this.deps.store.readFile(address, savedId);
            } else {
              if (!this.deps.telegram.downloadFile)
                throw new AttachmentError("Загрузка вложений сейчас недоступна.");
              bytes = await this.abortable(this.deps.telegram.downloadFile(ref.fileId, ATTACHMENT_LIMITS.fileBytes, controller.signal), controller.signal);
            }
            this.ensureActive(address, request.id, controller.signal);
            if (bytes.byteLength > ATTACHMENT_LIMITS.fileBytes)
              throw new AttachmentFileError("Лимит на файл составляет 20 МБ. Пришлите файл меньшего размера.");
            if (total + bytes.byteLength > ATTACHMENT_LIMITS.batchBytes) {
              this.excludeAttachment(address, index, "Файл не поместился в лимит 50 МБ на задание. Отправьте его отдельно.");
              continue;
            }
            const materialId = savedId ?? this.deps.store.saveAttachment(
              address, request.id, ref.fileId, {name: ref.name, mime: ref.mime, bytes}, config.dialogueFileBytes,
            ).id;
            total += bytes.byteLength;
            files.push({name: ref.name, mime: ref.mime, bytes, originalFileId: materialId, index});
          } catch (error) {
            const reason = error instanceof StoredFileUnavailableError ? "Сохранённая копия недоступна. Пришлите файл заново."
              : error instanceof DialogueFileQuotaError ? "Хранилище топика заполнено. Пришлите файл меньшего размера или используйте другой топик."
              : error instanceof AttachmentFileError ? error.message : undefined;
            if (!reason) throw error;
            this.excludeAttachment(address, index, reason);
          }
        }
        this.ensureActive(address, request.id, controller.signal);
        preview?.stage(files.every(file => file.mime === "application/pdf" || /\.pdf$/i.test(file.name)) ? "Читаю PDF" : "Читаю вложения");
        attachments = [];
        let textBytes = 0;
        let imageBytes = 0;
        for (const file of files) {
          let prepared: PreparedAttachment | undefined;
          let exceedsPreparationLimit = false;
          const macroWorkbook = /\.xlsm$/i.test(file.name);
          if (this.deps.attachments) {
            try {
              const result = await this.abortable(this.deps.attachments.prepare([file], controller.signal), controller.signal);
              if (result.length === 1) prepared = result[0];
            } catch (error) {
              if (error instanceof AttachmentFileError) {
                const advice = macroWorkbook ? " Если книга открывается, пересохраните её в .xlsx без макросов." : "";
                this.excludeAttachment(address, file.index, error.message + advice, file.originalFileId);
                continue;
              }
              if (!(error instanceof AttachmentError) || error instanceof AttachmentReaderUnavailableError) throw error;
              exceedsPreparationLimit = error instanceof AttachmentBatchError;
            }
            this.ensureActive(address, request.id, controller.signal);
          }
          materials.push({id: file.originalFileId, name: file.name});
          if (prepared) {
            const nextText = textBytes + Buffer.byteLength(prepared.text);
            const nextImages = prepared.images.reduce((sum, image) => sum + Buffer.byteLength(image.base64, "base64"), imageBytes);
            if (nextText <= ATTACHMENT_LIMITS.textBytes && nextImages <= ATTACHMENT_LIMITS.imageBytes) {
              attachments.push(prepared);
              textBytes = nextText;
              imageBytes = nextImages;
              continue;
            }
            exceedsPreparationLimit = true;
          }
          const display = attachmentName(file.name);
          if (exceedsPreparationLimit) {
            preparationNotes.push(`Передал «${display}» в исходном виде из-за лимита подготовки. Для отдельного разбора отправьте файл в новом задании.`);
          } else if (macroWorkbook && this.deps.attachments) {
            preparationNotes.push(`Передал «${display}» в исходном виде. Если книгу не удалось прочитать, пересохраните её в .xlsx без макросов.`);
          }
          attachments.push({name: file.name, text: "", images: [], originalFileId: file.originalFileId});
        }
        if (!attachments.length)
          throw new AttachmentError("В задании нет вложений, которые удалось подготовить.");
      }
      this.preparing.delete(dialogueKey(address));
      this.ensureActive(address, request.id, controller.signal);
      state = this.deps.store.get(address);
      const inputMaterials = original?.materials ?? materials;
      const incoming = {
        role: "user" as const, text: request.text,
        ...(attachments ? {attachments} : {}),
        ...(inputMaterials.length ? {materials: inputMaterials} : {}),
      };
      const start = previousTask ? 0 : state.contextPressure ? state.history.length : recentHistoryStart(state.history, incoming);
      if (start > 0) {
        preview?.stage("Обновляю контекст диалога");
        const retainFrom = state.contextPressure ? start : recentHistoryStart(state.history, incoming, 0.5);
        state = await this.compactHistory(state, retainFrom, request.id, selection, controller.signal);
      }
      this.ensureActive(address, request.id, controller.signal);
      preview?.stage("Готовлю ответ");
      engineStarted = true;
      const live = preview;
      const visible = previousResult && new Set(previousResult.inputFileIds);
      const inactive = new Set([
        ...(state.inactiveFileIds ?? []),
        ...Object.values(state.attachmentRetry?.savedAttachments ?? {}),
      ]);
      let inputFileIds: string[] = [];
      const run = () => {
        const files = this.deps.store.listFiles(address).filter(file =>
          visible ? visible.has(file.id) : !inactive.has(file.id));
        const availableIds = new Set(files.map(file => file.id));
        inputFileIds = [...availableIds];
        return this.abortable(this.deps.engine.run({
          requestId: request.id,
          userId,
          topicId: address.topicId,
          text: request.text,
          ...(attachments ? { attachments } : {}),
          ...selection,
          ...(!previousTask && state.threadId ? {threadId: state.threadId} : {}),
          history: previousTask ? state.history.slice(0, previousTask.historyIndex) : state.history,
          ...(state.summary ? {summary: state.summary} : {}),
          files,
          ...(live ? {onProgress: (progress) => live.progress(progress)} : {}),
          readFile: id => {
            if (!availableIds.has(id)) throw new ResponseFileError("Файл недоступен в контексте задания.");
            return this.deps.store.readFile(address, id);
          },
          onFile: async (file) => {
            this.ensureActive(address,request.id,controller.signal);
            return this.deps.store.saveResponseFile(address,request.id,file,config.dialogueFileBytes);
          },
          signal: controller.signal,
          onThread: (id) => {
            this.ensureActive(address, request.id, controller.signal);
            const current = this.deps.store.get(address);
            if (current.request?.id === request.id) {
              current.request.threadId = id;
              this.deps.store.put(current);
            } else {
              // The engine awaits this callback before creating native files.
              throw new Error("Dialogue allocation cancelled");
            }
          },
        }), controller.signal);
      };
      let response: ModelResponse;
      try {
        response = await run();
      } catch (error) {
        if (!(error instanceof ModelContextError) || previousTask || (!state.threadId && !state.history.length)) throw error;
        const attempted = this.deps.store.get(address);
        if (attempted.request?.fileIds?.length) throw error;
        // The provider can exceed the estimate inside a turn. Retry once with the summary alone.
        preview?.stage("Обновляю контекст диалога");
        state = await this.compactHistory(attempted, attempted.history.length, request.id, selection, controller.signal);
        this.ensureActive(address, request.id, controller.signal);
        preview?.stage("Готовлю ответ");
        response = await run();
      }
      const current = this.deps.store.get(address);
      if (current.request?.id !== request.id) return;
      if (current.request.stopped) throw new RequestStopped();
      const fileIds = current.request.fileIds ?? [];
      const savedIds = new Set(fileIds);
      const resultFiles: MaterialReference[] = fileIds.length
        ? this.deps.store.listFiles(address).filter(file => savedIds.has(file.id)).map(({id, name}) => ({id, name}))
        : [];
      const imageIds: string[] = [];
      const readyImages = [];
      let imageWarning = "";
      for (const image of response.images) {
        try {
          const {id, name} = this.deps.store.saveResponseImage(address, request.id, image, config.dialogueFileBytes);
          resultFiles.push({id, name});
          imageIds.push(id);
          readyImages.push(image);
        }
        catch (error) {
          if (!(error instanceof ResponseFileError)) throw error;
          imageWarning = "\n\nГотова только часть изображений. " + error.message;
        }
      }
      const outputFileIds = [...fileIds, ...imageIds];
      const answer = {...response,text:response.text+imageWarning,images:readyImages};
      let retired: string | undefined;
      if (previousResult && (response.incomplete || imageWarning)) {
        if (current.threadId !== response.threadId) retired = response.threadId;
        this.hideFiles(current, outputFileIds);
      } else {
        if (previousTask && previousResult) {
          if (current.threadId !== response.threadId) retired = current.threadId;
          current.history.length = previousTask.historyIndex;
          this.hideFiles(current, previousResult.outputFileIds);
          delete current.contextPressure;
        }
        current.threadId = response.threadId;
        if (response.contextPressure) current.contextPressure = true;
        current.history.push(incoming, {
          role: "assistant", text: response.text,
          ...(imageIds.length ? {imageIds} : {}),
          ...(resultFiles.length ? {materials: resultFiles} : {}),
        });
        current.lastResponse = answer.text;
        if (current.latestTask)
          current.latestTask.completed = { inputFileIds, outputFileIds };
      }
      if (retired) this.retireThread(current, retired);
      const revoked = current.request.revoked;
      const autoName = current.autoNameTopic && !revoked && !response.incomplete && !imageWarning;
      if (autoName) delete current.autoNameTopic;
      const deliveryWarnings = attachmentWarnings(current.request);
      delete current.request;
      if (!revoked) {
        current.delivery = { parts: [
          ...formatAnswer(answer),
          ...deliveryWarnings.map(text => ({kind: "text" as const, text: "Вложение исключено. " + text})),
          ...preparationNotes.map(text => ({kind: "text" as const, text})),
          ...fileIds.map(id => ({kind: "file" as const, id})),
        ], next: 0 };
        this.armRepeat(current);
      }
      this.deps.store.put(current);
      if (retired) this.control(() => this.cleanRetiredThreads(address));
      if (autoName && address.topicId) this.nameTopic({userId, topicId: address.topicId}, request.text);
    } catch (error) {
      if (this.closed) return;
      const current = this.deps.store.get(address);
      if (current.request?.id !== request.id) return;
      if (current.request.stopped) {
        await this.finishStopped(address, request.id);
        return;
      }
      // A rejected or timed-out preflight leaves the completed native thread usable.
      const rejectedBeforeTurn = current.request.threadId === undefined &&
        (error instanceof ModelSelectionError || controller.signal.aborted);
      const poisoned = engineStarted && !rejectedBeforeTurn
        ? current.request.threadId ?? (request.repeat ? undefined : current.threadId)
        : undefined;
      const message = isUserFacingRequestError(error) ? error.message : controller.signal.aborted
        ? "Время обработки запроса истекло. Пожалуйста, повторите запрос."
        : "Не удалось обработать запрос. Пожалуйста, повторите позже.";
      this.failRequest(current, poisoned, message);
      if (poisoned) await this.cleanRetiredThreads(address);
    } finally {
      this.preparing.delete(dialogueKey(address));
      clearTimeout(timer);
      clearInterval(typing);
      this.controllers.delete(key);
      await preview?.close();
      if (fallbackMessageId !== undefined) await this.cleanPreviews(address, fallbackMessageId).catch(() => {});
      this.previews.delete(key);
    }
    if (!this.closed) await this.deliver(address);
  }
  private async compactHistory(
    state: DialogueState, retainFrom: number, requestId: string, selection: ModelSelection, signal: AbortSignal,
  ): Promise<DialogueState> {
    this.ensureActive(state, requestId, signal);
    const {archived, batches} = compactionInput(state.history.slice(0, retainFrom));
    let summary = state.summary;
    for (const text of batches) {
      try {
        summary = (await this.abortable(this.deps.engine.summarize({
          ...selection, text, ...(summary ? {summary} : {}), signal,
        }), signal)).trim();
        if (!summary || Buffer.byteLength(summary) > SUMMARY_BYTES) throw new Error("Invalid summary");
      } catch (error) {
        if (signal.aborted || error instanceof ModelSelectionError) throw error;
        throw new AttachmentError("Не удалось обновить сводку диалога. История и материалы сохранены. Повторите задание позже.");
      }
      this.ensureActive(state, requestId, signal);
    }
    // Preserve pending files and the request's cleanup record across the model call.
    const current = this.deps.store.get(state);
    if (summary) current.summary = summary;
    current.history = current.history.slice(retainFrom);
    if (current.latestTask) current.latestTask.historyIndex = current.history.length;
    delete current.contextPressure;
    const retired = new Set(current.retiredThreadIds);
    if (current.threadId) retired.add(current.threadId);
    if (current.request?.threadId) {
      retired.add(current.request.threadId);
      delete current.request.threadId;
    }
    if (retired.size) current.retiredThreadIds = [...retired];
    delete current.threadId;
    this.deps.store.putCompacted(current, archived);
    await this.cleanRetiredThreads(current);
    return this.deps.store.get(state);
  }
  private async cleanRetiredThreads(address: DialogueAddress): Promise<void> {
    for (const id of this.deps.store.get(address).retiredThreadIds ?? []) {
      try { await this.deps.engine.deleteThread(id); } catch { continue; }
      const current = this.deps.store.get(address);
      if (!current.retiredThreadIds?.includes(id)) continue;
      current.retiredThreadIds = current.retiredThreadIds.filter(threadId => threadId !== id);
      if (!current.retiredThreadIds.length) delete current.retiredThreadIds;
      this.deps.store.put(current);
    }
  }
  private hideFiles(state: DialogueState, ids: string[]): void {
    if (ids.length) state.inactiveFileIds = [...new Set([...(state.inactiveFileIds ?? []), ...ids])];
  }
  private retireThread(state: DialogueState, id: string): void {
    state.retiredThreadIds = [...new Set([...(state.retiredThreadIds ?? []), id])];
  }
  private excludeAttachment(address: DialogueAddress, index: number, reason: string, savedId?: string): void {
    const current = this.deps.store.get(address);
    if (!current.request) return;
    (current.request.excludedAttachments ??= {})[index] = reason;
    if (savedId) this.hideFiles(current, [savedId]);
    this.deps.store.put(current);
  }
  private failRequest(state: DialogueState, threadId: string | undefined, message: string): void {
    const request = state.request;
    if (!request) return;
    const fileIds = request.fileIds ?? [];
    const imageIds = request.imageIds ?? [];
    const retry = this.rememberAttachmentRetry(state);
    if (request.repeat) this.hideFiles(state, [...fileIds, ...imageIds]);
    else delete state.latestTask;
    if (threadId) {
      if (!request.repeat) delete state.threadId;
      this.retireThread(state, threadId);
    }
    delete state.request;
    if (!request.revoked) {
      const saved = imageIds.length ? this.deps.store.listFiles(state) : [];
      const deferredImages: string[] = [];
      const images = imageIds.flatMap(id => {
        const file = saved.find(item => item.id === id);
        if (!file) return [];
        try { return [{...file, bytes: this.deps.store.readFile(state, id)}]; }
        catch (error) {
          if (!(error instanceof ResponseFileError)) throw error;
          if (!(error instanceof StoredFileUnavailableError)) deferredImages.push(id);
          return [];
        }
      });
      const recoveredFiles = [...deferredImages, ...fileIds];
      const prefix = recoveredFiles.length || images.length ? "Готова только часть задания; созданные файлы приложены. " : "";
      const missing = imageIds.length > images.length + deferredImages.length ? " Часть сохранённых изображений недоступна." : "";
      state.delivery = {
        parts: [
          { kind: "text", text: prefix + message + missing +
            (retry ? " Чтобы повторить это задание с вложениями, отправьте /retry." : "") },
          ...attachmentWarnings(request).map(text => ({kind: "text" as const, text: "Вложение исключено. " + text})),
          ...formatAnswer({text: "", images}),
          ...recoveredFiles.map(id => ({kind: "file" as const, id})),
        ],
        next: 0,
      };
      this.armRepeat(state);
    }
    this.deps.store.put(state);
  }
  private nameTopic(address: DialogueAddress & {topicId: number}, text: string): void {
    const key = dialogueKey(address);
    const abort = new AbortController();
    this.topicTitles.set(key, abort);
    const signal = AbortSignal.any([abort.signal, this.controlAbort.signal, AbortSignal.timeout(30_000)]);
    const canRename = () => {
      const snapshot = this.deps.config.snapshot();
      return !signal.aborted && snapshot.valid && this.allowed(address.userId, snapshot.config);
    };
    const task = this.topicTitleQueue.then(async () => {
      try {
        // Start the first answer send before spending time on the title.
        await setImmediate(undefined, {signal});
        if (!canRename()) return;
        const input = topicTitleInput(text);
        const title = input && /\p{L}/u.test(input)
          ? safeTopicTitle(await this.abortable(this.deps.engine.generateTopicTitle(input, signal), signal))
          : GENERIC_TOPIC_TITLE;
        if (title && canRename())
          await this.abortable(this.deps.telegram.renameTopic(address.userId, address.topicId, title, signal), signal);
      } finally {
        this.topicTitles.delete(key);
      }
    }).catch(() => {});
    this.topicTitleQueue = task;
    this.control(() => task);
  }
  private ensureActive(address: DialogueAddress, requestId: string, signal: AbortSignal): void {
    const userId = address.userId;
    signal.throwIfAborted();
    const snapshot = this.deps.config.snapshot();
    const request = this.deps.store.get(address).request;
    if (!snapshot.valid || !this.allowed(userId, snapshot.config) || request?.id !== requestId || request.revoked || request.stopped)
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
      const options: SendOptions = { signal: controller.signal, message_thread_id: address.topicId };
      const task = state.latestTask;
      if (delivery.buttonAt === delivery.next && task?.button) {
        const text = taskText(task.sources);
        const edited = text !== state.history[task.historyIndex]?.text;
        options.reply_markup = { inline_keyboard: [[{
          text: edited ? "Запустить снова" : "Другой вариант",
          callback_data: REPEAT_CALLBACK + task.button,
        }]] };
      }
      try {
        if (part.kind === "file") {
          const file = this.deps.store.listFiles(address).find(file=>file.id===part.id);
          if (!file) throw new StoredFileUnavailableError();
          if (!this.deps.telegram.sendFile) throw new Error("File delivery unavailable");
          await this.abortable(this.deps.telegram.sendFile(userId,{...file,bytes:this.deps.store.readFile(address,file.id)}, options), controller.signal);
        } else await this.abortable(this.deps.telegram.sendPart(userId, part, options), controller.signal);
      } catch (error) {
        const missing = error instanceof StoredFileUnavailableError;
        const permanent = error && typeof error === "object" && "permanent" in error && error.permanent;
        if (part.kind === "file" && (missing || (permanent && "code" in error && error.code === 400))) {
          const current = this.deps.store.get(address);
          if (current.delivery) {
            const text = missing ? "Сохранённый файл ответа недоступен. Попросите создать его заново."
              : "Не удалось доставить один из файлов. Он сохранён в диалоге; попросите отправить его повторно.";
            current.delivery.parts[current.delivery.next] = {kind: "text", text};
            this.deps.store.put(current);
          }
          continue;
        }
        if (permanent) {
          const current = this.deps.store.get(address);
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
    const preview = this.previews.get(dialogueKey(address));
    try {
      await this.deps.telegram.sendText(userId, text, { signal: this.topicSignal(address), message_thread_id: address.topicId });
      preview?.refresh();
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
          OPEN_TOPIC + " Создание и переименование доступны в интерфейсе Telegram. /delete — удалить текущую тему и данные после подтверждения; штатное удаление темы не гарантирует немедленную очистку данных бота. Отправьте текст для Codex или до 10 фото и файлов. Текст задания можно добавить в подписи или отправить отдельным сообщением после материалов. /retry повторяет последнее прерванное задание с вложениями в этой теме. Для получения документа попросите PDF, Word, Excel, презентацию или другой файл; до 10 файлов по 50 МБ. Для создания изображения напишите, например, «Нарисуй кота-космонавта»; образцы присылайте в этот диалог. Действуют возможности модели и лимиты подписки. /new — сброс диалога и материалов; /text — последний ответ текстом; /status — состояние." +
            (id === config.ownerId
              ? " /users — список доступа; /model — выбор модели; /broadcast <текст> — объявление одобренным пользователям."
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
          text += `\nАктивных запросов: ${this.busyCount()}/${config.maxConcurrentRequests}. Codex: ${health.available ? "доступен" : "недоступен"}.`;
        }
        const incomplete = this.deps.store.incompleteDeletions(state.userId);
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
                const username = this.deps.store.username(userId);
                return `${userId}${username ? ` @${username}` : ""}${userId === config.ownerId ? " (владелец)" : ""}`;
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
          await this.showModels(address, config);
        }
        break;
      default:
        await this.safeText(address, "Неизвестная команда. Список команд: /help.");
    }
  }
  private async confirmDelete(state: DialogueState, token: string): Promise<void> {
    if (this.deps.store.get(state).deleteConfirmation?.token !== token) return;
    const preview = this.previews.get(dialogueKey(state));
    try {
      await this.deps.telegram.sendText(state.userId,
        "Удалить эту тему со всеми сообщениями, контекстом и материалами? Это действие необратимо.", {
          signal: this.topicSignal(state), message_thread_id: state.topicId,
          reply_markup: {inline_keyboard: [[
            {text: "Удалить тему", callback_data: `delete:yes:${token}`},
            {text: "Отмена", callback_data: `delete:no:${token}`},
          ]]},
        });
      preview?.refresh();
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
      ...(!deleting && state.autoNameTopic ? {autoNameTopic: true} : {}),
      ...(state.username ? {username: state.username} : {}),
      ...(state.selection ? {selection: state.selection} : {}),
      ...(state.previewCleanup ? {previewCleanup: state.previewCleanup} : {}),
      ...(deleting ? {deleting: {id: randomUUID(), threadIds}} : {reset: {id: randomUUID(), threadIds}}),
    };
    // Durable cancellation precedes abort: every late callback sees the tombstone.
    this.deps.store.accept(updateId, cleared);
    this.topicTitles.get(dialogueKey(state))?.abort();
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
    delete state.summary;
    delete state.contextPressure;
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
  private async showModels(address: DialogueAddress, config: BotConfig): Promise<void> {
    const userId = address.userId;
    const signal = this.topicSignal(address);
    const revision = this.pickerRevision.get(dialogueKey(address));
    try {
      const models = await this.models(),
        selection = this.deps.store.get(address).selection ?? {
          model: config.defaultModel,
          effort: config.defaultEffort,
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
      for (const controller of this.topicTitles.values()) controller.abort();
      for (const [id, controller] of this.controllers) {
        const [userId, topicId] = id.split(":").map(Number);
        if (this.preparing.has(id)) controller.abort(new AttachmentError("Обработка приостановлена. Материалы сохранены."));
        else if (!this.readSaved({userId: userId!, topicId: topicId!})?.request) controller.abort();
      }
      return;
    }
    for (const [key, controller] of this.topicTitles)
      if (!this.allowed(Number(key.split(":")[0]), snapshot.config)) controller.abort();
  }
  private reconcilePending(config: BotConfig): void {
    for (const address of this.deps.store.revokedWorkAddresses([config.ownerId, ...config.allowedUserIds])) {
      const state = this.readSaved(address);
      if (!state) continue;
      this.cancelAlbum(address);
      if (state.pending) {
        clearPendingPrompt(state.pending);
        state.pending.awaitingTask = true;
      }
      if (state.request) state.request.revoked = true;
      delete state.delivery;
      this.deps.store.put(state);
      if (!state.request || this.preparing.has(dialogueKey(address))) this.controllers.get(dialogueKey(address))?.abort();
    }
    for (const address of this.deps.store.albumAddresses()) {
      if (!this.allowed(address.userId, config) || this.albums.has(dialogueKey(address))) continue;
      const readyAt = this.readSaved(address)?.pending?.readyAt;
      if (readyAt) this.scheduleAlbum(address, readyAt);
    }
  }
  private startLegacyMigrations(userId?: number): void {
    const snapshot = this.deps.config.snapshot();
    if (!snapshot.valid || this.closed) return;
    const addresses = userId === undefined ? this.deps.store.legacyAddresses() : [{userId}];
    for (const address of addresses) {
      if (!this.allowed(address.userId, snapshot.config)) continue;
      const state = this.readSaved(address);
      if (!state || state.migration?.phase === "creating") continue;
      // Persist intent before Telegram. Ambiguous failures wait for the service update,
      // never blindly call non-idempotent createForumTopic a second time.
      state.migration = {phase: "creating"};
      this.deps.store.put(state);
      this.control(async () => {
        try {
          const topicId = await this.deps.telegram.createTopic(state.userId, "Предыдущий диалог", this.controlAbort.signal);
          this.deps.store.moveLegacy(state.userId, topicId);
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
  private background(work: () => void): void {
    try { work(); this.backgroundErrorReported = false; }
    catch (error) {
      if (error instanceof StoredDialogueError) return;
      if (!this.backgroundErrorReported) console.error("Не удалось восстановить фоновые операции. Данные сохранены; повторим попытку.");
      this.backgroundErrorReported = true;
      this.pendingReload = this.deps.config.snapshot();
      this.wakeAt(Date.now() + 1000);
    }
  }
  private resume(): void {
    if (this.closed || this.recovering || this.resumeQueued) return;
    this.resumeQueued = true;
    queueMicrotask(() => {
      this.resumeQueued = false;
      if (this.closed || this.recovering) return;
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      this.retryAt = Infinity;
      this.background(() => {
        const reload = this.pendingReload;
        this.pendingReload = undefined;
        if (reload) this.reloaded(reload);
        const snapshot = this.deps.config.snapshot();
        if (!snapshot.valid) return;
        this.reconcilePending(snapshot.config);
        const now = Date.now();
        const dialogue = this.resumeSaved("dialogue", now);
        const preview = this.deps.telegram.deleteMessage ? this.resumeSaved("preview", now) : Infinity;
        const broadcast = this.broadcasts.resume(now) ?? Infinity;
        this.wakeAt(Math.min(dialogue, preview, broadcast));
      });
    });
  }
  private wakeAt(at: number): void {
    if (this.closed || !Number.isFinite(at) || at >= this.retryAt) return;
    clearTimeout(this.retryTimer);
    this.retryAt = at;
    this.retryTimer = setTimeout(() => this.resume(), Math.min(2_147_483_647, Math.max(0, at - Date.now())));
    this.retryTimer.unref();
  }
  private resumeSaved(kind: "dialogue" | "preview", now: number): number {
    const preview = kind === "preview";
    const retries = preview ? this.previewRetries : this.dialogueRetries;
    let next = Infinity;
    for (const address of this.deps.store.scheduledDialogues(kind)) {
      if (address.dueAt >= next && address.dueAt > now) break;
      const key = dialogueKey(address);
      if (preview ? this.previews.has(key) || this.previewCleanups.has(key) : this.jobs.has(key)) continue;
      const due = Math.max(address.dueAt, retries.get(key) ?? 0);
      if (due > now) { next = Math.min(next, due); continue; }
      const failed = (error: unknown) => {
        if (error instanceof StoredDialogueError) { retries.delete(key); return; }
        if (!retries.has(key)) console.error("Не удалось выполнить фоновую операцию. Данные сохранены; повторим попытку.");
        retries.set(key, Date.now() + 1000);
      };
      if (preview) {
        this.previewCleanups.add(key);
        this.control(async () => {
          await Promise.resolve();
          try {
            if (this.closed || !this.deps.config.snapshot().valid) return;
            await this.cleanPreviews(address);
            retries.delete(key);
          }
          catch (error) { failed(error); }
          finally { this.previewCleanups.delete(key); this.resume(); }
        });
      } else {
        this.launch(address, async () => {
          await this.runSaved(address);
          retries.delete(key);
        }, failed);
      }
    }
    return next;
  }
  private async runSaved(address: DialogueAddress): Promise<void> {
    if (this.closed || !this.deps.config.snapshot().valid) return;
    const state = this.deps.store.get(address);
    const now = Date.now();
    switch (dialogueOperations(state).find(operation => operation.dueAt <= now)?.kind) {
      case "binding": await this.bindLegacy(address); break;
      case "delete": await this.deleteDialogue(address); break;
      case "reset": await this.reset(address); break;
      case "delivery": await this.deliver(address); break;
    }
  }
  private readSaved(address: DialogueAddress): DialogueState | undefined {
    try { return this.deps.store.findDialogue(address); }
    catch (error) { if (!(error instanceof StoredDialogueError)) throw error; }
  }
  async discardOfflineUpdates(updates: TelegramUpdate[]): Promise<void> {
    for (const update of updates) {
      if (update.update_id < this.deps.store.offset) continue;
      if (update.message?.forum_topic_created || update.message?.forum_topic_edited) {
        await this.handleUpdate(update);
        continue;
      }
      if (BROADCAST_COMMAND.test(update.message?.text ?? "")) {
        this.deps.store.accept(update.update_id);
        continue;
      }
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
        const address = {userId: from.id, topicId: message.message_thread_id};
        let state: DialogueState;
        try { state = this.deps.store.get(address); }
        catch (error) {
          if (!(error instanceof StoredDialogueError)) throw error;
          this.deps.store.accept(update.update_id);
          continue;
        }
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
    await this.drainDialogues();
  }
  async recover(): Promise<void> {
    this.recovering = true;
    try {
      for (const address of this.deps.store.recoveryAddresses()) {
        try {
          const state = this.deps.store.findDialogue(address);
          if (!state) continue;
          if (state.request?.attachments?.length && !state.request.savedAttachments && state.pending) {
            // Older versions kept the active batch and its saved file IDs in pending.
            state.request.savedAttachments = state.pending.savedFiles ?? {};
            delete state.pending;
            this.deps.store.put(state);
          }
          if (state.pending) {
            clearPendingPrompt(state.pending);
            if (!state.request && !state.delivery)
              state.delivery = { parts: [{ kind: "text", text: "Материалы сохранены. После перезапуска повторите текст задания." }], next: 0 };
            this.deps.store.put(state);
          }
          if (state.request) {
            if (state.request.stopped) {
              await this.finishStopped(state, state.request.id);
              continue;
            }
            const threadId = state.request.threadId ?? (state.request.repeat ? undefined : state.threadId);
            this.failRequest(state, threadId, REPEAT);
          }
          if (state.retiredThreadIds?.length) await this.cleanRetiredThreads(state);
        } catch (error) {
          if (!(error instanceof StoredDialogueError)) throw error;
        }
      }
      this.startLegacyMigrations();
    } finally {
      this.recovering = false;
    }
    this.resume();
    await this.drainDialogues();
  }
  private async drainDialogues(): Promise<void> {
    await Promise.resolve();
    while (this.jobs.size || this.controlJobs.size || this.albums.size)
      await Promise.all([...this.jobs.values(), ...this.controlJobs, ...[...this.albums.values()].map((a) => a.done)]);
  }
  async drain(): Promise<void> {
    await Promise.resolve();
    await Promise.all([this.drainDialogues(), this.broadcasts.drain()]);
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    // Shutdown must work even when a saved snapshot cannot be read.
    for (const album of this.albums.values()) { clearTimeout(album.timer); album.resolve(); }
    this.albums.clear();
    clearTimeout(this.retryTimer);
    this.unsubscribeConfig?.();
    this.unsubscribeWork();
    this.controlAbort.abort(new Error("Bot shutting down"));
    for (const controller of this.controllers.values())
      controller.abort(new Error("Bot shutting down"));
    await this.drain();
  }
}

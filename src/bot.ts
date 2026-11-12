import { randomBytes, randomUUID } from "node:crypto";
import type {
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
import { formatAnswer, formatText } from "./telegram/format.ts";
import { SqliteStore } from "./store.ts";
import type { DialogueState } from "./store.ts";
interface Dependencies {
  config: ConfigSource;
  store: SqliteStore;
  engine: ModelEngine;
  telegram: TelegramTransport;
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
  private readonly controllers = new Map<number, AbortController>();
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
    if (!message.text) {
      this.deps.store.accept(update.update_id);
      this.control(() => this.safeText(userId, "Поддерживаются только текстовые сообщения."));
      return;
    }
    const state = this.deps.store.get(userId);
    if (from.username) state.username = from.username;
    const command = /^\/(\w+)(?:@\w+)?(?:\s|$)/
      .exec(message.text)?.[1]
      ?.toLowerCase();
    if (command) {
      if (command === "new" && !this.busy(state)) {
        if (userId === config.ownerId) this.invalidatePicker();
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
    if (
      this.deps.store.all().filter((s) => this.busy(s)).length >=
      config.maxConcurrentRequests
    ) {
      this.deps.store.accept(update.update_id, state);
      this.control(() => this.safeText(
        userId,
        "Все места обработки заняты. Повторите запрос позже.",
      ));
      return;
    }
    state.request = {
      id: randomUUID(),
      text: message.text,
      started: Date.now(),
    };
    if (userId === config.ownerId) this.invalidatePicker();
    this.deps.store.accept(update.update_id, state);
    this.launch(userId, () => this.process(userId, config));
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
    try {
      void this.deps.telegram.typing(userId, controller.signal).catch(() => {});
      const response = await Promise.race([
        this.deps.engine.run({
          userId,
          text: request.text,
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
        { role: "user", text: request.text },
        { role: "assistant", text: response.text },
      );
      current.lastResponse = response.text;
      const revoked = current.request.revoked;
      delete current.request;
      if (!revoked)
        current.delivery = { parts: formatAnswer(response), next: 0 };
      this.deps.store.put(current);
    } catch {
      if (this.closed) return;
      const current = this.deps.store.get(userId);
      const poisoned = current.request?.threadId ?? current.threadId;
      const revoked = current.request?.revoked;
      delete current.request;
      delete current.threadId;
      if (!revoked)
        current.delivery = {
          parts: [
            {
              kind: "text",
              text: controller.signal.aborted
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
      clearTimeout(timer);
      clearInterval(typing);
      this.controllers.delete(userId);
    }
    if (!this.closed) await this.deliver(userId);
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
          "Отправьте текст для Codex. /new — сброс диалога; /text — последний ответ текстом; /status — состояние." +
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
        if (!this.deps.store.get(id).request) controller.abort();
      return;
    }
    for (const state of this.deps.store.all())
      if (!this.allowed(state.userId, snapshot.config)) {
        if (state.request) state.request.revoked = true;
        delete state.delivery;
        this.deps.store.put(state);
        if (!state.request) this.controllers.get(state.userId)?.abort();
      }
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
        message.text &&
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
    for (const state of this.deps.store.all())
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
    this.reloaded(this.deps.config.snapshot());
    await this.drain();
  }
  async drain(): Promise<void> {
    while (this.jobs.size || this.controlJobs.size)
      await Promise.all([...this.jobs.values(), ...this.controlJobs]);
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    clearInterval(this.retryTimer);
    this.unsubscribe();
    this.controlAbort.abort(new Error("Bot shutting down"));
    for (const controller of this.controllers.values())
      controller.abort(new Error("Bot shutting down"));
    await this.drain();
  }
}

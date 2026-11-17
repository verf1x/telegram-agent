import { randomBytes } from "node:crypto";
import type { BotConfig, ConfigSource, DialogueAddress, SendOptions, TelegramTransport } from "./contracts.ts";
import type { BroadcastState, SqliteStore } from "./store.ts";
import { TelegramError } from "./telegram/transport.ts";

export const BROADCAST_COMMAND = /^\/broadcast(?:@\w+)?(?=\s|$)/i;
export const BROADCAST_CALLBACK = "broadcast:";

const CONFIRMATION_MS = 5 * 60_000;
const TEXT_LIMIT = 4096;
const MAX_RETRIES = 3;

interface BroadcastDraft extends BroadcastState {
  expiresAt: number;
}

interface BroadcastDependencies {
  config: ConfigSource;
  store: SqliteStore;
  telegram: TelegramTransport;
  signal: AbortSignal;
}

export class BroadcastController {
  private draft?: BroadcastDraft | undefined;
  private active?: Promise<void> | undefined;
  private storageErrorReported = false;
  private readonly deps: BroadcastDependencies;

  constructor(deps: BroadcastDependencies) {
    this.deps = deps;
  }

  async preview(owner: DialogueAddress, config: BotConfig, text: string): Promise<void> {
    if (owner.userId !== config.ownerId) return;
    const options: SendOptions = { message_thread_id: owner.topicId, signal: this.deps.signal };
    if (!text.trim()) {
      await this.deps.telegram.sendText(owner.userId, "Использование: /broadcast <текст объявления>", options);
      return;
    }
    if (text.length > TEXT_LIMIT) {
      await this.deps.telegram.sendText(owner.userId, `Сократите объявление до ${TEXT_LIMIT} символов.`, options);
      return;
    }

    const draft: BroadcastDraft = {
      id: randomBytes(16).toString("hex"),
      owner,
      text,
      recipients: [...new Set(config.allowedUserIds)].filter(userId => userId !== owner.userId)
        .map(userId => ({ userId, status: "pending" })),
      expiresAt: Date.now() + CONFIRMATION_MS,
    };
    this.draft = draft;
    const prompt = `Получателей: ${draft.recipients.length}`;
    let preview = `${prompt}\n\n${text}`;
    try {
      if (preview.length > TEXT_LIMIT) {
        await this.deps.telegram.sendText(owner.userId, text, options);
        if (this.draft !== draft) return;
        preview = prompt;
      }
      await this.deps.telegram.sendText(owner.userId, preview, {
        ...options,
        reply_markup: { inline_keyboard: [[
          { text: "Отправить", callback_data: `${BROADCAST_CALLBACK}send:${draft.id}` },
          { text: "Отмена", callback_data: `${BROADCAST_CALLBACK}cancel:${draft.id}` },
        ]] },
      });
    } catch {
      if (this.draft === draft) this.draft = undefined;
    }
  }

  confirm(owner: DialogueAddress, ownerId: number, data: string, updateId: number): string | undefined {
    const match = /^broadcast:(send|cancel):([a-f0-9]{32})$/.exec(data);
    const draft = this.draft;
    if (owner.userId !== ownerId) {
      this.deps.store.accept(updateId);
      return undefined;
    }
    if (!draft || match?.[2] !== draft.id || draft.owner.userId !== ownerId ||
        draft.owner.topicId !== owner.topicId || draft.expiresAt <= Date.now()) {
      this.deps.store.accept(updateId);
      return "Подтверждение устарело. Повторите /broadcast.";
    }

    if (match[1] === "cancel") {
      this.deps.store.accept(updateId);
      this.draft = undefined;
      return "Рассылка отменена.";
    }
    const { id, text, recipients } = draft;
    this.deps.store.accept(updateId, { id, owner, text, recipients });
    this.draft = undefined;
    this.resume();
    return "Рассылка запущена.";
  }

  resume(): void {
    if (this.draft && this.draft.expiresAt <= Date.now()) this.draft = undefined;
    if (this.active || this.deps.signal.aborted) return;
    let broadcast: BroadcastState | undefined;
    try { broadcast = this.nextReady(); }
    catch { this.reportStorageError(); return; }
    if (!broadcast) return;
    this.active = Promise.resolve()
      .then(() => this.run(broadcast))
      .then(() => { this.storageErrorReported = false; })
      .catch(() => this.reportStorageError())
      .finally(() => { this.active = undefined; });
  }

  async drain(): Promise<void> {
    await this.active;
  }

  private config(): BotConfig | undefined {
    const snapshot = this.deps.config.snapshot();
    if (!this.deps.signal.aborted && snapshot.valid) return snapshot.config;
  }

  private nextReady(): BroadcastState | undefined {
    const config = this.config();
    if (!config) return undefined;
    const broadcast = this.deps.store.nextBroadcast(config.ownerId);
    if (broadcast && (broadcast.retryAt ?? 0) <= Date.now()) return broadcast;
  }

  private reportStorageError(): void {
    if (!this.storageErrorReported) console.error("Не удалось обновить состояние рассылки. Повторим попытку.");
    this.storageErrorReported = true;
  }

  private async run(broadcast: BroadcastState): Promise<void> {
    while (true) {
      delete broadcast.retryAt;
      if (!await this.deliver(broadcast)) return;
      this.deps.store.removeBroadcast(broadcast.id);
      const next = this.nextReady();
      if (!next) return;
      broadcast = next;
    }
  }

  private async deliver(broadcast: BroadcastState): Promise<boolean> {
    for (const recipient of broadcast.recipients) {
      if (recipient.status === "sending") {
        // The call may have succeeded before the process lost its response or stopped.
        recipient.status = "unknown";
        this.deps.store.putBroadcast(broadcast);
      }
      if (recipient.status !== "pending") continue;
      const config = this.config();
      if (!config || config.ownerId !== broadcast.owner.userId) return false;
      if (!config.allowedUserIds.includes(recipient.userId)) {
        recipient.status = "skipped";
        this.deps.store.putBroadcast(broadcast);
        continue;
      }

      recipient.status = "sending";
      this.deps.store.putBroadcast(broadcast);
      try {
        await this.deps.telegram.sendText(recipient.userId, broadcast.text, { signal: this.deps.signal });
        recipient.status = "sent";
      } catch (error) {
        if (error instanceof TelegramError && error.code === 429) {
          recipient.retries = (recipient.retries ?? 0) + 1;
          recipient.status = recipient.retries <= MAX_RETRIES ? "pending" : "failed";
          broadcast.retryAt = this.retryAt(error);
        } else recipient.status = error instanceof TelegramError && error.permanent ? "failed" : "unknown";
      }
      this.deps.store.putBroadcast(broadcast);
      if (broadcast.retryAt !== undefined) return false;
    }

    if (this.config()?.ownerId !== broadcast.owner.userId) return false;
    return this.report(broadcast);
  }

  private async report(broadcast: BroadcastState): Promise<boolean> {
    const { owner, recipients } = broadcast;
    const count = (status: BroadcastState["recipients"][number]["status"]) =>
      recipients.filter(recipient => recipient.status === status).length;
    const text = ["Рассылка завершена.", `Доставлено: ${count("sent")}`, `Пропущено: ${count("skipped")}`,
      `Не доставлено: ${count("failed")}`, `Доставка неизвестна: ${count("unknown")}`].join("\n");
    const options = { message_thread_id: owner.topicId, signal: this.deps.signal };
    try {
      try {
        await this.deps.telegram.sendText(owner.userId, text, options);
      } catch (error) {
        if (!owner.topicId || !(error instanceof TelegramError && error.topicMissing)) throw error;
        await this.deps.telegram.sendText(owner.userId, text, { signal: this.deps.signal });
      }
    } catch (error) {
      if (this.deps.signal.aborted) return false;
      if (error instanceof TelegramError && error.permanent) return true;
      broadcast.reportRetries = (broadcast.reportRetries ?? 0) + 1;
      if (broadcast.reportRetries > MAX_RETRIES) return true;
      broadcast.retryAt = this.retryAt(error);
      this.deps.store.putBroadcast(broadcast);
      return false;
    }
    return true;
  }

  private retryAt(error: unknown): number {
    const seconds = error instanceof TelegramError ? error.retryAfter : undefined;
    return Date.now() + (seconds && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000);
  }
}

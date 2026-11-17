import type { ModelProgress, TelegramTransport } from '../contracts.ts';
import { TelegramError } from './transport.ts';

export const STOP_CALLBACK = 'stop:';

const stages = {
  responding: 'Готовлю ответ…',
  computing: 'Выполняю вычисления…',
  documents: 'Работаю с файлами…',
  images: 'Создаю изображение…',
  searching: 'Ищу информацию…',
} satisfies Record<Extract<ModelProgress, {kind: 'stage'}>['stage'], string>;

export class DraftRateLimit {
  private next = new Map<number, number>();

  acquire(chatId: number): number {
    const now = Date.now();
    const remaining = (this.next.get(chatId) ?? 0) - now;
    if (remaining > 0) return remaining;
    for (const [chat, until] of this.next) if (until <= now) this.next.delete(chat);
    this.next.set(chatId, now + 850);
    return 0;
  }

  defer(chatId: number, delay: number): void {
    this.next.set(chatId, Math.max(this.next.get(chatId) ?? 0, Date.now() + delay));
  }
}

interface PreviewOptions {
  telegram: TelegramTransport;
  chatId: number;
  topicId: number;
  draftId: number;
  requestId: string;
  rateLimit: DraftRateLimit;
  signal: AbortSignal;
  isAllowed: () => boolean;
  rememberFallback: (messageId: number) => void;
}

export class RequestPreview {
  readonly draftId: number;
  readonly requestId: string;
  private readonly options: PreviewOptions;
  private text = '';
  private status = '';
  private published: string | undefined;
  private publishedAt = 0;
  private needsRefresh = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private closed = false;
  private fallback = false;
  private failures = 0;

  constructor(options: PreviewOptions) {
    this.options = options;
    this.draftId = options.draftId;
    this.requestId = options.requestId;
  }

  stage(status: string): void {
    this.status = status;
    this.flush();
  }

  progress(event: ModelProgress): void {
    if (this.closed || this.options.signal.aborted) return;
    if (event.kind === 'stage') {
      this.stage(stages[event.stage]);
      return;
    }
    const text = this.text + event.delta;
    // Make room for new text to animate after the rolling preview reaches Telegram's limit.
    this.text = text.length <= 4096 ? text : text.slice(-3072).replace(/^[\uDC00-\uDFFF]/, '');
    this.flush();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    await this.inFlight;
  }

  refresh(): void {
    this.needsRefresh = true;
    this.flush();
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, delay);
    this.timer.unref();
  }

  private flush(): void {
    const {chatId, signal, isAllowed, rateLimit} = this.options;
    if (this.closed || signal.aborted || this.inFlight || this.fallback) return;
    if (!isAllowed()) { this.schedule(1000); return; }
    const text = this.text.trim() ? this.text : this.status;
    const refresh = this.publishedAt + 15_000 - Date.now();
    if (!this.needsRefresh && text === this.published && refresh > 0) { this.schedule(refresh); return; }
    const wait = rateLimit.acquire(chatId);
    if (wait) { this.schedule(wait); return; }
    clearTimeout(this.timer);
    this.needsRefresh = false;
    this.inFlight = this.publish(text).finally(() => {
      this.inFlight = undefined;
      this.flush();
    });
  }

  private async publish(text: string): Promise<void> {
    const {telegram, chatId, topicId, rateLimit, signal, isAllowed, rememberFallback} = this.options;
    try {
      await telegram.sendDraft!(chatId, this.draftId, text, topicId);
      this.published = text;
      this.publishedAt = Date.now();
      this.failures = 0;
    } catch (error) {
      if (this.closed || signal.aborted || !isAllowed()) return;
      if (error instanceof TelegramError && error.code === 429) {
        rateLimit.defer(chatId, (error.retryAfter ?? 2) * 1000);
        return;
      }
      const unsupported = error instanceof TelegramError && (error.permanent || error.code === 501);
      if (!unsupported && ++this.failures < 2) return;
      this.fallback = true;
      try {
        const messageId = await telegram.sendText(chatId, this.status || stages.responding, {
          message_thread_id: topicId,
          reply_markup: {inline_keyboard: [[{text: 'Стоп', callback_data: STOP_CALLBACK + this.requestId}]]},
          signal: AbortSignal.timeout(2500),
        });
        rememberFallback(messageId);
      } catch { /* A temporary message cannot affect delivery of the answer. */ }
    }
  }
}

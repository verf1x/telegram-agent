import type { ChatId, OutgoingPart, SendOptions, TelegramTransport, TelegramUpdate } from '../contracts.ts';
import { AttachmentError, ATTACHMENT_LIMITS } from '../contracts.ts';
import { formatText } from './format.ts';

export class TelegramError extends Error {
  readonly retryAfter: number | undefined;
  readonly permanent: boolean;
  readonly code: number;
  readonly richUnsupported: boolean;
  readonly topicMissing: boolean;
  constructor(code: number, description: string, retryAfter?: number, richUnsupported = false) {
    // Descriptions and network causes can include the URL, hence the bot token.
    super(`Telegram API: ${code || 'network error'}`);
    this.name = 'TelegramError';
    this.code = code;
    this.retryAfter = retryAfter;
    this.permanent = code >= 400 && code < 500 && ![408,409,429].includes(code);
    this.richUnsupported = richUnsupported;
    this.topicMissing = code === 400 && /TOPIC_ID_INVALID|TOPIC_DELETED|message thread not found|topic (not found|does not exist)/i.test(description);
  }
}

export class TelegramApi implements TelegramTransport {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  constructor(token: string, options: {baseUrl?:string;fetch?:typeof fetch} = {}) {
    this.#token = token;
    this.#baseUrl = (options.baseUrl ?? 'https://api.telegram.org').replace(/\/$/,'');
    this.#fetch = options.fetch ?? fetch;
  }
  async #call<T>(method: string, data: Record<string,unknown> | FormData, signal?: AbortSignal, timeoutMs=30_000): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal,timeout]) : timeout;
    try {
      const response = await this.#fetch(`${this.#baseUrl}/bot${this.#token}/${method}`, {
        method:'POST', signal:combined, redirect:'error',
        ...(data instanceof FormData ? {body:data} : {headers:{'content-type':'application/json'},body:JSON.stringify(data)}),
      });
      const body = await response.json() as {ok?:boolean;result:T;error_code?:number;description?:string;parameters?:{retry_after?:number}};
      if (!response.ok || !body.ok) {
        const code = body.error_code ?? response.status;
        const description = body.description ?? '';
        const richUnsupported = method === 'sendRichMessage' && (
          code === 404 || code === 501 || (code === 400 && /parse|entity|format|rich.?message|markdown|formula|block|table|method.*not.*(found|supported)/i.test(description))
        );
        throw new TelegramError(code,description,body.parameters?.retry_after,richUnsupported);
      }
      return body.result;
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      if (signal?.aborted) throw new DOMException('Telegram request aborted','AbortError');
      throw new TelegramError(0,'network error');
    }
  }
  async requireTopics(signal?: AbortSignal): Promise<void> {
    const bot = await this.#call<{has_topics_enabled?:boolean;allows_users_to_create_topics?:boolean}>('getMe',{},signal);
    if (!bot.has_topics_enabled || !bot.allows_users_to_create_topics)
      throw new Error('Включите Threaded Mode и управление темами пользователями в BotFather.');
  }
  getUpdates(options: {offset?:number;timeout:number;signal?:AbortSignal}): Promise<TelegramUpdate[]> {
    return this.#call('getUpdates',{offset:options.offset,timeout:options.timeout,allowed_updates:['message','callback_query']},options.signal,(options.timeout + 15) * 1000);
  }
  async downloadFile(fileId: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
    const limit = Math.min(maxBytes,ATTACHMENT_LIMITS.fileBytes);
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new AttachmentError('Недопустимый размер вложения.');
    // One deadline covers metadata, headers and the complete response stream.
    const deadline = AbortSignal.timeout(60_000);
    const combined = signal ? AbortSignal.any([signal,deadline]) : deadline;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const file = await this.#call<{file_path?:string;file_size?:number}>('getFile',{file_id:fileId},combined);
      if (file.file_size !== undefined && (!Number.isSafeInteger(file.file_size) || file.file_size < 0 || file.file_size > limit)) throw new AttachmentError('Файл слишком большой. Разделите материалы на части.');
      const path = file.file_path;
      // Telegram paths are relative identifiers, never user-selected URLs or
      // filesystem paths. A narrow alphabet also excludes encoded traversal.
      if (typeof path !== 'string' || path.length > 1024 || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(path) || path.split('/').some(part=>part === '.' || part === '..')) throw new AttachmentError('Не удалось получить файл Telegram. Отправьте его повторно.');
      const response = await this.#fetch(`${this.#baseUrl}/file/bot${this.#token}/${path}`,{signal:combined,redirect:'error'});
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new TelegramError(response.status,'download failed'); }
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit || !Number.isSafeInteger(Number(declared)))) { await response.body.cancel(); throw new AttachmentError('Файл слишком большой. Разделите материалы на части.'); }
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limit) throw new AttachmentError('Файл слишком большой. Разделите материалы на части.');
        chunks.push(chunk.value);
      }
      return Buffer.concat(chunks,size);
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Telegram request aborted','AbortError');
      if (error instanceof AttachmentError || error instanceof TelegramError) throw error;
      throw new TelegramError(0,'download failed');
    } finally { await reader?.cancel().catch(()=>{}); reader?.releaseLock(); }
  }
  async sendText(chatId: ChatId, text: string, options: SendOptions = {}): Promise<number> {
    let id = 0;
    for (const part of formatText(text)) {
      if (part.kind === 'image') continue;
      const sent = await this.#call<{message_id:number}>('sendMessage',{chat_id:chatId,message_thread_id:options.message_thread_id,text:part.text,...(options.reply_markup ? {reply_markup:options.reply_markup} : {})},options.signal);
      id = sent.message_id;
    }
    return id;
  }
  async sendPart(chatId: ChatId, part: OutgoingPart, options: SendOptions = {}): Promise<number> {
    if (part.kind === 'text') return this.sendText(chatId,part.text,options);
    if (part.kind === 'rich') {
      try {
        const sent = await this.#call<{message_id:number}>('sendRichMessage',{chat_id:chatId,message_thread_id:options.message_thread_id,rich_message:{markdown:part.text},...(options.reply_markup ? {reply_markup:options.reply_markup} : {})},options.signal);
        return sent.message_id;
      } catch (error) {
        if (error instanceof TelegramError && error.richUnsupported) return this.sendText(chatId,part.text,options);
        throw error;
      }
    }
    if (part.kind !== 'image') throw new TelegramError(400,'invalid outgoing part');
    const bytes = Buffer.from(part.base64,'base64');
    if (part.mime !== 'image/png' || bytes.length < 24 || bytes.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') throw new TelegramError(400,'invalid generated PNG');
    if (bytes.length > 49 * 1024 * 1024) throw new TelegramError(413,'generated PNG exceeds image upload size');
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height) throw new TelegramError(400,'invalid generated PNG dimensions');
    const photo = bytes.length <= 10 * 1024 * 1024 && width + height <= 10000 && Math.max(width,height) / Math.min(width,height) <= 20;
    const field = photo ? 'photo' : 'document';
    const form = new FormData();
    form.set('chat_id',String(chatId));
    if (options.message_thread_id !== undefined) form.set('message_thread_id',String(options.message_thread_id));
    form.set(field,new Blob([bytes],{type:'image/png'}),part.name.replace(/[^a-zA-Z0-9_.-]/g,'_').slice(0,120) || 'image.png');
    if (options.reply_markup) form.set('reply_markup',JSON.stringify(options.reply_markup));
    const sent = await this.#call<{message_id:number}>(photo ? 'sendPhoto' : 'sendDocument',form,options.signal,60_000);
    return sent.message_id;
  }
  async typing(chatId: ChatId, signal?: AbortSignal, topicId?: number): Promise<void> { await this.#call('sendChatAction',{chat_id:chatId,message_thread_id:topicId,action:'typing'},signal); }
  async createTopic(chatId: ChatId, name: string, signal?: AbortSignal): Promise<number> {
    const topic = await this.#call<{message_thread_id:number}>('createForumTopic',{chat_id:chatId,name},signal);
    return topic.message_thread_id;
  }
  async deleteTopic(chatId: ChatId, topicId: number, signal?: AbortSignal): Promise<void> {
    try { await this.#call('deleteForumTopic',{chat_id:chatId,message_thread_id:topicId},signal); }
    catch (error) { if (!(error instanceof TelegramError && error.topicMissing)) throw error; }
  }
  async answerCallback(id: string, text?: string, signal?: AbortSignal): Promise<void> { await this.#call('answerCallbackQuery',{callback_query_id:id,...(text ? {text} : {})},signal); }
}

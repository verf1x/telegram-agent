/** Shared seams. Implementations must keep each user's dialog independent. */
export type UserId = number;
export type ChatId = number;

export interface TelegramUser {
  id: UserId;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: ChatId; type: string };
  from?: TelegramUser;
  text?: string;
  caption?: string;
  media_group_id?: string;
  photo?: Array<{ file_id: string; width: number; height: number; file_size?: number }>;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
}

export const ATTACHMENT_LIMITS = {
  files: 10,
  fileBytes: 20_000_000,
  batchBytes: 50_000_000,
  imageBytes: 6_000_000,
  textBytes: 500_000,
  dialogueBytes: 12_000_000,
  albumQuietMs: 1500,
} as const;

/** Telegram references are durable; they are not local filesystem paths. */
export interface AttachmentRef {
  fileId: string;
  name: string;
  mime: string;
  size?: number;
  source: "photo" | "document";
}

export interface DownloadedAttachment {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

/** Normalized images, decoded only inside the isolated reader. */
export interface InputImage {
  name: string;
  mime: "image/jpeg" | "image/png";
  base64: string;
}

export interface PreparedAttachment {
  name: string;
  text: string;
  images: InputImage[];
}

export interface AttachmentReader {
  prepare(files: DownloadedAttachment[], signal: AbortSignal): Promise<PreparedAttachment[]>;
}

export class AttachmentError extends Error {
  constructor(message: string) { super(message); this.name = "AttachmentError"; }
}

export const GENERATED_IMAGE_LIMITS = {
  nativeImages: 4,
  imageBytes: 12_000_000,
  totalBytes: 24_000_000,
  dimension: 8192,
  pixels: 64_000_000,
} as const;

/** Only fixed, application-owned messages may be exposed to Telegram. */
export class ImageGenerationError extends Error {
  constructor(message: string) { super(message); this.name = "ImageGenerationError"; }
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

/** Unknown update kinds are acknowledged by update_id and otherwise ignored. */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

/** JSON-safe: saved before delivery and replayed after restart in the same order. */
export type OutgoingPart =
  | { kind: "rich" | "text"; text: string }
  | { kind: "image"; base64: string; name: string; mime: string };

export interface SendOptions {
  reply_markup?: InlineKeyboard;
  signal?: AbortSignal;
}

export interface TelegramTransport {
  getUpdates(options: {
    offset?: number;
    timeout: number;
    signal?: AbortSignal;
  }): Promise<TelegramUpdate[]>;
  sendText(chatId: ChatId, text: string, options?: SendOptions): Promise<number>;
  sendPart(chatId: ChatId, part: OutgoingPart, options?: SendOptions): Promise<number>;
  typing(chatId: ChatId, signal?: AbortSignal): Promise<void>;
  answerCallback(id: string, text?: string, signal?: AbortSignal): Promise<void>;
  downloadFile?(fileId: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array>;
}

/** Validated output bytes from isolated computations or native image generation. */
export interface GeneratedImage {
  bytes: Uint8Array;
  name: string;
  mime: string;
}

export interface ModelSelection {
  model: string;
  effort: string;
}

/** Completed conversation only; used to rebuild a thread after interrupted work. */
export interface ConversationMessage {
  role: "user" | "assistant";
  text: string;
  attachments?: PreparedAttachment[];
}

export interface ModelInfo {
  id: string;
  displayName?: string;
  supportedEfforts: string[];
  defaultEffort?: string;
}

export interface EngineHealth {
  available: boolean;
  detail?: string;
}

export interface ModelRequest extends ModelSelection {
  userId: UserId;
  threadId?: string;
  text: string;
  history?: ConversationMessage[];
  attachments?: PreparedAttachment[];
  signal: AbortSignal;
  /** Await persistence of the thread before continuing the request. */
  onThread: (threadId: string) => void | Promise<void>;
}

export interface ModelResponse {
  text: string;
  threadId: string;
  images: GeneratedImage[];
}

export interface ModelEngine {
  run(request: ModelRequest): Promise<ModelResponse>;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  deleteThread(threadId: string): Promise<void>;
  health(signal?: AbortSignal): Promise<EngineHealth>;
  close(): Promise<void>;
}

export interface BotConfig {
  botToken: string;
  ownerId: UserId;
  allowedUserIds: UserId[];
  databasePath: string;
  runtimeDir: string;
  maxConcurrentRequests: number;
  requestTimeoutMs: number;
  pollTimeoutSeconds: number;
  configReloadIntervalMs: number;
  defaultModel: "gpt-6.1-sol";
  defaultEffort: "medium";
}

/** Invalid snapshots pause new work and delivery. lastValid permits owner diagnostics. */
export type ConfigSnapshot =
  | { valid: true; config: BotConfig }
  | { valid: false; error: string; lastValid?: BotConfig };

export interface ConfigSource {
  snapshot(): ConfigSnapshot;
  /** Subscribe to validated reloads; the returned function stops this subscription. */
  watch(listener: (snapshot: ConfigSnapshot) => void): () => void;
  close(): void;
}

export interface Bot {
  /** Accept one Telegram update; request processing may continue after acceptance. */
  handleUpdate(update: TelegramUpdate): Promise<void>;
  /** Recover interrupted work and saved deliveries; never rerun model requests. */
  recover(): Promise<void>;
  /** Wait for all currently accepted processing and delivery work. */
  drain(): Promise<void>;
}

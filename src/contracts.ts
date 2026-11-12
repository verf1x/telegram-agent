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
  answerCallback(id: string, text?: string): Promise<void>;
}

/** Only images read by the trusted adapter from its isolated workspace. */
export interface GeneratedImage {
  bytes: Uint8Array;
  name: string;
  mime: string;
}

export interface ModelSelection {
  model: string;
  effort: string;
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
  listModels(): Promise<ModelInfo[]>;
  deleteThread(threadId: string): Promise<void>;
  health(): Promise<EngineHealth>;
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

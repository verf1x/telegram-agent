import { randomUUID } from "node:crypto";
import { RESPONSE_FILE_LIMITS, ResponseFileError } from "./contracts.ts";
import type { DialogueFile, GeneratedFile } from "./contracts.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AttachmentRef,
  ConversationMessage,
  ModelSelection,
  OutgoingPart,
} from "./contracts.ts";
export interface DialogueState {
  userId: number;
  username?: string;
  threadId?: string;
  history: ConversationMessage[];
  pending?: {
    refs: AttachmentRef[];
    captions: string[];
    readyAt?: number;
    awaitingTask?: boolean;
    savedFiles?: Record<string,string>;
  };
  selection?: ModelSelection;
  lastResponse?: string;
  request?: {
    id: string;
    text: string;
    threadId?: string;
    started: number;
    attachments?: AttachmentRef[];
    revoked?: boolean;
    fileIds?: string[];
  };
  reset?: { threadIds: string[] };
  delivery?: {
    parts: Array<OutgoingPart | {kind: "file"; id: string}>;
    next: number;
    retryAt?: number;
    failures?: number;
  };
}
export class SqliteStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("CREATE TABLE IF NOT EXISTS dialogue_files (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, bytes BLOB NOT NULL); CREATE INDEX IF NOT EXISTS files_user ON dialogue_files(user_id)");
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS dialogues (user_id INTEGER PRIMARY KEY, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }
  get offset(): number {
    return Number(
      (
        this.db
          .prepare("SELECT value FROM metadata WHERE key='offset'")
          .get() as { value: string } | undefined
      )?.value ?? 0,
    );
  }
  setOffset(offset: number): void {
    this.db
      .prepare(
        "INSERT INTO metadata(key,value) VALUES('offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(String(Math.max(offset, this.offset)));
  }
  get(userId: number): DialogueState {
    const row = this.db
      .prepare("SELECT state FROM dialogues WHERE user_id=?")
      .get(userId) as { state: string } | undefined;
    return row
      ? (JSON.parse(row.state) as DialogueState)
      : { userId, history: [] };
  }
  all(): DialogueState[] {
    return (
      this.db
        .prepare("SELECT state FROM dialogues ORDER BY user_id")
        .all() as Array<{ state: string }>
    ).map((x) => JSON.parse(x.state) as DialogueState);
  }
  put(state: DialogueState): void {
    this.db
      .prepare(
        "INSERT INTO dialogues(user_id,state) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET state=excluded.state",
      )
      .run(state.userId, JSON.stringify(state));
  }
  accept(updateId: number, state?: DialogueState): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (state) this.put(state);
      this.setOffset(updateId + 1);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  listFiles(userId: number): DialogueFile[] {
    return this.db.prepare("SELECT id,name,mime,size FROM dialogue_files WHERE user_id=? ORDER BY rowid").all(userId) as unknown as DialogueFile[];
  }
  readFile(userId: number, id: string): Uint8Array {
    const row = this.db.prepare("SELECT bytes FROM dialogue_files WHERE user_id=? AND id=?").get(userId,id) as {bytes: Uint8Array} | undefined;
    if (!row) throw new ResponseFileError("Файл недоступен в текущем диалоге.");
    return row.bytes;
  }
  saveFile(userId: number, file: GeneratedFile, quota = RESPONSE_FILE_LIMITS.dialogueBytes as number): DialogueFile {
    return this.persistFile(userId,file,quota);
  }
  saveResponseFile(userId: number, requestId: string, file: GeneratedFile, quota = RESPONSE_FILE_LIMITS.dialogueBytes as number): DialogueFile {
    return this.persistFile(userId,file,quota,requestId);
  }
  private persistFile(userId: number, file: GeneratedFile, quota: number, requestId?: string): DialogueFile {
    if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength > RESPONSE_FILE_LIMITS.fileBytes)
      throw new ResponseFileError("Файл превышает 50 МБ. Попросите уменьшить его размер.");
    if (!Number.isSafeInteger(quota) || quota <= 0) throw new Error("Invalid file quota");
    const name = file.name.replace(/\\/g,"/").split("/").at(-1)!.replace(/[\x00-\x1f\x7f]/g,"_").slice(0,180) || "document";
    const mime = /^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(file.mime) ? file.mime : "application/octet-stream";
    const result = {id: randomUUID(),name,mime,size:file.bytes.byteLength};
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = requestId === undefined ? undefined : this.get(userId);
      if (state && (!state.request || state.request.id !== requestId || state.request.revoked)) throw new ResponseFileError("Задание больше недоступно.");
      if (state && (state.request!.fileIds?.length ?? 0) >= RESPONSE_FILE_LIMITS.files) throw new ResponseFileError("Не более 10 файлов ответа на задание. Готовые файлы сохранены.");
      const used = (this.db.prepare("SELECT coalesce(sum(size),0) AS size FROM dialogue_files WHERE user_id=?").get(userId) as {size:number}).size;
      if (used + result.size > quota) throw new ResponseFileError("Хранилище файлов диалога заполнено. Старые файлы сохранены; начните новый диалог через /new.");
      this.db.prepare("INSERT INTO dialogue_files(id,user_id,name,mime,size,bytes) VALUES(?,?,?,?,?,?)").run(result.id,userId,name,mime,result.size,file.bytes);
      if (state) { (state.request!.fileIds ??= []).push(result.id); this.put(state); }
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  deleteFiles(userId: number): void {
    this.db.prepare("DELETE FROM dialogue_files WHERE user_id=?").run(userId);
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  close(): void {
    this.db.close();
  }
}

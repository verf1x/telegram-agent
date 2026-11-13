import { randomUUID } from "node:crypto";
import { RESPONSE_FILE_LIMITS, ResponseFileError } from "./contracts.ts";
import type { DialogueFile, GeneratedFile } from "./contracts.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AttachmentRef,
  DialogueAddress,
  ConversationMessage,
  ModelSelection,
  OutgoingPart,
} from "./contracts.ts";
export interface DialogueState extends DialogueAddress {
  migration?: { phase: "creating" | "retry" };
  legacyBinding?: boolean;
  bindingRetryAt?: number;
  deleteConfirmation?: { token: string; expires: number };
  deleting?: { id?: string; telegramDeleted?: boolean; threadIds: string[]; retryAt?: number; error?: string };
  username?: string;
  threadId?: string;
  /** Retain cleanup ownership even when best-effort deletion after a failure fails. */
  retiredThreadIds?: string[];
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
  reset?: { id?: string; threadIds: string[]; retryAt?: number };
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
    this.db.exec("CREATE TABLE IF NOT EXISTS dialogue_files (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, topic_id INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, bytes BLOB NOT NULL); CREATE INDEX IF NOT EXISTS files_user ON dialogue_files(user_id)");
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS dialogues (user_id INTEGER NOT NULL, topic_id INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, PRIMARY KEY(user_id,topic_id)); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    const fileColumns = this.db.prepare("PRAGMA table_info(dialogue_files)").all() as Array<{name:string}>;
    if (!fileColumns.some(column=>column.name==="topic_id")) this.db.exec("ALTER TABLE dialogue_files ADD COLUMN topic_id INTEGER NOT NULL DEFAULT 0");
    this.db.exec("CREATE INDEX IF NOT EXISTS files_dialogue ON dialogue_files(user_id,topic_id)");
    const columns = this.db.prepare("PRAGMA table_info(dialogues)").all() as Array<{name: string}>;
    if (!columns.some((column) => column.name === "topic_id")) {
      this.db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE dialogues RENAME TO legacy_dialogues;
        CREATE TABLE dialogues (user_id INTEGER NOT NULL, topic_id INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, PRIMARY KEY(user_id,topic_id));
        INSERT INTO dialogues(user_id,topic_id,state) SELECT user_id,0,state FROM legacy_dialogues;
        DROP TABLE legacy_dialogues;
        COMMIT;`);
    }
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
  get(user: number | DialogueAddress, topicId?: number): DialogueState {
    const address = typeof user === "number" ? {userId: user, ...(topicId ? {topicId} : {})} : user;
    const row = this.db
      .prepare("SELECT state FROM dialogues WHERE user_id=? AND topic_id=?")
      .get(address.userId, address.topicId ?? 0) as {state: string} | undefined;
    return row ? JSON.parse(row.state) as DialogueState : {...address, history: []};
  }
  /** Atomically adopt the old snapshot; never overwrite an existing topic. */
  moveLegacy(userId: number, topicId: number): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT state FROM dialogues WHERE user_id=? AND topic_id=0").get(userId) as {state:string} | undefined;
      if (row) {
        const state = JSON.parse(row.state) as DialogueState;
        state.topicId = topicId;
        delete state.migration;
        if (state.threadId) state.legacyBinding = true;
        this.db.prepare("INSERT INTO dialogues(user_id,topic_id,state) VALUES(?,?,?)").run(userId,topicId,JSON.stringify(state));
        this.db.prepare("UPDATE dialogue_files SET topic_id=? WHERE user_id=? AND topic_id=0").run(topicId,userId);
        this.db.prepare("DELETE FROM dialogues WHERE user_id=? AND topic_id=0").run(userId);
      }
      this.db.exec("COMMIT");
      return Boolean(row);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  remove(address: DialogueAddress): void {
    this.deleteFiles(address);
    this.db.prepare("DELETE FROM dialogues WHERE user_id=? AND topic_id=?").run(address.userId,address.topicId ?? 0);
  }
  all(): DialogueState[] {
    return (
      this.db
        .prepare("SELECT state FROM dialogues ORDER BY user_id,topic_id")
        .all() as Array<{ state: string }>
    ).map((x) => JSON.parse(x.state) as DialogueState);
  }
  put(state: DialogueState): void {
    this.db
      .prepare(
        "INSERT INTO dialogues(user_id,topic_id,state) VALUES(?,?,?) ON CONFLICT(user_id,topic_id) DO UPDATE SET state=excluded.state",
      )
      .run(state.userId, state.topicId ?? 0, JSON.stringify(state));
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
  listFiles(user: number | DialogueAddress): DialogueFile[] {
    const address = typeof user === "number" ? {userId:user} : user;
    return this.db.prepare("SELECT id,name,mime,size FROM dialogue_files WHERE user_id=? AND topic_id=? ORDER BY rowid").all(address.userId,address.topicId??0) as unknown as DialogueFile[];
  }
  readFile(user: number | DialogueAddress, id: string): Uint8Array {
    const address = typeof user === "number" ? {userId:user} : user;
    const row = this.db.prepare("SELECT bytes FROM dialogue_files WHERE user_id=? AND topic_id=? AND id=?").get(address.userId,address.topicId??0,id) as {bytes: Uint8Array} | undefined;
    if (!row) throw new ResponseFileError("Файл недоступен в текущем диалоге.");
    return row.bytes;
  }
  saveFile(user: number | DialogueAddress, file: GeneratedFile, quota = RESPONSE_FILE_LIMITS.dialogueBytes as number): DialogueFile {
    return this.persistFile(user,file,quota);
  }
  saveResponseFile(user: number | DialogueAddress, requestId: string, file: GeneratedFile, quota = RESPONSE_FILE_LIMITS.dialogueBytes as number): DialogueFile {
    return this.persistFile(user,file,quota,requestId);
  }
  private persistFile(user: number | DialogueAddress, file: GeneratedFile, quota: number, requestId?: string): DialogueFile {
    const address = typeof user === "number" ? {userId:user} : user;
    if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength > RESPONSE_FILE_LIMITS.fileBytes)
      throw new ResponseFileError("Файл превышает 50 МБ. Попросите уменьшить его размер.");
    if (!Number.isSafeInteger(quota) || quota <= 0) throw new Error("Invalid file quota");
    const name = file.name.replace(/\\/g,"/").split("/").at(-1)!.replace(/[\x00-\x1f\x7f]/g,"_").slice(0,180) || "document";
    const mime = /^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(file.mime) ? file.mime : "application/octet-stream";
    const result = {id: randomUUID(),name,mime,size:file.bytes.byteLength};
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = requestId === undefined ? undefined : this.get(address);
      if (state && (!state.request || state.request.id !== requestId || state.request.revoked)) throw new ResponseFileError("Задание больше недоступно.");
      if (state && (state.request!.fileIds?.length ?? 0) >= RESPONSE_FILE_LIMITS.files) throw new ResponseFileError("Не более 10 файлов ответа на задание. Готовые файлы сохранены.");
      const used = (this.db.prepare("SELECT coalesce(sum(size),0) AS size FROM dialogue_files WHERE user_id=? AND topic_id=?").get(address.userId,address.topicId??0) as {size:number}).size;
      if (used + result.size > quota) throw new ResponseFileError("Хранилище файлов диалога заполнено. Старые файлы сохранены; начните новый диалог через /new.");
      this.db.prepare("INSERT INTO dialogue_files(id,user_id,topic_id,name,mime,size,bytes) VALUES(?,?,?,?,?,?,?)").run(result.id,address.userId,address.topicId??0,name,mime,result.size,file.bytes);
      if (state) { (state.request!.fileIds ??= []).push(result.id); this.put(state); }
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  deleteFiles(user: number | DialogueAddress): void {
    const address = typeof user === "number" ? {userId:user} : user;
    this.db.prepare("DELETE FROM dialogue_files WHERE user_id=? AND topic_id=?").run(address.userId,address.topicId??0);
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  close(): void {
    this.db.close();
  }
}

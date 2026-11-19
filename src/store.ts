import { randomUUID } from "node:crypto";
import { dialogueKey, RESPONSE_FILE_LIMITS, ResponseFileError } from "./contracts.ts";
import type { DialogueFile, GeneratedFile } from "./contracts.ts";
import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ArchivedMaterial } from "./dialogue-context.ts";
import type {
  AttachmentRef,
  DialogueAddress,
  ConversationMessage,
  ModelSelection,
  OutgoingPart,
} from "./contracts.ts";
export interface TaskSource {
  messageId?: number;
  text: string;
}

export interface DialogueState extends DialogueAddress {
  autoNameTopic?: true;
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
  summary?: string;
  contextPressure?: boolean;
  latestTask?: {
    sources: TaskSource[];
    historyIndex: number;
    completed?: { inputFileIds: string[]; outputFileIds: string[] };
    button?: string;
  };
  /** Superseded outputs remain stored, but are no longer model context. */
  inactiveFileIds?: string[];
  pending?: {
    refs: AttachmentRef[];
    sources?: TaskSource[];
    captions?: string[]; // Legacy pending snapshots.
    readyAt?: number;
    awaitingTask?: boolean;
    savedFiles?: Record<string,string>;
  };
  selection?: ModelSelection;
  lastResponse?: string;
  previewCleanup?: Array<{id: number; retryAt?: number}>;
  request?: {
    id: string;
    text: string;
    threadId?: string;
    repeat?: boolean;
    started: number;
    attachments?: AttachmentRef[];
    revoked?: boolean;
    stopped?: boolean;
    fileIds?: string[];
    imageIds?: string[];
  };
  reset?: { id?: string; threadIds: string[]; retryAt?: number };
  delivery?: {
    parts: Array<OutgoingPart | {kind: "file"; id: string}>;
    next: number;
    buttonAt?: number;
    retryAt?: number;
    failures?: number;
  };
}

export interface BroadcastState {
  id: string;
  owner: DialogueAddress;
  text: string;
  recipients: Array<{
    userId: number;
    status: "pending" | "sending" | "sent" | "skipped" | "failed" | "unknown";
    retries?: number;
  }>;
  retryAt?: number;
  reportRetries?: number;
}

/** Never retain JSON.parse's cause: Node may print the entire private input. */
export class StoredDialogueError extends Error {
  constructor() { super("Не удалось прочитать сохранённое состояние диалога. Данные сохранены."); this.name = "StoredDialogueError"; }
}
function validDeadline(value: unknown): boolean {
  return value == null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}
function stringList(value: unknown): boolean {
  return Array.isArray(value) && value.every(id => typeof id === "string");
}
function parseState(value: string): DialogueState {
  let state: DialogueState;
  try {
    state = JSON.parse(value) as DialogueState;
  } catch {
    throw new StoredDialogueError();
  }
  if (!state || !Array.isArray(state.history) || !validDeadline(state.bindingRetryAt) ||
      (state.threadId != null && typeof state.threadId !== "string") ||
      (state.pending != null && (!Array.isArray(state.pending.refs) || !validDeadline(state.pending.readyAt))) ||
      (state.request != null && (typeof state.request.id !== "string" ||
        (state.request.threadId != null && typeof state.request.threadId !== "string") ||
        (state.request.fileIds != null && !stringList(state.request.fileIds)) ||
        (state.request.imageIds != null && !stringList(state.request.imageIds)))) ||
      (state.reset != null && (!stringList(state.reset.threadIds) || !validDeadline(state.reset.retryAt))) ||
      (state.deleting != null && (!stringList(state.deleting.threadIds) || !validDeadline(state.deleting.retryAt))) ||
      (state.delivery != null && (!Array.isArray(state.delivery.parts) || !validDeadline(state.delivery.retryAt) ||
        !Number.isSafeInteger(state.delivery.next) || state.delivery.next < 0)) ||
      (state.previewCleanup != null && (!Array.isArray(state.previewCleanup) ||
        state.previewCleanup.some(entry => !Number.isSafeInteger(entry?.id) || !validDeadline(entry.retryAt)))) ||
      (state.latestTask?.sources !== undefined && (!Array.isArray(state.latestTask.sources) ||
        state.latestTask.sources.some(source => typeof source?.text !== "string"))) ||
      (state.retiredThreadIds != null && !stringList(state.retiredThreadIds)) ||
      (state.inactiveFileIds != null && !stringList(state.inactiveFileIds)) ||
      (state.username != null && typeof state.username !== "string")) throw new StoredDialogueError();
  return state;
}

type BroadcastRow = {id: string; owner_id: number; state: string};
const broadcastStatuses = new Set(["pending", "sending", "sent", "skipped", "failed", "unknown"]);
function parseBroadcast(row: BroadcastRow): BroadcastState | undefined {
  try {
    const state = JSON.parse(row.state) as BroadcastState;
    if (state?.id === row.id && state.owner?.userId === row.owner_id && typeof state.text === "string" &&
        validDeadline(state.retryAt) && Array.isArray(state.recipients) && state.recipients.every(recipient =>
          Number.isSafeInteger(recipient?.userId) && broadcastStatuses.has(recipient.status))) return state;
  } catch { /* Report the error at the storage boundary, without the input. */ }
}

type DialogueRow = { user_id: number; topic_id: number };
function addressOf(row: DialogueRow): DialogueAddress {
  return {userId: row.user_id, ...(row.topic_id ? {topicId: row.topic_id} : {})};
}

type DialogueOperation = {kind: "binding" | "delete" | "reset" | "delivery"; dueAt: number};
export function dialogueOperations(state: DialogueState): DialogueOperation[] {
  if (state.legacyBinding) return [{kind: "binding", dueAt: state.bindingRetryAt ?? 0}];
  const operations: DialogueOperation[] = [];
  if (state.deleting) operations.push({kind: "delete", dueAt: state.deleting.retryAt ?? 0});
  if (state.reset) operations.push({kind: "reset", dueAt: state.reset.retryAt ?? 0});
  if (state.delivery) operations.push({kind: "delivery", dueAt: state.delivery.retryAt ?? 0});
  return operations;
}

function dialogueMetadata(state: DialogueState) {
  const operations = dialogueOperations(state);
  let previewDue: number | null = null;
  for (const preview of state.previewCleanup ?? []) {
    const at = preview?.retryAt ?? 0;
    previewDue = previewDue === null ? at : Math.min(previewDue, at);
  }
  return [state.username ?? null, Number(Boolean(state.request || operations.length)),
    Number(Boolean(state.pending || state.request || state.retiredThreadIds?.length)),
    state.pending?.readyAt ?? null, Number(Boolean((state.request && !state.request.revoked) || state.delivery || state.pending?.readyAt || (state.pending && !state.pending.awaitingTask))),
    Number(Boolean(state.deleting?.error)), state.topicId && operations.length ? Math.min(...operations.map(op => op.dueAt)) : null,
    previewDue] as const;
}

interface StoreDatabase {
  exec: DatabaseSync["exec"];
  prepare(sql: string): Pick<StatementSync, "all" | "get" | "iterate" | "run">;
  close: DatabaseSync["close"];
}

interface FilePayloads {
  put(id: string, bytes: Uint8Array): void;
  read(id: string): Uint8Array;
  remove(ids: string[]): void;
  recover(referenced: ReadonlySet<string>): void;
}

export class SqliteStore {
  private readonly db: StoreDatabase;
  private readonly payloads: FilePayloads | undefined;
  private pendingPayloadDeletes?: Map<string, string[]>;
  private acceptedOffset = 0;
  private transacting = false;
  private changed = false;
  private readonly listeners = new Set<() => void>();
  constructor(path: string, options?: { database?: StoreDatabase; payloads?: FilePayloads }) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = options?.database ?? new DatabaseSync(path);
    this.payloads = options?.payloads;
    this.db.exec("CREATE TABLE IF NOT EXISTS dialogue_files (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, topic_id INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, bytes BLOB NOT NULL); CREATE INDEX IF NOT EXISTS files_user ON dialogue_files(user_id)");
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS dialogues (user_id INTEGER NOT NULL, topic_id INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, PRIMARY KEY(user_id,topic_id)); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    this.db.exec("CREATE TABLE IF NOT EXISTS broadcasts (id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, state TEXT NOT NULL)");
    const fileColumns = this.db.prepare("PRAGMA table_info(dialogue_files)").all() as Array<{name:string}>;
    if (!fileColumns.some(column=>column.name==="topic_id")) this.db.exec("ALTER TABLE dialogue_files ADD COLUMN topic_id INTEGER NOT NULL DEFAULT 0");
    if (!fileColumns.some(column=>column.name==="prepared")) this.db.exec("ALTER TABLE dialogue_files ADD COLUMN prepared INTEGER NOT NULL DEFAULT 0");
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
    this.migrateScheduling();
    const offset = this.db.prepare("SELECT value FROM metadata WHERE key='offset'").get() as {value: string} | undefined;
    this.acceptedOffset = Number(offset?.value ?? 0);
    if (this.payloads) {
      const files = this.db.prepare("SELECT id FROM dialogue_files").all() as Array<{id: string}>;
      this.payloads.recover(new Set(files.map(file => file.id)));
    }
  }
  private migrateScheduling(): void {
    const columns = this.db.prepare("PRAGMA table_info(dialogues)").all() as Array<{name: string}>;
    const upgrade = !columns.some(column => column.name === "due_at");
    this.transaction(() => {
      if (upgrade) this.db.exec(`
        ALTER TABLE dialogues ADD COLUMN username TEXT;
        ALTER TABLE dialogues ADD COLUMN busy INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE dialogues ADD COLUMN recover INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE dialogues ADD COLUMN album_at INTEGER;
        ALTER TABLE dialogues ADD COLUMN access_work INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE dialogues ADD COLUMN incomplete_delete INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE dialogues ADD COLUMN due_at INTEGER;
        ALTER TABLE dialogues ADD COLUMN preview_at INTEGER;
        ALTER TABLE dialogues ADD COLUMN unreadable INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE broadcasts ADD COLUMN due_at INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE broadcasts ADD COLUMN unreadable INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX dialogues_recover ON dialogues (user_id,topic_id) WHERE recover=1 AND unreadable=0;
        CREATE INDEX dialogues_access_work ON dialogues (user_id,topic_id) WHERE access_work=1 AND unreadable=0;
        CREATE INDEX dialogues_album ON dialogues (user_id,topic_id) WHERE album_at IS NOT NULL AND unreadable=0;
        CREATE INDEX dialogues_busy ON dialogues (user_id,topic_id) WHERE busy=1 AND unreadable=0;
        CREATE INDEX dialogues_legacy ON dialogues (user_id) WHERE topic_id=0 AND unreadable=0;
        CREATE INDEX dialogues_due ON dialogues (due_at,user_id,topic_id) WHERE due_at IS NOT NULL AND unreadable=0;
        CREATE INDEX dialogues_preview ON dialogues (preview_at,user_id,topic_id) WHERE preview_at IS NOT NULL AND unreadable=0;
        CREATE INDEX dialogues_unreadable ON dialogues (user_id,topic_id) WHERE unreadable=1;
        CREATE INDEX broadcasts_owner ON broadcasts (owner_id) WHERE unreadable=0;
        CREATE INDEX broadcasts_unreadable ON broadcasts (id) WHERE unreadable=1;
      `);
      const addresses = this.addresses(upgrade ? "TRUE" : "unreadable=1");
      const update = this.db.prepare(`UPDATE dialogues SET
        username=?,busy=?,recover=?,album_at=?,access_work=?,incomplete_delete=?,due_at=?,preview_at=?,unreadable=0
        WHERE user_id=? AND topic_id=?`);
      for (const address of addresses) {
        try {
          const state = this.findDialogue(address);
          if (state) update.run(...dialogueMetadata(state), address.userId, address.topicId ?? 0);
        } catch (error) { if (!(error instanceof StoredDialogueError)) throw error; }
      }
      const reports = this.db.prepare(`SELECT id,owner_id,state FROM broadcasts WHERE ${upgrade ? "TRUE" : "unreadable=1"}`)
        .all() as BroadcastRow[];
      const saveDue = this.db.prepare("UPDATE broadcasts SET due_at=?,unreadable=0 WHERE id=?");
      for (const row of reports) {
        const state = parseBroadcast(row);
        if (state) saveDue.run(state.retryAt ?? 0, row.id);
        else this.markUnreadableBroadcast(row.id);
      }
    });
  }
  watchWork(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private notifyWork(): void {
    if (this.transacting) this.changed = true;
    else for (const listener of this.listeners) listener();
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    this.transacting = true;
    const previousOffset = this.acceptedOffset;
    let result: T;
    try {
      result = work();
      this.db.exec("COMMIT");
    } catch (error) {
      this.changed = false;
      this.acceptedOffset = previousOffset;
      this.db.exec("ROLLBACK");
      throw error;
    } finally { this.transacting = false; }
    if (this.changed) {
      this.changed = false;
      this.notifyWork();
    }
    return result;
  }
  get offset(): number { return this.acceptedOffset; }
  nextDraftId(): number {
    const row = this.db.prepare(`INSERT INTO metadata (key, value) VALUES ('draft_id', '1')
      ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) % 2147483647 + 1
      RETURNING CAST(value AS INTEGER) AS id`).get() as {id: number};
    return row.id;
  }
  get(user: number | DialogueAddress, topicId?: number): DialogueState {
    const address = typeof user === "number" ? {userId: user, ...(topicId ? {topicId} : {})} : user;
    return this.findDialogue(address) ?? {...address, history: []};
  }
  findDialogue(address: DialogueAddress): DialogueState | undefined {
    const row = this.db
      .prepare("SELECT state FROM dialogues WHERE user_id=? AND topic_id=?")
      .get(address.userId, address.topicId ?? 0) as {state: string} | undefined;
    if (!row) return;
    try {
      const state = parseState(row.state);
      if (state.userId !== address.userId || (state.topicId ?? 0) !== (address.topicId ?? 0)) throw new StoredDialogueError();
      return state;
    } catch (error) {
      const result = this.db.prepare("UPDATE dialogues SET unreadable=1 WHERE user_id=? AND topic_id=? AND unreadable=0")
        .run(address.userId, address.topicId ?? 0);
      if (result.changes) {
        console.error("Не удалось прочитать сохранённое состояние диалога. Данные сохранены.");
        this.notifyWork();
      }
      throw error;
    }
  }
  private addresses(condition: string): DialogueAddress[] {
    const rows = this.db.prepare(`SELECT user_id,topic_id FROM dialogues WHERE ${condition}`).all() as DialogueRow[];
    return rows.map(addressOf);
  }
  recoveryAddresses(): DialogueAddress[] { return this.addresses("recover=1 AND unreadable=0"); }
  legacyAddresses(): DialogueAddress[] { return this.addresses("topic_id=0 AND unreadable=0"); }
  busyAddresses(): DialogueAddress[] { return this.addresses("busy=1 AND unreadable=0"); }
  albumAddresses(): DialogueAddress[] { return this.addresses("album_at IS NOT NULL AND unreadable=0"); }
  revokedWorkAddresses(allowed: readonly number[]): DialogueAddress[] {
    const placeholders = allowed.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT user_id,topic_id FROM dialogues
      WHERE access_work=1 AND unreadable=0 AND user_id NOT IN (${placeholders})`).all(...allowed) as DialogueRow[];
    return rows.map(addressOf);
  }
  *scheduledDialogues(kind: "dialogue" | "preview"): Iterable<DialogueAddress & {dueAt: number}> {
    const field = kind === "dialogue" ? "due_at" : "preview_at";
    const rows = this.db.prepare(`SELECT user_id,topic_id,${field} AS due_at FROM dialogues
      WHERE ${field} IS NOT NULL AND unreadable=0 ORDER BY ${field},user_id,topic_id`)
      .iterate() as Iterable<DialogueRow & {due_at: number}>;
    for (const row of rows) yield {...addressOf(row), dueAt: row.due_at};
  }
  incompleteDeletions(userId: number): number {
    return (this.db.prepare("SELECT count(*) AS total FROM dialogues WHERE user_id=? AND incomplete_delete=1")
      .get(userId) as {total: number}).total;
  }
  username(userId: number): string | undefined {
    const row = this.db.prepare("SELECT username FROM dialogues WHERE user_id=? ORDER BY topic_id LIMIT 1")
      .get(userId) as {username: string | null} | undefined;
    return row?.username ?? undefined;
  }
  /** Atomically adopt the old snapshot; never overwrite an existing topic. */
  moveLegacy(userId: number, topicId: number): boolean {
    return this.transaction(() => {
      const state = this.findDialogue({userId});
      if (!state) return false;
      state.topicId = topicId;
      delete state.migration;
      if (state.threadId) state.legacyBinding = true;
      this.writeDialogue(state, false);
      this.db.prepare("UPDATE dialogue_files SET topic_id=? WHERE user_id=? AND topic_id=0").run(topicId,userId);
      this.db.prepare("DELETE FROM dialogues WHERE user_id=? AND topic_id=0").run(userId);
      return true;
    });
  }
  remove(address: DialogueAddress): void {
    const ids = this.transaction(() => {
      const removed = this.removeFiles(address);
      this.db.prepare("DELETE FROM dialogues WHERE user_id=? AND topic_id=?").run(address.userId,address.topicId ?? 0);
      this.notifyWork();
      return removed;
    });
    this.removePayloads(address, ids);
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  all(): DialogueState[] {
    return (
      this.db
        .prepare("SELECT state FROM dialogues ORDER BY user_id,topic_id")
        .all() as Array<{ state: string }>
    ).map((x) => parseState(x.state));
  }
  put(state: DialogueState): void {
    this.writeDialogue(state, true);
  }
  private writeDialogue(state: DialogueState, replace: boolean): void {
    const fields = "state,username,busy,recover,album_at,access_work,incomplete_delete,due_at,preview_at";
    const values = replace ? `ON CONFLICT(user_id,topic_id) DO UPDATE SET
      (${fields},unreadable) = (${fields.split(",").map(field => `excluded.${field}`).join(",")},0)` : "";
    this.db.prepare(`INSERT INTO dialogues(user_id,topic_id,${fields}) VALUES(?,?,?,?,?,?,?,?,?,?,?) ${values}`)
      .run(state.userId, state.topicId ?? 0, JSON.stringify(state), ...dialogueMetadata(state));
    this.notifyWork();
  }
  putCompacted(state: DialogueState, archived: ArchivedMaterial[]): void {
    this.transaction(() => {
      const insert = this.db.prepare("INSERT INTO dialogue_files(id,user_id,topic_id,name,mime,size,bytes,prepared) VALUES(?,?,?,?,?,?,?,1)");
      for (const {id, name, attachment} of archived) {
        const bytes = Buffer.from(JSON.stringify(attachment));
        insert.run(id,state.userId,state.topicId??0,name,"application/json",bytes.length,this.storePayload(id,bytes));
      }
      this.put(state);
    });
  }
  acceptTopicCreation(updateId: number, address: DialogueAddress & {topicId: number}, eligible: boolean): void {
    this.acceptUpdate(updateId, () => {
      const state: DialogueState = {...address, history: [], ...(eligible ? {autoNameTopic: true} : {})};
      this.db.prepare("INSERT INTO dialogues(user_id,topic_id,state) VALUES(?,?,?) ON CONFLICT DO NOTHING")
        .run(address.userId, address.topicId, JSON.stringify(state));
    });
  }
  accept(updateId: number, state?: DialogueState | BroadcastState): void {
    this.acceptUpdate(updateId, () => {
      if (state && "recipients" in state) this.putBroadcast(state);
      else if (state) this.put(state);
    });
  }
  private acceptUpdate(updateId: number, save: () => void): void {
    const offset = Math.max(updateId + 1, this.acceptedOffset);
    this.transaction(() => {
      save();
      if (offset > this.acceptedOffset) {
        this.db.prepare(`INSERT INTO metadata(key,value) VALUES('offset',?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(offset));
        this.acceptedOffset = offset;
      }
    });
  }
  broadcastHead(ownerId: number): {id: string; due_at: number} | undefined {
    return this.db.prepare("SELECT id,due_at FROM broadcasts WHERE owner_id=? AND unreadable=0 ORDER BY rowid LIMIT 1")
      .get(ownerId) as {id: string; due_at: number} | undefined;
  }
  nextBroadcast(ownerId: number): BroadcastState | undefined {
    const head = this.broadcastHead(ownerId);
    return head && this.getBroadcast(head.id);
  }
  getBroadcast(id: string): BroadcastState | undefined {
    const row = this.db.prepare("SELECT id,owner_id,state FROM broadcasts WHERE id=? AND unreadable=0").get(id) as BroadcastRow | undefined;
    if (!row) return;
    const state = parseBroadcast(row);
    if (!state) this.markUnreadableBroadcast(id);
    return state;
  }
  private markUnreadableBroadcast(id: string): void {
    const result = this.db.prepare("UPDATE broadcasts SET unreadable=1 WHERE id=? AND unreadable=0").run(id);
    if (result.changes) {
      console.error("Не удалось прочитать сохранённую рассылку. Данные сохранены.");
      this.notifyWork();
    }
  }
  putBroadcast(state: BroadcastState): void {
    this.db.prepare(`INSERT INTO broadcasts(id,owner_id,state,due_at) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state,due_at=excluded.due_at,unreadable=0`)
      .run(state.id, state.owner.userId, JSON.stringify(state), state.retryAt ?? 0);
    this.notifyWork();
  }
  removeBroadcast(id: string): void {
    this.db.prepare("DELETE FROM broadcasts WHERE id=?").run(id);
    this.notifyWork();
  }
  listFiles(user: number | DialogueAddress): DialogueFile[] {
    const address = typeof user === "number" ? {userId:user} : user;
    const files = this.db.prepare("SELECT id,name,mime,size,prepared FROM dialogue_files WHERE user_id=? AND topic_id=? ORDER BY rowid")
      .all(address.userId,address.topicId??0) as unknown as Array<Omit<DialogueFile, "prepared"> & {prepared: number}>;
    return files.map(({prepared, ...file}) => prepared ? {...file, prepared: true} : file);
  }
  readFile(user: number | DialogueAddress, id: string): Uint8Array {
    const address = typeof user === "number" ? {userId:user} : user;
    const row = this.db.prepare("SELECT bytes FROM dialogue_files WHERE user_id=? AND topic_id=? AND id=?").get(address.userId,address.topicId??0,id) as {bytes: Uint8Array} | undefined;
    if (!row) throw new ResponseFileError("Файл недоступен в текущем диалоге.");
    return this.payloads?.read(id) ?? row.bytes;
  }
  saveFile(user: number | DialogueAddress, file: GeneratedFile, quota = RESPONSE_FILE_LIMITS.dialogueBytes as number): DialogueFile {
    return this.persistFile(user,file,quota);
  }
  saveResponseFile(user: number | DialogueAddress, requestId: string, file: GeneratedFile, quota = RESPONSE_FILE_LIMITS.dialogueBytes as number): DialogueFile {
    return this.persistFile(user, file, quota, {id: requestId, kind: "file"});
  }
  saveResponseImage(user: DialogueAddress, requestId: string, image: GeneratedFile, quota = RESPONSE_FILE_LIMITS.dialogueBytes as number): DialogueFile {
    return this.persistFile(user, image, quota, {id: requestId, kind: "image"});
  }
  private persistFile(user: number | DialogueAddress, file: GeneratedFile, quota: number, output?: {id: string; kind: "file" | "image"}): DialogueFile {
    const address = typeof user === "number" ? {userId:user} : user;
    if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength > RESPONSE_FILE_LIMITS.fileBytes)
      throw new ResponseFileError("Файл превышает 50 МБ. Попросите уменьшить его размер.");
    if (!Number.isSafeInteger(quota) || quota <= 0) throw new Error("Invalid file quota");
    const name = file.name.replace(/\\/g,"/").split("/").at(-1)!.replace(/[\x00-\x1f\x7f]/g,"_").slice(0,180) || "document";
    const mime = /^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(file.mime) ? file.mime : "application/octet-stream";
    const result = {id: randomUUID(),name,mime,size:file.bytes.byteLength};
    return this.transaction(() => {
      const state = output ? this.get(address) : undefined;
      const request = state?.request;
      if (output && (request?.id !== output.id || request.stopped || (request.revoked && output.kind === "file")))
        throw new ResponseFileError("Задание больше недоступно.");
      if (output?.kind === "file" && (request?.fileIds?.length ?? 0) >= RESPONSE_FILE_LIMITS.files)
        throw new ResponseFileError("Не более 10 файлов ответа на задание. Готовые файлы сохранены.");
      const used = (this.db.prepare("SELECT coalesce(sum(size),0) AS size FROM dialogue_files WHERE user_id=? AND topic_id=?").get(address.userId,address.topicId??0) as {size:number}).size;
      if (used + result.size > quota) throw new ResponseFileError("Хранилище файлов диалога заполнено. Старые файлы сохранены; начните новый диалог через /new.");
      this.db.prepare("INSERT INTO dialogue_files(id,user_id,topic_id,name,mime,size,bytes) VALUES(?,?,?,?,?,?,?)").run(result.id,address.userId,address.topicId??0,name,mime,result.size,this.storePayload(result.id,file.bytes));
      if (state && request) {
        const ids = output?.kind === "image" ? (request.imageIds ??= []) : (request.fileIds ??= []);
        ids.push(result.id);
        this.put(state);
      }
      return result;
    });
  }
  deleteFiles(user: number | DialogueAddress): void {
    const address = typeof user === "number" ? {userId:user} : user;
    if (this.payloads) {
      const ids = this.transaction(() => this.removeFiles(address));
      this.removePayloads(address, ids);
    } else this.removeFiles(address);
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  private removeFiles(address: DialogueAddress): string[] {
    const sql = "DELETE FROM dialogue_files WHERE user_id=? AND topic_id=?";
    if (this.payloads) {
      const files = this.db.prepare(sql + " RETURNING id").all(address.userId,address.topicId??0) as Array<{id: string}>;
      return files.map(file => file.id);
    }
    this.db.prepare(sql).run(address.userId,address.topicId??0);
    return [];
  }
  private removePayloads(address: DialogueAddress, ids: string[]): void {
    if (!this.payloads) return;
    const key = dialogueKey(address);
    const pending = this.pendingPayloadDeletes?.get(key);
    const files = pending ? [...pending, ...ids] : ids;
    if (!files.length) return;
    try {
      this.payloads.remove(files);
      this.pendingPayloadDeletes?.delete(key);
    } catch (error) {
      // The database deletion has committed. Retain the IDs for retries in this process.
      (this.pendingPayloadDeletes ??= new Map()).set(key, files);
      throw error;
    }
  }
  private storePayload(id: string, bytes: Uint8Array): Uint8Array {
    if (!this.payloads) return bytes;
    this.payloads.put(id, bytes);
    return Buffer.alloc(0);
  }
  close(): void {
    this.db.close();
  }
}

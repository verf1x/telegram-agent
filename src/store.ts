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
  };
  reset?: { id?: string; threadIds: string[]; retryAt?: number };
  delivery?: {
    parts: OutgoingPart[];
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
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS dialogues (user_id INTEGER NOT NULL, topic_id INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, PRIMARY KEY(user_id,topic_id)); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
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
        this.db.prepare("DELETE FROM dialogues WHERE user_id=? AND topic_id=0").run(userId);
      }
      this.db.exec("COMMIT");
      return Boolean(row);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  remove(address: DialogueAddress): void {
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
  close(): void {
    this.db.close();
  }
}

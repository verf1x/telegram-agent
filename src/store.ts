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
  reset?: { threadIds: string[] };
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
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS dialogues (user_id INTEGER PRIMARY KEY, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
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
  close(): void {
    this.db.close();
  }
}

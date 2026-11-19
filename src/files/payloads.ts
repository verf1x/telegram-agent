import {
  chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const fileKey = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

export class MaterialStorageError extends Error {
  constructor() { super("Не удалось открыть хранилище материалов. Проверьте права и комплект резервной копии."); }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function isUnavailablePayload(error: unknown): boolean {
  return error instanceof MaterialStorageError || ["ENOENT", "ENOTDIR", "ELOOP"].some(code => hasCode(error, code));
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

export class DirectoryPayloads {
  private readonly directory: string;
  constructor(directory: string) { this.directory = directory; }

  bind(id: string, hasFiles: boolean): void {
    if (!fileKey.test(id)) throw new MaterialStorageError();
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.directory).isDirectory()) throw new MaterialStorageError();

    const marker = ".store-" + id;
    const entries = readdirSync(this.directory);
    if (!entries.includes(marker)) {
      if (hasFiles || entries.length) throw new MaterialStorageError();
      const fd = openSync(join(this.directory, marker), "wx", 0o600);
      try { fsyncSync(fd); }
      finally { closeSync(fd); }
    } else if (!lstatSync(join(this.directory, marker)).isFile()) throw new MaterialStorageError();
    chmodSync(this.directory, 0o700);
    syncDirectory(this.directory);
    syncDirectory(dirname(this.directory));
  }

  private path(key: string): string {
    if (!fileKey.test(key)) throw new MaterialStorageError();
    return join(this.directory, key);
  }

  put(key: string, bytes: Uint8Array, onCreated: () => void): void {
    const fd = openSync(this.path(key), "wx", 0o600);
    try {
      onCreated();
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Make the directory entry durable before committing the database reference.
    syncDirectory(this.directory);
  }

  available(key: string, size: number): boolean {
    try {
      const file = lstatSync(this.path(key));
      return file.isFile() && file.size === size;
    } catch (error) {
      // Keep transient filesystem errors eligible for retry when the bytes are requested.
      return !isUnavailablePayload(error);
    }
  }

  read(key: string): Uint8Array {
    const fd = openSync(this.path(key), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) throw new MaterialStorageError();
      return readFileSync(fd);
    } finally { closeSync(fd); }
  }

  remove(keys: string[]): void {
    if (!keys.length) return;
    for (const key of keys) {
      try { unlinkSync(this.path(key)); }
      catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    }
    syncDirectory(this.directory);
  }

  recover(referenced: ReadonlySet<string>, pendingDeletion: ReadonlySet<string>): void {
    const entries = this.fileKeys();
    const present = new Set(entries);
    if ([...referenced].some(key => !present.has(key)))
      console.error("Часть сохранённых файлов недоступна. Бот продолжит работу с доступными материалами.");

    // Keep pending deletions with their dialogue. An interrupted write leaves no reference.
    const orphans = entries.filter(key => !referenced.has(key) && !pendingDeletion.has(key));
    try { this.remove(orphans); }
    catch { console.error("Не удалось убрать файлы незавершённых записей. Бот повторит очистку при запуске."); }
  }

  fileKeys(): string[] {
    return readdirSync(this.directory).filter(key => fileKey.test(key));
  }
}

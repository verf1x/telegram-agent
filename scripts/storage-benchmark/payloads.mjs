import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const fileId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

function syncDirectory(path) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

export class DirectoryPayloads {
  constructor(directory) {
    this.directory = directory;
    if (mkdirSync(directory, { recursive: true, mode: 0o700 })) syncDirectory(dirname(directory));
  }

  path(id) {
    if (!fileId.test(id)) throw new Error("Invalid payload ID");
    return join(this.directory, id);
  }

  put(id, bytes) {
    const fd = openSync(this.path(id), "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Make the directory entry durable before committing the database reference.
    syncDirectory(this.directory);
  }

  read(id) {
    return readFileSync(this.path(id));
  }

  remove(ids) {
    if (!ids.length) return;
    for (const id of ids) {
      try { unlinkSync(this.path(id)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    syncDirectory(this.directory);
  }

  recover(referenced) {
    // One writer owns this directory. An interrupted write or delete may leave an orphan.
    this.remove(readdirSync(this.directory).filter(id => fileId.test(id) && !referenced.has(id)));
  }
}

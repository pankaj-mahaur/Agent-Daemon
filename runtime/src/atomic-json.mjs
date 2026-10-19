// Atomic JSON files for registries (P3.2; P4.1 reuses it): written to a temp file in
// the same folder with an fsync, then renamed over, so a reader sees the old file or
// the new one, never half. Owner-only (0600) from the first byte. Windows: a file
// another process has open can't be replaced for a moment, so the rename is retried
// (EPERM / EBUSY / EACCES, 5 tries at 20…320 ms). POSIX: the folder is fsynced too.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Write `text` to `file` atomically (synchronous). */
export function writeFileAtomicSync(file, text, { mode = 0o600, rename = fs.renameSync } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  const fd = fs.openSync(tmp, "wx", mode);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  for (let i = 0; ; i++) {
    try {
      rename(tmp, file);
      break;
    } catch (e) {
      if (i >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      sleep(20 * 2 ** i);
    }
  }
  if (process.platform !== "win32") {
    try {
      const d = fs.openSync(dir, "r");
      fs.fsyncSync(d);
      fs.closeSync(d);
    } catch {
      // a filesystem without folder fsync
    }
  }
}

/** Write `value` as pretty JSON to `file` atomically. */
export function writeJsonAtomicSync(file, value, opts) {
  writeFileAtomicSync(file, JSON.stringify(value, null, 2) + "\n", opts);
}

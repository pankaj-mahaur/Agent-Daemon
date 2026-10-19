// Safe reads and writes of a host's config file for the installer (P5.3).
//   inspect(file)   what is there: bytes, text, the real file behind a link, read-only
//   backup(...)     the original bytes, kept under adRoot()/memory/backups/<host>/
//   writeChecked()  temp file + rename (writeFileAtomic), then read back; a mismatch
//                   puts the previous bytes back
//   sha256(bytes)

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../atomic-write.mjs";

export const sha256 = (bytes) => (bytes == null ? null : createHash("sha256").update(bytes).digest("hex"));

/** @returns {{file, realFile, exists, symlink, readOnly, bytes: Buffer|null, text: string}} */
export function inspect(file) {
  let realFile = file;
  let symlink = false;
  try {
    symlink = fs.lstatSync(file).isSymbolicLink();
    if (symlink) realFile = fs.realpathSync(file);
  } catch {
    // missing
  }
  let bytes = null;
  try {
    bytes = fs.readFileSync(realFile);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  let readOnly = false;
  if (bytes) {
    try {
      fs.accessSync(realFile, fs.constants.W_OK);
      // Windows: the read-only attribute shows as a mode without the owner write bit.
      if (process.platform === "win32" && !(fs.statSync(realFile).mode & 0o200)) readOnly = true;
    } catch {
      readOnly = true;
    }
  }
  return { file, realFile, exists: bytes !== null, symlink, readOnly, bytes, text: bytes ? bytes.toString("utf8") : "" };
}

/** Keep the original bytes; → the backup's path. */
export function backup(root, host, file, bytes, now = new Date()) {
  const dir = path.join(root, "memory", "backups", host);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const dest = path.join(dir, `${stamp}-${path.basename(file)}`);
  fs.writeFileSync(dest, bytes, { flag: "wx" });
  return dest;
}

/**
 * Write `content` (text, or exact bytes) to `file` atomically and read it back. When
 * the read-back differs, the previous bytes are put back (or the file removed if
 * there was none) and it throws.
 */
export async function writeChecked(file, content, previous) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, bytes);
  if (!fs.readFileSync(file).equals(bytes)) {
    if (previous) await writeFileAtomic(file, previous);
    else fs.rmSync(file, { force: true });
    throw new Error(`${file} didn't read back as written; the previous content is restored`);
  }
}

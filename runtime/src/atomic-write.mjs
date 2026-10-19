// Replace a file atomically: write a temp file in the same folder, flush it
// to disk, then rename it over the target. A crash or a concurrent reader
// sees either the old file or the new one, never half of one. The target's
// mode is kept (POSIX). Used for files other programs own and read while ad
// runs (Claude Code's ~/.claude/settings.json and ~/.claude.json).

import fsp from "node:fs/promises";
import path from "node:path";

const RETRYABLE = new Set(["EBUSY", "EPERM", "EACCES"]);

/**
 * @param {string} file
 * @param {string} text
 * @param {{ fsx?: typeof fsp, retries?: number, delayMs?: number }} [opts]
 */
export async function writeFileAtomic(file, text, { fsx = fsp, retries = 10, delayMs = 50 } = {}) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let mode;
  try {
    mode = (await fsx.stat(file)).mode & 0o777;
  } catch {
    // new file: default mode
  }
  const handle = await fsx.open(tmp, "wx", mode ?? 0o644);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (mode !== undefined && process.platform !== "win32") await fsx.chmod(tmp, mode).catch(() => {});
  for (let attempt = 0; ; attempt++) {
    try {
      await fsx.rename(tmp, file);
      return;
    } catch (err) {
      // Windows: the target is open in another program (Claude Code). Retry a
      // few times, then leave the original untouched.
      if (RETRYABLE.has(err.code) && attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs * Math.min(attempt + 1, 4)));
        continue;
      }
      await fsx.rm(tmp, { force: true }).catch(() => {});
      if (RETRYABLE.has(err.code)) {
        const e = new Error(`couldn't update ${file}: it's in use; close Claude Code and run ad init again`);
        e.code = err.code;
        throw e;
      }
      throw err;
    }
  }
}

/** writeFileAtomic for a JSON value (2-space indent, as ad writes it). */
export function writeJsonAtomic(file, value, opts) {
  return writeFileAtomic(file, JSON.stringify(value, null, 2), opts);
}

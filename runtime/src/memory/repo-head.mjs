// The repository a folder is in, and its checked-out branch, read from the files git
// keeps (MCP launch plan L6, design decision 9). File reads only: no process, no
// child_process import, so a hook on any path (L7's tool.before included) can use it.
//
// The walk goes up to the nearest `.git`. A `.git` that can't be trusted ends it with
// no repository, rather than reaching a parent one (a stray ~/.git or /tmp/.git would
// otherwise name the wrong branch): a symlinked `.git`, a `gitdir:` file pointing at a
// network or device path (on Windows a stat of a UNC path is an SMB lookup), or a
// `.git` without a HEAD.

import fs from "node:fs";
import path from "node:path";

const MAX_BRANCH = 100;

/** Up to `max` bytes of a file (from its end with tail), or null. */
export function readSmall(file, max = 4096, { tail = false } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const n = Math.min(max, size);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, tail ? size - n : 0);
    return buf.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** \\server\share, //server/share, \\?\…, \\.\…: never touched from a hook. */
export const remotePath = (p) => /^(?:\\\\|\/\/)/.test(String(p ?? ""));

const lstat = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};
const isFile = (p) => {
  const st = lstat(p);
  return Boolean(st?.isFile());
};

/**
 * The repository a folder is in.
 * @param {string} cwd
 * @param {{stopAt?: string}} [opts] stopAt: the last folder to look in
 * @returns {{root: string, gitDir: string} | null}
 */
export function repoRoot(cwd, { stopAt } = {}) {
  if (!cwd || remotePath(cwd)) return null;
  let dir = path.resolve(cwd);
  const stop = stopAt ? path.resolve(stopAt) : null;
  for (let i = 0; i < 64; i++) {
    const dotGit = path.join(dir, ".git");
    const st = lstat(dotGit);
    if (st) {
      if (st.isDirectory()) return isFile(path.join(dotGit, "HEAD")) ? { root: dir, gitDir: dotGit } : null;
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(readSmall(dotGit, 1024) ?? "");
        if (!m || remotePath(m[1])) return null;
        const gitDir = path.resolve(dir, m[1]);
        return !remotePath(gitDir) && isFile(path.join(gitDir, "HEAD")) ? { root: dir, gitDir } : null;
      }
      return null; // a symlink or anything else
    }
    if (stop && dir === stop) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** A branch name as recall shows and keys it: [A-Za-z0-9._/-], at most 100 characters. */
export const validBranch = (b) => typeof b === "string" && b.length > 0 && b.length <= MAX_BRANCH && /^[A-Za-z0-9._/-]+$/.test(b) && !b.includes("..");

/** The checked-out branch from a git folder's HEAD, or null (detached, unreadable, odd). */
export function readBranch(gitDir) {
  const head = gitDir ? readSmall(path.join(gitDir, "HEAD"), 512) : null;
  const m = head && /^ref:\s*refs\/heads\/(\S+)\s*$/.exec(head.split("\n")[0]);
  return m && validBranch(m[1]) ? m[1] : null;
}

/** A worktree's shared git folder (its `commondir` file), else the git folder itself (L7 reads config there). */
export function commonDir(gitDir) {
  const rel = gitDir ? (readSmall(path.join(gitDir, "commondir"), 1024) ?? "").trim() : "";
  if (!rel || remotePath(rel)) return gitDir ?? null;
  const dir = path.resolve(gitDir, rel);
  return remotePath(dir) ? gitDir : dir;
}

/**
 * The branch `branch` was last checked out from, by the last "checkout: moving from
 * X to <branch>" line in the reflog (its last 8 KB), or null.
 */
export function parentBranch(gitDir, branch) {
  const text = gitDir && branch ? readSmall(path.join(gitDir, "logs", "HEAD"), 8192, { tail: true }) : null;
  if (!text) return null;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /\tcheckout: moving from (\S+) to (\S+)\s*$/.exec(lines[i]);
    if (m && m[2] === branch) return validBranch(m[1]) && m[1] !== branch ? m[1] : null;
  }
  return null;
}

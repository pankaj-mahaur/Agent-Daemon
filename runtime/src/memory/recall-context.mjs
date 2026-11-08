// The repo context the session brief is ranked against (MCP launch plan L6,
// design decision 9): the branch, the recently changed paths and the recent commit
// subjects of the repository the session runs in.
//
// The hook never starts a process for it: the root and the branch come from the
// files git keeps (repo-head.mjs), the paths and commits from a cache that a detached
// job (recall-context-job.mjs, with recall-context-git.mjs) refreshes. There is one
// cache per repository and branch: another branch's paths would point the brief at
// the wrong work. A branch with no cache yet uses the one it was cut from. A forged
// cache can only change which of the user's own notes rank first; it can't add one.
// File operations only.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adRoot } from "../ad-root.mjs";
import { parentBranch, readBranch, readSmall, remotePath, repoRoot, validBranch } from "./repo-head.mjs";

export { repoRoot, readBranch, parentBranch } from "./repo-head.mjs";

export const MAX_PATHS = 30;
export const MAX_COMMITS = 10;
export const MAX_AGE_MS = 10 * 60_000;
export const PRUNE_DAYS = 30;
const MAX_TEXT = 200;
const MAX_CACHE_BYTES = 64 * 1024;
const VERSION = 2;

const cleanText = (s) => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_TEXT) : null);

// The real path, case-folded where the file system usually is, so two spellings of
// a folder share a cache.
export function rootKey(root) {
  let p = path.resolve(root);
  try {
    p = fs.realpathSync.native(p);
  } catch {
    // a folder that went away: its own spelling
  }
  if (process.platform === "win32" || process.platform === "darwin") p = p.toLowerCase();
  return crypto.createHash("sha256").update(p).digest("hex").slice(0, 16);
}
const branchKey = (branch) => crypto.createHash("sha256").update(branch ?? "(no branch)").digest("hex").slice(0, 8);

/** The cache file for a repository root and branch. */
export function cacheFile(root, branch, { root: ad = adRoot() } = {}) {
  return path.join(ad, "recall", "context", `${rootKey(root)}-${branchKey(branch)}.json`);
}

/** The job's single-flight key for a root and branch (hooks/detached.mjs). */
export const jobKey = (root, branch) => `recall-ctx-${rootKey(root)}-${branchKey(branch)}`;

export const strings = (list, max) => (Array.isArray(list) ? list.map(cleanText).filter(Boolean).slice(0, max) : []);

function readCache(root, branch, ad) {
  const text = readSmall(cacheFile(root, branch, { root: ad }), MAX_CACHE_BYTES + 1);
  if (!text || text.length > MAX_CACHE_BYTES) return null;
  let c;
  try {
    c = JSON.parse(text);
  } catch {
    return null;
  }
  const at = typeof c?.at === "string" ? Date.parse(c.at) : NaN;
  const ok = c?.v === VERSION && typeof c.root === "string" && rootKey(c.root) === rootKey(root) && c.branch === branch && Array.isArray(c.paths) && Array.isArray(c.commits) && Number.isFinite(at);
  return ok ? { paths: strings(c.paths, MAX_PATHS), commits: strings(c.commits, MAX_COMMITS), at, iso: c.at } : null;
}

/**
 * What the brief ranks against, read without starting a process.
 * @param {string} cwd
 * @param {{root?: string, now?: number, maxAgeMs?: number, stopAt?: string}} [opts] root: ad's folder
 * @returns {{root: string|null, branch: string|null, paths: string[], commits: string[], stale: boolean, at: string|null, from: string|null}}
 *   from: the branch whose cache was used when this one has none yet
 */
export function readContext(cwd, { root: ad = adRoot(), now = Date.now(), maxAgeMs = MAX_AGE_MS, stopAt } = {}) {
  const found = repoRoot(cwd, { stopAt });
  if (!found) return { root: null, branch: null, paths: [], commits: [], stale: false, at: null, from: null };
  const branch = readBranch(found.gitDir);
  const own = readCache(found.root, branch, ad);
  if (own) return { root: found.root, branch, paths: own.paths, commits: own.commits, stale: now - own.at > maxAgeMs || own.at > now + 60_000, at: own.iso, from: null };
  const parent = parentBranch(found.gitDir, branch);
  const inherited = parent ? readCache(found.root, parent, ad) : null;
  if (inherited) return { root: found.root, branch, paths: inherited.paths, commits: inherited.commits, stale: true, at: inherited.iso, from: parent };
  return { root: found.root, branch, paths: [], commits: [], stale: true, at: null, from: null };
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Write the cache for a repository root and branch (temp file, then rename; retried while Windows holds the file). */
export function writeContext(root, { branch, paths, commits }, { root: ad = adRoot(), now = Date.now() } = {}) {
  const b = validBranch(branch) ? branch : null;
  const file = cacheFile(root, b, { root: ad });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ v: VERSION, root: path.resolve(root), branch: b, paths: strings(paths, MAX_PATHS), commits: strings(commits, MAX_COMMITS), at: new Date(now).toISOString() });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, body);
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return file;
    } catch (err) {
      if (i >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(err?.code)) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      sleep(25 * (i + 1));
    }
  }
}

/** Remove files older than `days` (temp files after an hour) from one of recall's folders. → how many went. */
export function pruneDir(dir, { now = Date.now(), days = PRUNE_DAYS } = {}) {
  let n = 0;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const f = path.join(dir, name);
    try {
      const st = fs.lstatSync(f);
      const old = now - st.mtimeMs > days * 86_400_000 || (name.endsWith(".tmp") && now - st.mtimeMs > 3_600_000);
      if (st.isFile() && old) {
        fs.rmSync(f, { force: true });
        n++;
      }
    } catch {
      // gone meanwhile
    }
  }
  return n;
}

/** Remove context caches older than 30 days. */
export const pruneContexts = ({ root: ad = adRoot(), now = Date.now(), days = PRUNE_DAYS } = {}) => pruneDir(path.join(ad, "recall", "context"), { now, days });

/**
 * Whether the job may run git in this root: never in the home folder or a folder
 * above it (a dotfiles repository would make it scan all of home).
 */
export function jobAllowed(root, { home = os.homedir() } = {}) {
  if (!root || remotePath(root)) return false;
  const real = (p) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const fold = (p) => (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p);
  const rel = path.relative(fold(real(root)), fold(real(home)));
  return !(rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)));
}

// One holder at a time for a named lock (O_EXCL file, heartbeat, takeover of a stale holder serialised by a `.takeover` file). Used for conversation threads (`lockThread` in `harness/session.mjs`) and for the engine's folder (the `migrate` lock).

//
// Who holds a lock (process-identity.mjs): a holder whose process is proven
// alive *and the same process* ("live") keeps the lock whatever its heartbeat
// says, so a session suspended with Ctrl+Z or paused in a debugger is never
// taken over. A dead holder, or one whose pid now belongs to another process
// ("reused"), is taken at once. When the OS can't say ("unknown"), the old
// rule applies: busy while the heartbeat is fresh, takeable after staleMs.

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { classifyHolder, identityOf as osIdentityOf, selfIdentity } from "./process-identity.mjs";

/**
 * ~/.agent-daemon/locks, computed at call time (a test that fakes HOME after
 * import gets its own folder). Under `node --test` with the real home, a
 * per-process temp folder instead, so no test ever writes the user's locks.
 */
export function defaultLockDir() {
  const home = homedir();
  if (process.env.NODE_TEST_CONTEXT) {
    let real = null;
    try {
      real = userInfo().homedir;
    } catch {
      // no passwd entry: treat as faked
    }
    if (real && real === home) return join(tmpdir(), `ad-test-locks-${process.pid}`);
  }
  return join(home, ".agent-daemon", "locks");
}

/** @deprecated computed at import; use defaultLockDir(). */
export const DEFAULT_LOCK_DIR = defaultLockDir();
let SELF = null;
const self = () => (SELF ??= selfIdentity());

// A pid's start time can't change while it lives, so a lookup is reused for a
// few seconds: a waiter retrying every 100 ms doesn't run PowerShell each time.
const ID_TTL_MS = 5000;
const idCache = new Map();
const cachedIdentityOf = (pid) => {
  const hit = idCache.get(pid);
  if (hit && Date.now() - hit.at < ID_TTL_MS) return hit.id;
  const id = osIdentityOf(pid);
  idCache.set(pid, { at: Date.now(), id });
  if (idCache.size > 64) idCache.delete(idCache.keys().next().value);
  return id;
};

// live: held whatever the heartbeat; dead/reused: free; unknown: the heartbeat decides.
const holdsLock = (kind, fresh) => kind === "live" || (kind === "unknown" && fresh);

// A lease (an engine, a scheduled job, an agent) is held while its Node holder
// OR the child it recorded is live: a holder killed with its engine still
// running keeps the folder busy. Both proven gone → free; otherwise unknown.
const LEASE_KINDS = new Set(["engine", "schedule", "agent"]);
function holderKind(holder, deps) {
  const own = classifyHolder(holder, deps);
  if (!LEASE_KINDS.has(holder?.kind) || !holder.child) return own;
  const child = classifyHolder(holder.child, deps);
  if (own === "live" || child === "live") return "live";
  if ((own === "dead" || own === "reused") && (child === "dead" || child === "reused")) return "dead";
  return "unknown";
}
const META_KEYS = ["kind", "home", "child"];
const pickMeta = (meta = {}) => Object.fromEntries(META_KEYS.filter((k) => meta[k] !== undefined).map((k) => [k, meta[k]]));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const WIN_TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);
const isListed = (file) => readdirSync(dirname(file)).includes(basename(file));

/**
 * Create `file` with O_EXCL. On Windows, a name whose last holder is deleting it
 * can't be created for a moment: the create fails with EPERM (or EACCES/EBUSY),
 * not EEXIST. Two processes taking turns on one lock hit that window (CI saw it
 * as a lost spend charge). So it is retried briefly; a name still listed after
 * that is in use, and throws EEXIST (busy). The same failure on a name that
 * isn't there is a real error (an unwritable folder) and is thrown as it is.
 */
export function createExclusive(file, data, { platform = process.platform, write = writeFileSync, listed = isListed, sleep = sleepSync, tries = 5 } = {}) {
  for (let i = 0; ; i++) {
    try {
      write(file, data, { flag: "wx" });
      return;
    } catch (err) {
      if (platform !== "win32" || !WIN_TRANSIENT.has(err.code)) throw err;
      if (i + 1 < tries) {
        sleep(10 * 2 ** i);
        continue;
      }
      let present = false;
      try {
        present = listed(file);
      } catch {
        // The folder can't be listed either: report the create's own error.
      }
      if (!present) throw err;
      const busy = new Error(`${basename(file)} is still being released`, { cause: err });
      busy.code = "EEXIST";
      throw busy;
    }
  }
}

/**
 * Remove `file`, retrying briefly on Windows while another process has it open
 * (EPERM/EBUSY). A lock file left behind with this process's token would look
 * held by a live process, and the next acquire, its own included, would wait
 * out its whole budget.
 */
export function removeFile(file, { platform = process.platform, remove = (f) => rmSync(f, { force: true }), sleep = sleepSync, tries = 5 } = {}) {
  for (let i = 0; ; i++) {
    try {
      remove(file);
      return;
    } catch (err) {
      if (platform !== "win32" || !WIN_TRANSIENT.has(err.code) || i + 1 >= tries) throw err;
      sleep(10 * 2 ** i);
    }
  }
}

export class LockBusyError extends Error {
  constructor(name, holder) {
    super(`${name} is held by another ad (pid ${holder?.pid ?? "unknown"})`);
    this.code = "LOCK_BUSY";
    this.holder = holder ?? { pid: "unknown" };
  }
}

/**
 * Takes the lock for a thread, or throws SessionLockedError. Returns a release
 * function.
 *
 * A holder refreshes its file's mtime every `heartbeatMs`. A lock is stale
 * when its process is gone or its heartbeat stopped `staleMs` ago (a reused
 * pid can't keep a dead holder's lock). Takeover is serialised by a `.takeover`
 * file made with O_EXCL, so two processes never both take a stale lock. An
 * unreadable lock younger than `staleMs` is someone mid-write: busy. A live
 * holder is never skipped, the same process included (one session per thread).
 */
export function acquireLock(name, opts = {}) {
  const { dir = defaultLockDir(), pid = process.pid, isAlive = alive, identityOf = cachedIdentityOf, now = Date.now, staleMs = 120_000, heartbeatMs = 30_000, busyError = (holder) => new LockBusyError(name, holder) } = opts;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${String(name).replace(/[^A-Za-z0-9_.-]/g, "_")}.lock`);
  const token = randomUUID();
  let record = { pid, ...self(), threadId: name, token, ...pickMeta(opts.meta) };
  const me = JSON.stringify(record);
  const busy = (holder) => busyError(holder ?? { pid: "unknown" });
  const exclusive = (f, data) => createExclusive(f, data, opts.fs);
  try {
    exclusive(file, me);
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    const guard = `${file}.takeover`;
    try {
      exclusive(guard, String(pid));
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Another process is taking it over; a guard left by a crash expires.
      let age = Infinity;
      try {
        age = now() - statSync(guard).mtimeMs;
      } catch {
        // Gone already: retry.
      }
      if (opts.retried || age < 10_000) throw busy(null);
      rmSync(guard, { force: true });
      return acquireLock(name, { ...opts, retried: true });
    }
    try {
      let holder = null;
      let fresh = true;
      let gone = false;
      try {
        fresh = now() - statSync(file).mtimeMs < staleMs;
        holder = JSON.parse(readFileSync(file, "utf8"));
      } catch (e) {
        if (e.code === "ENOENT") {
          fresh = false;
          gone = true;
        }
      }
      if (!holder && fresh) throw busy(null);
      if (holder && holdsLock(holderKind(holder, { isAlive, identityOf }), fresh)) throw busy(holder);
      if (gone) {
        // Released meanwhile: another process may have just taken it with O_EXCL. Never overwrite that.
        try {
          exclusive(file, me);
        } catch (e) {
          if (e.code === "EEXIST") throw busy(null);
          throw e;
        }
      } else writeFileSync(file, me); // stale: take it
    } finally {
      rmSync(guard, { force: true });
    }
  }
  const beat = setInterval(() => {
    try {
      const t = new Date(now());
      utimesSync(file, t, t);
    } catch {
      // The file is gone; release will find out.
    }
  }, heartbeatMs);
  beat.unref?.();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(beat);
    try {
      if (JSON.parse(readFileSync(file, "utf8")).token === token) removeFile(file, opts.fs);
    } catch {
      // Already gone, or someone else's now (or still held open by another process after the retries).
    }
  };
  /** Merge meta (kind, home, child) into the lock, under the same token; false when it is no longer ours. */
  release.updateMeta = (meta) => {
    if (released) return false;
    try {
      if (JSON.parse(readFileSync(file, "utf8")).token !== token) return false;
    } catch {
      return false;
    }
    record = { ...record, ...pickMeta(meta) };
    writeFileSync(file, JSON.stringify(record));
    return true;
  };
  release.file = file;
  return release;
}

/**
 * Remove lease files (kind engine / schedule / agent) whose holder and child
 * are both proven gone. A lease anyone might still hold is left alone.
 * @returns {number} how many were removed
 */
export function sweepDeadLeases({ dir = defaultLockDir(), isAlive = alive, identityOf = cachedIdentityOf } = {}) {
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const f of files) {
    if (!f.endsWith(".lock")) continue;
    const file = join(dir, f);
    let holder;
    try {
      holder = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue; // mid-write
    }
    if (!LEASE_KINDS.has(holder?.kind)) continue;
    if (holderKind(holder, { isAlive, identityOf }) !== "dead") continue;
    try {
      // Only the file as read: a new holder's lease has a new token.
      if (JSON.parse(readFileSync(file, "utf8")).token === holder.token) {
        rmSync(file, { force: true });
        removed++;
      }
    } catch {
      // gone meanwhile
    }
  }
  return removed;
}

/**
 * The locks in `dir` held right now, by the same test as acquireLock (a fresh
 * heartbeat and a live process; an unreadable fresh file counts as held) →
 * [{name, pid}]. `except` names locks to skip (the caller's own).
 */
export function liveLocks({ dir = defaultLockDir(), except = [], isAlive = alive, identityOf = cachedIdentityOf, now = Date.now, staleMs = 120_000 } = {}) {
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return []; // no lock folder: nothing held
  }
  const skip = new Set(except.map((n) => String(n).replace(/[^A-Za-z0-9_.-]/g, "_")));
  const held = [];
  for (const f of files) {
    if (!f.endsWith(".lock") || skip.has(f.slice(0, -5))) continue;
    const file = join(dir, f);
    let mtime;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      continue; // released while we looked
    }
    const fresh = now() - mtime < staleMs;
    let holder;
    try {
      holder = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      if (fresh) held.push({ name: f.slice(0, -5), pid: "unknown" }); // mid-write: someone is taking it
      continue;
    }
    if (holdsLock(holderKind(holder, { isAlive, identityOf }), fresh)) held.push({ name: holder.threadId ?? f.slice(0, -5), pid: holder.pid, ...pickMeta(holder) });
  }
  return held;
}

/** acquireLock, retried every stepMs for up to waitMs while another process holds it. */
export async function acquireLockWithin(name, { waitMs = 5000, stepMs = 100, ...opts } = {}) {
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      return acquireLock(name, opts);
    } catch (err) {
      if (err.code !== "LOCK_BUSY" || Date.now() >= until) throw err;
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }
}

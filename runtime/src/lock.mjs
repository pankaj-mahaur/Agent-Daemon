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
import { join } from "node:path";
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

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
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
  const me = JSON.stringify({ pid, ...self(), threadId: name, token });
  const busy = (holder) => busyError(holder ?? { pid: "unknown" });
  try {
    writeFileSync(file, me, { flag: "wx" });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    const guard = `${file}.takeover`;
    try {
      writeFileSync(guard, String(pid), { flag: "wx" });
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
      if (holder && holdsLock(classifyHolder(holder, { isAlive, identityOf }), fresh)) throw busy(holder);
      if (gone) {
        // Released meanwhile: another process may have just taken it with O_EXCL. Never overwrite that.
        try {
          writeFileSync(file, me, { flag: "wx" });
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
  return () => {
    if (released) return;
    released = true;
    clearInterval(beat);
    try {
      if (JSON.parse(readFileSync(file, "utf8")).token === token) rmSync(file, { force: true });
    } catch {
      // Already gone, or someone else's now.
    }
  };
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
    if (holdsLock(classifyHolder(holder, { isAlive, identityOf }), fresh)) held.push({ name: holder.threadId ?? f.slice(0, -5), pid: holder.pid });
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

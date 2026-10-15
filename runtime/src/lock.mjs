// One holder at a time for a named lock (O_EXCL file, heartbeat, takeover of a stale holder serialised by a `.takeover` file). Used for conversation threads (`lockThread` in `harness/session.mjs`) and for the engine's folder (the `migrate` lock).

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_LOCK_DIR = join(homedir(), ".agent-daemon", "locks");
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

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
  const { dir = DEFAULT_LOCK_DIR, pid = process.pid, isAlive = alive, now = Date.now, staleMs = 120_000, heartbeatMs = 30_000, busyError = (holder) => new LockBusyError(name, holder) } = opts;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${String(name).replace(/[^A-Za-z0-9_.-]/g, "_")}.lock`);
  const token = randomUUID();
  const me = JSON.stringify({ pid, startedAt: PROCESS_STARTED_AT, threadId: name, token });
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
      try {
        fresh = now() - statSync(file).mtimeMs < staleMs;
        holder = JSON.parse(readFileSync(file, "utf8"));
      } catch (e) {
        if (e.code === "ENOENT") fresh = false;
      }
      if (!holder && fresh) throw busy(null);
      if (holder && fresh && isAlive(holder.pid)) throw busy(holder);
      writeFileSync(file, me); // stale: take it
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

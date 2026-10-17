// Tests for the named lock (runtime/src/lock.mjs): one holder at a time,
// a waiter that retries, a read-only dir that is not LOCK_BUSY, and the
// migrate lock's file name.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, acquireLockWithin, liveLocks, LockBusyError } from "../src/lock.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ad-lock-"));
}

test("acquireLock: first call succeeds, a live second holder is busy, release frees it", () => {
  const dir = tempDir();
  try {
    const release = acquireLock("t1", { dir });
    assert.throws(() => acquireLock("t1", { dir, isAlive: () => true }), (err) => err.code === "LOCK_BUSY" && err instanceof LockBusyError);
    release();
    const release2 = acquireLock("t1", { dir });
    release2();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireLockWithin: a waiter gets the lock after the holder releases; a short wait throws LOCK_BUSY", async () => {
  const dir = tempDir();
  try {
    const release = acquireLock("t2", { dir });
    setTimeout(release, 150);
    const waited = await acquireLockWithin("t2", { dir, waitMs: 2000, stepMs: 20 });
    waited();
    const release2 = acquireLock("t2", { dir });
    await assert.rejects(
      (async () => acquireLockWithin("t2", { dir, waitMs: 50, stepMs: 10 }))(),
      (err) => err.code === "LOCK_BUSY",
    );
    release2();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a read-only lock dir throws its own error, not LOCK_BUSY", { skip: (process.platform === "win32" || process.getuid?.() === 0) && "chmod is not enforced here" }, () => {
  const dir = tempDir();
  try {
    chmodSync(dir, 0o500);
    try {
      assert.throws(() => acquireLock("t3", { dir }), (err) => err.code !== "LOCK_BUSY");
    } finally {
      chmodSync(dir, 0o700);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the migrate lock file is migrate.lock in the lock dir", () => {
  const dir = tempDir();
  try {
    const release = acquireLock("migrate", { dir });
    try {
      assert.equal(existsSync(join(dir, "migrate.lock")), true);
      assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".lock")), ["migrate.lock"]);
    } finally {
      release();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("liveLocks: a live, fresh holder counts; stale, dead and excepted ones don't; a half-written one counts", () => {
  const dir = tempDir();
  try {
    const live = acquireLock("thread-live", { dir });
    const own = acquireLock("migrate", { dir });
    writeFileSync(join(dir, "thread-dead.lock"), JSON.stringify({ pid: 999999, threadId: "thread-dead" }));
    writeFileSync(join(dir, "thread-stale.lock"), JSON.stringify({ pid: process.pid, threadId: "thread-stale" }));
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(join(dir, "thread-stale.lock"), old, old);
    writeFileSync(join(dir, "thread-half.lock"), "{");
    writeFileSync(join(dir, "thread-live.lock.takeover"), "1");
    try {
      const held = liveLocks({ dir, except: ["migrate"], isAlive: (pid) => pid === process.pid });
      assert.deepEqual(held.map((h) => h.name).sort(), ["thread-half", "thread-live"]);
      assert.equal(held.find((h) => h.name === "thread-live").pid, process.pid);
      assert.equal(held.find((h) => h.name === "thread-half").pid, "unknown");
      assert.deepEqual(liveLocks({ dir: join(dir, "missing") }), []);
    } finally {
      live();
      own();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("takeover: a holder that released meanwhile is taken with O_EXCL; one that won meanwhile is never overwritten", () => {
  const dir = tempDir();
  const file = join(dir, "t6.lock");
  try {
    const first = acquireLock("t6", { dir });
    let calls = 0;
    // `now` runs just before the takeover looks at the lock file: the holder lets go right there.
    const second = acquireLock("t6", { dir, now: () => (++calls === 1 && rmSync(file), Date.now()) });
    assert.equal(existsSync(file), true, "taken");
    first(); // the old holder's release leaves the new holder's file alone
    assert.equal(existsSync(file), true);
    second();
    assert.equal(existsSync(file), false);

    const holder = acquireLock("t6", { dir });
    calls = 0;
    const won = JSON.stringify({ pid: process.pid, threadId: "t6", token: "third" });
    const raced = () => {
      if (++calls === 1) {
        rmSync(file);
        writeFileSync(file, won, { flag: "wx" });
      }
      return Date.now();
    };
    assert.throws(() => acquireLock("t6", { dir, now: raced, isAlive: () => true }), (err) => err.code === "LOCK_BUSY");
    assert.equal(readFileSync(file, "utf8"), won, "the winner's file is untouched");
    holder();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

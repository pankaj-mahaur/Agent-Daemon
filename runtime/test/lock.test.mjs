// Tests for the named lock (runtime/src/lock.mjs): one holder at a time,
// a waiter that retries, a read-only dir that is not LOCK_BUSY, and the
// migrate lock's file name.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, acquireLockWithin, LockBusyError } from "../src/lock.mjs";

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

// Tests for runtime/src/orchestration/inbox.mjs — acked-message purging.
//
// Specifically WS-7a: messages in acked/ older than 7 days should be deleted
// during a readInbox()-triggered background purge. Throttled to 6h.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { purgeAckedOlderThan } from "../src/orchestration/inbox.mjs";

const HOME_ENV = process.env.HOME || process.env.USERPROFILE;

async function setupTempHome() {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "ad-inbox-test-"));
  process.env.HOME = tmpHome;
  // On Windows USERPROFILE wins over HOME — override that too
  if (process.platform === "win32") process.env.USERPROFILE = tmpHome;
  return tmpHome;
}

async function tearDownTempHome(tmpHome) {
  await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  if (HOME_ENV) {
    process.env.HOME = HOME_ENV;
    if (process.platform === "win32") process.env.USERPROFILE = HOME_ENV;
  }
}

test("purgeAckedOlderThan deletes files older than cutoff", async () => {
  const tmpHome = await setupTempHome();
  try {
    const ackedDir = path.join(tmpHome, ".agent-daemon", "teams", "t1", "inboxes", "agent-a", "acked");
    await fs.mkdir(ackedDir, { recursive: true });

    // 3 old messages, 2 fresh messages
    const old = ["msg-1.json", "msg-2.json", "msg-3.json"];
    const fresh = ["msg-4.json", "msg-5.json"];
    const oldTime = Date.now() - (10 * 24 * 60 * 60 * 1000); // 10 days ago

    for (const f of [...old, ...fresh]) {
      await fs.writeFile(path.join(ackedDir, f), '{"id":"x"}', "utf8");
    }
    // Backdate the "old" ones
    for (const f of old) {
      await fs.utimes(path.join(ackedDir, f), new Date(oldTime), new Date(oldTime));
    }

    const result = await purgeAckedOlderThan("t1", "agent-a", { force: true });
    assert.equal(result.purged, 3, `expected 3 purged, got ${result.purged}`);
    assert.equal(result.scanned, 5, `expected 5 scanned, got ${result.scanned}`);

    // Fresh files still there
    const remaining = await fs.readdir(ackedDir);
    const jsons = remaining.filter(n => n.endsWith(".json"));
    assert.deepEqual(jsons.sort(), fresh.sort());
  } finally {
    await tearDownTempHome(tmpHome);
  }
});

test("purgeAckedOlderThan respects throttle (.last-purge marker)", async () => {
  const tmpHome = await setupTempHome();
  try {
    const ackedDir = path.join(tmpHome, ".agent-daemon", "teams", "t2", "inboxes", "agent-b", "acked");
    await fs.mkdir(ackedDir, { recursive: true });

    // Drop one old file
    const oldFile = path.join(ackedDir, "msg-1.json");
    await fs.writeFile(oldFile, '{"id":"x"}', "utf8");
    const oldTime = Date.now() - (10 * 24 * 60 * 60 * 1000);
    await fs.utimes(oldFile, new Date(oldTime), new Date(oldTime));

    // First run with force=true: should purge
    const r1 = await purgeAckedOlderThan("t2", "agent-b", { force: true });
    assert.equal(r1.purged, 1);

    // Drop a NEW old file
    const oldFile2 = path.join(ackedDir, "msg-2.json");
    await fs.writeFile(oldFile2, '{"id":"y"}', "utf8");
    await fs.utimes(oldFile2, new Date(oldTime), new Date(oldTime));

    // Second run WITHOUT force — throttle should skip
    const r2 = await purgeAckedOlderThan("t2", "agent-b");
    assert.equal(r2.scanned, 0, "throttled run should not scan");
    assert.equal(r2.purged, 0);

    // File should still exist
    await fs.access(oldFile2);  // does not throw → exists
  } finally {
    await tearDownTempHome(tmpHome);
  }
});

test("purgeAckedOlderThan handles missing directory gracefully", async () => {
  const tmpHome = await setupTempHome();
  try {
    const r = await purgeAckedOlderThan("never-existed", "no-agent", { force: true });
    assert.equal(r.scanned, 0);
    assert.equal(r.purged, 0);
  } finally {
    await tearDownTempHome(tmpHome);
  }
});

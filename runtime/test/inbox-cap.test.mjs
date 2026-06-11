// Tests for inbox cap enforcement + dead-letter overflow (orchestration/inbox.mjs).
//
// Pre-fix behavior pinned here: MAX_INBOX_MESSAGES was defined but never
// enforced, and readInbox capped during arbitrary readdir order — dropping a
// RANDOM subset instead of the newest overflow.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sendMessage, readInbox, listDeadLetters, deadLetterCount, inboxCount } from "../src/orchestration/inbox.mjs";

async function withTmpHome(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ad-inbox-cap-"));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  try {
    await fn(root);
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevProfile;
    try {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* leave for OS tmp cleaner */ }
  }
}

function inboxDirFor(root, teamId, agent) {
  return path.join(root, ".agent-daemon", "teams", teamId, "inboxes", agent);
}

async function seedMessages(dir, count, startTs = 1700000000000) {
  await fs.mkdir(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const id = `msg-${startTs + i}-seed${String(i).padStart(4, "0")}`;
    const msg = { id, from: "seeder", to: "leader", type: "status-update", payload: { i }, timestamp: new Date(startTs + i).toISOString(), teamId: "t1" };
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(msg), "utf8");
  }
}

test("sendMessage at cap moves oldest to dead-letter and still delivers the new message", async () => {
  await withTmpHome(async (root) => {
    const dir = inboxDirFor(root, "t1", "leader");
    await seedMessages(dir, 505);

    const sent = await sendMessage({ teamId: "t1", from: "worker", to: "leader", type: "task-complete", payload: {} });
    assert.ok(sent.id, "new message delivered");

    const dead = await listDeadLetters("t1", "leader");
    assert.equal(dead.length, 6, "6 oldest dead-lettered (505 - 500 + 1)");
    // Oldest-first: the dead letters are the seeded messages 0..5
    assert.deepEqual(dead.map(d => d.payload.i), [0, 1, 2, 3, 4, 5]);
    assert.equal(await deadLetterCount("t1", "leader"), 6);

    const remaining = await inboxCount("t1", "leader");
    assert.equal(remaining, 500, "inbox back at cap including the new message");
  });
});

test("readInbox returns the oldest-first window deterministically when over cap", async () => {
  await withTmpHome(async (root) => {
    const dir = inboxDirFor(root, "t1", "leader");
    await seedMessages(dir, 510);

    const messages = await readInbox("t1", "leader");
    assert.equal(messages.length, 500, "capped at 500");
    // Deterministic: the FIRST 500 by filename (chronological), not a random subset
    assert.equal(messages[0].payload.i, 0);
    assert.equal(messages[499].payload.i, 499);
  });
});

test("under-cap inbox is untouched by enforcement", async () => {
  await withTmpHome(async () => {
    await sendMessage({ teamId: "t2", from: "a", to: "b", type: "query", payload: { q: 1 } });
    await sendMessage({ teamId: "t2", from: "a", to: "b", type: "query", payload: { q: 2 } });
    const messages = await readInbox("t2", "b");
    assert.equal(messages.length, 2);
    assert.equal(await deadLetterCount("t2", "b"), 0);
  });
});

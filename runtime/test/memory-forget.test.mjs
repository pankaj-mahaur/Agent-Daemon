// L1 (MCP launch plan 02 §2, §6): hidden, forget-requested, retention and purge.
//   - Anyone (the agent included) may hide a pending or provisional note.
//   - An agent's forget of an accepted note only flags it 'forget-requested': still
//     recalled, never purged, until the user decides in review.
//   - Only the review service purges an accepted note; retention purges hidden
//     unaccepted notes after 7 days and turns 30-day-old provisional notes back to
//     pending. A purged note's bytes are gone from the DB, the WAL and the search
//     index, on both SQLite drivers.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = mkdtempSync(path.join(tmpdir(), "ad-forget-"));
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
for (const k of ["AD_ROOT", "AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL"]) delete process.env[k];

const { open } = await import("../src/memory/sqlite.mjs");
const { availableDrivers } = await import("../src/memory/driver.mjs");
const svc = await import("../src/memory/review-service.mjs");
const { retainNotes } = await import("../src/memory/purge.mjs");
const { acceptedSql } = await import("../src/memory/trust.mjs");
const { testReviewToken } = await import("../testkit/memory-trust.mjs");

after(() => rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const PROJECT = "-work-shop-app";
let n = 0;
async function store(prefer) {
  const dir = path.join(ROOT, `db-${++n}`);
  mkdirSync(dir, { recursive: true });
  return open({ dbPath: path.join(dir, "episodic.db"), ...(prefer ? { prefer } : {}) });
}
function note(h, text, { status = "pending", accepted = false } = {}) {
  const id = Number(h.run("INSERT INTO learnings (project_slug, category, text, confidence, status, content_hash) VALUES (?, 'correction', ?, 0.8, ?, ?)", [PROJECT, text, status, `h-${text}`]).lastInsertRowid);
  if (accepted) svc.acceptLearning(h, testReviewToken(), id);
  return id;
}
const statusOf = (h, id) => h.get("SELECT status FROM learnings WHERE id = ?", [id])?.status ?? null;
const served = (h, id) => Boolean(h.get(`SELECT 1 AS ok FROM learnings WHERE id = ? AND ${acceptedSql()}`, [id]));

test("the agent's forget: hides a pending note, only flags an accepted one", async () => {
  const h = await store();
  try {
    const pending = note(h, "a pending note the agent can hide");
    const accepted = note(h, "an accepted note the agent cannot remove", { accepted: true });
    assert.deepEqual(svc.forgetNote(h, pending), { result: "hidden" });
    assert.equal(statusOf(h, pending), "hidden");
    assert.deepEqual(svc.forgetNote(h, accepted), { result: "forget-requested" });
    assert.equal(statusOf(h, accepted), "forget-requested");
    assert.ok(served(h, accepted), "still recalled until the user decides");
    assert.deepEqual(svc.forgetNote(h, 999999), { result: "none" });
    // Hiding never reaches an accepted note, whatever the caller asks.
    assert.equal(svc.hideNote(h, accepted), 0);
    assert.ok(served(h, accepted));
  } finally {
    h.close();
  }
});

test("the user decides a forget request in review: keep, or forget for good", async () => {
  const h = await store();
  try {
    const keep = note(h, "keep this lesson", { accepted: true });
    const drop = note(h, "drop this lesson", { accepted: true });
    svc.forgetNote(h, keep);
    svc.forgetNote(h, drop);
    assert.throws(() => svc.keepNote(h, null, keep), /review token/);
    assert.throws(() => svc.forgetAccepted(h, {}, drop), /review token/);
    svc.keepNote(h, testReviewToken(), keep);
    assert.equal(statusOf(h, keep), "active");
    svc.forgetAccepted(h, testReviewToken(), drop);
    assert.equal(statusOf(h, drop), null, "purged");
  } finally {
    h.close();
  }
});

test("retention: hidden unaccepted notes go after 7 days, provisional ones return to pending after 30, accepted ones never", async () => {
  const h = await store();
  try {
    const now = Date.parse("2026-11-20T00:00:00Z");
    const at = (days) => new Date(now - days * 86_400_000).toISOString();
    const oldHidden = note(h, "hidden eight days ago", { status: "hidden" });
    const newHidden = note(h, "hidden two days ago", { status: "hidden" });
    const oldProvisional = note(h, "provisional for 31 days", { status: "provisional" });
    const requested = note(h, "accepted, the agent asked to forget it", { accepted: true });
    svc.forgetNote(h, requested);
    // A hidden row that was accepted (no path makes one today): retention never purges it.
    const hiddenAccepted = note(h, "a hidden row that was once accepted", { accepted: true });
    h.run("UPDATE learnings SET status = 'hidden' WHERE id = ?", [hiddenAccepted]);
    for (const [id, days] of [[oldHidden, 8], [newHidden, 2], [oldProvisional, 31], [requested, 400], [hiddenAccepted, 400]]) h.run("UPDATE learnings SET status_at = ? WHERE id = ?", [at(days), id]);

    const r = retainNotes(h, { now });
    assert.deepEqual(r, { purged: 1, expired: 1 });
    assert.equal(statusOf(h, oldHidden), null);
    assert.equal(statusOf(h, newHidden), "hidden");
    assert.equal(statusOf(h, oldProvisional), "pending");
    assert.equal(statusOf(h, requested), "forget-requested");
    assert.equal(statusOf(h, hiddenAccepted), "hidden");
  } finally {
    h.close();
  }
});

const SENTINEL = "zqxjkw9vlemma";
const scan = (file) => (existsSync(file) ? readFileSync(file).includes(Buffer.from(SENTINEL)) : false);

for (const driver of await availableDrivers()) {
  test(`a purged note leaves no bytes in the DB, the WAL or the index (${driver})`, async () => {
    const h = await store(driver);
    const file = h.path;
    let id;
    try {
      // Other rows around it, so its pages and index segments are shared ones.
      for (let i = 0; i < 40; i++) note(h, `filler lesson number ${i} about builds and caches`, { accepted: true });
      id = note(h, `always warm the ${SENTINEL} cache before the build`, { accepted: true });
      assert.equal(h.all("SELECT rowid FROM learnings_fts WHERE learnings_fts MATCH ?", [SENTINEL]).length, 1);
      // Not checkpointed: the note's frames sit in the WAL, as on a live store.
      assert.ok(scan(file) || scan(`${file}-wal`), "the sentinel is on disk before the purge (the scan works)");
      svc.forgetAccepted(h, testReviewToken(), id);
      assert.equal(h.all("SELECT rowid FROM learnings_fts WHERE learnings_fts MATCH ?", [SENTINEL]).length, 0);
      // Still open: the purge itself cleared the WAL, not the close.
      for (const f of [file, `${file}-wal`]) assert.equal(scan(f), false, `${path.basename(f)} holds the purged note while the store is open`);
    } finally {
      h.close();
    }
    for (const f of [file, `${file}-wal`, `${file}-journal`]) assert.equal(scan(f), false, `${path.basename(f)} still holds the purged note`);
  });
}

test("/memory forget in ad's terminal UI: archived through the review service, this project's notes only", async () => {
  const h = await store();
  try {
    const mine = note(h, "a lesson of this project", { accepted: true });
    const other = Number(h.run("INSERT INTO learnings (project_slug, category, text, confidence, status, content_hash) VALUES ('-work-other', 'correction', 'another project lesson', 0.8, 'pending', 'h-other')").lastInsertRowid);
    svc.acceptLearning(h, testReviewToken(), other);
    assert.throws(() => svc.archiveLearning(h, null, mine, PROJECT), /review token/);
    assert.equal(svc.archiveLearning(h, testReviewToken(), other, PROJECT), 0, "another project's note is left alone");
    assert.equal(svc.archiveLearning(h, testReviewToken(), mine, PROJECT), 1);
    assert.equal(statusOf(h, mine), "archived");
    assert.equal(served(h, mine), false);
  } finally {
    h.close();
  }
});

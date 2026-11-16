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
    const keys = { keys: [PROJECT] };
    assert.deepEqual(svc.forgetNote(h, pending, keys), { result: "hidden" });
    assert.equal(statusOf(h, pending), "hidden");
    assert.deepEqual(svc.forgetNote(h, accepted, keys), { result: "forget-requested" });
    assert.equal(statusOf(h, accepted), "forget-requested");
    assert.ok(served(h, accepted), "still recalled until the user decides");
    assert.deepEqual(svc.forgetNote(h, 999999, keys), { result: "none" });
    // Hiding never reaches an accepted note, whatever the caller asks.
    assert.equal(svc.hideNote(h, accepted, keys), 0);
    // Never the user's own capture, never another project's note, never without a project.
    const users = note(h, "the user's own words, waiting for review");
    h.run("UPDATE learnings SET origin = 'user' WHERE id = ?", [users]);
    assert.deepEqual(svc.forgetNote(h, users, keys), { result: "none" });
    assert.equal(statusOf(h, users), "pending");
    const elsewhere = note(h, "an agent note in this project");
    assert.deepEqual(svc.forgetNote(h, elsewhere, { keys: ["-work-other"] }), { result: "none" });
    assert.deepEqual(svc.forgetNote(h, elsewhere, {}), { result: "none" });
    assert.equal(statusOf(h, elsewhere), "pending");
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
    svc.forgetNote(h, keep, { keys: [PROJECT] });
    svc.forgetNote(h, drop, { keys: [PROJECT] });
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
    svc.forgetNote(h, requested, { keys: [PROJECT] });
    // A hidden row that was accepted (no path makes one today): retention never purges it.
    const hiddenAccepted = note(h, "a hidden row that was once accepted", { accepted: true });
    h.run("UPDATE learnings SET status = 'hidden' WHERE id = ?", [hiddenAccepted]);
    for (const [id, days] of [[oldHidden, 8], [newHidden, 2], [oldProvisional, 31], [requested, 400], [hiddenAccepted, 400]]) h.run("UPDATE learnings SET status_at = ? WHERE id = ?", [at(days), id]);

    const r = retainNotes(h, { now });
    assert.deepEqual(r, { purged: 1, expired: 1, events: 0 });
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

// Review finding M1: pages freed before the purge (an index merge, a rewritten row, or an
// older ad without secure_delete) held the note's bytes; the purge compacts the store.
for (const driver of await availableDrivers()) {
  test(`a purge after an index merge and a rewritten row still leaves no bytes (${driver})`, async () => {
    const h = await store(driver);
    const file = h.path;
    try {
      h.raw.exec("PRAGMA secure_delete = OFF"); // as an older ad wrote this store
      for (let i = 0; i < 40; i++) note(h, `filler lesson ${i} about builds`, { accepted: true });
      const id = note(h, `always warm the ${SENTINEL} cache`, { accepted: true });
      h.run("UPDATE learnings SET evidence = ? WHERE id = ?", [`the user said ${SENTINEL} ${"y".repeat(3000)}`, id]);
      h.run("UPDATE learnings SET evidence = ? WHERE id = ?", [`rewritten once more ${SENTINEL}`, id]);
      for (let i = 0; i < 300; i++) note(h, `more filler ${i} about caching widgets w${i}`, { accepted: true });
      h.run("INSERT INTO learnings_fts(learnings_fts) VALUES('optimize')");
      h.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      assert.ok(scan(file), "the sentinel is on disk before the purge (the scan works)");
      h.raw.exec("PRAGMA secure_delete = ON");
      svc.forgetAccepted(h, testReviewToken(), id);
      for (const f of [file, `${file}-wal`]) assert.equal(scan(f), false, `${path.basename(f)} holds the purged note while open`);
      const { compactionPending } = await import("../src/memory/purge.mjs");
      assert.equal(compactionPending(h), false, "nothing owed: the store was compacted");
    } finally {
      h.close();
    }
    for (const f of [file, `${file}-wal`]) assert.equal(scan(f), false, `${path.basename(f)} holds the purged note after close`);
  });
}

test("a compaction another process blocks is owed, and ad memory migrate's maintenance pass does it", async () => {
  const h = await store();
  const other = await open({ dbPath: h.path });
  try {
    const id = note(h, "a note to forget while another reader holds the store", { accepted: true });
    other.raw.exec("BEGIN");
    other.get("SELECT COUNT(*) AS n FROM learnings"); // a read transaction: VACUUM and the truncate wait
    const { compactionPending } = await import("../src/memory/purge.mjs");
    svc.forgetAccepted(h, testReviewToken(), id);
    assert.equal(compactionPending(h), true, "owed while the other reader holds the store");
    other.raw.exec("COMMIT");
    const { runMemoryMaintenance } = await import("../src/memory/maintenance.mjs");
    // The memory server's and start-up passes never VACUUM (it would stall them); ad memory migrate does.
    assert.equal((await runMemoryMaintenance({ handle: h })).compacted, undefined);
    assert.equal(compactionPending(h), true);
    const ran = await runMemoryMaintenance({ handle: h, compact: true });
    assert.deepEqual(ran.compacted, { vacuumed: true, walCleared: true });
    assert.equal(compactionPending(h), false);
  } finally {
    other.close();
    h.close();
  }
});

test("forgetting erases only accepted notes, and drops the note's line from the memory file", async () => {
  const { writeFileSync: write, readFileSync: read } = await import("node:fs");
  const h = await store();
  try {
    const pending = note(h, "a pending note nobody accepted");
    assert.equal(svc.forgetAccepted(h, testReviewToken(), pending), 0, "not accepted: not this path");
    assert.equal(statusOf(h, pending), "pending");
    const file = path.join(path.dirname(h.path), "activeContext.md");
    const id = note(h, "always pin node to 22 in ci", { accepted: true });
    const kept = note(h, "the release script runs from the repo root", { accepted: true });
    write(file, "# Active context\n\n- **correction** (conf 0.80): always pin node to 22 in ci\n- **gotcha** (conf 0.70): the release script runs from the repo root\n");
    assert.equal(svc.forgetAccepted(h, testReviewToken(), id, { memoryFile: file }), 1);
    assert.equal(read(file, "utf8"), "# Active context\n\n- **gotcha** (conf 0.70): the release script runs from the repo root\n");
    assert.equal(svc.archiveLearning(h, testReviewToken(), kept, PROJECT, { memoryFile: file }), 1);
    assert.equal(read(file, "utf8"), "# Active context\n\n");
  } finally {
    h.close();
  }
});

test("without the index's secure-delete (SQLite before 3.44), a purge rebuilds the index and still leaves no bytes", async () => {
  const h = await store();
  const file = h.path;
  try {
    h.run("INSERT INTO learnings_fts(learnings_fts, rank) VALUES('secure-delete', 0)");
    for (let i = 0; i < 40; i++) note(h, `filler lesson ${i} about builds`, { accepted: true });
    const id = note(h, `always warm the ${SENTINEL} cache`, { accepted: true });
    h.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    assert.ok(scan(file), "the sentinel is on disk before the purge (the scan works)");
    svc.forgetAccepted(h, testReviewToken(), id);
    for (const f of [file, `${file}-wal`]) assert.equal(scan(f), false, `${path.basename(f)} holds the purged note`);
  } finally {
    h.close();
  }
});

test("forgetting drops the note's evidence lines too, and its line in the global user.md", async () => {
  const { writeFileSync: write, readFileSync: read } = await import("node:fs");
  const h = await store();
  try {
    const dir = path.dirname(h.path);
    const project = path.join(dir, "activeContext.md");
    const global = path.join(dir, "user.md");
    const id = note(h, "never commit the .env file", { accepted: true });
    write(project, "# Active\n\n- **correction** (conf 0.80): never commit the .env file  _tags: git_\n  > the user said: don't commit .env\n- **gotcha** (conf 0.70): keep this one\n  > its own evidence\n");
    write(global, "# You\n\n- **correction** (conf 0.80): never commit the .env file\n");
    assert.equal(svc.forgetAccepted(h, testReviewToken(), id, { memoryFile: [project, global] }), 1);
    assert.equal(read(project, "utf8"), "# Active\n\n- **gotcha** (conf 0.70): keep this one\n  > its own evidence\n");
    assert.equal(read(global, "utf8"), "# You\n\n");
  } finally {
    h.close();
  }
});

test("a retention purge never compacts the store (secure_delete zeroed what it freed)", async () => {
  const h = await store();
  try {
    const old = note(h, "hidden long ago by the agent", { status: "hidden" });
    h.run("UPDATE learnings SET status_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", [old]);
    const { compactionPending } = await import("../src/memory/purge.mjs");
    let vacuums = 0;
    const exec = h.raw.exec.bind(h.raw);
    h.raw.exec = (sql) => (/VACUUM/i.test(sql) && vacuums++, exec(sql));
    assert.deepEqual(retainNotes(h, { now: Date.parse("2026-02-01T00:00:00Z") }), { purged: 1, expired: 0, events: 0 });
    assert.equal(vacuums, 0);
    assert.equal(compactionPending(h), false);
  } finally {
    h.close();
  }
});

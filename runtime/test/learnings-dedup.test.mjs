// Tests for the SQLite content_hash dedup migration + insert behavior.
//
// Background: searchLearnings was returning the same text 3× because
// three different sessions each extracted "`git status` shows 4 changed
// files" and the inserts went through unguarded. This suite pins:
//   1. learningContentHash is deterministic + collision-resistant enough
//   2. The migration adds the column, backfills, dedupes, indexes
//   3. insertLearning(s) skip on duplicate content_hash (returns null)
//   4. Re-running open() on an already-migrated DB is a no-op (idempotent)

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { open, learningContentHash } from "../src/memory/sqlite.mjs";

/** Make a fresh tmp DB path; cleanup util closes + removes it. */
async function mkTmpDb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ad-learnings-dedup-"));
  const dbPath = path.join(dir, "episodic.db");
  return {
    dbPath, dir,
    cleanup: async (db) => {
      try { db && db.close(); } catch { /* ignore */ }
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  };
}

/* ------------------------- hash function ------------------------- */

test("learningContentHash: same text → same hash", () => {
  assert.equal(learningContentHash("use pnpm"), learningContentHash("use pnpm"));
});

test("learningContentHash: trims whitespace before hashing", () => {
  assert.equal(learningContentHash("use pnpm"), learningContentHash("  use pnpm  \n"));
});

test("learningContentHash: case-sensitive (different intent)", () => {
  assert.notEqual(learningContentHash("Use pnpm"), learningContentHash("use pnpm"));
});

test("learningContentHash: different text → different hash", () => {
  const a = learningContentHash("use pnpm not yarn");
  const b = learningContentHash("use npm not yarn");
  assert.notEqual(a, b);
});

test("learningContentHash: produces 16-hex string", () => {
  const h = learningContentHash("anything");
  assert.equal(h.length, 16);
  assert.match(h, /^[0-9a-f]{16}$/);
});

test("learningContentHash: empty / null / undefined → stable hash (does not throw)", () => {
  assert.ok(typeof learningContentHash("") === "string");
  assert.ok(typeof learningContentHash(null) === "string");
  assert.ok(typeof learningContentHash(undefined) === "string");
  // empty-text-equivalents all collapse to the same hash
  assert.equal(learningContentHash(""), learningContentHash(null));
});

/* ------------------------- migration (existing DBs) ------------------------- */

test("migration: ALTER TABLE adds content_hash column when missing", async () => {
  const t = await mkTmpDb();
  // Simulate a legacy DB by opening once, then dropping the column shouldn't
  // even need to happen — for fresh DBs the column exists from the start.
  // Instead simulate by opening (which runs the migration), then re-opening:
  // the second open should be a no-op + still pass.
  const db = await open({ dbPath: t.dbPath });
  try {
    const cols = db.all("PRAGMA table_info(learnings)");
    assert.ok(cols.some(c => c.name === "content_hash"), "column exists after open()");

    const indexes = db.all("PRAGMA index_list(learnings)");
    assert.ok(indexes.some(i => i.name === "idx_learnings_content_hash"),
      "unique partial index exists");
  } finally { await t.cleanup(db); }
});

test("migration: skill execution audit columns exist and are idempotent", async () => {
  const t = await mkTmpDb();
  const db = await open({ dbPath: t.dbPath });
  try {
    const cols = new Set(db.all("PRAGMA table_info(skill_executions)").map(c => c.name));
    assert.ok(cols.has("invocation_source"));
    assert.ok(cols.has("outcome_source"));
    assert.ok(cols.has("completed_at"));
    db.close();
    const db2 = await open({ dbPath: t.dbPath });
    const reopened = new Set(db2.all("PRAGMA table_info(skill_executions)").map(c => c.name));
    assert.ok(reopened.has("invocation_source"));
    await t.cleanup(db2);
  } catch (e) {
    await t.cleanup(db);
    throw e;
  }
});

test("migration: backfills NULL content_hash on legacy rows + dedupes", async () => {
  const t = await mkTmpDb();
  const db = await open({ dbPath: t.dbPath });
  try {
    // Simulate "legacy" rows by clearing their hashes after insert. We can't
    // bypass the schema's column, so we'll set them to NULL manually.
    db.run("INSERT INTO learnings (category, text) VALUES ('pattern', 'duplicate text A')");
    db.run("INSERT INTO learnings (category, text) VALUES ('pattern', 'duplicate text A')");  // dup of #1
    db.run("INSERT INTO learnings (category, text) VALUES ('pattern', 'unique text B')");
    db.run("INSERT INTO learnings (category, text) VALUES ('pattern', 'duplicate text A')");  // another dup
    // Force NULL hashes to simulate pre-migration legacy state. The unique
    // index allows multiple NULLs, so this is permitted.
    db.run("UPDATE learnings SET content_hash = NULL");

    // Confirm pre-migration state
    assert.equal(db.get("SELECT COUNT(*) AS c FROM learnings").c, 4);

    // Close + reopen → migration re-runs (backfill + dedupe)
    db.close();
    const db2 = await open({ dbPath: t.dbPath });
    try {
      const total = db2.get("SELECT COUNT(*) AS c FROM learnings").c;
      assert.equal(total, 2, "duplicates collapsed: 1 row for 'A' + 1 row for 'B'");

      const texts = db2.all("SELECT text FROM learnings ORDER BY id").map(r => r.text).sort();
      assert.deepEqual(texts, ["duplicate text A", "unique text B"]);

      // All content_hashes should now be populated
      const nulls = db2.get("SELECT COUNT(*) AS c FROM learnings WHERE content_hash IS NULL").c;
      assert.equal(nulls, 0, "no NULL hashes remain after migration");
    } finally {
      await t.cleanup(db2);
    }
  } catch (e) {
    await t.cleanup(db);
    throw e;
  }
});

test("migration: keeps the OLDEST row (lowest id) when deduping legacy duplicates", async () => {
  const t = await mkTmpDb();
  const db = await open({ dbPath: t.dbPath });
  try {
    // Insert 3 dups with different evidence so we can tell which survived
    const r1 = db.run("INSERT INTO learnings (category, text, evidence) VALUES ('pattern', 'same text', 'oldest evidence')");
    const r2 = db.run("INSERT INTO learnings (category, text, evidence) VALUES ('pattern', 'same text', 'middle evidence')");
    const r3 = db.run("INSERT INTO learnings (category, text, evidence) VALUES ('pattern', 'same text', 'newest evidence')");
    db.run("UPDATE learnings SET content_hash = NULL");

    db.close();
    const db2 = await open({ dbPath: t.dbPath });
    try {
      const rows = db2.all("SELECT id, evidence FROM learnings WHERE text = 'same text'");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, r1.lastInsertRowid, "oldest id survives");
      assert.equal(rows[0].evidence, "oldest evidence");
    } finally { await t.cleanup(db2); }
  } catch (e) {
    await t.cleanup(db);
    throw e;
  }
});

test("migration: re-running open() on an already-migrated DB is idempotent (no-op)", async () => {
  const t = await mkTmpDb();
  const db1 = await open({ dbPath: t.dbPath });
  try {
    db1.run("INSERT INTO learnings (category, text) VALUES ('pattern', 'persistent learning')");
    const beforeCount = db1.get("SELECT COUNT(*) AS c FROM learnings").c;
    db1.close();

    const db2 = await open({ dbPath: t.dbPath });
    const afterCount = db2.get("SELECT COUNT(*) AS c FROM learnings").c;
    assert.equal(afterCount, beforeCount, "row count unchanged across reopens");

    // A third open for good measure
    db2.close();
    const db3 = await open({ dbPath: t.dbPath });
    try {
      assert.equal(db3.get("SELECT COUNT(*) AS c FROM learnings").c, beforeCount);
    } finally { await t.cleanup(db3); }
  } catch (e) {
    await t.cleanup(db1);
    throw e;
  }
});

/* ------------------------- insertLearning(s) dedup ------------------------- */

test("insertLearning: first insert succeeds; second with same text returns null", async () => {
  // We test through episodic.mjs to verify the full path.
  const t = await mkTmpDb();
  // Override HOME so episodic's default db path lands in tmpdir
  const prevHome = process.env.HOME;
  const prevUP = process.env.USERPROFILE;
  process.env.HOME = t.dir;
  process.env.USERPROFILE = t.dir;

  // Re-import episodic with the patched HOME so it picks up the tmp path
  const mod = await import(`../src/memory/episodic.mjs?cachebust=${Date.now()}`);
  try {
    const id1 = await mod.insertLearning({ category: "pattern", text: "duplicate me" });
    const id2 = await mod.insertLearning({ category: "pattern", text: "duplicate me" });
    const id3 = await mod.insertLearning({ category: "pattern", text: "different text" });

    assert.ok(typeof id1 === "number" && id1 > 0, "first insert returns id");
    assert.equal(id2, null, "duplicate insert returns null");
    assert.ok(typeof id3 === "number" && id3 > 0, "non-duplicate insert succeeds");

    // Verify only 2 rows in DB
    const db = await open({});
    const total = db.get("SELECT COUNT(*) AS c FROM learnings WHERE text IN ('duplicate me', 'different text')").c;
    assert.equal(total, 2);
    db.close();
    mod.closeDb();
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUP;
    await t.cleanup();
  }
});

test("insertLearnings batch: dedupes within the batch AND against existing rows", async () => {
  const t = await mkTmpDb();
  const prevHome = process.env.HOME;
  const prevUP = process.env.USERPROFILE;
  process.env.HOME = t.dir;
  process.env.USERPROFILE = t.dir;

  const mod = await import(`../src/memory/episodic.mjs?cachebust=${Date.now()}`);
  try {
    // Pre-seed one row
    await mod.insertLearning({ category: "pattern", text: "already in db" });

    // Batch with intra-batch dup AND a collision with existing row
    const ids = await mod.insertLearnings([
      { category: "pattern", text: "batch unique 1" },
      { category: "pattern", text: "batch unique 1" },     // intra-batch dup
      { category: "pattern", text: "batch unique 2" },
      { category: "pattern", text: "already in db" },      // collision with existing
      { category: "pattern", text: "batch unique 3" }
    ]);

    // Expect: [id, null, id, null, id]
    assert.equal(ids.length, 5);
    assert.ok(typeof ids[0] === "number");
    assert.equal(ids[1], null, "intra-batch dup → null");
    assert.ok(typeof ids[2] === "number");
    assert.equal(ids[3], null, "collision with existing row → null");
    assert.ok(typeof ids[4] === "number");

    // 4 rows total: 1 pre-seeded + 3 newly inserted
    const db = await open({});
    assert.equal(db.get("SELECT COUNT(*) AS c FROM learnings").c, 4);
    db.close();
    mod.closeDb();
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUP;
    await t.cleanup();
  }
});

test("dedup is case-sensitive (matches hash semantics)", async () => {
  const t = await mkTmpDb();
  const prevHome = process.env.HOME;
  const prevUP = process.env.USERPROFILE;
  process.env.HOME = t.dir;
  process.env.USERPROFILE = t.dir;

  const mod = await import(`../src/memory/episodic.mjs?cachebust=${Date.now()}`);
  try {
    const a = await mod.insertLearning({ category: "pattern", text: "Use pnpm" });
    const b = await mod.insertLearning({ category: "pattern", text: "use pnpm" });
    assert.ok(typeof a === "number");
    assert.ok(typeof b === "number", "different case → different hash → both insert");
    mod.closeDb();
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUP;
    await t.cleanup();
  }
});

test("dedup ignores surrounding whitespace (trimmed)", async () => {
  const t = await mkTmpDb();
  const prevHome = process.env.HOME;
  const prevUP = process.env.USERPROFILE;
  process.env.HOME = t.dir;
  process.env.USERPROFILE = t.dir;

  const mod = await import(`../src/memory/episodic.mjs?cachebust=${Date.now()}`);
  try {
    const a = await mod.insertLearning({ category: "pattern", text: "trimmed match" });
    const b = await mod.insertLearning({ category: "pattern", text: "  trimmed match  \n" });
    assert.ok(typeof a === "number");
    assert.equal(b, null, "whitespace-only diff → still considered duplicate");
    mod.closeDb();
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUP;
    await t.cleanup();
  }
});

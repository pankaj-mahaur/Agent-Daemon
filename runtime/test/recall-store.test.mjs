// L6 P3 (design decisions 2, 5, 6): which stored rows recall may serve.
//   - this project's accepted, forget-requested and provisional notes; never another
//     project's, never pending, quarantined or hidden ones;
//   - no provisional note under strict mode or past its 30 days;
//   - global accepted notes only when asked (prompt recall, the recall command);
//   - freshness from created/verified, never from last_retrieved_at;
//   - every session: provisional, or the user's own words accepted in the last 14 days;
//   - above 1,500 rows the FTS index prefilters, and standing notes still come.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ad-l6-store-"));
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
for (const k of ["AD_ROOT", "AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR"]) delete process.env[k];

const { open } = await import("../src/memory/sqlite.mjs");
const R = await import("../src/memory/recall.mjs");
const { setReviewStrict } = await import("../src/memory/review-mode.mjs");

const stores = [];
after(() => {
  for (const s of stores) s.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
let n = 0;
async function store() {
  const db = await open({ dbPath: path.join(ROOT, `s${n++}.db`), prefer: "node:sqlite" });
  stores.push(db);
  return db;
}
const NOW = Date.parse("2026-11-08T12:00:00Z");
const ago = (d) => new Date(NOW - d * 86_400_000).toISOString();
function add(db, o) {
  const row = { project_slug: "app", category: "correction", status: "active", accepted_by: "review", accepted_at: ago(100), created_at: ago(100), provenance: "legacy", observed_count: 1, ...o };
  if (row.status !== "active" && row.status !== "forget-requested" && !("accepted_by" in o)) row.accepted_by = null;
  const cols = Object.keys(row);
  db.run(`INSERT INTO learnings (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map((c) => row[c]));
  return db.get("SELECT last_insert_rowid() AS id").id;
}
const ids = (rows) => rows.map((r) => r.id).sort((a, b) => a - b);

test("serves this project's accepted, forget-requested and live provisional notes only", async () => {
  const db = await store();
  const acc = add(db, { text: "accepted note" });
  const fr = add(db, { text: "asked to forget", status: "forget-requested" });
  const prov = add(db, { text: "provisional note", status: "provisional", status_at: ago(3), provenance: "user-prompt" });
  add(db, { text: "old provisional", status: "provisional", status_at: ago(31), provenance: "user-prompt" });
  add(db, { text: "pending note", status: "pending" });
  add(db, { text: "quarantined note", status: "quarantined", quarantine_reason: "instruction" });
  add(db, { text: "hidden note", status: "hidden" });
  add(db, { text: "other project's note", project_slug: "other" });
  add(db, { text: "other project's provisional", project_slug: "other", status: "provisional", status_at: ago(1) });
  add(db, { text: "unaccepted active (an older writer)", accepted_by: null });
  const rows = R.recallRows(db, ["app"], { now: NOW });
  assert.deepEqual(ids(rows), [acc, fr, prov]);
  assert.equal(rows.find((r) => r.id === prov).status, "provisional");
  assert.equal(rows.find((r) => r.id === fr).status, "forget-requested");
});

test("strict mode serves no provisional note", async () => {
  const db = await store();
  const acc = add(db, { text: "accepted" });
  add(db, { text: "provisional", status: "provisional", status_at: ago(1) });
  setReviewStrict(db, { now: new Date(NOW) });
  // strict's demotion moved it; a provisional row written after (a race) is not served either
  add(db, { text: "late provisional", status: "provisional", status_at: ago(0) });
  assert.deepEqual(ids(R.recallRows(db, ["app"], { now: NOW })), [acc]);
});

test("global accepted notes come only when asked", async () => {
  const db = await store();
  const p = add(db, { text: "project note" });
  const g = add(db, { text: "global note", project_slug: null, global_accepted_at: ago(5) });
  add(db, { text: "global, never accepted as global", project_slug: null });
  assert.deepEqual(ids(R.recallRows(db, ["app"], { now: NOW })), [p]);
  const both = R.recallRows(db, ["app"], { now: NOW, global: true });
  assert.deepEqual(ids(both), [p, g]);
  assert.equal(both.find((r) => r.id === g).standing, false, "a global note is never standing in a project's brief");
});

test("a note's age comes from created or accepted, never from verified, retrieved or repeat counts", async () => {
  const db = await store();
  const a = add(db, { text: "accepted later", created_at: ago(400), accepted_at: ago(10) });
  const b = add(db, { text: "verified and retrieved later, repeated", created_at: ago(400), accepted_at: ago(400), last_verified_at: ago(1), last_retrieved_at: ago(1), observed_count: 50 });
  const rows = R.recallRows(db, ["app"], { now: NOW });
  assert.equal(Date.parse(rows.find((r) => r.id === a).created), Date.parse(ago(10)));
  assert.equal(Date.parse(rows.find((r) => r.id === b).created), Date.parse(ago(400)));
  assert.equal(rows.find((r) => r.id === b).standing, false, "repeats never make a note go every session");
});

test("every session: provisional, or the user's own words accepted in the last 14 days", async () => {
  const db = await store();
  const plain = add(db, { text: "legacy, said once" });
  const own = add(db, { text: "from a prompt", provenance: "prompt", accepted_at: ago(3) });
  const cli = add(db, { text: "remember in the terminal", provenance: "user-cli", accepted_at: ago(13) });
  const oldOwn = add(db, { text: "from a prompt, long ago", provenance: "prompt", accepted_at: ago(90) });
  const agentRecent = add(db, { text: "the agent saved it", provenance: "agent", accepted_at: ago(1) });
  const rep = add(db, { text: "said three times", observed_count: 3 });
  const prov = add(db, { text: "provisional", status: "provisional", status_at: ago(2), provenance: "user-prompt" });
  const rows = R.recallRows(db, ["app"], { now: NOW });
  const sent = (id) => rows.find((r) => r.id === id).standing;
  assert.equal(sent(plain), false);
  assert.equal(sent(own), true);
  assert.equal(sent(cli), true);
  assert.equal(sent(oldOwn), false);
  assert.equal(sent(agentRecent), false);
  assert.equal(sent(rep), false);
  assert.equal(sent(prov), true);
  assert.equal(rows.find((r) => r.id === own).own, true);
  assert.equal(rows.find((r) => r.id === plain).own, false);
  assert.equal(Date.parse(rows.find((r) => r.id === own).written), Date.parse(ago(100)), "written = created_at");
});

test("above 1,500 notes the FTS index prefilters, and standing and pinned notes still come", async () => {
  const db = await store();
  db.run("BEGIN");
  for (let i = 0; i < 1600; i++) add(db, { text: `filler note ${i} about subsystem ${i % 40}` });
  const hit = add(db, { text: "refunds go through the bulk issuer" });
  const own = add(db, { text: "use pnpm, not npm", provenance: "prompt" });
  db.run("COMMIT");
  const rows = R.recallRows(db, ["app"], { now: NOW, ftsQuery: '"refunds" OR "bulk"' });
  assert.ok(rows.length <= R.PREFILTER_TOP + 100 + 5, String(rows.length));
  assert.ok(rows.some((r) => r.id === hit));
  assert.ok(rows.some((r) => r.id === own));
});

test("pending rows: this project's unaccepted notes, apart from what recall serves", async () => {
  const db = await store();
  const p = add(db, { text: "waiting", status: "pending" });
  add(db, { text: "accepted" });
  add(db, { text: "other project's waiting", status: "pending", project_slug: "other" });
  assert.deepEqual(R.pendingRows(db, ["app"]).map((r) => r.id), [p]);
});

// L5 P1 (design decisions 2, 10, 13, 14, 16, 19): the trust plumbing under capture.
//   - only a first-party verdict this process minted makes a note provisional, never under
//     strict mode, never without a project, never a revived note that was provisional before;
//   - review mode lives in the store and is sticky; loosening it needs the token;
//   - provisional notes are never guarded, rule sources, synced, exported or global;
//   - events, expiry and retention keep what later decisions read.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openFilesUnder } from "../testkit/open-files.mjs";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = mkdtempSync(path.join(tmpdir(), "ad-l5-trust-"));
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
for (const k of ["AD_ROOT", "AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL"]) delete process.env[k];

const { open } = await import("../src/memory/sqlite.mjs");
const trust = await import("../src/memory/trust.mjs");
const svc = await import("../src/memory/review-service.mjs");
const mode = await import("../src/memory/review-mode.mjs");
const { writeProvisional } = await import("../src/memory/provisional-write.mjs");
const { recordEvent, latestEvent, EVENT_KINDS } = await import("../src/memory/l5-tables.mjs");
const { retainNotes, pruneEvents, expiringSoon } = await import("../src/memory/purge.mjs");
const { promptSource } = await import("../src/hooks/prompt-source.mjs");
const { testReviewToken } = await import("../testkit/memory-trust.mjs");

// Every store this file opens is closed before ROOT goes: Windows can't delete an open database (EBUSY).
const opened = [];
after(async () => {
  for (const h of opened) {
    try {
      h.close();
    } catch {
      // a test closed it already
    }
  }
  (await import("../src/memory/episodic.mjs")).closeDb();
  const left = await openFilesUnder(ROOT);
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  assert.deepEqual(left, [], "every database is closed before the folder goes (Windows: EBUSY)");
});

const SLUG = "-work-shop-app";
const PID = "prj_shop0000000000000000";
const KEYS = [SLUG, PID];
let n = 0;
async function store() {
  const dir = path.join(ROOT, `db-${++n}`);
  mkdirSync(dir, { recursive: true });
  const h = await open({ dbPath: path.join(dir, "episodic.db") });
  opened.push(h);
  return h;
}
function note(h, text, { status = "pending", accepted = false, slug = SLUG, pid = PID, origin = "agent", reason = null, appliedTo = null } = {}) {
  const id = Number(h.run(
    "INSERT INTO learnings (project_slug, project_id, category, text, confidence, status, content_hash, origin, quarantine_reason, applied_to) VALUES (?, ?, 'correction', ?, 0.8, ?, ?, ?, ?, ?)",
    [slug, pid, text, status, `h-${n}-${text}`, origin, reason, appliedTo]
  ).lastInsertRowid);
  if (accepted) svc.acceptLearning(h, testReviewToken(), id);
  return id;
}
const row = (h, id) => h.get("SELECT * FROM learnings WHERE id = ?", [id]);
const LIST = [{ host: "claude", signal: "source-user", minVersion: "2.1.400", parentExe: /\/claude\/versions\// }];
// A first-party verdict vouches only for its own prompt's words.
const firstParty = (prompt = "please: use pnpm, not npm. a b c d e f prov prov note p2 p3 always use tabs in go files") => promptSource({ prompt, source: "user" }, { host: "claude", env: {}, scheduled: [], list: LIST, parent: () => ({ ok: true, version: "2.1.400" }) });
const notFirst = () => promptSource({ prompt: "never use npm in this repo", source: "user" }, { host: "claude", env: {}, scheduled: [] });
const newRow = (text) => ({ projectSlug: SLUG, projectId: PID, category: "correction", text, evidence: "typed", confidence: 0.8 });

test("writeProvisional: a first-party verdict makes a provisional note, stamped and recorded", async () => {
  const h = await store();
  const r = writeProvisional(h, firstParty(), { row: newRow("use pnpm, not npm") });
  assert.equal(r.status, "provisional");
  const x = row(h, r.id);
  assert.equal(x.status, "provisional");
  assert.ok(x.status_at, "status_at set (retention keys on it)");
  assert.equal(x.origin, "user");
  assert.equal(x.provenance, "user-prompt");
  assert.equal(x.accepted_by, null);
  assert.equal(latestEvent(h, "provisional", r.id).actor, "user");
});

test("writeProvisional falls back to pending: not first-party, a copied verdict, strict, no project", async () => {
  const h = await store();
  assert.equal(writeProvisional(h, notFirst(), { row: newRow("a") }).status, "pending");
  assert.equal(writeProvisional(h, { ...firstParty() }, { row: newRow("b") }).status, "pending", "a copy of a verdict isn't minted");
  assert.equal(writeProvisional(h, { typed: true, firstParty: true, provisionalEligible: true }, { row: newRow("c") }).status, "pending", "a home-made verdict");
  assert.equal(writeProvisional(h, firstParty(), { row: { ...newRow("d"), projectId: null } }).status, "pending", "no project id");
  assert.equal(writeProvisional(h, firstParty("something else entirely"), { row: newRow("use pnpm, not npm") }).status, "pending", "a verdict for another prompt");
  mode.setReviewStrict(h);
  assert.equal(writeProvisional(h, firstParty(), { row: newRow("e") }).status, "pending", "strict");
  const pend = note(h, "f");
  assert.equal(writeProvisional(h, firstParty(), { id: pend }).status, "pending", "strict on an existing note too");
  assert.equal(h.get("SELECT COUNT(*) AS n FROM learnings WHERE status = 'provisional'").n, 0);
});

test("writeProvisional: upgrades the agent's pending note, never an accepted one, never a revived one that was provisional", async () => {
  const h = await store();
  const agent = note(h, "use tabs in Go files");
  h.run("UPDATE learnings SET promote_request = 'global', provenance = 'agent' WHERE id = ?", [agent]);
  const r = writeProvisional(h, firstParty(), { id: agent });
  assert.equal(r.status, "provisional");
  const x = row(h, agent);
  assert.equal(x.provenance, "user-prompt");
  assert.equal(x.origin, "user");
  assert.equal(x.promote_request, null, "a provisional note never asks to become global");

  const acc = note(h, "accepted one", { accepted: true });
  assert.equal(writeProvisional(h, firstParty(), { id: acc }).why, "accepted");
  assert.equal(row(h, acc).status, "active");

  // Provisional, hidden, then a first-party capture again: back to pending, not a fresh 30 days.
  h.run("UPDATE learnings SET status = 'hidden', status_at = NULL WHERE id = ?", [agent]);
  const again = writeProvisional(h, firstParty(), { id: agent });
  assert.equal(again.status, "pending");
  assert.equal(row(h, agent).status, "pending");
});

test("review mode: auto by default, strict demotes provisional notes, sticky when its row is deleted, auto needs the token", async () => {
  const h = await store();
  assert.equal(mode.reviewMode(h), "auto");
  const p = writeProvisional(h, firstParty(), { row: newRow("prov") }).id;
  const { demoted } = mode.setReviewStrict(h);
  assert.equal(demoted, 1);
  assert.equal(row(h, p).status, "pending");
  assert.equal(mode.reviewMode(h), "strict");
  assert.ok(latestEvent(h, "strict-on"));
  h.run("DELETE FROM memory_settings WHERE key = 'review_mode'");
  assert.equal(mode.reviewMode(h), "strict", "a deleted row never loosens it");
  h.run("UPDATE memory_settings SET value = 'nonsense' WHERE key = 'review_mode_ever_strict'");
  h.run("INSERT INTO memory_settings (key, value, at) VALUES ('review_mode', 'garbage', 'x')");
  assert.equal(mode.reviewMode(h), "strict", "damaged rows fail closed");
  assert.throws(() => svc.setReviewAuto(h, { issuedAt: 1 }), /review token/);
  svc.setReviewAuto(h, testReviewToken());
  assert.equal(mode.reviewMode(h), "auto");
  assert.ok(latestEvent(h, "strict-off"));
});

test("predicates: provisional is recalled (project only, not under strict) and nothing else", async () => {
  const h = await store();
  const prov = writeProvisional(h, firstParty(), { row: newRow("prov note") }).id;
  const acc = note(h, "acc note", { accepted: true });
  const fr = note(h, "fr note", { accepted: true });
  svc.requestForget(h, fr, { keys: KEYS });
  h.run("UPDATE learnings SET provenance = 'user-prompt' WHERE id IN (?, ?)", [acc, prov]);
  const ids = (sql) => h.all(`SELECT id FROM learnings WHERE ${sql} ORDER BY id`).map((r) => r.id);
  assert.deepEqual(ids(trust.recallSql()), [prov, acc, fr]);
  assert.deepEqual(ids(trust.recallSql("", { strict: true })), [acc, fr]);
  assert.deepEqual(ids(trust.guardSourceSql()), [acc, fr], "a forget request never drops a rule; provisional never guards");
  assert.deepEqual(ids(trust.ruleProposalSql()), [acc]);
  assert.deepEqual(ids(trust.syncEligibleSql()), [acc]);
  assert.deepEqual(ids(trust.exportableSql()), [acc, fr]);
  assert.equal(trust.tagOf(row(h, prov)), "provisional");
  assert.equal(trust.tagOf(row(h, fr)), "agent asked to forget");
  assert.equal(trust.tagOf(row(h, acc)), null);
  // A provisional note never becomes global.
  assert.equal(svc.acceptGlobal(h, testReviewToken(), prov), 0);
  assert.equal(svc.promoteLearning(h, testReviewToken(), row(h, prov)).ok, false);
  assert.equal(row(h, prov).global_accepted_at, null);
});

test("acceptReviewed: pending and provisional; flagged only when confirmed; never a secret, another project or a stale row", async () => {
  const h = await store();
  const tok = testReviewToken();
  const pend = note(h, "p1");
  const prov = writeProvisional(h, firstParty(), { row: newRow("p2") }).id;
  const flag = note(h, "p3", { status: "quarantined", reason: "injection:x" });
  const legacy = note(h, "p3b", { appliedTo: "quarantined" });
  const secret = note(h, "p4", { status: "quarantined", reason: "secret:aws" });
  const other = note(h, "p5", { slug: "-other", pid: "prj_other000000000000000" });
  const rej = note(h, "p6", { status: "rejected" });
  assert.equal(svc.acceptReviewed(h, tok, pend, { keys: KEYS }), 1);
  assert.equal(svc.acceptReviewed(h, tok, prov, { keys: KEYS }), 1);
  assert.equal(row(h, prov).status, "active");
  assert.equal(svc.acceptReviewed(h, tok, flag, { keys: KEYS }), 0, "flagged needs the confirm");
  assert.equal(svc.acceptReviewed(h, tok, legacy, { keys: KEYS }), 0, "an older writer's held-back row is flagged too");
  assert.equal(svc.acceptReviewed(h, tok, flag, { keys: KEYS, withFlagged: true }), 1);
  assert.equal(svc.acceptReviewed(h, tok, secret, { keys: KEYS, withFlagged: true }), 0, "a secret is never released");
  assert.equal(svc.acceptReviewed(h, tok, other, { keys: KEYS }), 0);
  assert.equal(svc.acceptReviewed(h, tok, rej, { keys: KEYS }), 0);
  assert.equal(svc.acceptReviewed(h, tok, pend, { keys: KEYS }), 0, "already accepted: stale");
  assert.throws(() => svc.acceptReviewed(h, { issuedAt: 1 }, pend, { keys: KEYS }), /review token/);
});

test("rememberAccepted: the CLI with the token stores and accepts, provenance user-cli", async () => {
  const h = await store();
  const r = svc.rememberAccepted(h, testReviewToken(), newRow("always run the linter first"), { keys: KEYS });
  assert.equal(r.status, "accepted");
  const x = row(h, r.id);
  assert.equal(x.status, "active");
  assert.equal(x.provenance, "user-cli");
  assert.equal(svc.rememberAccepted(h, testReviewToken(), newRow("always run the linter first"), { keys: KEYS }).status, "accepted-before");
  assert.throws(() => svc.rememberAccepted(h, null, newRow("x"), { keys: KEYS }), /review token/);
});

test("events: known kinds and actors only; no text; pruning keeps what later decisions read", async () => {
  const h = await store();
  assert.throws(() => recordEvent(h, { kind: "nope", actor: "user" }), /unknown event kind/);
  assert.throws(() => recordEvent(h, { kind: "captured", actor: "root" }), /unknown actor/);
  const live = note(h, "live");
  const hidden = note(h, "hid", { status: "hidden" });
  const old = new Date(Date.now() - 400 * 86_400_000);
  const ids = {
    capturedUser: recordEvent(h, { kind: "captured", learningId: live, actor: "user", at: old }),
    capturedAgent: recordEvent(h, { kind: "captured", learningId: live, actor: "agent", at: old }),
    provisional: recordEvent(h, { kind: "provisional", learningId: live, actor: "user", at: old }),
    hidden: recordEvent(h, { kind: "hidden", learningId: hidden, actor: "user", at: old }),
    discarded: recordEvent(h, { kind: "discarded", actor: "review", detail: { hash: "abc" }, at: old }),
    reviewedOld: recordEvent(h, { kind: "reviewed", projectId: PID, actor: "review", at: old }),
    reviewedNew: recordEvent(h, { kind: "reviewed", projectId: PID, actor: "review", at: new Date(old.getTime() + 1000) }),
    expired: recordEvent(h, { kind: "expired", learningId: live, actor: "system", at: old }),
  };
  pruneEvents(h);
  const left = new Set(h.all("SELECT id FROM events").map((r) => r.id));
  for (const k of ["capturedUser", "provisional", "hidden", "discarded", "reviewedNew"]) assert.ok(left.has(ids[k]), `${k} kept`);
  for (const k of ["capturedAgent", "reviewedOld", "expired"]) assert.ok(!left.has(ids[k]), `${k} pruned`);
  assert.ok(EVENT_KINDS.includes("discarded"));
});

test("retention: expiry records an event; a hide nobody was shown (status_at NULL) is kept; expiringSoon counts", async () => {
  const h = await store();
  const now = Date.now();
  const day = 86_400_000;
  const exp = note(h, "expiring", { status: "provisional", origin: "user" });
  const soon = note(h, "soon", { status: "provisional", origin: "user" });
  const fresh = note(h, "fresh", { status: "provisional", origin: "user" });
  const unseen = note(h, "unseen hide", { status: "hidden", origin: "user" });
  h.run("UPDATE learnings SET status_at = ? WHERE id = ?", [new Date(now - 31 * day).toISOString(), exp]);
  h.run("UPDATE learnings SET status_at = ? WHERE id = ?", [new Date(now - 25 * day).toISOString(), soon]);
  h.run("UPDATE learnings SET status_at = ? WHERE id = ?", [new Date(now - 1 * day).toISOString(), fresh]);
  h.run("UPDATE learnings SET status_at = NULL WHERE id = ?", [unseen]);
  assert.equal(expiringSoon(h, KEYS, { days: 7, now }), 1, "only the one that goes within 7 days");
  const r = retainNotes(h, { now });
  assert.equal(r.expired, 1);
  assert.equal(row(h, exp).status, "pending");
  assert.ok(latestEvent(h, "expired", exp));
  assert.ok(row(h, unseen), "never purged unseen");
});

test("purge keeps counts but drops the link to the gone note", async () => {
  const h = await store();
  const { purgeLearnings } = await import("../src/memory/purge.mjs");
  const id = note(h, "gone soon");
  const ev = recordEvent(h, { kind: "captured", learningId: id, actor: "user" });
  purgeLearnings(h, [id], { compact: false });
  assert.equal(h.get("SELECT learning_id FROM events WHERE id = ?", [ev]).learning_id, null);
});

test("provenance on new rows: the drained journal is buffered, the digest digest, the MCP tool path agent", async () => {
  const src = (f) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), "utf8");
  assert.match(src("hooks/journal-drain.mjs"), /provenance: "buffered"/);
  assert.match(src("memory/capture.mjs"), /provenance: "agent"/);
  const h = await store();
  const { writeLearning } = await import("../src/memory/episodic.mjs");
  const id = Number(writeLearning(h, { ...newRow("forged"), provenance: "user-prompt-but-not-really" }));
  assert.equal(row(h, id).provenance, null, "an unknown value is stored as none");
});

// ── Scans: only the hook path reaches the provisional writer ─────────────────────────
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".mjs")) yield p;
  }
}

test("only capture-prompt.mjs and forget.mjs import the provisional writer; no other code writes 'provisional'", () => {
  const ALLOWED_IMPORTERS = new Set(["memory/capture-prompt.mjs", "memory/forget.mjs"]);
  const WRITE = /(?:status\s*=\s*'provisional'|status:\s*["'`]provisional["'`]|\bIN\s*\([^)]*'provisional'|THEN\s+'provisional'|VALUES\s*\([^)]*'provisional')/i;
  const READS = new Set(["memory/trust.mjs", "memory/purge.mjs", "memory/review-mode.mjs", "portability/export.mjs", "memory/review-service.mjs", "memory/review-queue.mjs"]);
  // capture-prompt.mjs returns "provisional" as a result status; it may never write it in SQL.
  const SQL_WRITE = /(?:SET\s+status\s*=\s*'provisional'|VALUES\s*\([^)]*'provisional'|THEN\s+'provisional')/i;
  assert.doesNotMatch(readFileSync(path.join(SRC, "memory/capture-prompt.mjs"), "utf8"), SQL_WRITE);
  READS.add("memory/capture-prompt.mjs");
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    const text = readFileSync(file, "utf8");
    if (/provisional-write\.mjs/.test(text) && rel !== "memory/provisional-write.mjs") assert.ok(ALLOWED_IMPORTERS.has(rel), `${rel} imports the provisional writer`);
    // Readers (WHERE status = 'provisional') are listed; any other file naming it is a writer.
    if (rel !== "memory/provisional-write.mjs" && !READS.has(rel)) assert.doesNotMatch(text, WRITE, `${rel} names a provisional status`);
  }
});

test("the MCP server's closure never reaches the provisional writer or the prompt capture", async () => {
  const { closure } = await import("../scripts/build-memory-package.mjs");
  const { files } = closure(["src/mcp/memory-server.mjs"]);
  assert.ok(files.includes("src/mcp/memory-server.mjs"));
  assert.ok(!files.includes("src/memory/provisional-write.mjs"), "the MCP server can reach writeProvisional");
  assert.ok(!files.includes("src/memory/capture-prompt.mjs"), "the MCP server can reach capturePrompt");
});

test("the store reopened: events and settings still write (no project triggers on events)", async () => {
  const dir = path.join(ROOT, "reopen");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "episodic.db");
  const a = await open({ dbPath: file });
  a.close();
  const h = await open({ dbPath: file });
  assert.ok(recordEvent(h, { kind: "captured", actor: "user", projectId: PID }));
  mode.setReviewStrict(h);
  assert.equal(mode.reviewMode(h), "strict");
  const id = note(h, "after reopen", { status: "provisional", origin: "user" });
  h.run("UPDATE learnings SET status_at = ? WHERE id = ?", [new Date(Date.now() - 40 * 86_400_000).toISOString(), id]);
  assert.equal(retainNotes(h).expired, 1);
  h.close();
});

test("writeProvisional never upgrades a flagged note, a quarantined new row, or another prompt's words", async () => {
  const h = await store();
  const q = note(h, "use pnpm, not npm", { status: "quarantined", reason: "injection:x" });
  assert.equal(writeProvisional(h, firstParty(), { id: q }).why, "flagged");
  const legacy = note(h, "always use tabs in go files", { appliedTo: "quarantined" });
  assert.equal(writeProvisional(h, firstParty(), { id: legacy }).why, "flagged");
  assert.equal(row(h, legacy).status, "pending");
  const r = writeProvisional(h, firstParty(), { row: { ...newRow("prov note"), status: "quarantined", quarantineReason: "injection:y" } });
  assert.equal(r.status, "quarantined");
  const other = note(h, "a completely different sentence", { origin: "agent" });
  assert.equal(writeProvisional(h, firstParty(), { id: other }).status, "pending", "the verdict's prompt doesn't hold these words");
  assert.equal(h.get("SELECT COUNT(*) AS n FROM learnings WHERE status = 'provisional'").n, 0);
});

test("hidden notes: a non-first-party capture revives only the agent's hide; strict revives to pending, never provisional", async () => {
  const h = await store();
  const byUser = note(h, "use pnpm, not npm", { status: "hidden", origin: "user" });
  recordEvent(h, { kind: "hidden", learningId: byUser, actor: "user" });
  const byAgent = note(h, "always use tabs in go files", { status: "hidden" });
  recordEvent(h, { kind: "hidden", learningId: byAgent, actor: "agent" });
  assert.equal(writeProvisional(h, notFirst(), { id: byUser }).status, "hidden", "a user's hide stands");
  assert.equal(writeProvisional(h, notFirst(), { id: byAgent }).status, "pending");
  const never = note(h, "prov note", { status: "hidden", origin: "user" });
  mode.setReviewStrict(h);
  assert.equal(writeProvisional(h, firstParty(), { id: never }).status, "pending", "strict: back, but pending");
});

test("rememberAccepted: no project, nothing written; a hidden note it can't accept stays hidden", async () => {
  const h = await store();
  assert.equal(svc.rememberAccepted(h, testReviewToken(), newRow("x y z"), { keys: [] }).status, "no-project");
  assert.equal(h.get("SELECT COUNT(*) AS n FROM learnings").n, 0);
  const { writeLearning } = await import("../src/memory/episodic.mjs");
  const hid = Number(writeLearning(h, { ...newRow("hidden here"), origin: "user" }));
  h.run("UPDATE learnings SET status = 'hidden', status_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", [hid]);
  const r = svc.rememberAccepted(h, testReviewToken(), { ...newRow("hidden here"), projectSlug: SLUG }, { keys: ["-elsewhere", "prj_elsewhere00000000000000"] });
  assert.equal(r.status, "hidden");
  assert.equal(row(h, hid).status_at, "2026-01-01T00:00:00.000Z");
});

test("only the review service and the provisional writer write the user's proven provenance", () => {
  // remember.mjs names it only for a first-party verdict (provenanceOf; the provisional writer stores it).
  const ALLOWED = new Set(["memory/provisional-write.mjs", "memory/review-service.mjs", "memory/trust.mjs", "memory/episodic.mjs", "memory/sqlite.mjs", "memory/capture-prompt.mjs", "hooks/remember.mjs", "memory/checklist-rows.mjs"]);
  // checklist-rows.mjs only labels rows by provenance ("you typed", "you ran remember"); it writes none.
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    if (ALLOWED.has(rel)) continue;
    assert.doesNotMatch(readFileSync(file, "utf8"), /["'`]user-(?:prompt|cli)["'`]/, `${rel} names a proven provenance`);
  }
});

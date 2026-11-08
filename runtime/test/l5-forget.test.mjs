// L5 P3 (design decision 12): forget and restore, by who asks.
//   - first-party prompt or the CLI with the token: hides the user's own unaccepted notes;
//   - a typed prompt no host can prove: only marks the user's notes (they stay as they are);
//   - the CLI without the token: refused on the user's notes, asks to forget an accepted one;
//   - nothing short of first-party or the token hides, purges, unrecalls or pauses anything
//     accepted; a prompt's hide of the user's note is never purged before review showed it.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = mkdtempSync(path.join(tmpdir(), "ad-l5-forget-"));
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
for (const k of ["AD_ROOT", "AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL"]) delete process.env[k];

const { open } = await import("../src/memory/sqlite.mjs");
const trust = await import("../src/memory/trust.mjs");
const svc = await import("../src/memory/review-service.mjs");
const mode = await import("../src/memory/review-mode.mjs");
const F = await import("../src/memory/forget.mjs");
const { recordEvent, latestEvent } = await import("../src/memory/l5-tables.mjs");
const { retainNotes } = await import("../src/memory/purge.mjs");
const { promptSource } = await import("../src/hooks/prompt-source.mjs");
const { testReviewToken } = await import("../testkit/memory-trust.mjs");

after(() => rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const SLUG = "-work-shop-app";
const PID = "prj_shop0000000000000000";
const KEYS = [SLUG, PID];
const DAY = 86_400_000;
let n = 0;
async function store() {
  const dir = path.join(ROOT, `db-${++n}`);
  mkdirSync(dir, { recursive: true });
  return open({ dbPath: path.join(dir, "episodic.db") });
}
function note(h, text, { status = "pending", accepted = false, slug = SLUG, pid = PID, origin = "agent", provenance = null, captureRef = null, appliedTo = null, reason = null } = {}) {
  const id = Number(h.run(
    "INSERT INTO learnings (project_slug, project_id, category, text, confidence, status, content_hash, origin, provenance, capture_ref, applied_to, quarantine_reason) VALUES (?, ?, 'correction', ?, 0.8, ?, ?, ?, ?, ?, ?, ?)",
    [slug, pid, text, status, `h-${n}-${text}`, origin, provenance, captureRef, appliedTo, reason]
  ).lastInsertRowid);
  if (accepted) svc.acceptLearning(h, testReviewToken(), id);
  return id;
}
const row = (h, id) => h.get("SELECT * FROM learnings WHERE id = ?", [id]);
const LIST = [{ host: "claude", signal: "source-user", minVersion: "2.1.400", parentExe: /\/claude\/versions\// }];
const firstParty = (prompt) => promptSource({ prompt, source: "user" }, { host: "claude", env: {}, scheduled: [], list: LIST, parent: () => ({ ok: true, version: "2.1.400" }) });
const typed = (prompt = "/agent-daemon-memory:forget 1") => promptSource({ prompt, source: "user" }, { host: "claude", env: {}, scheduled: [] });
const forget = (h, id, asker, extra = {}) => F.forgetLearning(h, { ref: { id }, asker, keys: KEYS, ...extra });
const restore = (h, id, asker, extra = {}) => F.restoreLearning(h, { ref: { id }, asker, keys: KEYS, ...extra });
const inRecall = (h, id) => Boolean(h.get(`SELECT 1 AS ok FROM learnings WHERE id = ? AND ${trust.recallSql()}`, [id]));
const inGuards = (h, id) => Boolean(h.get(`SELECT 1 AS ok FROM learnings WHERE id = ? AND ${trust.guardSourceSql()}`, [id]));

test("parseRef: #12, 12, L12 and last; anything else is no ref", () => {
  assert.deepEqual(F.parseRef("#12"), { id: 12 });
  assert.deepEqual(F.parseRef(" 12 "), { id: 12 });
  assert.deepEqual(F.parseRef("L12"), { id: 12 });
  assert.deepEqual(F.parseRef("last"), { last: true });
  for (const bad of ["", "0", "-3", "12a", "#", "twelve", "12 13", "1".repeat(20)]) assert.equal(F.parseRef(bad), null, bad);
});

test("askerOf: never stronger than what the caller holds", () => {
  assert.equal(F.askerOf({ cli: true, token: testReviewToken() }), "cli-token");
  assert.equal(F.askerOf({ cli: true, token: { issuedAt: 1 } }), "agent", "a home-made token");
  assert.equal(F.askerOf({ cli: true }), "agent");
  assert.equal(F.askerOf({ source: firstParty("/x:forget 3") }), "first-party");
  assert.equal(F.askerOf({ source: { typed: true, firstParty: true, why: "typed" } }), "typed", "a home-made verdict is only typed");
  assert.equal(F.askerOf({ source: typed() }), "typed");
  assert.equal(F.askerOf({ source: { typed: false, why: "headless" } }), null);
  assert.equal(F.askerOf({ source: { typed: true, why: "headless" } }), null);
});

test("first-party prompt: hides the user's own and the agent's unaccepted notes; an accepted one is only pointed to the terminal", async () => {
  const h = await store();
  const own = note(h, "use tabs in go", { origin: "user", provenance: "prompt" });
  const ownProv = note(h, "use pnpm", { origin: "user", provenance: "user-prompt", status: "provisional" });
  const agent = note(h, "agent note");
  const acc = note(h, "accepted one", { origin: "user", accepted: true });
  const v = (id) => ({ asker: "first-party", verdict: firstParty(`/x:forget ${id}`) });
  assert.equal((await forget(h, own, "first-party", v(own))).status, "hidden");
  assert.equal(row(h, own).status, "hidden");
  assert.equal(row(h, own).status_at, null, "a prompt's hide of the user's note waits for review to show it");
  assert.equal(latestEvent(h, "hidden", own).actor, "user");
  assert.equal(latestEvent(h, "hidden", own).detail.from, "pending");
  assert.equal((await forget(h, ownProv, "first-party", v(ownProv))).status, "hidden");
  assert.equal(latestEvent(h, "hidden", ownProv).detail.from, "provisional");
  assert.equal((await forget(h, agent, "first-party", v(agent))).status, "hidden");
  assert.ok(row(h, agent).status_at, "the agent's note starts its 7 days");
  const r = await forget(h, acc, "first-party", v(acc));
  assert.equal(r.status, "in-use");
  assert.equal(row(h, acc).status, "active");
  assert.ok(inRecall(h, acc) && inGuards(h, acc));
});

test("a typed prompt no host can prove: the user's note stays (provisional stays in use), marked; the agent's is hidden; accepted unchanged", async () => {
  const h = await store();
  const own = note(h, "use tabs in go", { origin: "user", provenance: "prompt" });
  const ownProv = note(h, "use pnpm", { origin: "user", provenance: "user-prompt", status: "provisional" });
  const agent = note(h, "agent note");
  const acc = note(h, "accepted one", { origin: "user", accepted: true });
  const r1 = await forget(h, own, "typed");
  assert.deepEqual([r1.status, r1.was], ["marked", "pending"]);
  assert.equal(row(h, own).status, "pending");
  assert.equal(latestEvent(h, "marked", own).actor, "user");
  const r2 = await forget(h, ownProv, "typed");
  assert.deepEqual([r2.status, r2.was], ["marked", "provisional"]);
  assert.equal(row(h, ownProv).status, "provisional");
  assert.ok(inRecall(h, ownProv), "still in use until the user decides");
  assert.equal((await forget(h, agent, "typed")).status, "hidden");
  assert.equal((await forget(h, acc, "typed")).status, "in-use");
  assert.equal(row(h, acc).status, "active");
});

test("a named asker is checked: first-party without a minted verdict marks, cli-token without an issued token is the agent", async () => {
  const h = await store();
  const own = note(h, "use tabs in go", { origin: "user", provenance: "prompt" });
  const acc = note(h, "accepted one", { origin: "user", accepted: true });
  assert.equal((await forget(h, own, "first-party", { verdict: { typed: true, firstParty: true } })).status, "marked");
  assert.equal((await forget(h, own, "first-party")).status, "marked");
  assert.equal(row(h, own).status, "pending");
  const r = await forget(h, acc, "cli-token", { token: { issuedAt: Date.now() }, confirm: () => true });
  assert.equal(r.status, "forget-requested", "no issued token: only a request");
  assert.ok(row(h, acc), "never purged");
  assert.equal((await forget(h, own, "admin")).status, "none");
});

test("the CLI without the token (a model-initiated forget): refused on the user's notes; accepted notes are only asked about — still recalled, still guarded, never purged", async () => {
  const h = await store();
  const own = note(h, "use tabs in go", { origin: "user", provenance: "prompt" });
  const said = note(h, "agent note the user also said");
  recordEvent(h, { kind: "captured", learningId: said, projectId: PID, actor: "user" });
  const agent = note(h, "agent note");
  const acc = note(h, "accepted one", { origin: "user", accepted: true });
  const accAgent = note(h, "accepted agent one", { accepted: true });
  assert.equal((await forget(h, own, "agent")).status, "refused-own");
  assert.equal(row(h, own).status, "pending");
  assert.equal((await forget(h, said, "agent")).status, "refused-own", "a typed prompt said it too (decision 15)");
  assert.equal((await forget(h, agent, "agent")).status, "hidden");
  assert.equal(latestEvent(h, "hidden", agent).actor, "agent");
  for (const id of [acc, accAgent]) {
    const r = await forget(h, id, "agent", { confirm: () => true });
    assert.equal(r.status, "forget-requested");
    assert.equal(row(h, id).status, "forget-requested");
    assert.ok(inRecall(h, id), "still recalled");
    assert.ok(inGuards(h, id), "its rules still enforced");
    assert.equal(latestEvent(h, "forget-requested", id).actor, "agent");
  }
  retainNotes(h, { now: Date.now() + 400 * DAY });
  assert.ok(row(h, acc) && row(h, accAgent), "retention never purges an accepted note");
  assert.equal(row(h, acc).status, "forget-requested");
});

test("the CLI with the token: hides the user's notes (clock starts), forgets an accepted note only with its number typed back", async () => {
  const h = await store();
  const token = testReviewToken();
  const own = note(h, "use tabs in go", { origin: "user", provenance: "prompt" });
  const acc = note(h, "accepted one", { origin: "user", accepted: true });
  const r = await forget(h, own, "cli-token", { token });
  assert.equal(r.status, "hidden");
  assert.ok(row(h, own).status_at, "seen in the terminal: its 7 days start");
  assert.equal((await forget(h, acc, "cli-token", { token })).status, "not-confirmed", "no confirm: nothing");
  assert.equal((await forget(h, acc, "cli-token", { token, confirm: async () => false })).status, "not-confirmed");
  assert.equal(row(h, acc).status, "active");
  assert.equal((await forget(h, acc, "cli-token", { token, confirm: async () => true })).status, "forgotten");
  assert.equal(row(h, acc), undefined, "purged");
});

test("forget last: the newest capture from a typed prompt in this session and project, never the agent's", async () => {
  const h = await store();
  note(h, "older typed", { origin: "user", provenance: "prompt", captureRef: "s1" });
  const newest = note(h, "newest typed", { origin: "user", provenance: "prompt", captureRef: "s1" });
  note(h, "agent after it", { provenance: "agent", captureRef: "s1" });
  note(h, "other session", { origin: "user", provenance: "prompt", captureRef: "s2" });
  note(h, "other project", { origin: "user", provenance: "prompt", captureRef: "s1", slug: "-work-other", pid: "prj_other000000000000000" });
  const r = await F.forgetLearning(h, { ref: { last: true }, asker: "typed", keys: KEYS, sessionId: "s1" });
  assert.equal(r.id, newest);
  assert.equal(r.text, "newest typed", "the receipt shows the text, so a wrong target is visible");
  assert.equal((await F.forgetLearning(h, { ref: { last: true }, asker: "typed", keys: KEYS, sessionId: "s9" })).status, "nothing-last");
  assert.equal((await F.forgetLearning(h, { ref: { last: true }, asker: "typed", keys: KEYS })).status, "nothing-last");
});

test("refs: unknown, another project's, already removed, bad", async () => {
  const h = await store();
  const other = note(h, "theirs", { slug: "-work-other", pid: "prj_other000000000000000" });
  const r = await forget(h, other, "first-party");
  assert.deepEqual([r.status, r.project], ["other-project", "other"]);
  assert.equal(row(h, other).status, "pending", "another project's note is never touched");
  assert.equal((await forget(h, 99999, "typed")).status, "unknown");
  const a = note(h, "agent note");
  await forget(h, a, "typed");
  assert.equal((await forget(h, a, "typed")).status, "already-removed");
  assert.equal((await F.forgetLearning(h, { ref: null, asker: "typed", keys: KEYS })).status, "bad-ref");
  assert.deepEqual(Object.values(await forget(h, a, "typed", { keys: [] })).slice(0, 2), ["other-project", a], "no project here: it names where the note lives");
});

test("restore: any typed restore undoes a hide of the agent's note; back to waiting, never in use", async () => {
  const h = await store();
  const a = note(h, "agent note", { status: "provisional" });
  recordEvent(h, { kind: "provisional", learningId: a, projectId: PID, actor: "user" });
  await forget(h, a, "agent");
  const r = restore(h, a, "typed");
  assert.deepEqual([r.status, r.to], ["restored", "pending"]);
  assert.equal(row(h, a).status, "pending", "a non-first-party restore never makes a note provisional");
  const b = note(h, "agent note 2");
  await forget(h, b, "agent");
  assert.equal(restore(h, b, "agent").status, "restored", "the agent may undo its own hide (to pending)");
  const c = note(h, "agent note 3");
  await forget(h, c, "typed");
  assert.equal(restore(h, c, "agent").status, "removed-by-you", "the agent can't undo a typed hide");
});

test("restore of the user's own hide: only first-party, the token or the checklist", async () => {
  const h = await store();
  const own = note(h, "use tabs in go", { origin: "user", provenance: "prompt" });
  await forget(h, own, "first-party", { verdict: firstParty(`/x:forget ${own}`) });
  assert.equal(restore(h, own, "typed").status, "removed-by-you");
  assert.equal(restore(h, own, "agent").status, "removed-by-you");
  assert.equal(row(h, own).status, "hidden");
  const r = restore(h, own, "cli-token", { token: testReviewToken() });
  assert.deepEqual([r.status, r.to], ["restored", "pending"]);
  assert.equal(latestEvent(h, "restored", own).actor, "user");
});

test("a first-party restore brings a provisional note back in use, with its first clock (no renewal); strict, a pending past or 30 days over → pending", async () => {
  const h = await store();
  const now = new Date("2026-11-08T12:00:00.000Z");
  const mk = (text, daysAgo) => {
    const id = note(h, text, { origin: "user", provenance: "user-prompt", status: "provisional" });
    const at = new Date(now.getTime() - daysAgo * DAY).toISOString();
    h.run("UPDATE learnings SET status_at = ? WHERE id = ?", [at, id]);
    recordEvent(h, { kind: "provisional", learningId: id, projectId: PID, actor: "user", at: new Date(at) });
    return { id, at };
  };
  const p = mk("in use ten days", 10);
  await forget(h, p.id, "first-party", { verdict: firstParty(`/x:forget ${p.id}`), now });
  const r = restore(h, p.id, "first-party", { verdict: firstParty(`/x:restore ${p.id}`), now });
  assert.deepEqual([r.status, r.to], ["restored", "provisional"]);
  assert.equal(row(h, p.id).status_at, p.at, "the first provisional time is put back");
  // A verdict for another prompt (another id) vouches for nothing.
  const q = mk("in use five days", 5);
  await forget(h, q.id, "first-party", { verdict: firstParty(`/x:forget ${q.id}`), now });
  assert.equal(restore(h, q.id, "first-party", { verdict: firstParty("/x:restore 777777"), now }).to, "pending");
  const old = mk("in use 31 days", 31);
  await forget(h, old.id, "first-party", { verdict: firstParty(`/x:forget ${old.id}`), now });
  assert.equal(restore(h, old.id, "first-party", { verdict: firstParty(`/x:restore ${old.id}`), now }).to, "pending");
  const s = mk("strict one", 2);
  await forget(h, s.id, "first-party", { verdict: firstParty(`/x:forget ${s.id}`), now });
  mode.setReviewStrict(h, { now });
  assert.equal(restore(h, s.id, "first-party", { verdict: firstParty(`/x:restore ${s.id}`), now }).to, "pending", "strict mode");
});

test("restore: a flagged note comes back flagged; not removed, too old, unknown and other projects are answered", async () => {
  const h = await store();
  const q = note(h, "flagged agent note", { status: "quarantined", appliedTo: "quarantined", reason: "screen:instruction" });
  assert.equal((await forget(h, q, "typed")).status, "hidden");
  const r = restore(h, q, "typed");
  assert.deepEqual([r.status, r.to], ["restored", "quarantined"]);
  assert.equal(row(h, q).status, "quarantined");
  const live = note(h, "not removed");
  assert.equal(restore(h, live, "typed").status, "not-removed");
  const old = note(h, "old hide");
  await forget(h, old, "typed", { now: new Date(Date.now() - 8 * DAY) });
  assert.equal(restore(h, old, "typed").status, "gone");
  assert.equal(restore(h, 424242, "typed").status, "unknown");
  const other = note(h, "theirs", { slug: "-work-other", pid: "prj_other000000000000000" });
  assert.equal(restore(h, other, "typed").status, "other-project");
  assert.equal(F.restoreLearning(h, { ref: { last: true }, asker: "typed", keys: KEYS }).status, "bad-ref");
});

test("retention: a prompt's hide of the user's note is never purged before review showed it; other hides go after 7 days", async () => {
  const h = await store();
  const own = note(h, "use tabs in go", { origin: "user", provenance: "prompt" });
  const agent = note(h, "agent note");
  const past = new Date(Date.now() - 60 * DAY);
  await forget(h, own, "first-party", { verdict: firstParty(`/x:forget ${own}`), now: past });
  await forget(h, agent, "first-party", { verdict: firstParty(`/x:forget ${agent}`), now: past });
  retainNotes(h, { now: Date.now() });
  assert.equal(row(h, own)?.status, "hidden", "kept until shown");
  assert.equal(row(h, agent), undefined, "the agent's note is purged after 7 days");
});

test("the agent's hides and forget requests: told once, on the next typed prompt", async () => {
  const h = await store();
  const a = note(h, "note about retries");
  const acc = note(h, "accepted agent one", { accepted: true });
  await forget(h, a, "agent");
  assert.deepEqual(F.untoldAgentActions(h, { keys: KEYS }).map((x) => [x.id, x.kind]), [[a, "hidden"]]);
  assert.deepEqual(F.untoldAgentActions(h, { keys: KEYS }), [], "marked told");
  await forget(h, acc, "agent");
  const b = note(h, "another");
  await forget(h, b, "agent");
  const told = F.untoldAgentActions(h, { keys: KEYS });
  assert.equal(told.length, 2);
  assert.match(F.agentActionsLine(told, { product: "P", review: "r" }), /^P: The agent removed 1 learning and asked to forget 1 · see r$/);
  assert.match(F.agentActionsLine([{ id: 31, text: "note about retries", kind: "hidden" }], { product: "P", review: "r" }), /The agent removed #31 "note about retries" · restore it in r/);
  assert.equal(F.agentActionsLine([], { review: "r" }), null);
  // A user's own forget is not the agent's.
  const u = note(h, "user hides it");
  await forget(h, u, "typed");
  assert.deepEqual(F.untoldAgentActions(h, { keys: KEYS }), []);
});

test("receipts: every outcome has its line, neutralised and cut", () => {
  const o = { product: "P", forget: "/p:forget", restore: "/p:restore", review: "npx p review", terminalForget: (id) => `npx p forget ${id}` };
  const line = (r, verb = "forget") => F.commandReceipt(r, { ...o, verb });
  assert.equal(line({ status: "hidden", id: 12, text: "use tabs in Go" }), 'P: Removed #12 "use tabs in Go" (restore within 7 days: /p:restore 12)');
  assert.equal(line({ status: "in-use", id: 12 }), "P: #12 is in use; forget it in your own terminal: npx p forget 12");
  assert.match(line({ status: "marked", id: 12, was: "provisional" }), /#12 stays in use until you delete it/);
  assert.match(line({ status: "marked", id: 12, was: "pending" }), /#12 won't be used/);
  assert.equal(line({ status: "restored", id: 12, text: "x", to: "provisional" }, "restore"), 'P: Restored #12 "x" (in use again)');
  assert.equal(line({ status: "removed-by-you", id: 12 }, "restore"), "P: #12 was removed by you; restore it in npx p review");
  assert.match(line({ status: "gone", id: 12 }, "restore"), /restored for 7 days, and this one is older/);
  assert.equal(line({ status: "nothing-last" }), "P: Nothing to forget: no learning saved from your prompts in this session");
  assert.equal(line({ status: "unknown", id: 12 }), "P: No learning #12 here");
  assert.equal(line({ status: "other-project", id: 12, project: "api" }), "P: #12 belongs to api");
  assert.match(line({ status: "bad-ref" }), /followed by a learning's number \(#12\) or "last"/);
  const esc = line({ status: "hidden", id: 1, text: `a\u{1b}[2Jb\u{202E}c${"x".repeat(100)}` });
  assert.doesNotMatch(esc, /[\u{1b}\u{202E}]/u);
  assert.ok(esc.length < 140);
  assert.equal(line({ status: "none" }), null);
});

test("writeProvisional's restore: only a minted first-party verdict naming the id brings a note back in use", async () => {
  const { writeProvisional } = await import("../src/memory/provisional-write.mjs");
  const h = await store();
  const mk = (text) => {
    const id = note(h, text, { origin: "user", provenance: "user-prompt", status: "provisional" });
    recordEvent(h, { kind: "provisional", learningId: id, projectId: PID, actor: "user" });
    h.run("UPDATE learnings SET status = 'hidden', status_at = NULL WHERE id = ?", [id]);
    recordEvent(h, { kind: "hidden", learningId: id, projectId: PID, actor: "user", detail: { from: "provisional", owner: "user" } });
    return id;
  };
  const a = mk("typed restore");
  assert.equal(writeProvisional(h, typed(`/x:restore ${a}`), { id: a }, { restore: true }).status, "pending");
  const b = mk("home-made verdict");
  assert.equal(writeProvisional(h, { typed: true, firstParty: true }, { id: b }, { restore: true }).status, "pending");
  const c = mk("was pending");
  h.run("DELETE FROM events WHERE kind = 'hidden' AND learning_id = ?", [c]);
  recordEvent(h, { kind: "hidden", learningId: c, projectId: PID, actor: "user", detail: { from: "pending", owner: "user" } });
  assert.equal(writeProvisional(h, firstParty(`/x:restore ${c}`), { id: c }, { restore: true }).status, "pending", "it wasn't in use when hidden");
  const d = mk("first-party");
  assert.equal(writeProvisional(h, firstParty(`/x:restore ${d}`), { id: d }, { restore: true }).status, "provisional");
  assert.equal(writeProvisional(h, firstParty(`/x:restore ${d}`), { id: d }, { restore: true }).status, "provisional", "not hidden: unchanged");
});

test("a user's hide of the agent's note (first-party or the token) comes back only the same way; forget last's receipt names the note", async () => {
  const h = await store();
  const a = note(h, "agent note");
  await forget(h, a, "first-party", { verdict: firstParty(`/x:forget ${a}`) });
  assert.equal(restore(h, a, "typed").status, "removed-by-you");
  assert.equal(restore(h, a, "cli-token", { token: testReviewToken() }).status, "restored");
  const b = note(h, "agent note b");
  await forget(h, b, "typed");
  assert.equal(restore(h, b, "typed").status, "restored", "a typed hide of the agent's note: any typed restore");
  const o = { verb: "forget", product: "P", forget: "/p:forget", restore: "/p:restore", review: "r", terminalForget: (id) => `t ${id}` };
  assert.equal(F.commandReceipt({ status: "marked", id: 3, text: "use tabs", was: "pending", last: true }, o), 'P: #3 "use tabs" won\'t be used; delete it in your next review (it\'s listed under "You asked to remove")');
  assert.doesNotMatch(F.commandReceipt({ status: "hidden", id: 3, text: `a${String.fromCodePoint(0xe0041)}b` }, o), new RegExp(String.fromCodePoint(0xe0041), "u"), "tag characters neutralised");
});

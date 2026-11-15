// L8 P4 (design decisions 10–14): the report's week-by-week counters, the rule-events
// counts, the counts-only share link and the once-a-week session-start line.
//   captured / provisional / repeated = events of that kind; accepted = accepted_at by
//   the review service; recalled = distinct notes in injections; asked / stopped = the
//   rule-events log by project id; repeated only when an accepted note is captured again.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = mkdtempSync(path.join(tmpdir(), "ad-l8-weekly-"));
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
for (const k of ["AD_ROOT", "AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL"]) delete process.env[k];

const { open } = await import("../src/memory/sqlite.mjs");
const { recordEvent } = await import("../src/memory/l5-tables.mjs");
const W = await import("../src/memory/weekly.mjs");
const { testReviewToken } = await import("../testkit/memory-trust.mjs");
const svc = await import("../src/memory/review-service.mjs");

const opened = [];
after(() => {
  for (const h of opened) {
    try {
      h.close();
    } catch {
      // closed already
    }
  }
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const SLUG = "-work-shop-app";
const PID = "prj_shop0000000000000000";
const OTHER = "prj_other000000000000000";
const KEYS = [SLUG, PID];
// Wednesday 18 Nov 2026, ISO week 47 (Monday 16 Nov).
const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const at = (s) => new Date(Date.parse(s));
let n = 0;

async function store() {
  const dir = path.join(ROOT, `db-${++n}`);
  mkdirSync(dir, { recursive: true });
  const h = await open({ dbPath: path.join(dir, "episodic.db") });
  opened.push(h);
  return h;
}
function note(h, text, { pid = PID, slug = SLUG, status = "pending", created = "2026-11-11 09:00:00" } = {}) {
  return Number(h.run(
    "INSERT INTO learnings (project_slug, project_id, category, text, confidence, status, content_hash, created_at) VALUES (?, ?, 'correction', ?, 0.7, ?, ?, ?)",
    [slug, pid, text, status, `h-${text}`, created]
  ).lastInsertRowid);
}

test("ISO weeks: Monday 00:00 UTC, the week key, and the window list oldest first", () => {
  const w = W.isoWeek(NOW);
  assert.equal(w.key, "2026-W47");
  assert.equal(w.from, "2026-11-16T00:00:00.000Z");
  assert.equal(w.to, "2026-11-23T00:00:00.000Z");
  // A Sunday late evening is still the week that started six days before.
  assert.equal(W.isoWeek(Date.parse("2026-11-15T23:59:59.000Z")).key, "2026-W46");
  // Year edges: 1 Jan 2027 (a Friday) belongs to 2026-W53.
  assert.equal(W.isoWeek(Date.parse("2027-01-01T10:00:00.000Z")).key, "2026-W53");
  assert.equal(W.isoWeek(Date.parse("2025-12-29T10:00:00.000Z")).key, "2026-W01");
  assert.deepEqual(W.weekWindows(3, NOW).map((x) => x.key), ["2026-W45", "2026-W46", "2026-W47"]);
});

test("every counter lands in its week; other projects and other kinds never count", async () => {
  const h = await store();
  const a = note(h, "use pnpm, not npm");
  const b = note(h, "run the linter before commits");
  const c = note(h, "other project's note", { pid: OTHER, slug: "-other" });
  // W46: two captured, one provisional, one captured in another project.
  recordEvent(h, { kind: "captured", learningId: a, projectId: PID, actor: "user", at: at("2026-11-10T09:00:00Z") });
  recordEvent(h, { kind: "captured", learningId: b, projectId: PID, actor: "user", at: at("2026-11-11T09:00:00Z") });
  recordEvent(h, { kind: "provisional", learningId: b, projectId: PID, actor: "user", at: at("2026-11-11T09:00:01Z") });
  recordEvent(h, { kind: "captured", learningId: c, projectId: OTHER, actor: "user", at: at("2026-11-11T09:00:00Z") });
  // Kinds that are not counters.
  recordEvent(h, { kind: "hidden", learningId: a, projectId: PID, actor: "user", at: at("2026-11-12T09:00:00Z") });
  // W47: accepted by the review service; then captured again → repeated.
  svc.acceptLearning(h, testReviewToken(), a, { now: at("2026-11-16T08:00:00Z") });
  recordEvent(h, { kind: "repeated", learningId: a, projectId: PID, actor: "user", at: at("2026-11-17T08:00:00Z") });
  recordEvent(h, { kind: "repeated", learningId: a, projectId: PID, actor: "user", at: at("2026-11-18T08:00:00Z") });
  // Recalled: distinct notes per week, not deliveries.
  for (const ts of ["2026-11-16 10:00:00", "2026-11-17 10:00:00"]) h.run("INSERT INTO injections (ts, project_slug, learning_id, surface) VALUES (?, ?, ?, 'session-start')", [ts, SLUG, a]);
  h.run("INSERT INTO injections (ts, project_slug, learning_id, surface) VALUES ('2026-11-17 11:00:00', '-other', ?, 'session-start')", [c]);

  const weeks = W.weeklyCounts(h, { keys: KEYS, weeks: 2, now: NOW });
  assert.deepEqual(weeks.map((x) => x.week), ["2026-W46", "2026-W47"]);
  assert.deepEqual(
    weeks.map(({ captured, provisional, accepted, recalled, repeated }) => ({ captured, provisional, accepted, recalled, repeated })),
    [
      { captured: 2, provisional: 1, accepted: 0, recalled: 0, repeated: 0 },
      { captured: 0, provisional: 0, accepted: 1, recalled: 1, repeated: 2 },
    ]
  );
  // Every project: the other project's capture and recall count too.
  const all = W.weeklyCounts(h, { keys: null, weeks: 2, now: NOW });
  assert.equal(all[0].captured, 3);
  assert.equal(all[1].recalled, 2);
});

test("captured: new notes from every writer by creation time, and purged notes by their surviving event", async () => {
  const h = await store();
  // A writer that records no event (a digest, an import): its row counts in its week.
  note(h, "from a digest", { created: "2026-11-17 08:00:00" });
  // A note captured, hidden and purged: its captured event survives with learning_id nulled.
  const gone = note(h, "hidden and purged", { created: "2026-11-17 09:00:00" });
  recordEvent(h, { kind: "captured", learningId: gone, projectId: PID, actor: "user", at: at("2026-11-17T09:00:00Z") });
  // Said twice more while it waited: re-captures, not new notes.
  recordEvent(h, { kind: "captured", learningId: gone, projectId: PID, actor: "user", at: at("2026-11-17T10:00:00Z") });
  recordEvent(h, { kind: "captured", learningId: gone, projectId: PID, actor: "user", at: at("2026-11-17T11:00:00Z") });
  const { purgeLearnings } = await import("../src/memory/purge.mjs");
  purgeLearnings(h, [gone]);
  // Another project's purged capture never counts here.
  recordEvent(h, { kind: "captured", learningId: null, projectId: OTHER, actor: "user", at: at("2026-11-17T09:00:00Z") });
  const [w] = W.weeklyCounts(h, { keys: KEYS, weeks: 1, now: NOW });
  assert.equal(w.captured, 2);
});

test("repeat detection: a capture of an accepted note counts once per capture; an unaccepted one never", async () => {
  // Through the real capture core (captureNote): the same words again.
  const h = await store();
  const { captureNote } = await import("../src/memory/capture-prompt.mjs");
  const cap = (text, iso) => captureNote({ handle: h, text, kind: "correction", source: { typed: true }, projectSlug: SLUG, projectId: PID, now: at(iso) });
  const first = await cap("always run the migrations before the tests", "2026-11-16T09:00:00Z");
  assert.ok(first.id, `captured: ${JSON.stringify(first)}`);
  svc.acceptLearning(h, testReviewToken(), first.id, { now: at("2026-11-16T09:30:00Z") });
  const pend = await cap("never edit the generated client by hand", "2026-11-16T09:00:00Z");
  assert.ok(pend.id);
  // Said again: the accepted one repeats, the unaccepted one doesn't.
  assert.equal((await cap("always run the migrations before the tests", "2026-11-17T09:00:00Z")).status, "repeat");
  await cap("never edit the generated client by hand", "2026-11-17T09:00:00Z");
  const [w] = W.weeklyCounts(h, { keys: KEYS, weeks: 1, now: NOW });
  assert.equal(w.repeated, 1, `one repeat of the accepted note (#${pend.id} said again is not a repeat)`);
  // Captured counts new notes (rows), never a note said again.
  assert.equal(h.get("SELECT COUNT(*) AS n FROM learnings").n, 2);
});

test("a store without the events or injections table reads as zeros", async () => {
  const h = await store();
  h.run("DROP TABLE events");
  h.run("DROP TABLE injections");
  const [w] = W.weeklyCounts(h, { keys: KEYS, weeks: 1, now: NOW });
  assert.deepEqual({ ...w, week: undefined, from: undefined, to: undefined }, { week: undefined, from: undefined, to: undefined, captured: 0, provisional: 0, accepted: 0, recalled: 0, repeated: 0 });
});

test("rule events: asked and stopped per week for this project; allow-once passes are neither", () => {
  const ev = [
    { at: "2026-11-10T10:00:00.000Z", project: PID, decision: "asked", rules: [{ id: 1 }] },
    { at: "2026-11-10T11:00:00.000Z", project: PID, decision: "stopped", rules: [{ id: 2 }] },
    { at: "2026-11-17T10:00:00.000Z", project: PID, decision: "stopped", rules: [{ id: 2 }] },
    { at: "2026-11-17T10:01:00.000Z", project: PID, decision: "passed", rules: [{ id: 2 }] },
    { at: "2026-11-17T10:02:00.000Z", project: OTHER, decision: "asked", rules: [{ id: 3 }] },
    { at: "not a date", project: PID, decision: "asked" },
    null,
    "torn",
  ];
  assert.deepEqual(W.weeklyRuleCounts(ev, { projectId: PID, weeks: 2, now: NOW }).map(({ asked, stopped }) => ({ asked, stopped })), [
    { asked: 1, stopped: 1 },
    { asked: 0, stopped: 1 },
  ]);
  assert.deepEqual(W.weeklyRuleCounts(ev, { projectId: null, all: true, weeks: 1, now: NOW }).map(({ asked, stopped }) => ({ asked, stopped })), [{ asked: 1, stopped: 1 }]);
  // No project id (a folder ad doesn't know): nothing is this project's.
  assert.deepEqual(W.weeklyRuleCounts(ev, { projectId: null, weeks: 1, now: NOW }).map(({ asked, stopped }) => ({ asked, stopped })), [{ asked: 0, stopped: 0 }]);
});

test("the share link holds only counts: integers into a fixed template, canaries never appear", async () => {
  const CANARY = "zebra-canary-77";
  const weekly = [{ week: "2026-W47", captured: 3, provisional: 1, accepted: 2, recalled: 5, repeated: 1, asked: 2, stopped: 3, note: CANARY, project: CANARY }];
  // Non-integers and text in counter fields come out as 0.
  const hostile = [{ week: CANARY, captured: `${CANARY}`, provisional: -4, accepted: 1.5, recalled: Infinity, repeated: { toString: () => CANARY }, asked: NaN, stopped: "7" }];
  for (const [rows, expiring] of [[weekly, 2], [hostile, CANARY]]) {
    const url = W.shareLink(rows, { expiring });
    assert.ok(url.startsWith(`${W.DISCUSSIONS_URL}/new?`), url);
    assert.doesNotMatch(url, new RegExp(CANARY));
    const q = new URL(url).searchParams;
    assert.deepEqual([...q.keys()].sort(), ["body", "category", "title"]);
    assert.equal(q.get("category"), "weekly-numbers");
    // Strip the digits: what is left is exactly the template.
    assert.equal(q.get("body").replace(/\d+/g, "N"), W.shareTemplate().replace(/\{\w+\}/g, "N"));
    assert.equal(q.get("title").replace(/\d+/g, "N"), W.shareTitleTemplate().replace(/\{\w+\}/g, "N"));
  }
  const q = new URL(W.shareLink(hostile, { expiring: CANARY })).searchParams;
  assert.match(q.get("body"), /captured 0\b/);
});

test("the weekly line: last week's stopped, asked and repeated; zeros dropped; nothing when all are zero", () => {
  assert.equal(W.weeklyLineText({ stopped: 3, asked: 2, repeated: 1 }), "Last week: 3 stopped, 2 asked, 1 repeated");
  assert.equal(W.weeklyLineText({ stopped: 0, asked: 2, repeated: 0 }), "Last week: 2 asked");
  assert.equal(W.weeklyLineText({ stopped: 0, asked: 0, repeated: 0 }), null);
});

test("the weekly line shows once per ISO week per project, counting last week", async () => {
  const h = await store();
  const a = note(h, "use pnpm");
  recordEvent(h, { kind: "repeated", learningId: a, projectId: PID, actor: "user", at: at("2026-11-12T08:00:00Z") });
  const ruleEvents = [{ at: "2026-11-10T11:00:00.000Z", project: PID, decision: "stopped", rules: [{ id: 2 }] }];
  const first = W.weeklyLine(h, { keys: KEYS, projectId: PID, ruleEvents, now: NOW });
  assert.equal(first, "Last week: 1 stopped, 1 repeated");
  assert.equal(W.weeklyLine(h, { keys: KEYS, projectId: PID, ruleEvents, now: NOW + 3_600_000 }), null, "once a week");
  // Next week: last week (W47) had nothing → no line, and nothing is recorded as shown.
  assert.equal(W.weeklyLine(h, { keys: KEYS, projectId: PID, ruleEvents, now: NOW + 7 * 86_400_000 }), null);
  // Another project has its own week.
  assert.equal(W.weeklyLine(h, { keys: ["-other", OTHER], projectId: OTHER, ruleEvents: [{ at: "2026-11-10T11:00:00.000Z", project: OTHER, decision: "asked" }], now: NOW }), "Last week: 1 asked");
});

test("report --share-link prints only counts from a store full of canaries; report --json carries the weeks", async () => {
  const { reportCommand } = await import("../src/memory/report.mjs");
  const h = await store();
  const CANARY = "otter-canary-31";
  const id = note(h, `${CANARY} use pnpm in /home/${CANARY}/shop`, { slug: SLUG, created: "2026-11-17 08:00:00" });
  recordEvent(h, { kind: "captured", learningId: id, projectId: PID, actor: "user", detail: { host: CANARY }, at: at("2026-11-17T08:00:00Z") });
  const lines = [];
  const ruleEvents = [{ at: "2026-11-17T09:00:00.000Z", project: PID, decision: "stopped", rules: [{ id: 1, matched: CANARY }], call: `rm -rf /${CANARY}` }];
  assert.equal(await reportCommand({ handle: h, keys: KEYS, shareLink: true, ruleEvents, now: NOW, out: (l) => lines.push(l) }), 0);
  const text = lines.join("\n");
  assert.doesNotMatch(decodeURIComponent(text.replace(/\+/g, " ")), new RegExp(CANARY));
  const q = new URL(lines.at(-1)).searchParams;
  assert.match(q.get("body"), /corrections captured 1\b/);
  assert.match(q.get("body"), /rules stopped 1\b/);
  const json = [];
  await reportCommand({ handle: h, keys: KEYS, json: true, weeks: 2, ruleEvents, now: NOW, out: (l) => json.push(l) });
  const r = JSON.parse(json[0]);
  assert.deepEqual(r.weekly.map((w) => [w.week, w.captured, w.stopped]), [["2026-W46", 0, null], ["2026-W47", 1, 1]]);
});

test("report --purge: refused outside your own terminal; with the token and a typed y it removes the history rows", async () => {
  const { reportPurgeMain } = await import("../src/memory/report-purge.mjs");
  const reportCommand = (o) => reportPurgeMain(["--purge"], o);
  const h = await store();
  const { ensureProposalTables } = await import("../src/memory/proposal-tables.mjs");
  ensureProposalTables(h);
  h.run("INSERT INTO history_clusters (project_id, project_slug, cluster_id, member_hashes, count, sessions, hosts, first_ts, last_ts, imported_at) VALUES (?, ?, 'c1', '[]', 2, 2, '[]', '2026-11-01', '2026-11-02', '2026-11-03')", [PID, SLUG]);
  const pend = Number(h.run("INSERT INTO learnings (project_slug, project_id, category, text, confidence, status, content_hash, provenance) VALUES (?, ?, 'correction', 'from history', 0.5, 'pending', 'hh1', 'transcript')", [SLUG, PID]).lastInsertRowid);
  const out = [];
  const refused = await reportCommand({ handle: h, keys: KEYS, purge: true, token: async () => ({ refused: "the agent's shell" }), ask: async () => "y", out: (l) => out.push(l) });
  assert.equal(refused, 2);
  assert.ok(h.get("SELECT 1 AS x FROM learnings WHERE id = ?", [pend]));
  assert.equal(await reportCommand({ handle: h, keys: KEYS, purge: true, token: async () => ({ token: testReviewToken() }), ask: async () => "n", out: (l) => out.push(l) }), 1);
  assert.ok(h.get("SELECT 1 AS x FROM history_clusters"));
  assert.equal(await reportCommand({ handle: h, keys: KEYS, purge: true, token: async () => ({ token: testReviewToken() }), ask: async () => "y", out: (l) => out.push(l) }), 0);
  assert.equal(h.get("SELECT COUNT(*) AS n FROM history_clusters").n, 0);
  assert.equal(h.get("SELECT 1 AS x FROM learnings WHERE id = ?", [pend]), undefined);
  assert.match(out.at(-1), /Removed 1 history row and 1 note waiting for review\./);
  // Every project at once is never purged.
  assert.equal(await reportCommand({ handle: h, keys: null, purge: true, token: async () => ({ token: testReviewToken() }), ask: async () => "y", out: () => {} }), 1);
});

test("weeks before the rule-events log's first line show – for asked and stopped, never 0", async () => {
  const { memoryReport, renderReport } = await import("../src/memory/report.mjs");
  const h = await store();
  const ruleEvents = [{ at: "2026-11-17T09:00:00.000Z", project: PID, decision: "asked" }];
  const r = memoryReport(h, { keys: KEYS, weeks: 2, ruleEvents, now: NOW });
  assert.deepEqual(r.weekly.map((w) => [w.asked, w.stopped]), [[null, null], [1, 0]]);
  assert.match(renderReport(r), /–.*\n.*\(– : the rule events log keeps only its most recent entries\)/s);
  // No rule events at all: zeros (nothing was asked), not –.
  assert.deepEqual(memoryReport(h, { keys: KEYS, weeks: 1, ruleEvents: [], now: NOW }).weekly.map((w) => w.asked), [0]);
});

test("the weekly line reads the rule-events log only when it may show", async () => {
  const h = await store();
  let reads = 0;
  const ruleEvents = () => {
    reads++;
    return [{ at: "2026-11-10T11:00:00.000Z", project: PID, decision: "asked" }];
  };
  assert.equal(W.weeklyLine(h, { keys: KEYS, projectId: PID, ruleEvents, now: NOW }), "Last week: 1 asked");
  assert.equal(W.weeklyLine(h, { keys: KEYS, projectId: PID, ruleEvents, now: NOW }), null);
  assert.equal(reads, 1);
});

test("the doctor nudge: day 6 nothing, day 7 the feedback thread; epoch dates and no ledger ignored", async () => {
  const { feedbackNudge } = await import("../src/memory-install/feedback-nudge.mjs");
  const { writeFileSync } = await import("node:fs");
  const root = path.join(ROOT, "adroot");
  mkdirSync(path.join(root, "memory"), { recursive: true });
  assert.equal(feedbackNudge(root, { now: NOW }), null, "no ledger");
  const { ledgerPath } = await import("../src/memory-install/ledger.mjs");
  const write = (hosts) => writeFileSync(ledgerPath(root), JSON.stringify({ schemaVersion: 1, hosts }));
  write({ cursor: { driver: "cli", installedAt: "1970-01-01T00:00:00.000Z" } });
  assert.equal(feedbackNudge(root, { now: NOW }), null, "an epoch date is not an install");
  write({ cursor: { driver: "cli", installedAt: "2026-11-12T12:00:01.000Z" } });
  assert.equal(feedbackNudge(root, { now: NOW + 0 }), null, "6 days");
  assert.match(feedbackNudge(root, { now: Date.parse("2026-11-19T12:00:01.000Z") }), /github\.com\/pankaj-mahaur\/Agent-Daemon\/discussions/);
});

// L7 P5: report's rules section (D20, memory/rules-read.mjs), self-protection stops counted in
// the rule events, doctor's rules rows (D21, memory-install/doctor-rules.mjs) and the
// fail-closed row's rule count. Temp roots only. No output here names a lowering command (S4).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RR = await import("../src/memory/rules-read.mjs");
const { renderReport, reportCommand } = await import("../src/memory/report.mjs");
const { toolBefore } = await import("../src/hooks/tool-before.mjs");
const { readRuleEvents, ruleEventsPath } = await import("../src/hooks/rule-events.mjs");
const { rulesChecks } = await import("../src/memory-install/doctor-rules.mjs");
const { ruleCount } = await import("../src/hooks/hook-doctor.mjs");
const { writeGuards, activePath } = await import("../src/hooks/guards.mjs");
const W = await import("../src/memory-install/rule-switch.mjs");
const D = await import("../src/memory/launch/dists.mjs");

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const tmp = () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-l7p5-")));
  made.push(d);
  return d;
};
// Lowering verbs an agent's shell must never be shown (S4).
const LOWERING = /\brules\s+(rm|pause|resume|allow-once|add)\b|safety\s+off|config\s+review\s+auto|\buninstall\b/;
const NOW = Date.parse("2026-11-16T12:00:00Z");
const ago = (h) => new Date(NOW - h * 3_600_000).toISOString();
const R = (id, decision = "deny", extra = {}) => ({ id, decision, orphaned_at: null, ...extra });

test("rulesSection: stoppable vs reminded, asked/stopped/passes in the window and project, self-protection everywhere, pauses", () => {
  const events = [
    { at: ago(1), decision: "asked", project: "p1" },
    { at: ago(2), decision: "stopped", project: "p1" },
    { at: ago(3), decision: "stopped", project: "p2" },
    { at: ago(4), decision: "passed", project: "p1" },
    { at: ago(5), decision: "self-protect", outcome: "deny", class: "state" },
    { at: ago(6), decision: "self-protect", outcome: "ask", class: "host" },
    { at: ago(24 * 40), decision: "stopped", project: "p1" },
    { at: "garbled", decision: "stopped", project: "p1" },
    null,
  ];
  const paused = { all: null, projects: { p1: { at: ago(1), until: new Date(NOW + 3_600_000).toISOString() }, p2: { at: ago(9), until: ago(1) } } };
  // Two rules on learning 10, one on 11, a policy rule (no learning), an orphaned one.
  const rules = [R(1, "deny", { learning_id: 10 }), R(2, "ask", { learning_id: 10 }), R(3, "deny", { learning_id: 11 }), R(4, "ask", { learning_id: null, source: "policy" }), R(5, "deny", { learning_id: null, orphaned_at: ago(1) })];
  const s = RR.rulesSection({ rules, reminded: 5, events, paused, projectId: "p1", days: 30, now: NOW });
  assert.deepEqual({ ...s, paused: undefined }, { rules: 5, stop: 3, ask: 2, orphaned: 1, stoppable: 2, reminded: 5, paused: undefined, asked: 1, stopped: 1, passes: 1, selfProtect: { stopped: 1, asked: 1 } });
  assert.equal(s.paused.project, new Date(NOW + 3_600_000).toISOString());
  assert.equal(s.paused.all, false);
  const all = RR.rulesSection({ events, all: true, paused: { all: { at: ago(1), until: null }, projects: {} }, now: NOW });
  assert.equal(all.stopped, 2);
  assert.equal(all.paused.all, null, "until resumed");
  assert.equal(RR.rulesSection({ events, projectId: "p2", paused, now: NOW }).paused.project, false, "an ended pause is no pause");
  assert.equal(RR.rulesSection({ events, projectId: null, now: NOW }).asked, 0, "no project: only the all-projects view counts project events");
});

test("rulesLines: the copy line and its limits line, the counts, the pause; never a lowering command", () => {
  const s = RR.rulesSection({ rules: [R(1, "deny", { learning_id: 7 }), R(2, "ask", { learning_id: null, source: "policy" })], reminded: 3, events: [{ at: ago(1), decision: "self-protect", outcome: "deny" }], paused: { all: { at: ago(1), until: null }, projects: {} }, all: true, now: NOW });
  const text = RR.rulesLines(s).join("\n");
  assert.match(text, /Rules\s+2 \(stop 1, ask 1\)/);
  assert.match(text, /stoppable \/ reminded\s+1 \/ 3/);
  assert.match(text, /ad's own files guarded\s+1 stopped, 0 asked/);
  assert.match(text, /paused everywhere until you resume them/);
  assert.ok(text.includes(RR.RULES_COPY) && text.includes(RR.RULES_LIMITS));
  assert.match(RR.RULES_COPY, /asked about or stopped where the host can; other corrections are recalled and counted/);
  assert.doesNotMatch(text, LOWERING);
  assert.doesNotMatch(RR.rulesLines(s, { share: true }).join("\n"), /paused/, "the shared report says no pause");
});

test("report: the rules section from the store and the events log, this project or every project", async () => {
  const { open } = await import("../src/memory/sqlite.mjs");
  const dir = tmp();
  const h = await open({ dbPath: path.join(dir, "episodic.db") });
  try {
    h.run("INSERT INTO rules (learning_id, project_id, scope, kind, decision, pattern, reason, source, approved_at) VALUES (NULL, 'p1', 'project', 'command', 'deny', 'x', 'r', 'policy', ?)", [ago(1)]);
    const lines = [];
    const code = await reportCommand({ handle: h, keys: null, ruleEvents: [{ at: ago(1), decision: "stopped", project: "p1" }], out: (l) => lines.push(l), now: NOW });
    assert.equal(code, 0);
    const text = lines.join("\n");
    assert.match(text, /Rules\s+1 \(stop 1, ask 0\)/);
    assert.match(text, /asked \/ stopped\s+0 \/ 1/);
    assert.doesNotMatch(text, LOWERING);
    const json = [];
    await reportCommand({ handle: h, keys: null, json: true, ruleEvents: [], out: (l) => json.push(l), now: NOW });
    assert.equal(JSON.parse(json[0]).rules.rules, 1);
    // No rules and no events: no section.
    assert.doesNotMatch(renderReport({ ...JSON.parse(json[0]), rules: RR.rulesSection({}) }), /Rules\s/);
  } finally {
    h.close();
  }
});

test("a self-protection decision is counted in the rule events: its class and outcome, never the command", () => {
  const root = tmp();
  const input = { session_id: "s", cwd: "/w", permission_mode: "default", tool_name: "Bash", tool_input: { command: "rm -rf ~/.agent-daemon/secret-words" } };
  const out = toolBefore(input, { root, env: {}, host: "claude", platform: "linux", selfProtect: { decision: "deny", class: "state", why: "x" } });
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  const ev = readRuleEvents({ root });
  assert.equal(ev.length, 1);
  assert.deepEqual({ ...ev[0], at: undefined }, { at: undefined, decision: "self-protect", outcome: "deny", class: "state", host: "claude", mode: "default" });
  assert.doesNotMatch(fs.readFileSync(ruleEventsPath(root), "utf8"), /secret-words|rm -rf/);
  toolBefore(input, { root, env: {}, host: "codex", platform: "linux", selfProtect: { decision: "ask", class: "host", why: "x" } });
  assert.equal(readRuleEvents({ root })[1].outcome, "ask");
  // The log seam (tests, the gate) writes nowhere else.
  const seen = [];
  toolBefore(input, { root: tmp(), env: {}, host: "claude", platform: "linux", selfProtect: { decision: "deny", class: "verb", why: "x" }, log: (e) => seen.push(e) });
  assert.equal(seen[0].class, "verb");
});

test("hook-doctor's rule count: global and paused rules count (the check stays fail-closed through a pause)", () => {
  assert.equal(ruleCount({ projects: { a: { paused: { at: ago(1), until: null }, rules: [1, 2] }, b: { paused: false, rules: [3] } }, global: { rules: [4] } }), 4);
  assert.equal(ruleCount(null), 0);
});

test("doctor's rules rows: count and pauses, the store, the sentinel, the switch, the guard copy, Codex on Windows; no lowering command", async () => {
  const root = tmp();
  const ctx = { root, home: root, env: {}, platform: "linux" };
  const rows = async (o = {}) => Object.fromEntries((await rulesChecks(ctx, { now: NOW, openStore: async () => null, ...o })).map((r) => [r.code, r]));
  assert.equal((await rows())["rules.count"].note, "no rules");
  writeGuards({ projects: { p1: { roots: ["/w"], paused: { at: ago(1), until: new Date(NOW + 3_600_000).toISOString() }, rules: [{ id: 7, rule: { type: "literal", text: "x" } }] } }, global: { rules: [] }, ruleCount: 1 }, { root });
  let r = await rows();
  assert.match(r["rules.count"].note, /^1 rule, 0 in force; paused: 1 project \(until /);
  assert.equal(r["rules.sentinel"].ok, false, "rules but no sentinel");
  assert.equal(r["rules.guard"].ok, false, "rules but no guard copy");
  fs.writeFileSync(activePath(root), "1\n");
  // The store: rule 7 missing from it, then another store's id.
  const fake = (ids, storeId = null) => async () => ({ all: () => ids.map((id) => ({ id, orphaned_at: null })), get: () => (storeId ? { value: storeId } : undefined) });
  r = await rows({ openStore: fake([]) });
  assert.equal(r["rules.sentinel"].ok, true);
  assert.equal(r["rules.store"].ok, false);
  assert.match(r["rules.store"].note, /holds 1 rule the store doesn't have/);
  assert.equal((await rows({ openStore: fake([7]) }))["rules.store"].ok, true);
  // The switch record against the rules (a Claude Code entry in the ledger).
  const { openLedger2ForWrite, upsertItem, writeLedger2 } = await import("../src/memory-install/ledger2.mjs");
  const led = openLedger2ForWrite(root).ledger;
  upsertItem(led, { host: "claude-code", kind: "hook", file: path.join(root, "settings.json"), locator: { hostEvent: "PreToolUse", event: "tool.before", script: D.launcherFile(root) }, value: { command: "node" } });
  upsertItem(led, { host: "codex", kind: "hook", file: path.join(root, ".codex", "hooks.json"), locator: { hostEvent: "SessionStart", event: "session.start", script: D.launcherFile(root) }, value: { command: "node" } });
  await writeLedger2(root, led);
  assert.equal((await rows())["rules.switch"].ok, false, "no record while rules exist");
  fs.mkdirSync(path.dirname(W.switchPath(root)), { recursive: true });
  const rec = (o) => fs.writeFileSync(W.switchPath(root), JSON.stringify({ at: ago(1), active: true, readMatcher: false, pendingLower: false, ...o }));
  rec({});
  assert.match((await rows())["rules.switch"].note, /^fail-closed/);
  rec({ failed: true });
  assert.equal((await rows())["rules.switch"].ok, false);
  rec({ active: false });
  assert.equal((await rows())["rules.switch"].ok, false, "rules exist, recorded resting");
  // No rule left, still raised: fine, and it says the next review puts it back.
  writeGuards({ projects: {}, global: { rules: [] }, ruleCount: 0 }, { root });
  rec({ active: false, pendingLower: true });
  r = await rows();
  assert.equal(r["rules.switch"].ok, true);
  assert.match(r["rules.switch"].note, /next review in your own terminal/);
  // Codex on Windows without its entry, while rules exist.
  writeGuards({ projects: { p1: { roots: ["/w"], paused: false, rules: [{ id: 7, rule: { type: "literal", text: "x" } }] } }, global: { rules: [] }, ruleCount: 1 }, { root });
  r = await rows({ platform: "win32" });
  assert.equal(r["rules.codex-windows"].ok, false);
  assert.equal(r["rules.limits"].note, RR.RULES_LIMITS);
  for (const row of Object.values(r)) assert.doesNotMatch(row.note, LOWERING, row.code);
  // The guard copy's version, as recorded.
  D.writeGuard(root, { route: "clone", path: path.join(root, "ad-clone"), version: "9.9.9" });
  assert.match((await rows())["rules.guard"].note, /^9\.9\.9 from .* \(ad's clone\)$/);
});

test("session start, daily while rules are paused: this project's pause or every project's; no command", async () => {
  const { open } = await import("../src/memory/sqlite.mjs");
  const { pausedReminder } = await import("../src/memory/reminder.mjs");
  const { putSetting } = await import("../src/memory/l5-tables.mjs");
  const h = await open({ dbPath: path.join(tmp(), "episodic.db") });
  try {
    const now = new Date(NOW);
    assert.equal(pausedReminder(h, { projectId: "p1", now }), null, "nothing paused");
    putSetting(h, "rules_paused", JSON.stringify({ all: null, projects: { p1: { at: ago(1), until: new Date(NOW + 3_600_000).toISOString() } } }), { now });
    const line = pausedReminder(h, { projectId: "p1", product: "ad", now });
    assert.match(line, /^ad: your rules are paused in this project until .* \(self-protection still applies\)$/);
    assert.doesNotMatch(line, LOWERING);
    assert.equal(pausedReminder(h, { projectId: "p1", now: new Date(NOW + 60_000) }), null, "once a day");
    assert.equal(pausedReminder(h, { projectId: "p2", now: new Date(NOW + 120_000) }), null, "another project's live pause isn't this one's");
    assert.equal(pausedReminder(h, { projectId: "p2", now: new Date(NOW + 2 * 86_400_000) }), null, "another project's pause");
    assert.equal(pausedReminder(h, { projectId: "p1", now: new Date(NOW + 2 * 3_600_000) }), null, "the pause ended");
    putSetting(h, "rules_paused", JSON.stringify({ all: { at: ago(0.5), until: null }, projects: {} }), { now });
    assert.match(pausedReminder(h, { projectId: "p9", now: new Date(NOW + 120_000) }), /paused in every project until you resume them/, "a new pause is told at once");
  } finally {
    h.close();
  }
});

test("the rule step's line prompt: Ctrl-C answers \"\" (no, or no change) instead of ending the run", { timeout: 10_000 }, async () => {
  const { PassThrough } = await import("node:stream");
  const { rawInput } = await import("../src/memory/rule-step.mjs");
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdout.resume();
  const input = rawInput(stdin, stdout);
  const p = input.line("  pattern: ", "git push");
  setImmediate(() => stdin.write("\u0003"));
  assert.equal(await p, "");
  const q = input.line("  y/n ");
  setImmediate(() => stdin.write("y\r"));
  assert.equal(await q, "y");
});

test("self-protection: learnings export/import and report --purge are the review token's from the agent's shell (L8's second layer)", async () => {
  const SP = await import("../src/hooks/self-protect.mjs");
  const sp = (command) => SP.selfProtect({ tool_name: "Bash", tool_input: { command }, cwd: "/work/app", session_id: "s" }, { host: "claude", platform: "linux", home: "/home/dev", folders: ["/home/dev/.agent-daemon/memory", "/work/ad/runtime"] })?.decision ?? null;
  for (const c of ["ad learnings export x.json", "ad learnings import x.json", "ad learnings edit 3", "ad report --purge", "ad memory report --purge", "ad memory learnings import f.json"]) assert.equal(sp(c), "deny", c);
  for (const c of ["ad learnings list", "ad learnings show 3", "ad report", "ad report --weeks 4", "ad memory report"]) assert.equal(sp(c), null, c);
});

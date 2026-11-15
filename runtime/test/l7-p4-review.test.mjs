// L7 P4 (design D2, D4, D17–D18): the rule step at review and the removal confirmation.
//   - offers come only from accepted, active learnings (never provisional or pending), at most
//     3, just-accepted rows first; declined ones only after a repeat; deferred ones after 14
//     days, and never after two deferrals; a learning with a rule isn't offered again;
//   - defaults: ask, this project; `p` (all projects) and `b` (block) are explicit; `e` edits
//     the pattern; `n` records a decline, enter a deferral; a rule needs the token;
//   - the step runs with nothing else waiting, after the checklist (plain mode), never in
//     --accept-all; `a` in the checklist never turns a rule on;
//   - the preview: consent asked once and kept, no read without it, exact counts over fixture
//     transcripts, a 1.5 s cap;
//   - "also removes rule 7": a forget's rule ends only with the typed code;
//   - consolidate --apply-stale leaves rule-bearing learnings in place;
//   - validPattern refuses ad's entry points and protected paths.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFilesUnder } from "../testkit/open-files.mjs";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ad-l7p4-rev-"));
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
process.env.AD_ROOT = path.join(ROOT, ".agent-daemon");
for (const k of ["AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[k];

const { open } = await import("../src/memory/sqlite.mjs");
const svc = await import("../src/memory/review-service.mjs");
const rules = await import("../src/memory/rules-service.mjs");
const { ruleOffers, parsePatternText, patternText, proposalFor } = await import("../src/memory/rule-proposals.mjs");
const { ruleStep } = await import("../src/memory/rule-step.mjs");
const preview = await import("../src/memory/rule-preview.mjs");
const { reviewChecklist } = await import("../src/memory/review-checklist.mjs");
const { recordEvent } = await import("../src/memory/l5-tables.mjs");
const { testReviewToken } = await import("../testkit/memory-trust.mjs");

const opened = [];
after(async () => {
  for (const h of opened) {
    try {
      h.close();
    } catch {
      // closed already
    }
  }
  (await import("../src/memory/episodic.mjs")).closeDb();
  const left = await openFilesUnder(ROOT);
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  assert.deepEqual(left, []);
});

const SLUG = "-work-shop-app";
const PID = "prj_0000000000000000000000SHP1";
const KEYS = [SLUG, PID];
let n = 0;
async function store() {
  const dir = path.join(ROOT, `db-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  const h = await open({ dbPath: path.join(dir, "episodic.db") });
  opened.push(h);
  return { h, root: path.join(dir, "ad") };
}
function note(h, text, { status = "pending", accepted = false, provenance = "prompt", origin = "user" } = {}) {
  const id = Number(h.run(
    "INSERT INTO learnings (project_slug, project_id, category, text, confidence, status, content_hash, origin, provenance) VALUES (?, ?, 'correction', ?, 0.8, ?, ?, ?, ?)",
    [SLUG, PID, text, status, `h-${++n}-${text}`, origin, provenance]
  ).lastInsertRowid);
  if (accepted) svc.acceptLearning(h, testReviewToken(), id);
  return id;
}
const rulesOf = (h) => h.all("SELECT * FROM rules ORDER BY id").map((r) => ({ ...r, pattern: JSON.parse(r.pattern) }));
const eventsOf = (h, kind) => h.all("SELECT * FROM events WHERE kind = ? ORDER BY id", [kind]);
const asked = [];
const keys = (...answers) => {
  const q = [...answers];
  return { key: async () => q.shift() ?? "stop", line: async (question) => (asked.push(question), q.shift() ?? "") };
};
const step = (h, input, extra = {}) => {
  const lines = [];
  // The preview's consent question is its own test: answered "off" here unless asked to keep it unset.
  if (!extra.askConsent && preview.previewConsent(h) === null) preview.setPreviewConsent(h, "off");
  return ruleStep({ handle: h, token: testReviewToken(), keys: KEYS, projectId: PID, out: (l) => lines.push(l), input, ...extra }).then((r) => ({ ...r, out: lines.join("\n") }));
};

test("offers: accepted and active only, at most 3, just-accepted first; a learning with a rule isn't offered", async () => {
  const { h } = await store();
  note(h, "use pnpm, not npm"); // pending
  note(h, "never push to main", { status: "provisional" });
  const old1 = note(h, "never use yarn add", { accepted: true });
  const old2 = note(h, "don't edit migrations/ files", { accepted: true });
  const old3 = note(h, "never run docker system prune", { accepted: true });
  const fresh = note(h, "use pnpm, not npm please", { accepted: true });
  note(h, "keep functions short", { accepted: true }); // no rule in it
  const o = ruleOffers(h, { keys: KEYS, justAccepted: [fresh] });
  assert.equal(o.length, 3);
  assert.equal(o[0].learningId, fresh, "just accepted first");
  assert.ok(!o.some((x) => x.text === "use pnpm, not npm" || x.text === "never push to main"), "never a pending or provisional row");
  rules.addRule(h, testReviewToken(), { learningId: fresh, projectId: PID, kind: "command", pattern: o[0].pattern, reason: "x" });
  assert.ok(!ruleOffers(h, { keys: KEYS }).some((x) => x.learningId === fresh), "it has a rule now");
  assert.deepEqual(ruleOffers(h, { keys: ["-other"] }), [], "another project's learnings aren't offered here");
  const { h: h2 } = await store();
  note(h2, "use pnpm, not npm");
  note(h2, "never push to main", { status: "provisional" });
  note(h2, "keep functions short", { accepted: true });
  assert.deepEqual(ruleOffers(h2, { keys: KEYS }), [], "pending, provisional and not-a-rule learnings: no offer");
  const { h: h3 } = await store();
  const oldest = note(h3, "never use yarn add", { accepted: true });
  for (const t of ["use pnpm, not npm", "never run docker system prune", "don't edit migrations/ files"]) note(h3, t, { accepted: true });
  assert.equal(ruleOffers(h3, { keys: KEYS, justAccepted: [oldest] })[0].learningId, oldest, "just accepted first, even an older id");
  void old1;
  void old2;
  void old3;
});

test("declined: offered again only after a repeat; deferred: after 14 days, never after two deferrals", async () => {
  const { h } = await store();
  const a = note(h, "use pnpm, not npm", { accepted: true });
  const t = testReviewToken();
  const day = 86_400_000;
  const t0 = new Date("2026-11-01T00:00:00Z");
  rules.recordRuleAnswer(h, t, { learningId: a, projectId: PID, answer: "declined", now: t0 });
  assert.equal(ruleOffers(h, { keys: KEYS, now: new Date(t0.getTime() + 60 * day) }).length, 0, "declined");
  recordEvent(h, { kind: "repeated", learningId: a, projectId: PID, actor: "system", at: new Date(t0.getTime() + day) });
  assert.equal(ruleOffers(h, { keys: KEYS, now: new Date(t0.getTime() + 2 * day) }).length, 1, "repeated since the decline");

  const b = note(h, "never use yarn add", { accepted: true });
  h.run("DELETE FROM events WHERE learning_id = ?", [a]);
  rules.recordRuleAnswer(h, t, { learningId: a, projectId: PID, answer: "declined", now: t0 });
  rules.recordRuleAnswer(h, t, { learningId: b, projectId: PID, answer: "deferred", now: t0 });
  assert.equal(ruleOffers(h, { keys: KEYS, now: new Date(t0.getTime() + 13 * day) }).length, 0, "deferred under 14 days");
  assert.equal(ruleOffers(h, { keys: KEYS, now: new Date(t0.getTime() + 15 * day) }).length, 1, "after 14 days");
  rules.recordRuleAnswer(h, t, { learningId: b, projectId: PID, answer: "deferred", now: new Date(t0.getTime() + 15 * day) });
  assert.equal(ruleOffers(h, { keys: KEYS, now: new Date(t0.getTime() + 90 * day) }).length, 0, "two deferrals: only `rules add`");
  assert.throws(() => rules.recordRuleAnswer(h, null, { learningId: b, answer: "declined" }), /review token/);
});

test("the step: r adds ask + this project by default; p and b are explicit toggles", async () => {
  const { h } = await store();
  const a = note(h, "use pnpm, not npm", { accepted: true });
  const r = await step(h, keys("r"), { read: null });
  assert.equal(r.added.length, 1);
  const [rule] = rulesOf(h);
  assert.equal(rule.decision, "ask", "ask by default");
  assert.equal(rule.scope, "project", "this project by default");
  assert.equal(rule.learning_id, a);
  assert.match(r.out, /#\d+ "use pnpm, not npm"\n {2}rule: npm install\|i\|in[^\n]*asks in Claude Code, stops in Codex {2}· {2}this project/);
  assert.match(r.out, /r make it a rule · e edit · p all projects · b block instead of ask · n never · enter later/);
  assert.match(r.out, /File rules see edits made with the agent's file tools, not shell redirects/);

  const b = note(h, "never use yarn add", { accepted: true });
  const r2 = await step(h, keys("p", "b", "r"));
  assert.equal(r2.added.length, 1);
  const rule2 = rulesOf(h).find((x) => x.learning_id === b);
  assert.equal(rule2.scope, "all");
  assert.equal(rule2.decision, "deny");
  const c = note(h, "never run docker system prune", { accepted: true });
  await step(h, keys("pb", "pb", "r"));
  const rule3 = rulesOf(h).find((x) => x.learning_id === c);
  assert.equal(rule3.scope, "project", "toggled twice");
  assert.equal(rule3.decision, "ask");
});

test("the step: e edits the pattern (validated), n declines, enter defers, a bad token adds nothing", async () => {
  const { h } = await store();
  const a = note(h, "use pnpm, not npm", { accepted: true });
  const r = await step(h, keys("e", "ad rules pause", "e", "npm install|ci on main", "r"));
  assert.match(r.out, /not changed: a rule can't name ad's own commands/);
  const [rule] = rulesOf(h);
  assert.deepEqual(rule.pattern, { type: "command", program: "npm", subcommands: ["install", "ci"], flags: null, branches: ["main"] });
  assert.equal(rule.learning_id, a);

  const { h: h2 } = await store();
  const x = note(h2, "use pnpm, not npm", { accepted: true });
  const y = note(h2, "never use yarn add", { accepted: true });
  const r2 = await step(h2, keys("n", ""));
  assert.equal(r2.declined.length, 1);
  assert.equal(r2.deferred.length, 1);
  assert.equal(eventsOf(h2, "rule-declined").length, 1);
  assert.equal(eventsOf(h2, "rule-deferred").length, 1, "enter defers; it never records a decline");
  assert.equal(rulesOf(h2).length, 0);
  assert.ok([x, y].includes(eventsOf(h2, "rule-deferred")[0].learning_id));

  const { h: h3 } = await store();
  note(h3, "use pnpm, not npm", { accepted: true });
  preview.setPreviewConsent(h3, "off");
  const lines = [];
  await ruleStep({ handle: h3, token: { fake: true }, keys: KEYS, out: (l) => lines.push(l), input: keys("r") });
  assert.equal(rulesOf(h3).length, 0, "no rule without the token");
  assert.match(lines.join("\n"), /not added: this needs a review token/);
});

test("pattern grammar round-trips", () => {
  for (const s of ["npm install|ci", "git push on main,release/2.0", "eslint --fix", "write src/generated/** dist/**"]) {
    const p = parsePatternText(s);
    assert.ok(!p.error, `${s}: ${p.error}`);
    assert.equal(patternText(p.kind, p.pattern), s.replace(" on main,release/2.0", " on main,release/2.0"));
  }
  assert.match(parsePatternText("write").error, /at least one/);
  assert.match(parsePatternText("git push on").error, /branches/);
  assert.match(parsePatternText("write .agent-daemon/**").error, /ad's own/);
  assert.match(parsePatternText("write /etc/passwd").error, /not a usable pattern/);
});

test("validPattern refuses ad's entry points and protected paths (rules list never prints a lowering command)", () => {
  const bad = [
    ["command", { type: "command", program: "ad", subcommands: ["rules"] }],
    ["command", { type: "command", program: "agent-daemon" }],
    ["command", { type: "command", program: "AD.cmd" }],
    ["command", { type: "command", program: "npx", subcommands: ["agent-daemon-memory@beta"] }],
    ["write", { type: "write", globs: [".agent-daemon/memory/**"] }],
    ["write", { type: "write", globs: [".claude/settings.json"] }],
    ["write", { type: "write", globs: [".codex/config.toml"] }],
    ["write", { type: "write", globs: ["x/guards.json"] }],
  ];
  for (const [k, p] of bad) assert.throws(() => rules.validPattern(k, p), /ad's own/, JSON.stringify(p));
  assert.ok(rules.validPattern("command", { type: "command", program: "npx", subcommands: ["prettier"] }));
  assert.ok(rules.validPattern("write", { type: "write", globs: ["src/claude/**"] }));
  assert.equal(proposalFor("never run `ad rules pause`"), null, "a learning about ad's commands proposes nothing");
});

// ---- preview -------------------------------------------------------------------------

function fixtureHistory() {
  const home = path.join(ROOT, `home-${++n}`);
  const proj = path.join(home, "work", "shop");
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
  const slug = proj.replace(/[\\/:._]/g, "-");
  const dir = path.join(home, ".claude", "projects", slug);
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const line = (cmd, ageDays, cwd = proj, i = 0) => JSON.stringify({ type: "assistant", cwd, timestamp: new Date(now - ageDays * 86_400_000).toISOString(), message: { content: [{ type: "tool_use", id: `t${ageDays}-${i}-${cmd.length}`, name: "Bash", input: { command: cmd } }] } });
  const lines = [line("npm install lodash", 1), line("npm ci", 2), line("npm install lodash", 3, proj, 1), line("pnpm install", 1), line("npm test", 1), line("npm install old", 40), line("npm install other-project", 1, path.join(home, "work", "other"))];
  fs.writeFileSync(path.join(dir, "s1.jsonl"), lines.join("\n") + "\n");
  const stale = path.join(dir, "old.jsonl");
  fs.writeFileSync(stale, line("npm install from-an-old-file", 1) + "\n");
  const t = (now - 45 * 86_400_000) / 1000;
  fs.utimesSync(stale, t, t);
  return { home, proj };
}

test("preview: exact counts over this project's last 30 days, files filtered by date first", async () => {
  const { home, proj } = fixtureHistory();
  const env = { HOME: home, USERPROFILE: home };
  const r = await preview.readPreviewCalls({ cwd: proj, env, home });
  const npm = proposalFor("use pnpm, not npm").pattern;
  const { previewCounts } = await import("../src/memory/rule-proposals.mjs");
  const c = previewCounts(npm, r.calls, { rootOf: () => r.root });
  assert.equal(c.count, 3, "two npm installs and an npm ci in the window; not the 40-day one, the other project's or the old file's");
  assert.deepEqual(c.examples, ["npm install lodash", "npm ci"]);
  // Through the worker, as review starts it.
  const read = preview.startPreviewRead({ cwd: proj, env, home });
  const got = await read.result;
  assert.equal(previewCounts(npm, got.calls, { rootOf: () => got.root }).count, 3);
});

test("preview consent: asked once in the step and kept; no read without it; the step waits at most 1.5 s", async () => {
  const { h } = await store();
  note(h, "use pnpm, not npm", { accepted: true });
  let started = 0;
  const startRead = () => {
    started++;
    return { result: new Promise(() => {}), stop() {} };
  };
  asked.length = 0;
  await step(h, keys("n", ""), { startRead, askConsent: true });
  assert.match(asked.join("\n"), /Show what each rule would have done[\s\S]*nothing is stored/);
  assert.equal(preview.previewConsent(h), "off");
  assert.equal(started, 0, "no consent: no read");

  const { h: h2 } = await store();
  note(h2, "use pnpm, not npm", { accepted: true });
  let t = 1_000_000;
  const clock = () => (t += 800); // each look at the clock: 0.8 s later
  const r2 = await step(h2, keys("y", ""), { startRead, now: clock, askConsent: true });
  assert.equal(preview.previewConsent(h2), "on", "kept");
  assert.equal(started, 1);
  assert.match(r2.out, /still reading your history/, "past the cap: not waited for");
  note(h2, "never use yarn add", { accepted: true });
  asked.length = 0;
  await step(h2, keys(""), { startRead, askConsent: true });
  assert.deepEqual(asked, [], "asked once");
  assert.throws(() => preview.setPreviewConsent(h2, "on", {}), /own terminal/);

  const { h: h3 } = await store();
  note(h3, "use pnpm, not npm", { accepted: true });
  preview.setPreviewConsent(h3, "on", { token: testReviewToken() });
  const ready = { result: Promise.resolve({ root: "/w", calls: [{ tool: "Bash", input: { command: "npm i x" }, os: "linux", cwd: "/w" }] }), stop() {} };
  const r4 = await step(h3, keys(""), { read: ready });
  assert.match(r4.out, /last 30 days here: would have stopped 1 command, e\.g\. npm i x/);
});

// ---- review wiring -------------------------------------------------------------------

function review(h, root, o = {}) {
  const lines = [];
  const answers = [...(o.answers ?? [])];
  return reviewChecklist({
    handle: h,
    keys: KEYS,
    cwd: ROOT,
    root,
    out: (l) => lines.push(l),
    ask: async () => answers.shift() ?? "",
    isTTY: () => true,
    env: {},
    gate: async () => ({ token: testReviewToken() }),
    stdin: { isTTY: false },
    stdout: { rows: 30, columns: 100, write() {} },
    home: ROOT,
    confirmCode: o.confirmCode,
    ...o.flags,
  }).then((code) => ({ code, out: lines.join("\n") }));
}

test("review: the step runs with nothing else waiting, after the checklist, never in --accept-all; `a` turns no rule on", async () => {
  const { h, root } = await store();
  preview.setPreviewConsent(h, "off");
  note(h, "use pnpm, not npm", { accepted: true });
  const r = await review(h, root, { answers: ["r"] });
  assert.equal(r.code, null, "then review goes on as before (proposal files): " + r.out);
  assert.equal(rulesOf(h).length, 1, "nothing waited; the step still offered");
  assert.ok(fs.existsSync(path.join(root, "guards.json")), "afterReview rebuilt the snapshot");

  const { h: h2, root: root2 } = await store();
  preview.setPreviewConsent(h2, "off");
  note(h2, "never use yarn add");
  const r2 = await review(h2, root2, { answers: ["a", "y", ""], flags: { plain: true } });
  assert.equal(r2.code, 0, r2.out);
  assert.equal(rulesOf(h2).length, 0, "accepting with a adds no rule; enter defers");
  assert.equal(eventsOf(h2, "rule-deferred").length, 1, "the step ran after the checklist");

  const { h: h3, root: root3 } = await store();
  preview.setPreviewConsent(h3, "off");
  note(h3, "never use yarn add");
  const r3 = await review(h3, root3, { answers: ["1", "r"], flags: { acceptAll: true } });
  assert.match(r3.out, /Accepted 1/);
  assert.equal(rulesOf(h3).length, 0);
  assert.doesNotMatch(r3.out, /make it a rule/, "never in --accept-all");
});

test("review: forgetting a learning with a rule asks 'also removes rule N'; only the code ends it", async () => {
  for (const ok of [false, true]) {
    const { h, root } = await store();
    preview.setPreviewConsent(h, "off");
    const a = note(h, "use pnpm, not npm", { accepted: true });
    const id = rules.addRule(h, testReviewToken(), { learningId: a, projectId: PID, kind: "command", pattern: proposalFor("use pnpm, not npm").pattern, reason: "use pnpm, not npm" });
    h.run("UPDATE learnings SET status = 'forget-requested' WHERE id = ?", [a]); // the agent asked; the user decides here
    const seen = [];
    const r = await review(h, root, { answers: ["x1", "y"], flags: { plain: true }, confirmCode: async ({ what }) => (seen.push(what), ok ? { ok: true } : { ok: false, text: "the code didn't match" }) });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`Forgetting #${a} also removes rule ${id} \\(asks before \`npm install`));
    assert.deepEqual(seen, [`Remove rule ${id}`]);
    assert.equal(rulesOf(h).length, ok ? 0 : 1, ok ? "confirmed: removed" : "not confirmed: kept (orphaned)");
    if (!ok) assert.match(r.out, /stays \(the code didn't match\)/);
  }
});

test("consolidate --apply-stale leaves rule-bearing learnings in place", async () => {
  const { h } = await store();
  const a = note(h, "use pnpm, not npm", { accepted: true });
  const b = note(h, "old stale note", { accepted: true });
  rules.addRule(h, testReviewToken(), { learningId: a, projectId: PID, kind: "command", pattern: proposalFor("use pnpm, not npm").pattern, reason: "x" });
  assert.equal(svc.archiveStale(h, testReviewToken(), [a, b]), 1);
  assert.equal(h.get("SELECT status FROM learnings WHERE id = ?", [a]).status, "active");
  assert.equal(h.get("SELECT status FROM learnings WHERE id = ?", [b]).status, "archived");
});

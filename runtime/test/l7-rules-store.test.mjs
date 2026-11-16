// L7 P1a (design D1–D4): the rules store, the review service's rule writes, and the
// guards.json snapshot projected from the store.
//   - only the review service (a token) writes rules, pause and resume; each write is an event;
//   - rules come only from accepted, active learnings; patterns are validated;
//   - maintainRules (token) moves a superseded learning's rules and ends archived ones;
//   - the rebuild projects the store and never drops a rule early: a quarantined or
//     forget-requested learning keeps its rule, a tokenless rebuild never drops a root;
//   - writeGuards keeps every field; guards.active exists while rules do;
//   - allow-once tokens and their markers outlive expiry by a grace period.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openFilesUnder } from "../testkit/open-files.mjs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = mkdtempSync(path.join(tmpdir(), "ad-l7-store-"));
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
for (const k of ["AD_ROOT", "AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL"]) delete process.env[k];

const { open } = await import("../src/memory/sqlite.mjs");
const svc = await import("../src/memory/review-service.mjs");
const rules = await import("../src/memory/rules-service.mjs");
const { buildSnapshot, rebuildGuards } = await import("../src/memory/guards-build.mjs");
const { loadGuards, writeGuards, guardsPath, lastGoodPath, ACTIVE_FILE } = await import("../src/hooks/guards.mjs");
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
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  assert.deepEqual(left, [], "every database is closed before the folder goes (Windows: EBUSY)");
});

const SLUG = "-work-shop-app";
const PID = "prj_0000000000000000000000SHP1";
const KEYS = [SLUG, PID];
let n = 0;
async function store() {
  const dir = path.join(ROOT, `db-${++n}`);
  mkdirSync(dir, { recursive: true });
  const h = await open({ dbPath: path.join(dir, "episodic.db") });
  opened.push(h);
  return h;
}
function note(h, text, { status = "pending", accepted = false, pid = PID } = {}) {
  const id = Number(h.run(
    "INSERT INTO learnings (project_slug, project_id, category, text, confidence, status, content_hash, origin) VALUES (?, ?, 'correction', ?, 0.8, ?, ?, 'user')",
    [SLUG, pid, text, status, `h-${++n}-${text}`]
  ).lastInsertRowid);
  if (accepted) svc.acceptLearning(h, testReviewToken(), id);
  return id;
}
const NPM = { type: "command", program: "npm", subcommands: ["install", "i", "ci", "add"], flags: null };
const GEN = { type: "write", globs: ["src/generated/**"] };
const realOf = (p) => realpathSync.native(p);
const rulesOf = (h) => h.all("SELECT * FROM rules ORDER BY id");
const eventsOf = (h, kind) => h.all("SELECT * FROM events WHERE kind = ? ORDER BY id", [kind]);
const rev = (h) => Number(h.get("SELECT value FROM memory_settings WHERE key = 'rules_rev'")?.value ?? 0);

function adRootDir() {
  const dir = path.join(ROOT, `root-${++n}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function registry(root, projects) {
  writeFileSync(path.join(root, "projects.json"), JSON.stringify({ schemaVersion: 1, revision: 1, projects: projects.map(([id, paths]) => ({ id, name: id, paths: paths.map((p) => ({ path: p })), aliases: { episodic: [], handoff: [] } })) }));
}

test("the rules table exists on open; deleting a learning orphans its rules; changes bump rules_rev", async () => {
  const h = await store();
  const id = note(h, "use pnpm, not npm", { accepted: true });
  const before = rev(h);
  const r = rules.addRule(h, testReviewToken(), { learningId: id, projectId: PID, kind: "command", pattern: NPM, reason: "use pnpm, not npm" });
  assert.ok(r > 0);
  assert.ok(rev(h) > before, "a new rule bumps rules_rev");
  const mid = rev(h);
  h.run("UPDATE learnings SET status = 'archived' WHERE id = ?", [id]);
  assert.ok(rev(h) > mid, "a learning's status change bumps rules_rev");
  h.run("DELETE FROM learnings WHERE id = ?", [id]);
  const [orphan] = rulesOf(h);
  assert.equal(orphan.id, r, "the rule outlives its learning until the user removes it");
  assert.equal(orphan.learning_id, null);
  assert.ok(orphan.orphaned_at);
  assert.match(String(h.get("SELECT value FROM memory_settings WHERE key = 'store_id'").value), /^[0-9a-f]{32}$/);
});

test("addRule needs the token and an accepted, active learning of this project", async () => {
  const h = await store();
  const acc = note(h, "never run npm install here", { accepted: true });
  const pend = note(h, "use tabs");
  const prov = note(h, "use spaces", { status: "provisional" });
  assert.throws(() => rules.addRule(h, null, { learningId: acc, projectId: PID, kind: "command", pattern: NPM, reason: "x" }), /token/);
  assert.throws(() => rules.addRule(h, {}, { learningId: acc, projectId: PID, kind: "command", pattern: NPM, reason: "x" }), /token/);
  for (const bad of [pend, prov]) assert.throws(() => rules.addRule(h, testReviewToken(), { learningId: bad, projectId: PID, kind: "command", pattern: NPM, reason: "x" }), /accepted/);
  assert.throws(() => rules.addRule(h, testReviewToken(), { learningId: acc, projectId: "prj_000000000000000000000000T2", kind: "command", pattern: NPM, reason: "x" }), /project/);
  svc.requestForget(h, acc, { keys: KEYS });
  assert.throws(() => rules.addRule(h, testReviewToken(), { learningId: acc, projectId: PID, kind: "command", pattern: NPM, reason: "x" }), /accepted/, "forget-requested: no new rule");
  assert.equal(rulesOf(h).length, 0);
});

test("addRule defaults to ask and this project, validates the pattern, and records rule-on", async () => {
  const h = await store();
  const id = note(h, "use pnpm, not npm", { accepted: true });
  const t = testReviewToken();
  const r = rules.addRule(h, t, { learningId: id, projectId: PID, kind: "command", pattern: NPM, reason: "use pnpm, not npm" });
  const row = rulesOf(h)[0];
  assert.equal(row.id, r);
  assert.equal(row.decision, "ask");
  assert.equal(row.scope, "project");
  assert.deepEqual(JSON.parse(row.pattern), NPM);
  assert.equal(eventsOf(h, "rule-on").length, 1);
  const bad = [
    ["command", { type: "command", program: "", subcommands: null, flags: null }],
    ["command", { type: "write", globs: ["x/**"] }],
    ["write", { type: "write", globs: [] }],
    ["write", { type: "write", globs: ["**"] }],
    ["write", { type: "write", globs: ["../outside/**"] }],
    ["write", { type: "write", globs: ["/etc/passwd"] }],
  ];
  for (const [kind, pattern] of bad) assert.throws(() => rules.addRule(h, t, { learningId: id, projectId: PID, kind, pattern, reason: "x" }), /pattern/, JSON.stringify(pattern));
  const all = rules.addRule(h, t, { learningId: id, projectId: PID, kind: "write", pattern: GEN, reason: "no generated edits", scope: "all", decision: "deny" });
  const g = rulesOf(h).find((x) => x.id === all);
  assert.equal(g.scope, "all");
  assert.equal(g.decision, "deny");
});

test("removeRule, pause and resume need the token and record events", async () => {
  const h = await store();
  const id = note(h, "use pnpm", { accepted: true });
  const t = testReviewToken();
  const r = rules.addRule(h, t, { learningId: id, projectId: PID, kind: "command", pattern: NPM, reason: "use pnpm" });
  assert.throws(() => rules.removeRule(h, null, r), /token/);
  assert.throws(() => rules.pauseRules(h, null, { projectId: PID }), /token/);
  const now = new Date("2026-11-08T10:00:00Z");
  rules.pauseRules(h, t, { projectId: PID, until: new Date("2026-11-08T11:00:00Z"), now });
  rules.pauseRules(h, t, { projectId: null, until: null, now });
  const p = rules.pausedState(h);
  assert.equal(p.projects[PID].until, "2026-11-08T11:00:00.000Z");
  assert.equal(p.all.until, null);
  rules.resumeRules(h, t, { projectId: null, now });
  assert.equal(rules.pausedState(h).all, null);
  assert.ok(rules.pausedState(h).projects[PID], "resuming all leaves a project's own pause");
  rules.resumeRules(h, t, { projectId: PID, now });
  assert.deepEqual(rules.pausedState(h).projects, {});
  assert.equal(eventsOf(h, "rules-paused").length, 2);
  assert.equal(eventsOf(h, "rules-resumed").length, 2);
  assert.equal(rules.removeRule(h, t, r), true);
  assert.equal(rulesOf(h).length, 0);
  assert.equal(eventsOf(h, "rule-off").length, 1);
});

test("maintainRules: a superseded learning's rule moves; archived or orphaned ends only when confirmed; quarantined stays", async () => {
  const h = await store();
  const t = testReviewToken();
  const a = note(h, "use pnpm", { accepted: true });
  const b = note(h, "use pnpm, never npm", { accepted: true });
  const c = note(h, "no generated edits", { accepted: true });
  const d = note(h, "no force push", { accepted: true });
  const ra = rules.addRule(h, t, { learningId: a, projectId: PID, kind: "command", pattern: NPM, reason: "use pnpm" });
  const rc = rules.addRule(h, t, { learningId: c, projectId: PID, kind: "write", pattern: GEN, reason: "gen" });
  const rd = rules.addRule(h, t, { learningId: d, projectId: PID, kind: "command", pattern: { type: "command", program: "git", subcommands: ["push"], flags: ["--force"] }, reason: "no force push" });
  h.run("UPDATE learnings SET status = 'superseded', superseded_by = ? WHERE id = ?", [b, a]);
  h.run("UPDATE learnings SET status = 'archived' WHERE id = ?", [c]);
  h.run("UPDATE learnings SET status = 'quarantined' WHERE id = ?", [d]);
  assert.throws(() => rules.maintainRules(h, null), /token/);
  const res = rules.maintainRules(h, t);
  assert.deepEqual(res, { moved: [ra], removed: [], pending: [rc] }, "unconfirmed: the archived learning's rule stays");
  assert.deepEqual(rules.rulesAwaitingRemoval(h).map((x) => [x.id, x.why]), [[rc, "archived"]]);
  const res2 = rules.maintainRules(h, t, { confirmed: [rc] });
  assert.deepEqual(res2.removed, [rc]);
  const left = rulesOf(h);
  assert.equal(left.find((x) => x.id === ra).learning_id, b);
  assert.ok(!left.some((x) => x.id === rc));
  assert.ok(left.some((x) => x.id === rd), "a quarantine is not the user's decision: the rule stays");
  h.run("DELETE FROM learnings WHERE id = ?", [d]);
  assert.deepEqual(rules.maintainRules(h, t).pending, [rd], "an orphaned rule waits for confirmation");
  assert.deepEqual(rules.maintainRules(h, t, { confirmed: [rd] }).removed, [rd]);
  assert.equal(eventsOf(h, "rule-off").length, 2);
});

test("buildSnapshot: project and global rules, roots with their real paths, counts, cmd", async () => {
  const h = await store();
  const t = testReviewToken();
  const root = adRootDir();
  const real = path.join(ROOT, `real-${++n}`);
  mkdirSync(real);
  const link = path.join(ROOT, `link-${n}`);
  symlinkSync(real, link, "junction");
  registry(root, [[PID, [link]]]);
  const a = note(h, "use pnpm", { accepted: true });
  const b = note(h, "no generated edits", { accepted: true });
  const c = note(h, "no force push", { accepted: true });
  rules.addRule(h, t, { learningId: a, projectId: PID, kind: "command", pattern: NPM, reason: "use pnpm" });
  rules.addRule(h, t, { learningId: b, projectId: PID, kind: "write", pattern: GEN, reason: "no generated edits", scope: "all" });
  rules.addRule(h, t, { learningId: c, projectId: PID, kind: "command", pattern: { type: "command", program: "git", subcommands: ["push"], flags: ["--force"] }, reason: "no force push", decision: "deny" });
  svc.requestForget(h, c, { keys: KEYS }); // forget-requested: still enforced (D40)
  const s = buildSnapshot(h, { root, now: new Date("2026-11-08T10:00:00Z"), cmd: "ad" });
  const p = s.projects[PID];
  assert.ok(p, "the project is in the snapshot");
  assert.ok(p.roots.includes(link) && p.roots.includes(realOf(real)), `roots: ${p.roots}`);
  assert.deepEqual(p.rules.map((r) => r.reason).sort(), ["no force push", "use pnpm"]);
  assert.equal(p.rules.find((r) => r.reason === "no force push").decision, "deny");
  assert.deepEqual(s.global.rules.map((r) => r.reason), ["no generated edits"]);
  assert.equal(s.ruleCount, 3);
  assert.equal(s.cmd, "ad");
  assert.equal(s.rules_rev, rev(h));
  const r0 = p.rules.find((r) => r.reason === "use pnpm");
  assert.deepEqual(r0.rule, NPM);
  assert.equal(r0.kind, "command");
});


test("buildSnapshot never emits a rule whose learning was never accepted, and keeps a quarantined one", async () => {
  const h = await store();
  const root = adRootDir();
  registry(root, [[PID, ["/work/shop/app"]]]);
  const a = note(h, "use pnpm", { accepted: true });
  const pend = note(h, "pending note");
  const quar = note(h, "quarantined later", { accepted: true });
  const t = testReviewToken();
  rules.addRule(h, t, { learningId: a, projectId: PID, kind: "command", pattern: NPM, reason: "use pnpm" });
  rules.addRule(h, t, { learningId: quar, projectId: PID, kind: "write", pattern: GEN, reason: "gen" });
  // A rule row on a never-accepted learning (data from elsewhere): never enforced.
  h.run("INSERT INTO rules (learning_id, project_id, scope, kind, decision, pattern, reason, approved_at) VALUES (?, ?, 'project', 'command', 'deny', ?, 'x', ?)", [pend, PID, JSON.stringify(NPM), new Date().toISOString()]);
  h.run("UPDATE learnings SET status = 'quarantined' WHERE id = ?", [quar]);
  const s = buildSnapshot(h, { root, now: new Date(), cmd: "ad" });
  assert.deepEqual(s.projects[PID].rules.map((r) => r.reason).sort(), ["gen", "use pnpm"]);
  assert.equal(s.ruleCount, 2);
});

test("pause and allow-once state carried into the snapshot; markers kept until expiry plus grace", async () => {
  const h = await store();
  const root = adRootDir();
  registry(root, [[PID, ["/work/shop/app"]]]);
  const t = testReviewToken();
  const a = note(h, "use pnpm", { accepted: true });
  rules.addRule(h, t, { learningId: a, projectId: PID, kind: "command", pattern: NPM, reason: "use pnpm" });
  const now = new Date("2026-11-08T10:00:00Z");
  rules.pauseRules(h, t, { projectId: PID, until: new Date("2026-11-08T11:00:00Z"), now });
  const consumed = path.join(root, "guards-consumed");
  mkdirSync(consumed, { recursive: true });
  const tok = (nonce, expires) => ({ callId: "abc123", rules: [1], project: PID, nonce, expires });
  const previous = {
    version: 1, generation: 3, projects: {}, global: { rules: [] }, ruleCount: 0,
    allowOnce: [tok("a".repeat(32), "2026-11-08T10:04:00Z"), tok("b".repeat(32), "2026-11-08T09:59:30Z"), tok("c".repeat(32), "2026-11-08T09:50:00Z")],
  };
  for (const x of ["a", "b", "c"]) writeFileSync(path.join(consumed, x.repeat(32)), "1");
  writeGuards(previous, { root });
  await rebuildGuards(h, { root, token: t, now, cmd: "ad", expected: { pause: true } });
  const s = loadGuards({ root }).snapshot;
  assert.deepEqual(s.projects[PID].paused, { at: now.toISOString(), until: "2026-11-08T11:00:00.000Z" });
  assert.deepEqual(s.allowOnce.map((x) => x.nonce[0]).sort(), ["a", "b"], "expired within the grace: kept");
  assert.ok(existsSync(path.join(consumed, "a".repeat(32))) && existsSync(path.join(consumed, "b".repeat(32))));
  assert.ok(!existsSync(path.join(consumed, "c".repeat(32))), "past expiry plus grace: the marker goes");
});

test("a rebuild without the token never drops a root the previous snapshot had; with it, it may", async () => {
  const h = await store();
  const root = adRootDir();
  const t = testReviewToken();
  const a = note(h, "use pnpm", { accepted: true });
  rules.addRule(h, t, { learningId: a, projectId: PID, kind: "command", pattern: NPM, reason: "use pnpm" });
  registry(root, [[PID, ["/work/shop/app", "/work/shop/app-wt"]]]);
  await rebuildGuards(h, { root, token: t, cmd: "ad" });
  registry(root, [[PID, ["/work/shop/app"]]]);
  await rebuildGuards(h, { root, cmd: "ad" });
  const wt = path.resolve("/work/shop/app-wt");
  assert.ok(loadGuards({ root }).snapshot.projects[PID].roots.includes(wt), "tokenless: the old root stays");
  await rebuildGuards(h, { root, token: t, cmd: "ad" });
  const after2 = loadGuards({ root }).snapshot.projects[PID].roots;
  assert.ok(after2.includes(path.resolve("/work/shop/app")) && !after2.includes(wt), "with the token: the registry decides");
});

test("guards.active exists while rules do; writeGuards keeps every field; no ruleCount with rules → last-good", async () => {
  const h = await store();
  const root = adRootDir();
  registry(root, [[PID, ["/work/shop/app"]]]);
  const t = testReviewToken();
  const a = note(h, "use pnpm", { accepted: true });
  const r = rules.addRule(h, t, { learningId: a, projectId: PID, kind: "command", pattern: NPM, reason: "use pnpm" });
  await rebuildGuards(h, { root, token: t, cmd: "npx -y agent-daemon-memory@3.1.0" });
  assert.ok(existsSync(path.join(root, ACTIVE_FILE)));
  const s = JSON.parse(readFileSync(guardsPath(root), "utf8"));
  for (const k of ["version", "generation", "updatedAt", "projects", "global", "allowOnce", "ruleCount", "rules_rev", "cmd"]) assert.ok(k in s, `${k} kept`);
  assert.equal(s.cmd, "npx -y agent-daemon-memory@3.1.0");
  rules.removeRule(h, t, r);
  await rebuildGuards(h, { root, token: t, cmd: "ad", expected: { rules: [r] } });
  assert.ok(!existsSync(path.join(root, ACTIVE_FILE)), "no rules: no sentinel");
  // A snapshot that holds rules but no count can't be trusted: the reader falls back.
  const good = JSON.parse(readFileSync(guardsPath(root), "utf8"));
  writeFileSync(lastGoodPath(root), JSON.stringify({ ...good, generation: 99 }));
  const broken = { ...good, projects: { [PID]: { roots: ["/x"], rules: [{ id: 1, kind: "command", decision: "ask", reason: "x", rule: NPM }] } } };
  delete broken.ruleCount;
  writeFileSync(guardsPath(root), JSON.stringify(broken));
  const loaded = loadGuards({ root });
  assert.equal(loaded.source, "last-good");
  assert.equal(loaded.snapshot.generation, 99);
});

test("two rebuilds at once both land, one after the other", async () => {
  const h = await store();
  const root = adRootDir();
  registry(root, [[PID, ["/work/shop/app"]]]);
  const t = testReviewToken();
  const a = note(h, "use pnpm", { accepted: true });
  rules.addRule(h, t, { learningId: a, projectId: PID, kind: "command", pattern: NPM, reason: "use pnpm" });
  const [g1, g2] = await Promise.all([rebuildGuards(h, { root, token: t, cmd: "ad" }), rebuildGuards(h, { root, token: t, cmd: "ad" })]);
  assert.notEqual(g1.generation, g2.generation);
  assert.equal(loadGuards({ root }).snapshot.generation, Math.max(g1.generation, g2.generation));
});

test("afterReview settles changed learnings' rules and rebuilds; nothing to do without rules", async () => {
  const { afterReview } = await import("../src/memory/rules-finish.mjs");
  const h = await store();
  const root = adRootDir();
  registry(root, [[PID, ["/work/shop/app"]]]);
  const t = testReviewToken();
  assert.equal(await afterReview(h, t, { root }), null, "no rules anywhere: nothing written");
  assert.ok(!existsSync(guardsPath(root)));
  const a = note(h, "no generated edits", { accepted: true });
  const r = rules.addRule(h, t, { learningId: a, projectId: PID, kind: "write", pattern: GEN, reason: "gen" });
  const first = await afterReview(h, t, { root });
  assert.equal(first.ruleCount, 1);
  h.run("UPDATE learnings SET status = 'archived' WHERE id = ?", [a]);
  const second = await afterReview(h, t, { root });
  assert.deepEqual(second.pending, [r], "not confirmed: still enforced");
  assert.equal(second.ruleCount, 1);
  const third = await afterReview(h, t, { root, confirmed: [r] });
  assert.deepEqual(third.removed, [r]);
  assert.equal(third.ruleCount, 0);
  assert.equal(loadGuards({ root }).snapshot.ruleCount, 0);
  assert.ok(!existsSync(path.join(root, ACTIVE_FILE)));
});

test("the detached refresh job rebuilds the snapshot from the store without a token", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const home = path.join(ROOT, `home-${++n}`);
  const root = path.join(home, ".agent-daemon");
  mkdirSync(root, { recursive: true });
  const h = await open({ dbPath: path.join(root, "episodic.db") });
  opened.push(h);
  registry(root, [[PID, ["/work/shop/app"]]]);
  const a = note(h, "use pnpm", { accepted: true });
  rules.addRule(h, testReviewToken(), { learningId: a, projectId: PID, kind: "command", pattern: NPM, reason: "use pnpm" });
  const other = await store(); // an empty store elsewhere: arguments and AD_MEMORY_DB never point the job at it
  const otherFile = other.get("PRAGMA database_list").file;
  const job = fileURLToPath(new URL("../src/memory/guards-refresh-job.mjs", import.meta.url));
  // AD_ROOT, AD_MEMORY_DB and arguments all point elsewhere: the job uses the root it was installed for.
  const elsewhere = adRootDir();
  // AD_ROOT naming another root: the job does nothing there and nothing here.
  const r0 = spawnSync(process.execPath, [job], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, AD_ROOT: elsewhere } });
  assert.equal(r0.status, 0, r0.stderr);
  assert.ok(!existsSync(guardsPath(root)) && !existsSync(guardsPath(elsewhere)));
  // AD_MEMORY_DB naming another store: refused, nothing written.
  const r1 = spawnSync(process.execPath, [job], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, AD_ROOT: root, AD_MEMORY_DB: otherFile } });
  assert.equal(r1.status, 0, r1.stderr);
  assert.ok(!existsSync(guardsPath(root)));
  // Arguments point elsewhere: ignored; the job uses ad's own store under its own root.
  const r = spawnSync(process.execPath, [job, otherFile, elsewhere], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, AD_ROOT: root } });
  assert.equal(r.status, 0, r.stderr);
  const s = loadGuards({ root }).snapshot;
  assert.equal(s.ruleCount, 1);
  assert.equal(s.rules_rev, rev(h));
});

test("S1: a tokenless rebuild is one-way: another store is refused, rules and pauses never dropped", async () => {
  const h = await store();
  const root = adRootDir();
  registry(root, [[PID, ["/work/shop/app"]]]);
  const t = testReviewToken();
  const a = note(h, "use pnpm", { accepted: true });
  const r = rules.addRule(h, t, { learningId: a, projectId: PID, kind: "command", pattern: NPM, reason: "use pnpm" });
  await rebuildGuards(h, { root, token: t, cmd: "ad" });
  const empty = await store();
  await assert.rejects(rebuildGuards(empty, { root }), /isn't the store/);
  assert.equal(loadGuards({ root }).snapshot.ruleCount, 1, "the refused rebuild left the snapshot alone");
  // A rule removed in the store without its own token rebuild: a tokenless one keeps enforcing it.
  rules.removeRule(h, t, r);
  await rebuildGuards(h, { root });
  assert.equal(loadGuards({ root }).snapshot.ruleCount, 1);
  assert.ok(existsSync(path.join(root, ACTIVE_FILE)));
  // A pause in the store that the snapshot never had isn't added without the token.
  rules.pauseRules(h, t, { projectId: null, until: null });
  await rebuildGuards(h, { root });
  assert.equal(loadGuards({ root }).snapshot.pausedAll, null);
  await assert.rejects(rebuildGuards(h, { root, addAllowOnce: [{ nonce: "d".repeat(32), expires: new Date(Date.now() + 60_000).toISOString() }] }), /token/);
  // With the token the store decides — for what this run says it changed.
  await rebuildGuards(h, { root, token: t, expected: { rules: [r], pause: true } });
  const s = loadGuards({ root }).snapshot;
  assert.equal(s.ruleCount, 0);
  assert.ok(s.pausedAll);
  assert.ok(!existsSync(path.join(root, ACTIVE_FILE)));
});

test("S1: an expired pause is dropped by a tokenless rebuild (raising), a live one kept", async () => {
  const h = await store();
  const root = adRootDir();
  registry(root, [[PID, ["/work/shop/app"]]]);
  const t = testReviewToken();
  const a = note(h, "use pnpm", { accepted: true });
  rules.addRule(h, t, { learningId: a, projectId: PID, kind: "command", pattern: NPM, reason: "use pnpm" });
  const at = new Date("2026-11-08T10:00:00Z");
  rules.pauseRules(h, t, { projectId: PID, until: new Date("2026-11-08T11:00:00Z"), now: at });
  await rebuildGuards(h, { root, token: t, now: at, expected: { pause: true } });
  await rebuildGuards(h, { root, now: new Date("2026-11-08T10:30:00Z") });
  assert.ok(loadGuards({ root }).snapshot.projects[PID].paused, "still paused");
  await rebuildGuards(h, { root, now: new Date("2026-11-08T11:30:00Z") });
  assert.equal(loadGuards({ root }).snapshot.projects[PID].paused, false, "the pause ended");
});

test("S1: a tokenless rebuild keeps a rule exactly as the snapshot had it and never lengthens a pause", async () => {
  const h = await store();
  const root = adRootDir();
  registry(root, [[PID, ["/work/shop/app"]]]);
  const t = testReviewToken();
  const a = note(h, "never force push", { accepted: true });
  const PUSH = { type: "command", program: "git", subcommands: ["push"], flags: ["--force", "-f"] };
  const r = rules.addRule(h, t, { learningId: a, projectId: PID, kind: "command", pattern: PUSH, reason: "never force push", decision: "deny", scope: "all" });
  const at = new Date("2026-11-08T10:00:00Z");
  rules.pauseRules(h, t, { projectId: PID, until: new Date("2026-11-08T11:00:00Z"), now: at });
  await rebuildGuards(h, { root, token: t, now: at, expected: { pause: true } });
  // The store changes behind the snapshot's back: laxer decision, narrower pattern, smaller scope, a longer pause.
  h.run("UPDATE rules SET decision = 'ask', scope = 'project', pattern = ? WHERE id = ?", [JSON.stringify({ ...PUSH, flags: ["--force-only"] }), r]);
  h.run("UPDATE memory_settings SET value = ? WHERE key = 'rules_paused'", [JSON.stringify({ all: { at: at.toISOString(), until: null }, projects: { [PID]: { at: at.toISOString(), until: null } } })]);
  await rebuildGuards(h, { root, now: new Date("2026-11-08T10:10:00Z") });
  const s = loadGuards({ root }).snapshot;
  const g = s.global.rules.find((x) => x.id === r);
  assert.ok(g, "still a global rule");
  assert.equal(g.decision, "deny");
  assert.deepEqual(g.rule, PUSH);
  assert.equal(s.pausedAll, null, "no pause the snapshot didn't have");
  assert.equal(s.projects[PID].paused.until, "2026-11-08T11:00:00.000Z", "never longer than before");
});

test("maintainRules moves a rule only to a successor the user accepted", async () => {
  const h = await store();
  const t = testReviewToken();
  const a = note(h, "use pnpm", { accepted: true });
  const twin = note(h, "use pnpm please"); // pending
  const r = rules.addRule(h, t, { learningId: a, projectId: PID, kind: "command", pattern: NPM, reason: "use pnpm" });
  h.run("UPDATE learnings SET status = 'superseded', superseded_by = ? WHERE id = ?", [twin, a]);
  assert.deepEqual(rules.maintainRules(h, t).moved, []);
  assert.equal(rulesOf(h).find((x) => x.id === r).learning_id, a, "kept on the superseded (ever-accepted) learning");
  const root = adRootDir();
  registry(root, [[PID, ["/work/shop/app"]]]);
  assert.equal(buildSnapshot(h, { root, token: t }).ruleCount, 1, "still enforced");
});

const { acquireLock } = await import("../src/lock.mjs");
const { validSnapshot, activePath, readActive } = await import("../src/hooks/guards.mjs");
const { ruleReason } = await import("../src/memory/rules-service.mjs");

test("rules_rev moves on rule updates and deletes, and on a rule's learning being superseded", async () => {
  const h = await store();
  const t = testReviewToken();
  const a = note(h, "use pnpm", { accepted: true });
  const b = note(h, "use pnpm always", { accepted: true });
  const other = note(h, "unrelated", { accepted: true });
  const r = rules.addRule(h, t, { learningId: a, projectId: PID, kind: "command", pattern: NPM, reason: "use pnpm" });
  let v = rev(h);
  h.run("UPDATE rules SET decision = 'deny' WHERE id = ?", [r]);
  assert.ok(rev(h) > v, "update");
  v = rev(h);
  h.run("UPDATE learnings SET superseded_by = ? WHERE id = ?", [b, a]);
  assert.ok(rev(h) > v, "superseded_by alone");
  v = rev(h);
  h.run("UPDATE learnings SET status = 'archived' WHERE id = ?", [other]);
  assert.equal(rev(h), v, "a learning with no rule doesn't move it");
  h.run("DELETE FROM rules WHERE id = ?", [r]);
  assert.ok(rev(h) > v, "delete");
});

test("an orphaned rule (its learning deleted) is still emitted, without the forgotten words", async () => {
  const h = await store();
  const root = adRootDir();
  registry(root, [[PID, ["/work/shop/app"]]]);
  const t = testReviewToken();
  const a = note(h, "never touch the secret billing table", { accepted: true });
  rules.addRule(h, t, { learningId: a, projectId: PID, kind: "write", pattern: GEN, reason: "never touch the secret billing table" });
  h.run("DELETE FROM learnings WHERE id = ?", [a]);
  const s = buildSnapshot(h, { root, token: t });
  assert.equal(s.ruleCount, 1);
  assert.doesNotMatch(s.projects[PID].rules[0].reason, /billing/);
});

test("the store id stays the same across opens", async () => {
  const dir = path.join(ROOT, `db-${++n}`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "episodic.db");
  const h1 = await open({ dbPath: file });
  const id1 = h1.get("SELECT value FROM memory_settings WHERE key = 'store_id'").value;
  h1.close();
  const h2 = await open({ dbPath: file });
  opened.push(h2);
  assert.equal(h2.get("SELECT value FROM memory_settings WHERE key = 'store_id'").value, id1);
});

test("S1: while rules exist, a tokenless rebuild refuses an unreadable snapshot or another store's sentinel", async () => {
  const h = await store();
  const root = adRootDir();
  registry(root, [[PID, ["/work/shop/app"]]]);
  const t = testReviewToken();
  const a = note(h, "use pnpm", { accepted: true });
  rules.addRule(h, t, { learningId: a, projectId: PID, kind: "command", pattern: NPM, reason: "use pnpm" });
  await rebuildGuards(h, { root, token: t });
  assert.match(String(readActive({ root }).store_id), /^[0-9a-f]{32}$/);
  writeFileSync(guardsPath(root), "{broken");
  writeFileSync(lastGoodPath(root), "{broken");
  const empty = await store();
  await assert.rejects(rebuildGuards(empty, { root }), /can't be read/);
  await assert.rejects(rebuildGuards(h, { root }), /can't be read/, "the same store too: no current snapshot to build on");
  await rebuildGuards(h, { root, token: t }); // the user's terminal can rebuild
  writeFileSync(activePath(root), JSON.stringify({ ruleCount: 1, store_id: "f".repeat(32) }));
  await assert.rejects(rebuildGuards(h, { root }), /isn't the store/);
});

test("a tokenless rebuild never removes the sentinel", async () => {
  const h = await store();
  const root = adRootDir();
  registry(root, [[PID, ["/work/shop/app"]]]);
  const t = testReviewToken();
  await rebuildGuards(h, { root, token: t }); // no rules: a valid empty snapshot
  writeFileSync(activePath(root), JSON.stringify({ ruleCount: 1, store_id: h.get("SELECT value FROM memory_settings WHERE key = 'store_id'").value }));
  await rebuildGuards(h, { root });
  assert.ok(existsSync(activePath(root)), "only a token run removes it");
});

test("a read error in the store is an error, never zero rules", async () => {
  const root = adRootDir();
  const broken = { all: () => { throw new Error("database disk image is malformed"); }, get: () => ({ value: "x" }) };
  assert.throws(() => buildSnapshot(broken, { root, token: testReviewToken() }), /malformed/);
});

test("the guards lock serialises rebuilds", async () => {
  const h = await store();
  const root = adRootDir();
  const release = acquireLock("guards", { dir: path.join(root, "locks") });
  try {
    await assert.rejects(rebuildGuards(h, { root, token: testReviewToken(), waitMs: 300 }), (e) => e.code === "LOCK_BUSY");
  } finally {
    release();
  }
});

test("S1: a tokenless new root may not nest inside another project's root", async () => {
  const h = await store();
  const root = adRootDir();
  const OTHER = "prj_000000000000000000000000T2";
  const t = testReviewToken();
  const a = note(h, "use pnpm", { accepted: true });
  const b = note(h, "no generated edits", { accepted: true, pid: OTHER });
  rules.addRule(h, t, { learningId: a, projectId: PID, kind: "command", pattern: NPM, reason: "use pnpm" });
  rules.addRule(h, t, { learningId: b, projectId: OTHER, kind: "write", pattern: GEN, reason: "gen" });
  registry(root, [[PID, ["/work/shop/app"]], [OTHER, ["/work/other"]]]);
  await rebuildGuards(h, { root, token: t });
  // The registry (no token needed) gives OTHER a folder inside PID's root.
  registry(root, [[PID, ["/work/shop/app"]], [OTHER, ["/work/other", "/work/shop/app/sub"]]]);
  await rebuildGuards(h, { root });
  assert.ok(!loadGuards({ root }).snapshot.projects[OTHER].roots.includes(path.resolve("/work/shop/app/sub")));
  await rebuildGuards(h, { root, token: t });
  assert.ok(loadGuards({ root }).snapshot.projects[OTHER].roots.includes(path.resolve("/work/shop/app/sub")), "the user's terminal decides");
});

test("validSnapshot: the count must match, pauses and tokens must be well formed", () => {
  const base = { version: 1, generation: 1, projects: { [PID]: { roots: ["/x"], paused: false, rules: [{ id: 1, kind: "command", decision: "ask", reason: "x", rule: NPM }] } } };
  assert.equal(validSnapshot(base), true, "an L2-era file (no L7 fields)");
  assert.equal(validSnapshot({ ...base, ruleCount: 0 }), false, "a count that disagrees");
  assert.equal(validSnapshot({ ...base, global: { rules: [] } }), false, "an L7 file without a count");
  assert.equal(validSnapshot({ ...base, global: { rules: [] }, ruleCount: 1 }), true);
  assert.equal(validSnapshot({ ...base, ruleCount: 1, pausedAll: "yes" }), false);
  assert.equal(validSnapshot({ ...base, ruleCount: 1, allowOnce: [{ nonce: "short" }] }), false);
  assert.equal(validSnapshot({ ...base, ruleCount: 1, projects: { [PID]: { ...base.projects[PID], paused: { at: "x", until: 5 } } } }), false);
});

test("writeGuards: a corrupt current file doesn't restart the generation", () => {
  const root = adRootDir();
  writeGuards({ projects: {} }, { root });
  writeGuards({ projects: {} }, { root });
  writeGuards({ projects: {} }, { root }); // current 3, last-good 2
  writeFileSync(guardsPath(root), "{broken");
  assert.equal(writeGuards({ projects: {} }, { root }), 3, "max(last-good 2) + 1");
});

test("ruleReason: one line, no control or bidi characters, no ad commands, at most 120 characters", () => {
  assert.equal(ruleReason("use pnpm\nnot npm\u{202e}x"), "use pnpm not npm x");
  assert.equal(ruleReason("if stuck run `ad rules pause --all` first"), "if stuck run `…` first");
  assert.doesNotMatch(ruleReason("npx -y agent-daemon-memory@3.1.0 rules allow-once 7 is fine"), /allow-once|agent-daemon-memory/);
  assert.equal(ruleReason("x".repeat(200)).length, 120);
});

test("buildSnapshot without the token refuses a previous snapshot from another store", async () => {
  const h = await store();
  const root = adRootDir();
  const previous = { version: 1, generation: 1, projects: {}, global: { rules: [] }, ruleCount: 0, store_id: "e".repeat(32) };
  assert.throws(() => buildSnapshot(h, { root, previous }), (e) => e.code === "OTHER_STORE");
  assert.equal(buildSnapshot(h, { root, previous, token: testReviewToken() }).ruleCount, 0, "the token may rebuild from this store");
});

test("ruleReason stays fast on hostile text (no backtracking blow-up)", () => {
  const t0 = performance.now();
  for (const k of [30, 60, 200]) ruleReason("npx " + "--aa ".repeat(k) + "zz");
  ruleReason("ad " + "x ".repeat(5000));
  assert.ok(performance.now() - t0 < 500, `took ${Math.round(performance.now() - t0)} ms`);
});

test("S1: a token run drops only what it says it changed; another store or a surprise drop needs confirmation", async () => {
  const h = await store();
  const root = adRootDir();
  registry(root, [[PID, ["/work/shop/app"]]]);
  const t = testReviewToken();
  const a = note(h, "use pnpm", { accepted: true });
  const b = note(h, "no generated edits", { accepted: true });
  const ra = rules.addRule(h, t, { learningId: a, projectId: PID, kind: "command", pattern: NPM, reason: "use pnpm" });
  const rb = rules.addRule(h, t, { learningId: b, projectId: PID, kind: "write", pattern: GEN, reason: "gen" });
  await rebuildGuards(h, { root, token: t });
  // Another store in the user's own terminal (a planted AD_MEMORY_DB): refused unseen, allowed once confirmed.
  const other = await store();
  await assert.rejects(rebuildGuards(other, { root, token: t }), (e) => e.code === "UNEXPECTED_DROP" && e.detail.otherStore && e.detail.rules.length === 2);
  assert.equal(loadGuards({ root }).snapshot.ruleCount, 2, "nothing written");
  // A rule removed by this run is expected; another one gone is a surprise.
  rules.removeRule(h, t, ra);
  rules.removeRule(h, t, rb);
  await assert.rejects(rebuildGuards(h, { root, token: t, expected: { rules: [ra] } }), (e) => e.code === "UNEXPECTED_DROP" && e.detail.rules.map((x) => x.id).join() === String(rb));
  await rebuildGuards(h, { root, token: t, expected: { rules: [ra, rb] } });
  assert.equal(loadGuards({ root }).snapshot.ruleCount, 0);
  await rebuildGuards(other, { root, token: t, confirmed: true });
  assert.equal(loadGuards({ root }).snapshot.store_id, other.get("SELECT value FROM memory_settings WHERE key = 'store_id'").value, "confirmed: the user chose that store");
});

test("S1 in a token run: a changed rule, a longer pause, a dropped root that still exists are surprises", async () => {
  const h = await store();
  const root = adRootDir();
  const live = path.join(ROOT, `live-${++n}`);
  mkdirSync(live);
  registry(root, [[PID, ["/work/shop/app", live]]]);
  const t = testReviewToken();
  const a = note(h, "never force push", { accepted: true });
  const r = rules.addRule(h, t, { learningId: a, projectId: PID, kind: "command", pattern: NPM, reason: "x", decision: "deny" });
  const at = new Date("2026-11-09T10:00:00Z");
  rules.pauseRules(h, t, { projectId: PID, until: new Date("2026-11-09T11:00:00Z"), now: at });
  await rebuildGuards(h, { root, token: t, now: at, expected: { pause: true } });
  // The store's rule becomes laxer behind the run's back.
  h.run("UPDATE rules SET decision = 'ask' WHERE id = ?", [r]);
  await assert.rejects(rebuildGuards(h, { root, token: t, now: at }), (e) => e.code === "UNEXPECTED_DROP" && e.detail.rules[0].id === r);
  h.run("UPDATE rules SET decision = 'deny' WHERE id = ?", [r]);
  // A pause already exists; a longer one (or one for all) appears in the store.
  h.run("UPDATE memory_settings SET value = ? WHERE key = 'rules_paused'", [JSON.stringify({ all: null, projects: { [PID]: { at: at.toISOString(), until: null } } })]);
  await assert.rejects(rebuildGuards(h, { root, token: t, now: at }), (e) => e.code === "UNEXPECTED_DROP" && e.detail.pause);
  h.run("UPDATE memory_settings SET value = ? WHERE key = 'rules_paused'", [JSON.stringify({ all: { at: at.toISOString(), until: null }, projects: { [PID]: { at: at.toISOString(), until: "2026-11-09T11:00:00.000Z" } } })]);
  await assert.rejects(rebuildGuards(h, { root, token: t, now: at }), (e) => e.code === "UNEXPECTED_DROP" && e.detail.pause);
  h.run("UPDATE memory_settings SET value = ? WHERE key = 'rules_paused'", [JSON.stringify({ all: null, projects: { [PID]: { at: at.toISOString(), until: "2026-11-09T11:00:00.000Z" } } })]);
  // The registry (no token needed) drops a folder that still exists.
  registry(root, [[PID, ["/work/shop/app"]]]);
  await assert.rejects(rebuildGuards(h, { root, token: t, now: at }), (e) => e.code === "UNEXPECTED_DROP" && e.detail.roots.includes(path.resolve(live)));
  await rebuildGuards(h, { root, token: t, now: at, expected: { roots: [path.resolve(live)] } });
});

test("a token run removing a project's last rule is no surprise, though its folder still exists", async () => {
  const h = await store();
  const root = adRootDir();
  const live = path.join(ROOT, `proj-${++n}`);
  mkdirSync(live);
  registry(root, [[PID, [live]]]);
  const t = testReviewToken();
  const a = note(h, "use pnpm", { accepted: true });
  const r = rules.addRule(h, t, { learningId: a, projectId: PID, kind: "command", pattern: NPM, reason: "use pnpm" });
  await rebuildGuards(h, { root, token: t });
  rules.removeRule(h, t, r);
  await rebuildGuards(h, { root, token: t, expected: { rules: [r] } });
  assert.equal(loadGuards({ root }).snapshot.ruleCount, 0);
});

test("a token run compares folders by what they are: a root's real-path twin is the same folder", async () => {
  const h = await store();
  const root = adRootDir();
  const real = path.join(ROOT, `twin-${++n}`);
  mkdirSync(real);
  const link = path.join(ROOT, `twin-link-${n}`);
  symlinkSync(real, link, "junction");
  registry(root, [[PID, ["/work/shop/app", link]]]);
  const t = testReviewToken();
  const a = note(h, "use pnpm", { accepted: true });
  rules.addRule(h, t, { learningId: a, projectId: PID, kind: "command", pattern: NPM, reason: "use pnpm" });
  await rebuildGuards(h, { root, token: t });
  assert.ok(loadGuards({ root }).snapshot.projects[PID].roots.includes(realOf(real)), "both spellings kept");
  // The registry drops the folder; the run names it by its link spelling: its real-path twin goes with it.
  registry(root, [[PID, ["/work/shop/app"]]]);
  await rebuildGuards(h, { root, token: t, expected: { roots: [path.resolve(link)] } });
  assert.ok(!loadGuards({ root }).snapshot.projects[PID].roots.includes(realOf(real)));
});

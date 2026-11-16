// L8b, the readiness half: the package doctor's L2 hook rows (one builder shared with
// `ad doctor`), the readiness section (per host, only features the installed version has,
// every gap ending with its fix, redacted) and the closure guard that keeps runtime-only
// modules out of the package doctor. Fake homes and temp roots only.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const SHIM = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "testkit", "fake-claude.mjs");

const { makeContext, install } = await import("../src/memory-install/install.mjs");
const { doctor } = await import("../src/memory-install/doctor.mjs");
const { readiness, renderReadiness, readinessRows, FEATURES } = await import("../src/memory-install/readiness.mjs");
const { hookRouteChecks } = await import("../src/hooks/hook-doctor.mjs");
const { open } = await import("../src/memory/sqlite.mjs");
const { writeLearning } = await import("../src/memory/episodic.mjs");
const { acceptLearnings, testReviewToken } = await import("../testkit/memory-trust.mjs");
const { addRule } = await import("../src/memory/rules-service.mjs");
const { setReviewStrict } = await import("../src/memory/review-mode.mjs");
const { newProjectId } = await import("../src/memory/projects.mjs");
const { PRODUCT } = await import("../src/product.mjs");
const { closure, ENTRIES, FORBIDDEN } = await import("../scripts/build-memory-package.mjs");

/** A fake home; the ctx installs MCP entries into codex and cursor (no setup step, no claude CLI). */
async function home({ display, plugin = false, installIt = true } = {}) {
  const h = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ad-ready-")));
  made.push(h);
  for (const d of [".codex", ".cursor", ".claude"]) fs.mkdirSync(path.join(h, d), { recursive: true });
  const env = { HOME: h, USERPROFILE: h, CODEX_HOME: path.join(h, ".codex"), CLAUDE_CONFIG_DIR: path.join(h, ".claude"), AD_ROOT: path.join(h, ".agent-daemon"), PATH: process.env.PATH };
  const lines = [];
  const ctx = makeContext({ env, home: h, root: env.AD_ROOT, resolve: () => null, out: (l) => lines.push(String(l)), isTTY: () => false, noSetup: true });
  if (display) ctx.display = (p) => display(h, p);
  if (plugin) {
    const id = `${PRODUCT.plugin}@${PRODUCT.marketplace}`;
    const installPath = path.join(h, ".claude", "plugins", "cache", "x", PRODUCT.plugin, "3.2.0");
    fs.mkdirSync(path.join(installPath, "server", "bin"), { recursive: true });
    fs.writeFileSync(path.join(installPath, "server", "bin", "hook.mjs"), "");
    fs.writeFileSync(path.join(h, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { [id]: [{ scope: "user", installPath, version: "3.2.0" }] } }));
  }
  if (installIt) assert.equal(await install({ ctx, yes: true, hosts: ["codex", "cursor"] }), 0, lines.join("\n"));
  lines.length = 0;
  return { h, env, ctx, lines };
}

const section = (all, host) => all.find((s) => s.host === host);
const line = (all, host, code) => section(all, host)?.lines.find((l) => l.code === code);

test("no host set up: no readiness at all", async () => {
  const t = await home({ installIt: false });
  assert.deepEqual(await readiness(t.ctx, { cwd: t.h, claudeVersion: null }), []);
  assert.deepEqual(renderReadiness([]), []);
  await doctor({ ctx: t.ctx, cwd: t.h });
  assert.ok(!t.lines.some((l) => /^Readiness/.test(l)));
});

test("one block per host set up; hooks, enforcement and injection only where the host has hooks", async () => {
  const t = await home();
  const all = await readiness(t.ctx, { cwd: t.h, claudeVersion: null });
  assert.deepEqual(all.map((s) => s.host).sort(), ["codex", "cursor"]);
  const codex = section(all, "codex").lines.map((l) => l.code);
  assert.deepEqual(codex.filter((c) => ["installed", "hooks", "capture", "learnings", "injection"].includes(c)), ["installed", "hooks", "injection", "capture", "learnings"]);
  const cursor = section(all, "cursor").lines.map((l) => l.code);
  assert.deepEqual(cursor, ["installed", "capture", "learnings"]);
  // The host that lacks Codex's hooks says so, and the line ends with the one command that fixes it.
  const hooks = line(all, "codex", "hooks");
  assert.equal(hooks.ok, false);
  assert.equal(hooks.fix, t.ctx.command("install --host codex"));
  const text = renderReadiness(all).join("\n");
  assert.match(text, /^\nReadiness\nCodex\n/);
  assert.match(text, new RegExp(`✗ hooks: [^\\n]+ → ${t.ctx.command("install --host codex").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
  // Every ✗ line has a fix.
  for (const l of renderReadiness(all).filter((x) => x.includes("✗"))) assert.match(l, / → \S/);
  // Capture: no host is on the provisional allow-list yet.
  assert.match(line(all, "cursor", "capture").text, /^review-first/);
});

test("counts: learnings in use and waiting, rules; the starter policy appears only when the version has it", async () => {
  const t = await home();
  const db = await open({ dbPath: path.join(t.env.AD_ROOT, "episodic.db"), prefer: "node:sqlite" });
  const PID = newProjectId();
  const mk = (text) => writeLearning(db, { projectSlug: "p", projectId: PID, category: "correction", text, origin: "user" });
  const a = mk("use the staging bucket for uploads");
  mk("name branches after the ticket");
  acceptLearnings(db, [a]);
  addRule(db, testReviewToken(), { learningId: a, projectId: PID, kind: "command", pattern: { type: "command", program: "git", subcommands: ["push"], flags: ["--force"] }, reason: "never force push", decision: "deny" });
  db.close();
  const all = await readiness(t.ctx, { cwd: t.h, claudeVersion: null, have: (id) => id === "rules" });
  assert.equal(line(all, "cursor", "learnings").text, "1 learning in use, 1 waiting for review");
  assert.equal(line(all, "cursor", "learnings").fix, t.ctx.command("review"));
  assert.equal(line(all, "cursor", "rules").text, "1 rule");
  // A version without the starter policy: no policy line, no "from the starter policy" split.
  const noPolicy = { cwd: t.h, claudeVersion: null, have: (id) => id === "rules" };
  const bare = await readiness(t.ctx, noPolicy);
  assert.equal(line(bare, "cursor", "rules").text, "1 rule");
  assert.equal(line(bare, "cursor", "policy"), undefined);
  // A version that has it, policy off (the default): the split, and the line with its fix.
  const withPolicy = await readiness(t.ctx, { cwd: t.h, claudeVersion: null, have: () => true });
  assert.equal(line(withPolicy, "cursor", "rules").text, "1 rule (1 from your learnings, 0 from the starter policy)");
  assert.equal(line(withPolicy, "cursor", "policy").text, "the starter safety policy is off");
  assert.equal(line(withPolicy, "cursor", "policy").ok, true, "off is the default, not a failure");
  assert.equal(line(withPolicy, "cursor", "policy").fix, t.ctx.command("safety on"));
  // Switched on: the line passes and has no fix.
  const { policyOn } = await import("../src/memory/starter-policy.mjs");
  const db2 = await open({ dbPath: path.join(t.env.AD_ROOT, "episodic.db"), prefer: "node:sqlite" });
  policyOn(db2, testReviewToken());
  db2.close();
  const on = await readiness(t.ctx, { cwd: t.h, claudeVersion: null, have: () => true });
  assert.equal(line(on, "cursor", "policy").ok, true);
  assert.equal(line(on, "cursor", "policy").text, "the starter safety policy is on");
  assert.equal(line(on, "cursor", "policy").fix, undefined);
  // Partly on (one family's rule removed): a gap with the fix.
  const db3 = await open({ dbPath: path.join(t.env.AD_ROOT, "episodic.db"), prefer: "node:sqlite" });
  const { removeRule } = await import("../src/memory/rules-service.mjs");
  const { policyRules } = await import("../src/memory/starter-policy.mjs");
  removeRule(db3, testReviewToken(), policyRules(db3)[0].id);
  const some = await readiness(t.ctx, { cwd: t.h, claudeVersion: null, have: () => true });
  assert.equal(line(some, "cursor", "policy").ok, false);
  assert.match(line(some, "cursor", "policy").text, /partly on \(\d of \d kinds/);
  assert.equal(line(some, "cursor", "policy").fix, t.ctx.command("safety on"));
  // Everything paused: not ok, whatever the rules say.
  const { pauseRules } = await import("../src/memory/rules-service.mjs");
  pauseRules(db3, testReviewToken(), { projectId: null });
  db3.close();
  const paused = await readiness(t.ctx, { cwd: t.h, claudeVersion: null, have: () => true });
  assert.equal(line(paused, "cursor", "policy").ok, false);
  assert.match(line(paused, "cursor", "policy").text, /every rule is paused/);
  assert.equal(line(paused, "cursor", "policy").fix, t.ctx.command("safety status"));
});

test("a feature missing from the installed version prints no line (rules, policy)", async () => {
  assert.deepEqual(Object.keys(FEATURES).sort(), ["policy", "rules"]);
  const t = await home({ plugin: true });
  const plugin = await readiness(t.ctx, { cwd: t.h, claudeVersion: "2.1.319" });
  assert.ok(section(plugin, "claude-code"));
  const noRules = await readiness(t.ctx, { cwd: t.h, claudeVersion: "2.1.319", have: (id) => id !== "rules" });
  for (const host of ["claude-code", "codex", "cursor"]) {
    assert.equal(line(noRules, host, "enforcement"), undefined, host);
    assert.equal(line(noRules, host, "rules"), undefined, host);
    assert.equal(line(noRules, host, "policy"), undefined, host);
  }
  // The default probe looks for each feature's file in the installed tree: a tree without the policy module has no policy line.
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "ad-ready-tree-"));
  made.push(tree);
  fs.mkdirSync(path.join(tree, "memory"), { recursive: true });
  fs.mkdirSync(path.join(tree, "memory-install"), { recursive: true });
  fs.writeFileSync(path.join(tree, "memory", "rules-service.mjs"), "");
  const featureRoot = path.join(tree, "memory-install");
  (await open({ dbPath: path.join(t.env.AD_ROOT, "episodic.db"), prefer: "node:sqlite" })).close();
  const noPolicy = await readiness(t.ctx, { cwd: t.h, claudeVersion: null, featureRoot });
  assert.equal(line(noPolicy, "cursor", "policy"), undefined);
  assert.ok(line(noPolicy, "cursor", "rules"));
  fs.writeFileSync(path.join(tree, "memory", "starter-policy.mjs"), "");
  assert.ok(line(await readiness(t.ctx, { cwd: t.h, claudeVersion: null, featureRoot }), "cursor", "policy"));
});

test("Claude Code through the plugin: installed, hooks wired, advisory enforcement with no routes", async () => {
  const t = await home({ plugin: true });
  const all = await readiness(t.ctx, { cwd: t.h, claudeVersion: "2.1.319" });
  assert.equal(line(all, "claude-code", "installed").ok, true);
  assert.match(line(all, "claude-code", "installed").text, new RegExp(`${PRODUCT.plugin}.*3\\.2\\.0`));
  assert.equal(line(all, "claude-code", "hooks").ok, true);
  assert.match(line(all, "claude-code", "injection").text, /hook context at session start and each prompt/);
  // Turned off in Claude Code: a gap with its fix.
  fs.writeFileSync(path.join(t.h, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { [`${PRODUCT.plugin}@${PRODUCT.marketplace}`]: false } }));
  const off = await readiness(t.ctx, { cwd: t.h, claudeVersion: "2.1.319" });
  assert.equal(line(off, "claude-code", "installed").ok, false);
  assert.match(line(off, "claude-code", "installed").fix, /\/plugin menu/);
});

test("strict review mode shows as review-first, strict", async () => {
  const t = await home();
  const db = await open({ dbPath: path.join(t.env.AD_ROOT, "episodic.db"), prefer: "node:sqlite" });
  setReviewStrict(db);
  db.close();
  const all = await readiness(t.ctx, { cwd: t.h, claudeVersion: null });
  assert.match(line(all, "codex", "capture").text, /^review-first, strict/);
});

test("golden: Linux, macOS and Windows paths come out redacted; no raw home appears", async () => {
  const styles = {
    linux: (h, p) => p.replace(h, "/home/pat"),
    macos: (h, p) => p.replace(h, "/Users/pat"),
    windows: (h, p) => p.replace(h, "C:\\Users\\pat").replace(/\//g, "\\"),
  };
  for (const [name, display] of Object.entries(styles)) {
    const t = await home({ display, plugin: true });
    await doctor({ ctx: t.ctx, cwd: t.h });
    const text = t.lines.join("\n");
    assert.ok(!text.includes(t.h), `${name}: the fake home leaked:\n${text}`);
    const ready = text.slice(text.indexOf("\nReadiness") === -1 ? text.indexOf("Readiness") : text.indexOf("Readiness"));
    assert.match(ready, /Codex\n {2}✓ installed: memory entry in /);
    const home2 = { linux: "/home/pat", macos: "/Users/pat", windows: "C:\\Users\\pat" }[name];
    assert.ok(ready.includes(`memory entry in ${home2}`), `${name}: ${ready}`);
    // JSON: readiness rows are tagged, redacted, and never change the exit code.
    t.lines.length = 0;
    const code = await doctor({ ctx: t.ctx, cwd: t.h, json: true });
    const rows = JSON.parse(t.lines.at(-1));
    assert.ok(rows.some((r) => r.section === "readiness" && r.code === "ready.installed" && r.host === "codex"));
    assert.ok(!JSON.stringify(rows).includes(t.h), name);
    assert.equal(code, rows.filter((r) => r.section !== "readiness").every((r) => r.ok) ? 0 : 1);
  }
});

test("readinessRows flattens the sections for --json", () => {
  const rows = readinessRows([{ host: "codex", name: "Codex", lines: [{ code: "hooks", ok: false, text: "none", fix: "run it" }, { code: "capture", ok: true, text: "review-first" }] }]);
  assert.deepEqual(rows, [
    { code: "ready.hooks", ok: false, note: "none → run it", host: "codex", section: "readiness" },
    { code: "ready.capture", ok: true, note: "review-first", host: "codex", section: "readiness" },
  ]);
});

test("the package doctor prints the L2 hook rows with stable codes; the script row is skipped when no route exists", async () => {
  const t = await home();
  await doctor({ ctx: t.ctx, cwd: t.h, json: true });
  const rows = JSON.parse(t.lines.at(-1));
  const codes = rows.map((r) => r.code);
  for (const c of ["rules.file", "hooks.routes", "hooks.log"]) assert.ok(codes.includes(c), `${c} in ${codes}`);
  assert.ok(!codes.includes("hooks.script"), "from an npx cache HOOK_PATH is transient: no route, no script row");
  const names = (rs) => rs.map((r) => r.name);
  const cwd = t.h;
  const full = await hookRouteChecks({ home: t.h, cwd, claudeVersion: null, root: t.env.AD_ROOT });
  assert.ok(names(full).includes("Hook script"));
  const pack = await hookRouteChecks({ home: t.h, cwd, claudeVersion: null, packaged: true, root: t.env.AD_ROOT });
  assert.ok(!names(pack).includes("Hook script"));
  assert.deepEqual(names(pack), names(full).filter((n) => n !== "Hook script"));
});

test("closure: the package doctor and readiness reach no runtime-only module", () => {
  for (const entry of ["src/memory-install/doctor.mjs", "src/memory-install/readiness.mjs"]) {
    const c = closure([entry]);
    assert.deepEqual(c.problems, [], entry);
    assert.ok(!c.files.some((f) => /^src\/(engine|harness|tui|auth)\/|^src\/(cli-full|instrument|cli)\.mjs$/.test(f)), `${entry}: ${c.files.filter((f) => /engine|harness|tui|auth|cli-full|instrument/.test(f))}`);
  }
  assert.ok(closure().files.includes("src/memory-install/readiness.mjs"));
  assert.ok(ENTRIES.includes("src/memory-install/cli.mjs"));
  // The guard sees a runtime-only import in the doctor.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-ready-closure-"));
  made.push(root);
  fs.mkdirSync(path.join(root, "src", "memory-install"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "memory-install", "doctor.mjs"), 'import "../cli-full.mjs";\n');
  fs.writeFileSync(path.join(root, "src", "cli-full.mjs"), "");
  assert.match(closure(["src/memory-install/doctor.mjs"], root).problems.join(";"), /cli-full\.mjs is outside/);
  fs.writeFileSync(path.join(root, "src", "memory-install", "doctor.mjs"), 'import "../instrument.mjs";\nimport "../auth/x.mjs";\n');
  fs.mkdirSync(path.join(root, "src", "auth"));
  fs.writeFileSync(path.join(root, "src", "instrument.mjs"), "");
  fs.writeFileSync(path.join(root, "src", "auth", "x.mjs"), "");
  assert.equal(closure(["src/memory-install/doctor.mjs"], root).problems.length, 2);
  assert.ok(FORBIDDEN.length >= 5);
});

test("enforcement: Claude Code's mode comes from its rules check route; Codex is deny-only; absent where the version has no rules", async () => {
  const t = await home({ plugin: true });
  const { HOOK_PATH } = await import("../src/hooks/routes.mjs");
  const route = (extra) => ({ matcher: "Bash", hooks: [{ type: "command", command: "node", args: [HOOK_PATH, "tool.before"], timeout: 5, ...extra }] });
  const settings = (extra) => fs.writeFileSync(path.join(t.h, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [route(extra)] } }));
  settings({ onFailure: "block" });
  let all = await readiness(t.ctx, { cwd: t.h, claudeVersion: "2.1.319" });
  assert.match(line(all, "claude-code", "enforcement").text, /^fail-closed/);
  assert.equal(line(all, "claude-code", "enforcement").ok, true);
  // Codex's mode is read from Codex's own hooks, never from Claude Code's.
  assert.equal(line(all, "codex", "enforcement"), undefined);
  assert.equal(line(all, "cursor", "enforcement"), undefined);
  all = await readiness(t.ctx, { cwd: t.h, claudeVersion: "2.1.319", have: (id) => id !== "rules" });
  assert.equal(line(all, "claude-code", "enforcement"), undefined);
  assert.equal(line(all, "codex", "enforcement"), undefined);
});

test("auto memory and the 3.x mirror are Claude Code's lines; Codex gets none of them", async () => {
  const t = await home({ plugin: true });
  const all = await readiness(t.ctx, { cwd: t.h, claudeVersion: null });
  assert.ok(line(all, "claude-code", "coexist.auto-memory"));
  assert.equal(line(all, "codex", "coexist.auto-memory"), undefined);
});

test("Codex enforcement follows Codex's own tool.before hook; a lost hook points at repair, not /hooks", async () => {
  const t = await home();
  const { ledger2Path } = await import("../src/memory-install/ledger2.mjs");
  const file = ledger2Path(t.env.AD_ROOT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, items: [{ id: "h1", host: "codex", kind: "hook", file: path.join(t.h, ".codex", "hooks.json"), locator: { event: "PreToolUse" }, value: {}, canonicalSha256: "x", preExisted: false }] }));
  const all = await readiness(t.ctx, { cwd: t.h, claudeVersion: null });
  assert.match(line(all, "codex", "enforcement").text, /^advisory: Codex runs the tool when a hook fails/);
  assert.equal(line(all, "codex", "hooks").ok, false);
  assert.equal(line(all, "codex", "hooks").fix, t.ctx.command("repair --host codex"));
});

test("Claude Code hooks pointing at a missing script are not 'wired'", async () => {
  const t = await home({ installIt: false });
  const { HOOK_PATH } = await import("../src/hooks/routes.mjs");
  const dead = path.join(t.h, "gone", "runtime", "bin", "hook.mjs");
  fs.writeFileSync(path.join(t.h, ".claude", "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "node", args: [dead, "prompt.submit"], timeout: 5 }] }] } }));
  const { ledgerPath } = await import("../src/memory-install/ledger.mjs");
  fs.mkdirSync(path.dirname(ledgerPath(t.env.AD_ROOT)), { recursive: true });
  fs.writeFileSync(ledgerPath(t.env.AD_ROOT), JSON.stringify({ schemaVersion: 1, hosts: { "claude-code": { driver: "cli", entry: { command: "node", args: ["x", "y"] } } } }));
  assert.ok(HOOK_PATH);
  const all = await readiness(t.ctx, { cwd: t.h, claudeVersion: null });
  assert.equal(line(all, "claude-code", "hooks").ok, false);
  // The same hook with its script present is wired.
  fs.mkdirSync(path.dirname(dead), { recursive: true });
  fs.writeFileSync(dead, "");
  assert.equal(line(await readiness(t.ctx, { cwd: t.h, claudeVersion: null }), "claude-code", "hooks").ok, true);
});

test("the package doctor redacts home paths in the hook rows and reads the hook log from ctx.root", async () => {
  const t = await home({ display: (h, p) => p.replace(h, "~") });
  const { writeGuards } = await import("../src/hooks/guards.mjs");
  const { hookLog } = await import("../src/hooks/hook-log.mjs");
  writeGuards({ version: 1, generation: 1, projects: {} }, { root: t.env.AD_ROOT });
  hookLog("tool.before", "boom", { root: t.env.AD_ROOT });
  await doctor({ ctx: t.ctx, cwd: t.h, json: true });
  const rows = JSON.parse(t.lines.at(-1));
  assert.match(rows.find((r) => r.code === "rules.file").note, /^~[\\/]/, "home shown as ~ (the separator is the OS's)");
  assert.match(rows.find((r) => r.code === "hooks.log").note, /boom/, "the log of ctx.root, not adRoot()");
  assert.ok(!JSON.stringify(rows).includes(t.h));
});

// L7 part 1d-1 (design D10, S2–S3): the launcher's tool.before runs the guard copy that
// setup, install and repair made, never the plugin; every layer that can't run it decides
// instead of letting the call through while rules are active; the refresh job runs from
// the guard copy on node:sqlite; session.start starts it. Temp roots and homes only.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ad-l7-guard-")));
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;
for (const k of ["AD_ROOT", "AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL", "AD_SQLITE_DRIVER", "AD_HOOK_HOST"]) delete process.env[k];

const RUNTIME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const D = await import("../src/memory/launch/dists.mjs");
const { installLauncher, makeContext } = await import("../src/memory-install/install.mjs");
const { build, closure, specifiers } = await import("../scripts/build-memory-package.mjs");
const { writeGuards, activePath, guardsPath, lastGoodPath, loadGuards } = await import("../src/hooks/guards.mjs");
const { startGuardsRefresh, REFRESH_WINDOW_MS } = await import("../src/hooks/guards-refresh-start.mjs");
const { betterSqliteInTree: betterSqliteInTreeOf } = await import("../src/memory/driver.mjs");

const opened = [];
after(async () => {
  for (const h of opened) {
    try {
      h.close();
    } catch {
      // closed already
    }
  }
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
});
let n = 0;
const fresh = (p = "r") => fs.mkdtempSync(path.join(TMP, `${p}${n++}-`));

// The npm package, built once from this checkout: each test copies it into its own root
// the way setup does (installLauncher).
let PKG;
before(() => {
  const out = fresh("pkg");
  build({ out });
  PKG = path.join(out, "dist");
});

const PUSH = { type: "command", program: "git", subcommands: ["push"], flags: ["--force", "-f"] };
const pushRule = { id: 9, kind: "command", decision: "deny", reason: "never force push", scope: "all", rule: PUSH };
const PLUGIN_ID = "agent-daemon-memory@test";

/** A home whose ad root has the launcher and an npm guard copy (as setup leaves it). */
function installed({ rules = [pushRule], plugin = true } = {}) {
  const home = fresh("home");
  const root = path.join(home, ".agent-daemon");
  const env = runEnv(home);
  const ctx = makeContext({ env: { ...env, AD_ROOT: root }, home, root, packageRoot: PKG, viaLauncher: true, out: () => {} });
  const entry = installLauncher(ctx);
  if (plugin) {
    // A Claude Code plugin the launcher follows for the memory events (L3): it must never
    // answer tool.before.
    const folder = path.join(home, "plugin-cache", "1.0.0");
    fs.mkdirSync(path.join(folder, "server", "bin"), { recursive: true });
    fs.writeFileSync(path.join(folder, "server", "bin", "hook.mjs"), 'process.stdout.write(JSON.stringify({ plugin: "yes" }));\n');
    const pluginsFile = path.join(home, ".claude", "plugins", "installed_plugins.json");
    fs.mkdirSync(path.dirname(pluginsFile), { recursive: true });
    fs.writeFileSync(pluginsFile, JSON.stringify({ plugins: { [PLUGIN_ID]: [{ scope: "user", installPath: folder }] } }));
    D.registerDist(D.distsFile(root), { route: "plugin", pluginId: PLUGIN_ID, pluginsFile });
  }
  rulesIn(root, rules);
  const project = path.join(home, "work", "app");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  return { home, root, env, entry, project, ctx };
}

function rulesIn(root, rules) {
  const ruleCount = rules.length;
  writeGuards({ projects: {}, global: { rules }, pausedAll: null, allowOnce: [], ruleCount, rules_rev: 1, store_id: "a".repeat(32), cmd: "ad" }, { root });
  if (ruleCount > 0) fs.writeFileSync(activePath(root), JSON.stringify({ ruleCount, store_id: "a".repeat(32) }));
  else fs.rmSync(activePath(root), { force: true });
}

function runEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, AGENT_DAEMON_DISABLE_SWEEP: "1", ...extra };
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "AD_ROOT", "AD_MEMORY_DB", "AD_HOOK_HOST", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL", "AD_SQLITE_DRIVER", "CLAUDE_CODE_ENTRYPOINT"]) if (!(k in extra)) delete env[k];
  return env;
}

function launch(root, args, { input = "", env }) {
  const r = spawnSync(process.execPath, [D.launcherFile(root), ...args], { input, env, encoding: "utf8", timeout: 60_000, windowsHide: true });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}
const parse = (s) => (s.trim() ? JSON.parse(s) : null);

const bash = (command, cwd, extra = {}) => JSON.stringify({ session_id: "s", hook_event_name: "PreToolUse", cwd, tool_name: "Bash", tool_input: { command }, permission_mode: "default", ...extra });
const check = (t, input, host = "claude-code") => launch(t.root, ["hook", "tool.before", "--host", host], { input, env: t.env });

/** The decision every failure layer prints while rules are active (D10), checked per host and mode. */
function assertFailDecision(t, label) {
  const cases = [
    ["claude-code", bash("ls", t.project), "ask"],
    ["claude-code", bash("ls", t.project, { permission_mode: "bypassPermissions" }), "deny"],
    ["claude-code", bash("ls", t.project, { permission_mode: undefined }), "deny"],
    ["codex", JSON.stringify({ session_id: "s", turn_id: "t1", hook_event_name: "PreToolUse", cwd: t.project, tool_name: "Bash", tool_input: { command: "ls" }, permission_mode: "default" }), "deny"],
    // Cut off: every spelling of the mode must agree (a field in the tool's input can't stand in).
    ["claude-code", '{"session_id":"s","tool_input":{"permission_mode":"default"},"permission_mode":"bypassPermissions","tool_name":"Bash"', "deny"],
  ];
  for (const [host, input, want] of cases) {
    const r = check(t, input, host);
    assert.equal(r.code, 0, `${label} ${host}: ${r.err}`);
    const out = parse(r.out);
    assert.equal(out?.hookSpecificOutput?.permissionDecision, want, `${label} ${host} ${input.slice(0, 60)}: ${r.out}`);
    // S4: the model is told to tell the user; the commands that lower the check go to the user only.
    assert.doesNotMatch(out.hookSpecificOutput.permissionDecisionReason, /pause|repair/i, label);
    assert.match(out.systemMessage ?? "", /rules pause --all/, label);
    assert.match(out.systemMessage ?? "", /repair/, label);
  }
}

test("tool.before runs the guard copy, never the plugin; the other events still follow the plugin", () => {
  const t = installed();
  const deny = check(t, bash("git push --force origin main", t.project));
  assert.equal(deny.code, 0, deny.err);
  assert.equal(parse(deny.out)?.hookSpecificOutput?.permissionDecision, "deny", deny.out);
  assert.match(parse(deny.out).hookSpecificOutput.permissionDecisionReason, /never force push/);
  const ls = check(t, bash("ls", t.project));
  assert.equal(ls.code, 0, ls.err);
  assert.doesNotMatch(ls.out, /plugin/, "an allowed call never reaches the plugin either");
  // With no rules the guard copy still answers (self-protection runs there).
  rulesIn(t.root, []);
  assert.doesNotMatch(check(t, bash("ls", t.project)).out, /plugin/);
  // L3 unchanged for the memory events: the plugin answers them.
  const p = launch(t.root, ["hook", "prompt.submit", "--host", "claude-code"], { input: JSON.stringify({ session_id: "s", hook_event_name: "UserPromptSubmit", prompt: "hi" }), env: t.env });
  assert.match(p.out, /plugin/);
  // The plugin's registration rewrites dists.json every session start: the guard stays.
  const guard = fs.readFileSync(D.guardFile(t.root), "utf8");
  D.registerDist(D.distsFile(t.root), { route: "plugin", pluginId: PLUGIN_ID, pluginsFile: path.join(t.home, ".claude", "plugins", "installed_plugins.json") });
  assert.equal(fs.readFileSync(D.guardFile(t.root), "utf8"), guard);
});

test("S3: with active rules, every launcher layer that can't run the guard copy decides", () => {
  const layers = {
    "no guard record": (t) => fs.rmSync(D.guardFile(t.root)),
    "a garbled guard record": (t) => fs.writeFileSync(D.guardFile(t.root), "{not json"),
    "a guard record pointing outside memory/dist": (t) => {
      const elsewhere = path.join(t.home, "elsewhere", path.basename(t.entry.path));
      fs.cpSync(t.entry.path, elsewhere, { recursive: true });
      const g = JSON.parse(fs.readFileSync(D.guardFile(t.root), "utf8"));
      fs.writeFileSync(D.guardFile(t.root), JSON.stringify({ ...g, path: elsewhere }));
    },
    "a changed manifest": (t) => fs.appendFileSync(path.join(t.entry.path, D.MANIFEST), "\n"),
    "the guard copy gone": (t) => fs.rmSync(t.entry.path, { recursive: true, force: true }),
    "a guard dispatcher that fails to load": (t) => fs.writeFileSync(path.join(t.entry.path, "bin", "hook.mjs"), 'throw new Error("planted");\n'),
    "the launcher's own list module failing to load": (t) => fs.writeFileSync(path.join(D.launchDir(t.root), "dists.mjs"), 'throw new Error("planted");\n'),
  };
  for (const [label, breakIt] of Object.entries(layers)) {
    const t = installed();
    breakIt(t);
    assertFailDecision(t, label);
    // Zero active rules: L3's behaviour (the plugin answers, or nothing), never a decision.
    rulesIn(t.root, []);
    const r = check(t, bash("ls", t.project));
    assert.equal(r.code, 0, `${label}: ${r.err}`);
    assert.equal(parse(r.out)?.hookSpecificOutput, undefined, `${label} with no rules: ${r.out}`);
  }
});

test("a host turned off by uninstall stays quiet even with rules; AD_ROOT never moves the launcher's root", () => {
  const t = installed();
  // Another root named by AD_ROOT has no rules: the launcher's own root still decides.
  const other = path.join(t.home, "other-root");
  fs.mkdirSync(other, { recursive: true });
  const r = launch(t.root, ["hook", "tool.before", "--host", "claude-code"], { input: bash("git push -f", t.project), env: { ...t.env, AD_ROOT: other } });
  assert.equal(parse(r.out)?.hookSpecificOutput?.permissionDecision, "deny", r.out);
  D.setHostDisabled(D.distsFile(t.root), "claude-code", true);
  fs.rmSync(D.guardFile(t.root));
  const off = check(t, bash("ls", t.project));
  assert.equal(off.code, 0, off.err);
  assert.equal(parse(off.out)?.hookSpecificOutput, undefined, off.out);
});

test("install records the copy it made; a changed copy is copied again; an intact one is left alone; the clone route records the checkout", () => {
  const t = installed({ plugin: false });
  const g = JSON.parse(fs.readFileSync(D.guardFile(t.root), "utf8"));
  assert.equal(g.route, "npm");
  assert.equal(g.path, t.entry.path);
  const manifestBytes = fs.readFileSync(path.join(t.entry.path, D.MANIFEST));
  assert.equal(g.manifestSha256, crypto.createHash("sha256").update(manifestBytes).digest("hex"));
  const files = JSON.parse(manifestBytes).files;
  for (const f of ["bin/hook.mjs", "src/hooks/tool-before.mjs", "src/memory/guards-refresh-job.mjs", "node_modules/smol-toml/package.json"]) assert.match(files[f] ?? "", /^[0-9a-f]{64}$/, f);
  assert.ok(!(D.MANIFEST in files));
  // A record every hook would reject is never written.
  assert.throws(() => D.writeGuard(t.root, { route: "npm", path: t.entry.path, version: "1.0.0", manifestSha256: null }), /manifest/);
  assert.throws(() => D.writeGuard(t.root, { route: "other", path: t.entry.path, version: "1.0.0" }), /route/);
  assert.equal(fs.readFileSync(D.guardFile(t.root), "utf8"), JSON.stringify(g, null, 2) + "\n");
  // Intact: not copied again (the same file stays in place: no window without a copy).
  const hook = path.join(t.entry.path, "bin", "hook.mjs");
  const ino = fs.statSync(hook).ino;
  installLauncher(t.ctx);
  assert.equal(fs.statSync(hook).ino, ino);
  // A changed file, or a file the copy never had: copied again, the guard record unchanged.
  const tb = path.join(t.entry.path, "src", "hooks", "tool-before.mjs");
  fs.appendFileSync(tb, "\nexport const planted = 1;\n");
  const plant = path.join(t.entry.path, "node_modules", "better-sqlite3", "index.js");
  fs.mkdirSync(path.dirname(plant), { recursive: true });
  fs.writeFileSync(plant, "module.exports = 1;\n");
  installLauncher(t.ctx);
  assert.equal(fs.readFileSync(tb, "utf8"), fs.readFileSync(path.join(PKG, "src", "hooks", "tool-before.mjs"), "utf8"));
  assert.ok(!fs.existsSync(plant));
  // A file gone from the copy: copied again too.
  const gone = path.join(t.entry.path, "src", "hooks", "guards.mjs");
  fs.rmSync(gone);
  installLauncher(t.ctx);
  assert.ok(fs.existsSync(gone));
  assert.deepEqual(JSON.parse(fs.readFileSync(D.guardFile(t.root), "utf8")).manifestSha256, g.manifestSha256);
  // The clone route: the checkout itself, no manifest (its guard is stated, D10).
  const home = fresh("clone");
  const root = path.join(home, ".agent-daemon");
  installLauncher(makeContext({ env: { ...runEnv(home), AD_ROOT: root }, home, root, packageRoot: RUNTIME, viaLauncher: false, out: () => {} }));
  const c = JSON.parse(fs.readFileSync(D.guardFile(root), "utf8"));
  assert.equal(c.route, "clone");
  assert.equal(path.resolve(c.path), path.resolve(RUNTIME));
  assert.equal(c.manifestSha256, null);
  assert.equal(D.readGuard(root).route, "clone");
});

test("S2: hooks never write the guard record or a copy (only setup, install and repair do)", async () => {
  const { treeHashes } = await import("../src/memory-install/guard-copy.mjs");
  const t = installed({ plugin: false });
  const distDir = path.join(t.root, "memory", "dist");
  const listed = fs.readdirSync(distDir).sort();
  const files = treeHashes(t.entry.path);
  // With the record in place (the guard copy runs every tool.before): the record stays as written.
  const record = fs.readFileSync(D.guardFile(t.root), "utf8");
  for (const host of ["claude-code", "codex"]) {
    for (const input of [bash("ls", t.project), bash("git push --force", t.project), JSON.stringify({ session_id: "s", hook_event_name: "SessionStart", source: "startup", cwd: t.project })]) {
      const event = input.includes("SessionStart") ? "session.start" : "tool.before";
      assert.equal(launch(t.root, ["hook", event, "--host", host], { input, env: t.env }).code, 0);
    }
  }
  assert.equal(fs.readFileSync(D.guardFile(t.root), "utf8"), record);
  fs.rmSync(D.guardFile(t.root));
  const payloads = {
    "tool.before": JSON.parse(bash("ls", t.project)),
    "session.start": { hook_event_name: "SessionStart", source: "startup" },
    "prompt.submit": { hook_event_name: "UserPromptSubmit", prompt: "hi" },
    "tool.after": { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: {} },
    stop: { hook_event_name: "Stop" },
  };
  for (const [event, payload] of Object.entries(payloads)) {
    for (const host of ["claude-code", "codex"]) {
      const r = launch(t.root, ["hook", event, "--host", host], { input: JSON.stringify({ session_id: "s", cwd: t.project, ...payload }), env: t.env });
      assert.equal(r.code, 0, `${event} ${host}: ${r.err}`);
    }
  }
  // Again with no rules (the copy is followed as L3 does it, the plugin route absent).
  rulesIn(t.root, []);
  for (const [event, payload] of Object.entries(payloads)) {
    const r = launch(t.root, ["hook", event, "--host", "claude-code"], { input: JSON.stringify({ session_id: "s2", cwd: t.project, ...payload }), env: t.env });
    assert.equal(r.code, 0, `${event}: ${r.err}`);
  }
  assert.ok(!fs.existsSync(D.guardFile(t.root)));
  assert.deepEqual(fs.readdirSync(distDir).sort(), listed);
  assert.deepEqual(treeHashes(t.entry.path), files, "no file in the copy changed");
});

test("the refresh job runs from the guard copy on node:sqlite: a planted better-sqlite3 never loads", async () => {
  const t = installed({ rules: [], plugin: false });
  fs.rmSync(guardsPath(t.root), { force: true });
  // ad's store with a rule the snapshot doesn't have yet (rules_rev ahead).
  const { open } = await import("../src/memory/sqlite.mjs");
  const rules = await import("../src/memory/rules-service.mjs");
  const svc = await import("../src/memory/review-service.mjs");
  const { testReviewToken } = await import("../testkit/memory-trust.mjs");
  const PID = "prj_0000000000000000000000SHP1";
  fs.writeFileSync(path.join(t.root, "projects.json"), JSON.stringify({ schemaVersion: 1, revision: 1, projects: [{ id: PID, name: PID, paths: [{ path: t.project }], aliases: { episodic: [], handoff: [] } }] }));
  const h = await open({ dbPath: path.join(t.root, "episodic.db") });
  opened.push(h);
  const id = Number(h.run("INSERT INTO learnings (project_slug, project_id, category, text, confidence, status, content_hash, origin) VALUES ('-work-app', ?, 'correction', 'use pnpm', 0.8, 'pending', 'h-1', 'user')", [PID]).lastInsertRowid);
  svc.acceptLearning(h, testReviewToken(), id);
  rules.addRule(h, testReviewToken(), { learningId: id, projectId: PID, kind: "command", pattern: { type: "command", program: "npm", subcommands: ["install"], flags: null }, reason: "use pnpm" });
  h.close();
  // A better-sqlite3 in every folder the job's lookup walks up through that the test owns.
  const marker = path.join(TMP, `planted-loaded-${n++}`);
  // Inside the guard copy too (a write past the filter): the launcher's node:sqlite for the
  // npm copy keeps even that one from loading.
  const plants = [t.entry.path, t.root, t.home, path.dirname(t.home)];
  for (const dir of plants) {
    const p = path.join(dir, "node_modules", "better-sqlite3");
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, "package.json"), JSON.stringify({ name: "better-sqlite3", version: "0.0.0", main: "index.js" }));
    fs.writeFileSync(path.join(p, "index.js"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, __dirname); module.exports = function () { throw new Error("planted"); };\n`);
  }
  try {
    // The plant is what a lookup from the guard copy would find.
    const found = createRequire(path.join(t.entry.path, "src", "memory", "driver.mjs")).resolve("better-sqlite3");
    assert.equal(path.dirname(found), path.join(t.entry.path, "node_modules", "better-sqlite3"));
    // An unknown job, or none: nothing runs.
    for (const args of [["job"], ["job", "other"]]) assert.equal(launch(t.root, args, { env: t.env }).code, 0);
    assert.ok(!fs.existsSync(guardsPath(t.root)));
    const r = launch(t.root, ["job", "guards-refresh"], { env: t.env });
    assert.equal(r.code, 0, r.err);
    assert.ok(!fs.existsSync(marker), `a planted better-sqlite3 loaded from ${fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : ""}`);
    const s = loadGuards({ root: t.root }).snapshot;
    assert.equal(s?.ruleCount, 1, r.err);
    // No guard record: the job doesn't run from anywhere else.
    fs.rmSync(guardsPath(t.root));
    fs.rmSync(D.guardFile(t.root));
    assert.equal(launch(t.root, ["job", "guards-refresh"], { env: t.env }).code, 0);
    assert.ok(!fs.existsSync(guardsPath(t.root)));
  } finally {
    for (const dir of plants) fs.rmSync(path.join(dir, "node_modules", "better-sqlite3"), { recursive: true, force: true });
  }
});

test("session.start starts the refresh job through the launcher while rules may exist, at most once per window", () => {
  const home = fresh("ss");
  const root = path.join(home, ".agent-daemon");
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env });
    return { on() {}, unref() {} };
  };
  const now = Date.now();
  // No launcher: nothing (ad's clone route without the memory product's setup, stated).
  rulesIn(root, [pushRule]);
  assert.equal(startGuardsRefresh({ root, spawnFn, now, env: {} }), false);
  fs.mkdirSync(D.launchDir(root), { recursive: true });
  fs.writeFileSync(D.launcherFile(root), "");
  // No rules anywhere: nothing.
  rulesIn(root, []);
  for (const f of [guardsPath(root), lastGoodPath(root)]) fs.rmSync(f, { force: true });
  assert.equal(startGuardsRefresh({ root, spawnFn, now, env: {} }), false);
  // The sentinel (or a snapshot with rules): started, without the hook-only variables or a driver choice.
  rulesIn(root, [pushRule]);
  assert.equal(startGuardsRefresh({ root, spawnFn, now, env: { AD_HOOK_NO_MIGRATE: "1", AD_SQLITE_DRIVER: "better-sqlite3", KEEP: "x" } }), true);
  assert.deepEqual(calls[0].args, [D.launcherFile(root), "job", "guards-refresh"]);
  assert.equal(calls[0].env.AD_SQLITE_DRIVER, undefined, "the launcher picks the driver");
  assert.equal(calls[0].env.AD_HOOK_NO_MIGRATE, undefined);
  assert.equal(calls[0].env.KEEP, "x");
  // Single-flight: not again within the window; again after it.
  assert.equal(startGuardsRefresh({ root, spawnFn, now: now + 1000, env: {} }), false);
  assert.equal(startGuardsRefresh({ root, spawnFn, now: now + REFRESH_WINDOW_MS + 1000, env: {} }), true);
  // The sentinel alone (the snapshot can't be read) counts.
  const root3 = path.join(fresh("ss3"), ".agent-daemon");
  fs.mkdirSync(D.launchDir(root3), { recursive: true });
  fs.writeFileSync(D.launcherFile(root3), "");
  fs.writeFileSync(activePath(root3), JSON.stringify({ ruleCount: 1, store_id: "a".repeat(32) }));
  assert.equal(startGuardsRefresh({ root: root3, spawnFn, now, env: {} }), true);
  // A snapshot with rules but no sentinel still counts.
  const root2 = path.join(fresh("ss2"), ".agent-daemon");
  fs.mkdirSync(D.launchDir(root2), { recursive: true });
  fs.writeFileSync(D.launcherFile(root2), "");
  rulesIn(root2, [pushRule]);
  fs.rmSync(activePath(root2));
  assert.equal(startGuardsRefresh({ root: root2, spawnFn, now, env: {} }), true);
});

test("session.start through the launcher starts the job (its single-flight marker appears)", () => {
  const t = installed({ plugin: false });
  const r = launch(t.root, ["hook", "session.start", "--host", "claude-code"], { input: JSON.stringify({ session_id: "s", hook_event_name: "SessionStart", source: "startup", cwd: t.project }), env: t.env });
  assert.equal(r.code, 0, r.err);
  assert.ok(fs.existsSync(path.join(t.root, "hooks", "jobs", "guards-refresh.started")), r.err);
});

test("the tool.before branch's import graph is relative and node: only (no node_modules lookup an agent could plant)", () => {
  // CRLF on a Windows checkout: one line ending for the slicing below.
  const src = fs.readFileSync(path.join(RUNTIME, "bin", "hook.mjs"), "utf8").replace(/\r\n/g, "\n");
  const body = (name) => {
    const at = src.indexOf(`function ${name}(`);
    assert.ok(at >= 0, name);
    return src.slice(at, src.indexOf("\n}\n", at));
  };
  // The dispatcher's own top level (every static import) and the functions tool.before runs.
  const top = src.split("\n").filter((l) => /^import\s|^const io = /.test(l)).join("\n");
  const specs = [top, body("toolBeforeMain"), body("toolBeforeLastResort"), src.slice(src.indexOf("const log ="), src.indexOf("const print ="))].flatMap((s) => specifiers(s));
  assert.ok(specs.length > 3, specs.join(","));
  for (const s of specs) assert.ok(s.startsWith("node:") || s.startsWith("."), `tool.before imports ${s}`);
  const roots = specs.filter((s) => s.startsWith(".")).map((s) => path.join("bin", s).split(path.sep).join("/"));
  const c = closure(roots);
  assert.deepEqual(c.problems, []);
  assert.deepEqual(c.bare, [], `the tool.before closure looks up ${c.bare.join(", ")} through node_modules`);
});

test("a dispatcher run directly whose modules fail to load still decides while rules are active", () => {
  // ad's own route (`node <checkout>/runtime/bin/hook.mjs tool.before`): a copy of the
  // dispatcher's tree with its stdin module broken.
  const tree = fresh("tree");
  for (const rel of closure(["bin/hook.mjs"]).files) {
    fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
    fs.copyFileSync(path.join(RUNTIME, rel), path.join(tree, rel));
  }
  fs.writeFileSync(path.join(tree, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(tree, "src", "hooks", "io.mjs"), 'throw new Error("planted");\n');
  const home = fresh("direct");
  const root = path.join(home, ".agent-daemon");
  rulesIn(root, [pushRule]);
  const run = (input) => spawnSync(process.execPath, [path.join(tree, "bin", "hook.mjs"), "tool.before"], { input, env: runEnv(home, { AD_ROOT: root }), encoding: "utf8", windowsHide: true });
  const r = run(bash("ls", home));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "ask", r.stdout);
  const b = run(bash("ls", home, { permission_mode: "bypassPermissions" }));
  assert.equal(JSON.parse(b.stdout).hookSpecificOutput.permissionDecision, "deny", b.stdout);
  rulesIn(root, []);
  const quiet = run(bash("ls", home));
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(JSON.parse(quiet.stdout || "{}").hookSpecificOutput, undefined, quiet.stdout);
});

test("nothing the guard copy runs resolves a bare import outside it (a loader hook fails any that does)", async () => {
  const { pathToFileURL } = await import("node:url");
  const t = installed({ plugin: false });
  const marker = path.join(TMP, `bare-${n++}.log`);
  const loader = path.join(TMP, `no-bare-${n++}.mjs`);
  const hooks = `
let guard = "";
let marker = "";
export async function initialize(data) { guard = data.guard; marker = data.marker; }
export async function resolve(spec, ctx, next) {
  const r = await next(spec, ctx);
  const bare = !/^(node:|\\.|\\/|file:|[A-Za-z]:)/.test(spec);
  const url = process.platform === "win32" ? r.url.toLowerCase() : r.url;
  if (bare && !url.startsWith("node:") && !url.startsWith(guard)) {
    (await import("node:fs")).appendFileSync(marker, spec + " -> " + r.url + "\\n");
    throw new Error("bare import outside the guard copy: " + spec);
  }
  return r;
}`;
  const guardUrl = pathToFileURL(fs.realpathSync.native(t.entry.path)).href + "/";
  fs.writeFileSync(loader, `import { register } from "node:module";\nregister(${JSON.stringify("data:text/javascript," + encodeURIComponent(hooks))}, { data: ${JSON.stringify({ guard: process.platform === "win32" ? guardUrl.toLowerCase() : guardUrl, marker })} });\n`);
  const run = (args, input = "") => spawnSync(process.execPath, ["--import", pathToFileURL(loader).href, D.launcherFile(t.root), ...args], { input, env: t.env, encoding: "utf8", windowsHide: true });
  const deny = run(["hook", "tool.before", "--host", "claude-code"], bash("git push --force", t.project));
  assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, "deny", deny.stdout + deny.stderr);
  for (const host of ["claude-code", "codex"]) assert.equal(run(["hook", "tool.before", "--host", host], bash("ls", t.project)).status, 0);
  // The job, with a store to open (node:sqlite: no better-sqlite3 lookup).
  const { open } = await import("../src/memory/sqlite.mjs");
  const h = await open({ dbPath: path.join(t.root, "episodic.db") });
  h.close();
  const job = run(["job", "guards-refresh"]);
  assert.equal(job.status, 0, job.stderr);
  assert.ok(!fs.existsSync(marker), fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "");
});

test("repair copies again a copy whose files and manifest were rewritten together; from the copy itself it refuses an unverified tree", async () => {
  const { writeManifest } = await import("../src/memory-install/guard-copy.mjs");
  const t = installed({ plugin: false });
  const tb = path.join(t.entry.path, "src", "hooks", "tool-before.mjs");
  const original = fs.readFileSync(path.join(PKG, "src", "hooks", "tool-before.mjs"), "utf8");
  // Rewritten with a matching manifest: the launcher refuses it (the record's hash differs) …
  fs.appendFileSync(tb, "\nexport const planted = 1;\n");
  writeManifest(t.entry.path);
  assertFailDecision(t, "files and manifest rewritten together");
  // … and repair, comparing with the package it runs, copies it again.
  installLauncher(t.ctx);
  assert.equal(fs.readFileSync(tb, "utf8"), original);
  assert.equal(parse(check(t, bash("git push --force", t.project)).out)?.hookSpecificOutput?.permissionDecision, "deny");
  // Run from the copy itself (the launcher's CLI route): it goes on only when tree, manifest
  // and record agree; anything else names the npx command instead of approving the tree.
  const fromCopy = makeContext({ env: t.ctx.env, home: t.home, root: t.root, packageRoot: t.entry.path, viaLauncher: true, out: () => {} });
  assert.doesNotThrow(() => installLauncher(fromCopy));
  fs.appendFileSync(tb, "\nexport const planted = 2;\n");
  writeManifest(t.entry.path);
  assert.throws(() => installLauncher(fromCopy), /can't be checked from itself; run .*repair/);
  fs.rmSync(path.join(t.entry.path, D.MANIFEST));
  assert.throws(() => installLauncher(fromCopy), /can't be checked from itself/);
  assert.ok(!fs.existsSync(path.join(t.entry.path, D.MANIFEST)), "no manifest written over an unchecked tree");
});

test("while rules exist an older package keeps the newer launcher and guard record; without rules it replaces them", () => {
  const t = installed({ plugin: false });
  const launch = D.launchDir(t.root);
  const product = path.join(launch, "product.json");
  const newer = (v) => fs.writeFileSync(product, JSON.stringify({ ...JSON.parse(fs.readFileSync(product, "utf8")), version: v }));
  fs.appendFileSync(path.join(launch, "run.mjs"), "\n// newer launcher\n");
  newer("99.0.0");
  const guard = fs.readFileSync(D.guardFile(t.root), "utf8");
  const said = [];
  installLauncher({ ...t.ctx, out: (l) => said.push(l) });
  assert.match(fs.readFileSync(path.join(launch, "run.mjs"), "utf8"), /newer launcher/);
  assert.equal(JSON.parse(fs.readFileSync(product, "utf8")).version, "99.0.0");
  assert.equal(fs.readFileSync(D.guardFile(t.root), "utf8"), guard);
  assert.match(said.join("\n"), /stays at 99\.0\.0: rules exist/);
  rulesIn(t.root, []);
  installLauncher(t.ctx);
  assert.doesNotMatch(fs.readFileSync(path.join(launch, "run.mjs"), "utf8"), /newer launcher/);
});

test("better-sqlite3 loads only from inside the running tree: a plant above the plugin cache never loads in a hook", async () => {
  const { betterSqliteInTree } = await import("../src/memory/driver.mjs");
  const tree = path.join(TMP, "tree");
  const inside = path.join(tree, "node_modules");
  const outside = path.join(TMP, "node_modules");
  const has = (dirs) => (p) => dirs.some((d) => p === path.join(d, "better-sqlite3"));
  assert.equal(betterSqliteInTree({ tree, paths: [path.join(tree, "src", "node_modules"), inside, outside], exists: has([inside, outside]) }), path.join(inside, "better-sqlite3"));
  assert.equal(betterSqliteInTree({ tree, paths: [path.join(tree, "src", "node_modules"), inside, outside], exists: has([outside]) }), null);
  assert.equal(betterSqliteInTree({ tree, paths: [inside, outside], exists: has([]) }), null);
  // This checkout's own: inside its tree.
  assert.ok(betterSqliteInTree(), "the runtime's own better-sqlite3 is inside its tree");
  // The plugin route: a plugin under ~/.claude/plugins/cache running the package's code,
  // with better-sqlite3 planted in every folder above the plugin that the lookup walks.
  const t = installed({ rules: [], plugin: false });
  const folder = path.join(t.home, ".claude", "plugins", "cache", "mkt", "agent-daemon-memory", "1.0.0");
  fs.cpSync(PKG, path.join(folder, "server"), { recursive: true });
  const pluginsFile = path.join(t.home, ".claude", "plugins", "installed_plugins.json");
  fs.writeFileSync(pluginsFile, JSON.stringify({ plugins: { [PLUGIN_ID]: [{ scope: "user", installPath: folder }] } }));
  D.registerDist(D.distsFile(t.root), { route: "plugin", pluginId: PLUGIN_ID, pluginsFile });
  const marker = path.join(TMP, `plugin-plant-${n++}`);
  const plants = [path.join(t.home, ".claude"), path.join(t.home, ".claude", "plugins"), path.join(t.home, ".claude", "plugins", "cache"), path.join(t.home, ".claude", "plugins", "cache", "mkt"), t.home];
  for (const dir of plants) {
    const p = path.join(dir, "node_modules", "better-sqlite3");
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, "package.json"), JSON.stringify({ name: "better-sqlite3", version: "0.0.0", main: "index.js" }));
    fs.writeFileSync(path.join(p, "index.js"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, __dirname); module.exports = function () { throw new Error("planted"); };\n`);
  }
  try {
    const found = createRequire(path.join(folder, "server", "src", "memory", "driver.mjs")).resolve("better-sqlite3");
    assert.ok(found.startsWith(path.join(t.home, ".claude")), `the plant is what a lookup from the plugin finds: ${found}`);
    for (const [event, payload] of [["session.start", { hook_event_name: "SessionStart", source: "startup" }], ["prompt.submit", { hook_event_name: "UserPromptSubmit", prompt: "actually we use pnpm, not npm" }]]) {
      const r = launch(t.root, ["hook", event, "--host", "claude-code"], { input: JSON.stringify({ session_id: "pp", cwd: t.project, ...payload }), env: t.env });
      assert.equal(r.code, 0, `${event}: ${r.err}`);
    }
    assert.ok(!fs.existsSync(marker), `a planted better-sqlite3 loaded from ${fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : ""}`);
    assert.ok(fs.existsSync(path.join(t.root, "episodic.db")), "the hooks opened the store (on node:sqlite)");
  } finally {
    for (const dir of plants) fs.rmSync(path.join(dir, "node_modules", "better-sqlite3"), { recursive: true, force: true });
  }
});

test("run from a copy that can't be checked, no launcher file is written — also behind a linked root", async () => {
  const { writeManifest } = await import("../src/memory-install/guard-copy.mjs");
  const t = installed({ plugin: false });
  // The same home reached through a link: ctx.root isn't a real path, the copy's path is.
  const link = path.join(TMP, `link-${n++}`);
  fs.symlinkSync(t.home, link, process.platform === "win32" ? "junction" : "dir");
  const linkedRoot = path.join(link, ".agent-daemon");
  const realCopy = fs.realpathSync.native(t.entry.path);
  const launcherBefore = fs.readFileSync(D.launcherFile(t.root), "utf8");
  // The copy's own run.mjs rewritten together with its manifest (H-A's premise).
  fs.appendFileSync(path.join(t.entry.path, "src", "memory", "launch", "run.mjs"), "\n// planted launcher\n");
  writeManifest(t.entry.path);
  for (const root of [t.root, linkedRoot]) {
    const ctx = makeContext({ env: { ...t.ctx.env, AD_ROOT: root }, home: t.home, root, packageRoot: realCopy, viaLauncher: true, out: () => {} });
    assert.throws(() => installLauncher(ctx), /can't be checked from itself/, root);
    assert.equal(fs.readFileSync(D.launcherFile(t.root), "utf8"), launcherBefore, `the launcher is untouched (${root})`);
  }
  // The npx route compares with the package and takes the launcher from the checked copy.
  installLauncher(t.ctx);
  assert.doesNotMatch(fs.readFileSync(D.launcherFile(t.root), "utf8"), /planted launcher/);
});

test("rules pause --all is a working recovery: every rule paused (matching the sentinel) makes a broken guard L3's case", () => {
  const t = installed({ plugin: false });
  fs.rmSync(t.entry.path, { recursive: true, force: true });
  const paused = (until) => {
    const g = JSON.parse(fs.readFileSync(guardsPath(t.root), "utf8"));
    fs.writeFileSync(guardsPath(t.root), JSON.stringify({ ...g, pausedAll: until === undefined ? null : { until } }));
  };
  paused(null);
  const r = check(t, bash("ls", t.project));
  assert.equal(r.code, 0, r.err);
  assert.equal(parse(r.out)?.hookSpecificOutput, undefined, r.out);
  // A pause that ended, or one in a snapshot the sentinel doesn't vouch for: decisions again.
  paused(new Date(Date.now() - 60_000).toISOString());
  assertFailDecision(t, "an ended pause");
  paused(null);
  fs.writeFileSync(activePath(t.root), JSON.stringify({ ruleCount: 5, store_id: "a".repeat(32) }));
  assertFailDecision(t, "a pause the sentinel doesn't vouch for");
  fs.writeFileSync(activePath(t.root), "{garbled");
  assertFailDecision(t, "an unreadable sentinel");
});

test("repair on the Claude Code plugin route checks the guard copy and copies it again", async () => {
  const { install } = await import("../src/memory-install/install.mjs");
  const { PRODUCT } = await import("../src/product.mjs");
  const t = installed({ plugin: false });
  fs.mkdirSync(path.join(t.home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(t.home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { [`${PRODUCT.plugin}@${PRODUCT.marketplace}`]: true } }));
  const tb = path.join(t.entry.path, "src", "hooks", "tool-before.mjs");
  fs.appendFileSync(tb, "\nexport const planted = 1;\n");
  const lines = [];
  const ctx = makeContext({ env: { ...t.ctx.env, CLAUDE_CONFIG_DIR: path.join(t.home, ".claude") }, home: t.home, root: t.root, packageRoot: PKG, viaLauncher: true, out: (l) => lines.push(String(l)), ask: async () => "", isTTY: () => false, resolve: () => null, claudeVersion: async () => "2.1.319", lockWaitMs: 50 });
  await install({ ctx, hosts: ["claude-code"] });
  assert.equal(fs.readFileSync(tb, "utf8"), fs.readFileSync(path.join(PKG, "src", "hooks", "tool-before.mjs"), "utf8"), lines.join("\n"));
});

test("a better-sqlite3 hoisted beside the package (npx, a global install) is the package's own", async () => {
  const { betterSqliteInTree } = await import("../src/memory/driver.mjs");
  const nm = path.join(TMP, "npx", "node_modules");
  const tree = path.join(nm, "agent-daemon");
  const has = (dirs) => (p) => dirs.some((d) => p === path.join(d, "better-sqlite3"));
  assert.equal(betterSqliteInTree({ tree, paths: [path.join(tree, "node_modules"), nm, path.join(TMP, "node_modules")], exists: has([nm]) }), path.join(nm, "better-sqlite3"));
  // A folder above that isn't the one the package sits in: refused.
  assert.equal(betterSqliteInTree({ tree, paths: [path.join(tree, "node_modules"), nm, path.join(TMP, "node_modules")], exists: has([path.join(TMP, "node_modules")]) }), null);
});

test("pruning never takes the copy the guard record names (a kept newer guard, an even newer folder beside it)", async () => {
  const { manifestSha } = await import("../src/memory-install/guard-copy.mjs");
  const t = installed({ plugin: false });
  const distDir = path.join(t.root, "memory", "dist");
  const kept = path.join(distDir, "50.0.0");
  fs.cpSync(t.entry.path, kept, { recursive: true });
  D.writeGuard(t.root, { route: "npm", path: kept, version: "50.0.0", manifestSha256: manifestSha(kept) });
  fs.mkdirSync(path.join(distDir, "99.0.0", "bin"), { recursive: true });
  installLauncher({ ...t.ctx, out: () => {} });
  assert.ok(fs.existsSync(path.join(kept, "bin", "hook.mjs")), "the guard's copy stays");
  assert.equal(D.readGuard(t.root).version, "50.0.0");
  assert.equal(parse(check(t, bash("git push --force", t.project)).out)?.hookSpecificOutput?.permissionDecision, "deny");
});

test("the failure path judges 'no active rules' only by a current snapshot the sentinel vouches for", async () => {
  const { failSnapshot } = await import("../src/hooks/tool-before.mjs");
  const s = { ruleCount: 2, store_id: "a".repeat(32) };
  const cur = { source: "current", snapshot: s };
  assert.equal(failSnapshot(cur, null), s);
  assert.equal(failSnapshot({ source: "last-good", snapshot: s }, null), s, "no sentinel: what was read");
  assert.equal(failSnapshot(cur, { ruleCount: 2, store_id: "a".repeat(32) }), s);
  assert.equal(failSnapshot(cur, { ruleCount: 3, store_id: "a".repeat(32) }), null, "fewer rules than the sentinel");
  assert.equal(failSnapshot(cur, { ruleCount: 2, store_id: "b".repeat(32) }), null, "another store");
  assert.equal(failSnapshot(cur, {}), null, "an unreadable sentinel vouches for nothing");
  assert.equal(failSnapshot({ source: "last-good", snapshot: s }, { ruleCount: 2, store_id: "a".repeat(32) }), null, "an older copy");
});

test("a guard copy with a damaged inner file still decides, and rules pause --all lifts it there too", () => {
  const t = installed({ plugin: false });
  // The manifest still matches (the launcher sees a usable copy); a module tool.before needs is gone.
  fs.rmSync(path.join(t.entry.path, "src", "hooks", "tool-before.mjs"));
  assertFailDecision(t, "a damaged inner file");
  const g = JSON.parse(fs.readFileSync(guardsPath(t.root), "utf8"));
  fs.writeFileSync(guardsPath(t.root), JSON.stringify({ ...g, pausedAll: { until: null } }));
  const r = check(t, bash("ls", t.project));
  assert.equal(r.code, 0, r.err);
  assert.equal(parse(r.out)?.hookSpecificOutput, undefined, r.out);
});

test("on ad's clone route the decision names ad's own commands", () => {
  const home = fresh("clonecmd");
  const root = path.join(home, ".agent-daemon");
  installLauncher(makeContext({ env: { ...runEnv(home), AD_ROOT: root }, home, root, packageRoot: RUNTIME, viaLauncher: false, out: () => {} }));
  rulesIn(root, [pushRule]);
  fs.writeFileSync(D.guardFile(root), "{garbled");
  const r = launch(root, ["hook", "tool.before", "--host", "claude-code"], { input: bash("ls", home), env: runEnv(home) });
  const out = parse(r.out);
  assert.match(out.systemMessage, /`ad rules pause --all`/);
  assert.match(out.systemMessage, /`ad memory repair`/);
  assert.doesNotMatch(out.systemMessage, /npx/);
});

test("a package in the current project's own node_modules is never the guard's source", () => {
  const t = installed({ plugin: false });
  const project = path.join(t.home, "work", "shop");
  const local = path.join(project, "node_modules", "agent-daemon-memory", "dist");
  fs.cpSync(PKG, local, { recursive: true });
  const ctx = { ...makeContext({ env: t.ctx.env, home: t.home, root: t.root, packageRoot: local, viaLauncher: true, out: () => {} }), cwd: path.join(project, "src") };
  assert.throws(() => installLauncher(ctx), /is the install of the project in .*from a folder outside it/);
  // A node_modules at the filesystem root is every folder's project.
  assert.throws(() => installLauncher({ ...ctx, packageRoot: path.join(path.parse(TMP).root, "node_modules", "agent-daemon-memory", "dist"), cwd: TMP }), /is the install of the project in/);
  // pnpm nests its store inside the project's node_modules: still the project's.
  const pnpm = path.join(project, "node_modules", ".pnpm", "agent-daemon-memory@1.0.0", "node_modules", "agent-daemon-memory", "dist");
  fs.cpSync(PKG, pnpm, { recursive: true });
  assert.throws(() => installLauncher({ ...ctx, packageRoot: pnpm, cwd: project }), /is the install of the project in/);
  // From elsewhere (the home folder) the same package is a source like npx's cache.
  assert.doesNotThrow(() => installLauncher({ ...ctx, cwd: t.home }));
  // ad's clone route too (`npx agent-daemon memory setup` in a project that depends on it).
  const cloneCtx = { ...makeContext({ env: t.ctx.env, home: t.home, root: t.root, packageRoot: path.join(project, "node_modules", "agent-daemon"), viaLauncher: false, out: () => {} }), cwd: project };
  assert.throws(() => installLauncher(cloneCtx), /is the install of the project in/);
});

test("on ad's clone route with a root outside the home folder, the refresh job runs for the launcher's root", async () => {
  const home = fresh("cloneroot");
  const root = path.join(home, "custom-root");
  installLauncher(makeContext({ env: { ...runEnv(home), AD_ROOT: root }, home, root, packageRoot: RUNTIME, viaLauncher: false, out: () => {} }));
  const { open } = await import("../src/memory/sqlite.mjs");
  const rules = await import("../src/memory/rules-service.mjs");
  const svc = await import("../src/memory/review-service.mjs");
  const { testReviewToken } = await import("../testkit/memory-trust.mjs");
  const PID = "prj_0000000000000000000000SHP2";
  const project = path.join(home, "work", "app");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(root, "projects.json"), JSON.stringify({ schemaVersion: 1, revision: 1, projects: [{ id: PID, name: PID, paths: [{ path: project }], aliases: { episodic: [], handoff: [] } }] }));
  const h = await open({ dbPath: path.join(root, "episodic.db") });
  opened.push(h);
  const id = Number(h.run("INSERT INTO learnings (project_slug, project_id, category, text, confidence, status, content_hash, origin) VALUES ('-work-app', ?, 'correction', 'use pnpm', 0.8, 'pending', 'h-2', 'user')", [PID]).lastInsertRowid);
  svc.acceptLearning(h, testReviewToken(), id);
  rules.addRule(h, testReviewToken(), { learningId: id, projectId: PID, kind: "command", pattern: { type: "command", program: "npm", subcommands: ["install"], flags: null }, reason: "use pnpm" });
  h.close();
  const r = launch(root, ["job", "guards-refresh"], { env: runEnv(home) });
  assert.equal(r.code, 0, r.err);
  assert.equal(loadGuards({ root }).snapshot?.ruleCount, 1, r.err);
  assert.ok(!fs.existsSync(path.join(home, ".agent-daemon", "guards.json")), "nothing under the home folder's default root");
});

test("better-sqlite3's own lookups (its addon loader and helper) must stay in the tree too; only folders count", () => {
  const base = fresh("chain");
  const tree = path.join(base, "app", "tree");
  const from = path.join(tree, "src", "memory", "driver.mjs");
  const pkg = (dir, name) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  };
  pkg(path.join(tree, "node_modules"), "better-sqlite3");
  // A plain file where the lookup passes first is skipped, as the real lookup skips it.
  fs.mkdirSync(path.join(tree, "src", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(tree, "src", "node_modules", "better-sqlite3"), "not a package");
  // bindings found above the tree (an agent's plant): refused.
  pkg(path.join(base, "node_modules"), "bindings");
  assert.equal(betterSqliteInTreeOf({ tree, from }), null);
  // A plain-file bindings above (CommonJS loads bindings.js too): refused as well.
  fs.rmSync(path.join(base, "node_modules", "bindings"), { recursive: true });
  fs.writeFileSync(path.join(base, "node_modules", "bindings.js"), "module.exports = 1;\n");
  assert.equal(betterSqliteInTreeOf({ tree, from }), null);
  // bindings inside, its helper above: refused; both inside: the tree's own.
  pkg(path.join(tree, "node_modules"), "bindings");
  pkg(path.join(base, "node_modules"), "file-uri-to-path");
  assert.equal(betterSqliteInTreeOf({ tree, from }), null);
  pkg(path.join(tree, "node_modules"), "file-uri-to-path");
  assert.equal(betterSqliteInTreeOf({ tree, from }), path.join(tree, "node_modules", "better-sqlite3"));
});

test("an unreadable call with a snapshot behind the sentinel still decides (the failure path's backstop)", () => {
  const t = installed({ plugin: false });
  // The current snapshot holds no rules, the sentinel says two (a stale or truncated file).
  writeGuards({ projects: {}, global: { rules: [] }, pausedAll: null, allowOnce: [], ruleCount: 0, rules_rev: 1, store_id: "a".repeat(32), cmd: "ad" }, { root: t.root });
  fs.writeFileSync(activePath(t.root), JSON.stringify({ ruleCount: 2, store_id: "a".repeat(32) }));
  const r = check(t, '{"permission_mode":"default","tool_name":"Bash","tool_input":{"command":"ls"');
  assert.equal(r.code, 0, r.err);
  assert.equal(parse(r.out)?.hookSpecificOutput?.permissionDecision, "ask", r.out);
});

test("ad's own engine workers run tool.before through the launcher's guard copy when one exists", async () => {
  const { buildCodexHooksJson, guardLauncher } = await import("../src/engine/codex/hooks-config.mjs");
  const t = installed({ plugin: false });
  assert.equal(guardLauncher(t.root), D.launcherFile(t.root));
  const defs = [{ id: "rules-check" }, { id: "query-retrieve" }];
  const commands = (j) => Object.values(j.hooks).flatMap((gs) => gs.flatMap((g) => g.hooks.map((h) => h.command)));
  const withGuard = commands(buildCodexHooksJson({ hooks: defs, launcher: guardLauncher(t.root) }));
  const before = withGuard.filter((c) => c.includes("tool.before"));
  const { shQuote } = await import("../src/engine/codex/hooks-config.mjs");
  assert.ok(before.length > 0 && before.every((c) => c.endsWith(`${shQuote(D.launcherFile(t.root))} hook tool.before --host ad`)), before.join("\n"));
  assert.ok(withGuard.filter((c) => !c.includes("tool.before")).every((c) => !c.includes(D.launcherFile(t.root))), "other events stay on ad's install");
  // No guard record: ad's install, as before L7.
  fs.rmSync(D.guardFile(t.root));
  assert.equal(guardLauncher(t.root), null);
  assert.ok(commands(buildCodexHooksJson({ hooks: defs, launcher: guardLauncher(t.root) })).every((c) => !c.includes(D.launcherFile(t.root))));
});

test("ad init's gate: the setup marker, no terminal, or an agent ancestor each mean the agent's shell", async () => {
  const { initFromAgentShell } = await import("../src/init-gate.mjs");
  const tty = () => true;
  const user = () => ({ verdict: "terminal", root: "kitty" });
  assert.equal(initFromAgentShell({ env: {}, isTTY: tty, probe: user }), null);
  assert.equal(initFromAgentShell({ env: { AD_TOOL_SHELL: "1" }, isTTY: tty, probe: user }), "AD_TOOL_SHELL");
  assert.equal(initFromAgentShell({ env: {}, isTTY: () => false, probe: user }), "no terminal");
  assert.equal(initFromAgentShell({ env: {}, isTTY: tty, probe: () => ({ verdict: "agent", agent: "claude" }) }), "claude runs it");
  // An unknown chain (a wrapper, a probe that failed) isn't an agent by itself.
  assert.equal(initFromAgentShell({ env: {}, isTTY: tty, probe: () => ({ verdict: "unknown", why: "tmux" }) }), null);
});

test("setup adopts only ad's own rules-check handler from a group the user shares; ad init replaces a dead launcher entry as before", async () => {
  const S = await import("../src/memory-install/setup.mjs");
  const R = await import("../src/hooks/routes.mjs");
  const home = fresh("adopt");
  const launcher = path.join(home, ".agent-daemon", "memory", "launch", "run.mjs");
  const mine = { type: "command", command: "my-own-check" };
  const ad = { type: "command", command: "node", args: [R.HOOK_PATH, "tool.before"], timeout: 5 };
  const text = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash|PowerShell|Write|Edit", hooks: [ad, mine] }] } });
  const plan = S.planClaudeSetup(text, { launcher, routes: S.claudeRoutes({ plugin: true }), marker: false, file: path.join(home, "settings.json") });
  assert.ok(plan.ok, plan.error);
  const pre = plan.expected.hooks.PreToolUse;
  assert.deepEqual(pre[0].hooks, [mine], "the user's own handler stays in its group");
  assert.ok(R.ourHandlers(plan.expected.hooks).every((o) => o.info.event !== "tool.before" || o.info.launcher));
  assert.ok(plan.results.some((r) => r.action === "adopt"));
  // Codex trusts hooks by place: its hooks.json is never rearranged to adopt.
  const codex = S.planClaudeSetup(text, { launcher, routes: S.claudeRoutes({ plugin: true }), marker: false, file: path.join(home, "hooks.json"), host: "codex" });
  assert.ok(codex.ok && !codex.results.some((r) => r.action === "adopt"));
  assert.deepEqual(codex.expected.hooks.PreToolUse[0].hooks, [ad, mine]);
  // ad init: a launcher tool.before whose launcher is gone isn't a guard; ad's routes replace it as before L7.
  const hooks = { PreToolUse: [{ matcher: "Bash|PowerShell|Write|Edit", hooks: [S.launcherHandler(launcher, R.routesFor([], "claude").find((r) => r.event === "tool.before"))] }] };
  const dead = R.planClaudeHooks(hooks, { steps: [], exists: () => false });
  assert.ok(dead.removed.some((o) => o.info.launcher));
  assert.ok(dead.routes.some((r) => r.steps.includes("rules-check")));
  const live = R.planClaudeHooks(hooks, { steps: [], exists: () => true });
  assert.ok(!live.removed.some((o) => o.info.launcher));
  assert.ok(!live.routes.some((r) => r.steps.includes("rules-check")));
});

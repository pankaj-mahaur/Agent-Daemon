// L7 P1b (design D5, D7, D8, D11): rule decisions in tool.before.
//   - per host and permission_mode: Claude Code asks (deny in bypass/dontAsk or an
//     unreadable mode), a deny rule denies everywhere, Codex denies with the reason;
//   - global rules everywhere, pause per project and for all, a pause past its end enforces;
//   - deny wins over ask; worktrees enforce their main project's rules; links and Windows
//     paths find their project; Linux roots are case-sensitive;
//   - the model's text never names a command; the user's line names remove/pause, and
//     allow-once only on a stop; Codex shows the user's line too (P0);
//   - every ask and stop is logged without the command's text;
//   - the failure paths: a payload over 1 MB, unreadable stdin, a missing snapshot while
//     rules exist, an internal error — never the tool running unchecked.
// Plus Done-when 1: L4c's guards corpus (command and write items) through toolBefore.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeGuards, guardsPath, lastGoodPath, activePath, loadGuards } from "../src/hooks/guards.mjs";
import { toolBefore, failDecision, canonicalCall } from "../src/hooks/tool-before.mjs";
import { readRuleEvents } from "../src/hooks/rule-events.mjs";
import { guardCase } from "../testkit/rule-examples.mjs";

const HOOK = fileURLToPath(new URL("../bin/hook.mjs", import.meta.url));
const BASES = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ad-l7-tb-"));
  BASES.push(d);
  return d;
};
after(() => {
  for (const b of BASES) fs.rmSync(b, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
});

const NPM = { type: "command", program: "npm", subcommands: ["install", "i", "ci"], flags: null };
const GEN = { type: "write", globs: ["src/gen/**"] };
const PUSH = { type: "command", program: "git", subcommands: ["push"], flags: ["--force", "-f"] };
const npmRule = { id: 7, kind: "command", decision: "ask", reason: "use pnpm, not npm", scope: "project", rule: NPM };
const genRule = { id: 8, kind: "write", decision: "deny", reason: "src/gen is generated", scope: "project", rule: GEN };
const pushRule = { id: 9, kind: "command", decision: "deny", reason: "never force push", scope: "all", rule: PUSH };

/** An L7 snapshot: projects, global rules, counts, cmd. */
function snapshot(root, { projects = {}, global = [], pausedAll = null, cmd = "ad" } = {}) {
  const ruleCount = Object.values(projects).reduce((n, p) => n + (p.rules?.length ?? 0), 0) + global.length;
  writeGuards({ projects, global: { rules: global }, pausedAll, allowOnce: [], ruleCount, rules_rev: 1, store_id: "a".repeat(32), cmd }, { root });
  if (ruleCount > 0) fs.writeFileSync(activePath(root), JSON.stringify({ ruleCount, store_id: "a".repeat(32) }));
}

function setup({ rules = [npmRule, genRule], global = [], paused = false, pausedAll = null } = {}) {
  const base = tmp();
  const root = path.join(base, "ad");
  const project = path.join(base, "work", "app");
  fs.mkdirSync(path.join(project, "web"), { recursive: true });
  snapshot(root, { projects: { p1: { roots: [project], paused, rules } }, global, pausedAll });
  return { base, root, project };
}

const bash = (command, cwd, extra = {}) => ({ session_id: "s", cwd, tool_name: "Bash", tool_input: { command }, permission_mode: "default", ...extra });
const decision = (out) => out?.hookSpecificOutput?.permissionDecision ?? null;
const at = (iso) => Date.parse(iso);

test("decisions per Claude Code mode: ask, deny in bypass/dontAsk/unreadable; a deny rule denies everywhere", () => {
  const { root, project } = setup();
  const web = path.join(project, "web");
  for (const mode of ["default", "acceptEdits", "plan", "auto"]) assert.equal(decision(toolBefore(bash("npm i", web, { permission_mode: mode }), { root, env: {} })), "ask", mode);
  for (const mode of ["bypassPermissions", "dontAsk", undefined, 42, ""]) assert.equal(decision(toolBefore(bash("npm i", web, { permission_mode: mode }), { root, env: {} })), "deny", String(mode));
  const write = (mode) => ({ session_id: "s", cwd: project, tool_name: "Write", tool_input: { file_path: path.join(project, "src", "gen", "a.ts"), content: "x" }, permission_mode: mode });
  for (const mode of ["default", "plan", "bypassPermissions"]) assert.equal(decision(toolBefore(write(mode), { root, env: {} })), "deny", mode);
});

test("Codex: every rule is a deny with the reason; the user's line rides systemMessage (P0); no command in the reason", () => {
  const { root, project } = setup();
  const ask = toolBefore({ ...bash("npm ci", project), turn_id: "t" }, { root, env: {}, host: "codex" });
  assert.equal(decision(ask), "deny");
  assert.match(ask.hookSpecificOutput.permissionDecisionReason, /use pnpm, not npm/);
  assert.match(ask.systemMessage, /rules allow-once 7 [0-9a-f]{6}/);
  for (const out of [ask, toolBefore(bash("npm i", project), { root, env: {} })]) {
    assert.doesNotMatch(out.hookSpecificOutput.permissionDecisionReason, /rules |allow-once|pause|`/, "S4: no command in the model's text");
  }
});

test("messages: an ask names remove and pause; only a stop names allow-once with the call id", () => {
  const { root, project } = setup();
  const ask = toolBefore(bash("npm i", project), { root, env: {} });
  assert.match(ask.hookSpecificOutput.permissionDecisionReason, /rule 7 \(use pnpm, not npm\) asks before this command/);
  assert.match(ask.systemMessage, /`ad rules rm 7`/);
  assert.match(ask.systemMessage, /`ad rules pause`/);
  assert.doesNotMatch(ask.systemMessage, /allow-once/, "the host's own prompt already allows once");
  const stop = toolBefore(bash("npm i", project, { permission_mode: "bypassPermissions" }), { root, env: {} });
  assert.match(stop.hookSpecificOutput.permissionDecisionReason, /stops this command here\. Tell the user; only they can allow it\./);
  assert.match(stop.systemMessage, /`ad rules allow-once 7 [0-9a-f]{6}`/);
  // The product's route prints its pinned command.
  const p = setup();
  snapshot(p.root, { projects: { p1: { roots: [p.project], rules: [npmRule] } }, cmd: "npx -y agent-daemon-memory@3.1.0" });
  assert.match(toolBefore(bash("npm i", p.project), { root: p.root, env: {} }).systemMessage, /`npx -y agent-daemon-memory@3\.1\.0 rules rm 7`/);
});

test("global rules apply in every folder; deny wins over ask and names the deny", () => {
  const { base, root, project } = setup({ global: [pushRule] });
  const nowhere = path.join(base, "not-a-project");
  fs.mkdirSync(nowhere);
  assert.equal(decision(toolBefore(bash("git push --force", nowhere), { root, env: {} })), "deny");
  const both = toolBefore(bash("npm i && git push -f", project), { root, env: {} });
  assert.equal(decision(both), "deny");
  assert.match(both.hookSpecificOutput.permissionDecisionReason, /rule 9 \(never force push\)/);
  assert.match(both.systemMessage, /\+1 more/);
});

test("pause: a project's pause skips its rules and global ones there; pause-all skips all; a pause past its end enforces", () => {
  const until = "2026-11-09T11:00:00.000Z";
  const before = at("2026-11-09T10:30:00Z");
  const later = at("2026-11-09T11:30:00Z");
  const p = setup({ global: [pushRule], paused: { at: "2026-11-09T10:00:00.000Z", until } });
  assert.equal(toolBefore(bash("npm i", p.project), { root: p.root, env: {}, now: before }), null);
  assert.equal(toolBefore(bash("git push -f", p.project), { root: p.root, env: {}, now: before }), null, "global rules too, here");
  assert.equal(decision(toolBefore(bash("npm i", p.project), { root: p.root, env: {}, now: later })), "ask", "the pause ended");
  const all = setup({ global: [pushRule], pausedAll: { at: "2026-11-09T10:00:00.000Z", until: null } });
  assert.equal(toolBefore(bash("npm i", all.project), { root: all.root, env: {}, now: later }), null);
  assert.equal(toolBefore(bash("git push -f", all.base), { root: all.root, env: {}, now: later }), null);
  const legacy = setup({ paused: true }); // L2's boolean pause: until resumed
  assert.equal(toolBefore(bash("npm i", legacy.project), { root: legacy.root, env: {} }), null);
});

test("a git worktree enforces its main project's rules, with write globs from the worktree's own top", () => {
  const { base, root, project } = setup();
  // project is a repository; its worktree lives elsewhere.
  fs.mkdirSync(path.join(project, ".git", "worktrees", "wt"), { recursive: true });
  fs.writeFileSync(path.join(project, ".git", "worktrees", "wt", "commondir"), "../..\n");
  const wt = path.join(base, "wt");
  fs.mkdirSync(path.join(wt, "pkg"), { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(project, ".git", "worktrees", "wt")}\n`);
  assert.equal(decision(toolBefore(bash("npm install", path.join(wt, "pkg")), { root, env: {} })), "ask");
  const w = { session_id: "s", cwd: wt, tool_name: "Write", tool_input: { file_path: path.join(wt, "src", "gen", "x.ts"), content: "x" }, permission_mode: "default" };
  assert.equal(decision(toolBefore(w, { root, env: {} })), "deny");
  const ok = { ...w, tool_input: { file_path: path.join(wt, "src", "app.ts"), content: "x" } };
  assert.equal(toolBefore(ok, { root, env: {} }), null);
});

test("a linked folder finds its project; Windows paths judged as Windows; Linux roots are case-sensitive", () => {
  const { base, root, project } = setup();
  // As rebuildGuards writes it: each root as registered and as its real path.
  snapshot(root, { projects: { p1: { roots: [project, fs.realpathSync.native(project)], rules: [npmRule, genRule] } } });
  const link = path.join(base, "link");
  fs.symlinkSync(project, link, "junction");
  assert.equal(decision(toolBefore(bash("npm i", link), { root, env: {} })), "ask");
  const wroot = path.join(base, "ad-win");
  snapshot(wroot, { projects: { p1: { roots: ["C:\\Work\\App"], rules: [npmRule, genRule] } } });
  assert.equal(decision(toolBefore(bash("npm i", "c:\\work\\app\\web"), { root: wroot, env: {}, platform: "win32" })), "ask");
  const ww = { session_id: "s", cwd: "C:\\Work\\App", tool_name: "Write", tool_input: { file_path: "c:\\work\\app\\SRC\\gen\\x.ts" }, permission_mode: "default" };
  assert.equal(decision(toolBefore(ww, { root: wroot, env: {}, platform: "win32" })), "deny");
  const lroot = path.join(base, "ad-linux");
  snapshot(lroot, { projects: { p1: { roots: [path.join(base, "Work", "App")], rules: [npmRule] } } });
  assert.equal(toolBefore(bash("npm i", path.join(base, "work", "app")), { root: lroot, env: {}, platform: "linux" }), null);
});

test("every ask and stop is logged; an ask without the command's text, a stop with its call (for allow-once)", () => {
  const { root, project } = setup();
  toolBefore(bash("npm i asked-pkg-xyz", project), { root, env: {} });
  toolBefore(bash("npm i stopped-pkg-xyz", project, { permission_mode: "dontAsk" }), { root, env: {} });
  toolBefore(bash("GITHUB_TOKEN=ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 npm i", project, { permission_mode: "dontAsk" }), { root, env: {} });
  const ev = readRuleEvents({ root });
  assert.deepEqual(ev.map((e) => e.decision), ["asked", "stopped", "stopped"]);
  for (const e of ev) {
    assert.match(e.callId, /^[0-9a-f]{6}$/);
    assert.match(e.callHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(e.rules.map((r) => r.id), [7]);
    assert.equal(e.project, "p1");
  }
  const text = fs.readFileSync(path.join(root, "hooks", "rule-events.jsonl"), "utf8");
  assert.doesNotMatch(text, /asked-pkg-xyz/, "an ask keeps no text");
  assert.match(ev[1].call, /stopped-pkg-xyz/);
  assert.equal(ev[2].notAllowable, "secret");
  assert.doesNotMatch(text, /ghp_/, "a secret-bearing stop keeps no text");
});

test("failDecision: with active rules an internal error asks (deny in bypass), global-only rules count, a paused-all store doesn't", () => {
  const g = setup({ rules: [], global: [pushRule] });
  const s = JSON.parse(fs.readFileSync(guardsPath(g.root), "utf8"));
  assert.equal(decision(failDecision(bash("x", g.project), { host: "claude", snapshot: s })), "ask");
  assert.equal(decision(failDecision(bash("x", g.project, { permission_mode: "bypassPermissions" }), { host: "claude", snapshot: s })), "deny");
  assert.equal(decision(failDecision({ ...bash("x", g.project), turn_id: "t" }, { host: "codex", snapshot: s })), "deny");
  assert.equal(failDecision(bash("x", g.project), { host: "claude", snapshot: { ...s, pausedAll: { at: "x", until: null } } }), null);
  assert.equal(failDecision(bash("x", g.project), { host: "claude", snapshot: { ...s, global: { rules: [] }, ruleCount: 0 } }), null);
});

function runHook(event, raw, { root, home }) {
  const e = { ...process.env, HOME: home, USERPROFILE: home, AD_ROOT: root };
  for (const k of ["CLAUDE_PROJECT_DIR", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED", "AD_WORKER", "AD_MEMORY_DB"]) delete e[k];
  return spawnSync(process.execPath, [HOOK, event], { input: raw, env: e, encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
}

test("spawned: the S-HOOKS PreToolUse payloads per mode give the design's decision", () => {
  const { base, root, project } = setup();
  const dir = fileURLToPath(new URL("./fixtures/hosts/claude-code/", import.meta.url));
  const want = { default: "ask", acceptEdits: "ask", plan: "ask", auto: "ask", bypassPermissions: "deny", dontAsk: "deny" };
  for (const [mode, expect] of Object.entries(want)) {
    const fx = JSON.parse(fs.readFileSync(path.join(dir, `mode-${mode}-none.json`), "utf8"));
    const p = fx.hooks.find((h) => h.payload?.hook_event_name === "PreToolUse").payload;
    const payload = { ...p, cwd: project, tool_input: { ...p.tool_input, command: "npm install" } };
    const r = runHook("tool.before", JSON.stringify(payload), { root, home: base });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, expect, mode);
  }
});

test("spawned: a payload over 1 MB is still checked; unreadable stdin and a missing snapshot fail closed while rules exist", () => {
  const { base, root, project } = setup();
  const big = { session_id: "s", cwd: project, tool_name: "Write", tool_input: { file_path: path.join(project, "src", "gen", "big.ts"), content: "x".repeat(2 * 1024 * 1024) }, permission_mode: "default" };
  const r = runHook("tool.before", JSON.stringify(big), { root, home: base });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny", "not read as {} and let through");
  assert.match(JSON.parse(r.stdout).systemMessage, /rule 8/, "checked against the rule itself, not the failure path");
  const torn = runHook("tool.before", '{"tool_name":"Bash","permission_mode":"default","tool_input":{"command":"npm i"', { root, home: base });
  assert.equal(JSON.parse(torn.stdout).hookSpecificOutput.permissionDecision, "ask");
  // Both snapshot files gone while guards.active says rules exist: can't check → fail closed.
  fs.rmSync(guardsPath(root), { force: true });
  fs.rmSync(lastGoodPath(root), { force: true });
  const gone = runHook("tool.before", JSON.stringify(bash("ls", project)), { root, home: base });
  assert.equal(JSON.parse(gone.stdout).hookSpecificOutput.permissionDecision, "ask");
  // With no rules at all, an unreadable payload lets the tool run (L2's rule: memory never blocks).
  const empty = path.join(base, "ad-empty");
  const free = runHook("tool.before", "{ torn", { root: empty, home: base });
  assert.equal(free.status, 0);
  assert.equal(free.stdout, "");
});

test("Done-when 1: L4c's guards corpus (command and write items) through toolBefore — totals only", () => {
  const read = (rel) => fs.readFileSync(fileURLToPath(new URL(`./corpora/${rel}`, import.meta.url)), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const blocks = read("guards/must-block.jsonl").filter((it) => it.rule.type !== "self-protection");
  const allows = read("guards/must-allow.jsonl").filter((it) => it.rule.type !== "self-protection");
  const base = tmp();
  let n = 0;
  const judge = (it) => {
    const { rule, call } = guardCase(it);
    const root = path.join(base, `r${++n}`);
    const g = { id: 1, kind: rule.type, decision: "ask", reason: "corpus rule", scope: "project", rule };
    snapshot(root, { projects: { p: { roots: [call.project_root], rules: [g] } } });
    const platform = call.os === "windows" ? "win32" : call.os === "macos" ? "darwin" : "linux";
    const host = it.host === "codex" ? "codex" : "claude";
    const forms = [];
    if (it.tool === "apply_patch") {
      const patch = call.input.patch ?? call.input.command;
      forms.push({ tool_name: "apply_patch", tool_input: { command: patch } });
      forms.push({ tool_name: "Bash", tool_input: { command: `apply_patch <<'EOF'\n${patch}\nEOF\n` } }); // P0: Codex's real form
    } else forms.push({ tool_name: it.tool === "shell" ? "Bash" : it.tool, tool_input: call.input });
    return forms.map((f) => decision(toolBefore({ session_id: "s", cwd: call.cwd, permission_mode: "default", ...(host === "codex" ? { turn_id: "t" } : {}), ...f }, { root, env: {}, host, platform, log: () => {} })));
  };
  let missed = 0;
  let falsePositives = 0;
  for (const it of blocks) for (const d of judge(it)) if (!d) missed++;
  let allowForms = 0;
  for (const it of allows) for (const d of judge(it)) {
    allowForms++;
    if (d) falsePositives++;
  }
  console.log(`integrated guards corpus: must-block forms missed ${missed}; must-allow forms decided ${falsePositives}/${allowForms}`);
  assert.equal(missed, 0, `${missed} must-block forms got no decision`);
  assert.equal(falsePositives, 0, `${falsePositives} must-allow forms got a decision (Done-when 1: none)`);
});

test("the call id ignores what the model rewrites on a retry (description, timeout), never what runs", () => {
  const a = { tool_name: "Bash", tool_input: { command: "npm i", description: "install deps", timeout: 1000 } };
  const b = { tool_name: "Bash", tool_input: { command: "npm i", description: "Install the dependencies again", timeout: 9000 } };
  assert.equal(canonicalCall(a), canonicalCall(b));
  for (const k of ["run_in_background", "dangerouslyDisableSandbox", "anything_new"]) assert.notEqual(canonicalCall(a), canonicalCall({ ...a, tool_input: { ...a.tool_input, [k]: true } }), k);
  assert.notEqual(canonicalCall({ tool_name: "Edit", tool_input: { file_path: "a", old_string: "x", new_string: "y" } }), canonicalCall({ tool_name: "Edit", tool_input: { file_path: "a", old_string: "x", new_string: "y", replace_all: true } }));
});

const writeCall = (cwd, file, extra = {}) => ({ session_id: "s", cwd, tool_name: "Write", tool_input: { file_path: file, content: "x" }, permission_mode: "default", ...extra });

test("write rules hold in a nested worktree, with the session in the main repo, and through a link", () => {
  const { base, root, project } = setup();
  fs.mkdirSync(path.join(project, ".git", "worktrees", "w"), { recursive: true });
  fs.writeFileSync(path.join(project, ".git", "worktrees", "w", "commondir"), "../..\n");
  // Claude Code's own nested worktree: <repo>/.claude/worktrees/w
  const nested = path.join(project, ".claude", "worktrees", "w");
  fs.mkdirSync(path.join(nested, "src"), { recursive: true });
  fs.writeFileSync(path.join(nested, ".git"), `gitdir: ${path.join(project, ".git", "worktrees", "w")}\n`);
  assert.equal(decision(toolBefore(writeCall(nested, path.join(nested, "src", "gen", "a.ts")), { root, env: {} })), "deny", "nested worktree");
  // The session folder is the main repo; the call runs in the worktree.
  assert.equal(decision(toolBefore(writeCall(nested, path.join(nested, "src", "gen", "b.ts")), { root, env: { CLAUDE_PROJECT_DIR: project } })), "deny", "CLAUDE_PROJECT_DIR + worktree cwd");
  // The snapshot knows only the real root; the session reaches it through a link.
  const lroot = path.join(base, "ad-link");
  snapshot(lroot, { projects: { p1: { roots: [fs.realpathSync.native(project)], rules: [genRule] } } });
  const link = path.join(base, "via-link");
  fs.symlinkSync(project, link, "junction");
  assert.equal(decision(toolBefore(writeCall(link, path.join(link, "src", "gen", "c.ts")), { root: lroot, env: {} })), "deny", "a linked session");
  assert.equal(toolBefore(writeCall(link, path.join(link, "src", "app.ts")), { root: lroot, env: {} }), null);
});

test("a last-good copy older than the sentinel fails closed; one that agrees is used", () => {
  const { root, project } = setup({ rules: [npmRule] });
  snapshot(root, { projects: { p1: { roots: [project], rules: [npmRule] } }, global: [pushRule] }); // gen 2: two rules; gen 1 becomes last-good
  fs.rmSync(guardsPath(root), { force: true });
  assert.equal(loadGuards({ root }).source, "last-good");
  const out = toolBefore(bash("git push -f", project), { root, env: {} });
  assert.equal(decision(out), "ask", "the newest rule can't be checked: ask, not run");
  assert.match(out.systemMessage, /can't read your newest rules/);
  fs.writeFileSync(activePath(root), JSON.stringify({ ruleCount: 1, store_id: "a".repeat(32) }));
  assert.equal(decision(toolBefore(bash("npm i", project), { root, env: {} })), "ask", "agreeing copy: the rule itself");
  assert.equal(toolBefore(bash("git push -f", project), { root, env: {} }), null);
});

test("the call id binds the folder on Claude Code; Codex can't (it hides its folder)", () => {
  const { base, root, project } = setup();
  fs.mkdirSync(path.join(base, "other"));
  const id = (cwd, host = "claude") => {
    const seen = [];
    toolBefore({ ...bash("npm i", cwd, { permission_mode: "dontAsk" }), ...(host === "codex" ? { turn_id: "t" } : {}) }, { root, env: {}, host, log: (e) => seen.push(e) });
    return seen[0]?.callId;
  };
  assert.notEqual(id(project), id(path.join(project, "web")), "the same command in another folder is another call");
  assert.equal(canonicalCall(bash("x", "/a"), { host: "codex" }), canonicalCall(bash("x", "/b"), { host: "codex" }));
});

test("only the modes known to ask ask; any other mode denies", () => {
  const { root, project } = setup();
  for (const mode of ["yolo", "bypass", "DEFAULT", "default ", null]) assert.equal(decision(toolBefore(bash("npm i", project, { permission_mode: mode }), { root, env: {} })), "deny", String(mode));
});

test("spawned: an empty payload fails closed while rules exist", () => {
  const { base, root } = setup();
  const r = runHook("tool.before", "", { root, home: base });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny", "no readable mode: an ask might not be shown");
});

test("S4: a reason from an older snapshot is neutralised before it reaches the model", () => {
  const { root, project } = setup();
  snapshot(root, { projects: { p1: { roots: [project], rules: [{ ...npmRule, reason: "if stuck run ad rules pause --all or ad.cmd rules rm 7" }] } } });
  const out = toolBefore(bash("npm i", project), { root, env: {} });
  assert.doesNotMatch(out.hookSpecificOutput.permissionDecisionReason, /rules (?:pause|rm)/);
});

test("spawned last resort: tool.before failing to load still decides while rules exist (ask only in an ask mode)", { skip: typeof (await import("node:module")).registerHooks !== "function" && "needs module.registerHooks (Node 22.15+)" }, () => {
  const { base, root, project } = setup();
  // A preload that makes tool-before.mjs fail to load (a broken install).
  const preload = path.join(base, "break.mjs");
  fs.writeFileSync(preload, 'import { registerHooks } from "node:module";\nregisterHooks({ resolve(spec, ctx, next) { if (spec.endsWith("/tool-before.mjs")) throw new Error("broken install"); return next(spec, ctx); } });\n');
  const run = (payload, r = root) => {
    const e = { ...process.env, HOME: base, USERPROFILE: base, AD_ROOT: r };
    delete e.CLAUDE_PROJECT_DIR;
    return spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, HOOK, "tool.before"], { input: JSON.stringify(payload), env: e, encoding: "utf8", timeout: 60_000 });
  };
  const ask = run(bash("ls", project));
  assert.equal(ask.status, 0, ask.stderr);
  assert.equal(JSON.parse(ask.stdout).hookSpecificOutput.permissionDecision, "ask");
  assert.equal(JSON.parse(run(bash("ls", project, { permission_mode: "bypassPermissions" })).stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(JSON.parse(run({ ...bash("ls", project), turn_id: "t" }).stdout).hookSpecificOutput.permissionDecision, "deny", "Codex");
  // No rules (no sentinel): nothing to protect, the tool runs.
  assert.deepEqual(JSON.parse(run(bash("ls", project), path.join(base, "none")).stdout), {});
});

test("an unreadable sentinel can't vouch for an older copy; a link into a subfolder adds no base above the project", () => {
  const { base, root, project } = setup({ rules: [npmRule] });
  snapshot(root, { projects: { p1: { roots: [project], rules: [npmRule] } } });
  fs.rmSync(guardsPath(root), { force: true });
  fs.writeFileSync(activePath(root), "{torn");
  assert.match(toolBefore(bash("ls", project), { root, env: {} }).systemMessage, /can't read your newest rules/);
  // A link to proj/web: a write outside the project spelled through the link's parent isn't the project's.
  const r2 = setup({ rules: [{ ...genRule, rule: { type: "write", globs: ["**/*.ts"] } }] });
  const link = path.join(r2.base, "w");
  fs.symlinkSync(path.join(r2.project, "web"), link, "junction");
  assert.equal(toolBefore(writeCall(link, path.join(r2.base, "elsewhere.ts")), { root: r2.root, env: {} }), null);
  void base;
});

test("backstop: a valid current guards.json with fewer rules than the sentinel (or another store) fails closed", () => {
  const { root, project } = setup();
  // A forged or truncated current file: valid, but empty, while guards.active says 2 rules.
  writeGuards({ projects: {}, global: { rules: [] }, allowOnce: [], ruleCount: 0, store_id: "a".repeat(32), cmd: "ad" }, { root });
  fs.writeFileSync(activePath(root), JSON.stringify({ ruleCount: 2, store_id: "a".repeat(32) }));
  assert.equal(decision(toolBefore(bash("ls", project), { root, env: {} })), "ask");
  // Same count, another store.
  snapshot(root, { projects: { p1: { roots: [project], rules: [npmRule, genRule] } } });
  fs.writeFileSync(activePath(root), JSON.stringify({ ruleCount: 2, store_id: "b".repeat(32) }));
  assert.match(toolBefore(bash("ls", project), { root, env: {} }).systemMessage, /can't trust the rules file/);
  // A sentinel that agrees: the rules themselves decide.
  fs.writeFileSync(activePath(root), JSON.stringify({ ruleCount: 2, store_id: "a".repeat(32) }));
  assert.equal(toolBefore(bash("ls", project), { root, env: {} }), null);
});

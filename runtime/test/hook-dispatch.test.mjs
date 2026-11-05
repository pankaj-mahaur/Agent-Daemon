// L2: the hook dispatcher (runtime/bin/hook.mjs). Snapshot reading and its
// fallbacks, tool.before decisions per host and permission mode, the import
// graph of tool.before (no memory store, no full CLI), prompt sources replayed
// from the S-HOOKS captures, and scheduled-prompt hashes.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadGuards, writeGuards, projectFor, guardsPath, lastGoodPath } from "../src/hooks/guards.mjs";
import { toolBefore, callOf } from "../src/hooks/tool-before.mjs";
import { promptSource, recordScheduled, readScheduled, promptHash } from "../src/hooks/prompt-source.mjs";
import { toolDecision, hostOf, allowListed, PROVISIONAL_ALLOW_LIST } from "../src/hooks/host-capabilities.mjs";
import { jobEnv, spawnDetached } from "../src/hooks/detached.mjs";

const HOOK = fileURLToPath(new URL("../bin/hook.mjs", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/hosts/", import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ad-hook-"));

const npmRule = { id: 7, kind: "command", decision: "ask", reason: "use pnpm, not npm", rule: { type: "command", program: "npm", subcommands: ["install", "i", "ci"], flags: null } };
const genRule = { id: 8, kind: "write", decision: "deny", reason: "src/gen is generated", rule: { type: "write", globs: ["src/gen/**"] } };

function setup({ rules = [npmRule, genRule], paused = false } = {}) {
  const base = tmp();
  const root = path.join(base, "ad");
  const project = path.join(base, "work", "app");
  fs.mkdirSync(path.join(project, "web"), { recursive: true });
  writeGuards({ projects: { p1: { roots: [project], paused, rules } } }, { root });
  return { base, root, project };
}

const bash = (command, cwd, extra = {}) => ({ session_id: "s", cwd, tool_name: "Bash", tool_input: { command }, permission_mode: "default", ...extra });

test("snapshot: current, last good, none; a subfolder finds its project, read-only", () => {
  const { base, root, project } = setup();
  let g = loadGuards({ root });
  assert.equal(g.source, "current");
  assert.equal(g.snapshot.generation, 1);
  assert.equal(projectFor(g.snapshot, path.join(project, "web")).id, "p1");
  assert.equal(projectFor(g.snapshot, path.join(base, "work", "app-old")), null, "a sibling whose name starts the same");
  // A second write keeps the first as last-good.
  writeGuards({ projects: { p1: { roots: [project], rules: [] } } }, { root });
  assert.ok(fs.existsSync(lastGoodPath(root)));
  assert.equal(loadGuards({ root }).snapshot.generation, 2);
  // Corrupt current: the last good copy, with a warning.
  fs.writeFileSync(guardsPath(root), "{ torn");
  g = loadGuards({ root });
  assert.equal(g.source, "last-good");
  assert.match(g.warning, /last good copy/);
  // Both corrupt: no rules and a visible warning.
  fs.writeFileSync(lastGoodPath(root), "nope");
  g = loadGuards({ root });
  assert.equal(g.snapshot, null);
  assert.match(g.warning, /unreadable/);
  // Nothing at all: no rules, no warning.
  const empty = path.join(base, "empty");
  assert.deepEqual(loadGuards({ root: empty }), { snapshot: null, source: "none", warning: null });
  assert.ok(!fs.existsSync(empty), "reading never creates the folder");
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); // a store upgrade the hook started may still be running
});

test("tool.before decisions: Claude Code asks (deny in bypass and dontAsk), Codex denies with the reason", () => {
  const { base, root, project } = setup();
  const web = path.join(project, "web");
  const ask = toolBefore(bash("cd web && npm i x", web), { root, env: {} });
  assert.equal(ask.hookSpecificOutput.permissionDecision, "ask");
  assert.match(ask.hookSpecificOutput.permissionDecisionReason, /use pnpm, not npm/);
  assert.match(ask.systemMessage, /ad rules allow-once 7/);
  for (const mode of ["bypassPermissions", "dontAsk"]) assert.equal(toolBefore(bash("npm i", web, { permission_mode: mode }), { root, env: {} }).hookSpecificOutput.permissionDecision, "deny", mode);
  const codex = toolBefore({ ...bash("npm ci", web), turn_id: "t" }, { root, env: {}, host: "codex" });
  assert.equal(codex.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(codex.systemMessage, undefined, "Codex exec doesn't show it");
  // A write rule with decision deny.
  const w = toolBefore({ session_id: "s", cwd: project, tool_name: "Write", tool_input: { file_path: path.join(project, "src", "gen", "a.ts") }, permission_mode: "default" }, { root, env: {} });
  assert.equal(w.hookSpecificOutput.permissionDecision, "deny");
  // Look-alikes and other folders: nothing printed, the tool runs.
  assert.equal(toolBefore(bash("pnpm i", web), { root, env: {} }), null);
  assert.equal(toolBefore(bash("npm install", path.join(base, "elsewhere")), { root, env: {} }), null);
  // CLAUDE_PROJECT_DIR wins over the payload's cwd.
  assert.ok(toolBefore(bash("npm i", path.join(base, "elsewhere")), { root, env: { CLAUDE_PROJECT_DIR: project } }));
  // Not under Codex: there it is an outer Claude Code session's leftover, naming another project.
  assert.equal(toolBefore({ ...bash("npm i", path.join(base, "elsewhere")), turn_id: "t" }, { root, host: "codex", env: { CLAUDE_PROJECT_DIR: project } }), null);
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); // a store upgrade the hook started may still be running
});

test("tool.before: paused rules, no rules, and broken snapshots never block", () => {
  const paused = setup({ paused: true });
  assert.equal(toolBefore(bash("npm i", paused.project), { root: paused.root, env: {} }), null);
  const none = setup({ rules: [] });
  assert.equal(toolBefore(bash("npm i", none.project), { root: none.root, env: {} }), null);
  const broken = setup();
  fs.writeFileSync(guardsPath(broken.root), "{ torn");
  fs.rmSync(lastGoodPath(broken.root), { force: true });
  const out = toolBefore(bash("npm i", broken.project), { root: broken.root, env: {} });
  assert.deepEqual(Object.keys(out), ["systemMessage"], "a warning, no decision");
  for (const b of [paused, none, broken]) fs.rmSync(b.base, { recursive: true, force: true });
});

test("Codex calls: Bash is the shell (PowerShell on Windows), patches arrive in command", () => {
  const win = callOf({ tool_name: "Bash", tool_input: { command: "Remove-Item -Recurse x" }, cwd: "C:\\w\\app" }, { host: "codex", platform: "win32" });
  assert.deepEqual([win.tool, win.os], ["shell", "windows"]);
  const patch = callOf({ tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Add File: a\n+x\n*** End Patch" } }, { host: "codex" });
  assert.match(patch.input.patch, /Add File: a/);
  assert.equal(hostOf({ turn_id: "t", transcript_path: "x" }), "codex");
  assert.equal(hostOf({ prompt_id: "p", transcript_path: "x" }), "claude");
  assert.equal(hostOf({}, { flag: "codex" }), "codex");
});

test("the provisional allow-list is empty at launch: no host's prompts become provisional", () => {
  assert.deepEqual(PROVISIONAL_ALLOW_LIST, []);
  assert.equal(allowListed("claude", "9.9.9"), false);
  const list = [{ host: "claude", minVersion: "2.1.400" }];
  assert.equal(allowListed("claude", "2.1.314", { list }), false, "older than the version that ships the signal");
  assert.equal(allowListed("claude", "2.1.400", { list }), true);
  assert.equal(allowListed("claude", "2.2.0", { list }), true);
  assert.equal(allowListed("codex", "9.0.0", { list }), false);
  assert.equal(allowListed("claude", null, { list }), false, "an unknown version never qualifies");
  const typed = promptSource({ prompt: "never use npm here" }, { env: {}, scheduled: [] });
  assert.deepEqual(typed, { typed: true, why: "typed", provisionalEligible: false });
});

test("on an allow-listed host only typed prompts become provisional; every other source stays pending", async () => {
  const { PLAN_CLEAR_CONTEXT_PREFIX } = await import("../src/hooks/generated-prompts.mjs");
  const list = [{ host: "claude", minVersion: "2.1.400" }];
  const opts = (extra = {}) => ({ host: "claude", version: "2.1.400", env: {}, scheduled: [], list, ...extra });
  assert.deepEqual(promptSource({ prompt: "never use npm in this repo" }, opts()), { typed: true, why: "typed", provisionalEligible: true });
  const wake = "check the deploy again and report back";
  const others = [
    [{ prompt: "never use npm here", agent_id: "a1" }, opts(), "a subagent"],
    [{ prompt: "never use npm here", agent_type: "Explore" }, opts(), "a subagent type"],
    [{ prompt: `${PLAN_CLEAR_CONTEXT_PREFIX}\n\n1. use pnpm` }, opts(), "a plan hand-off"],
    [{ prompt: "<task-notification>\n<result>use pnpm</result>\n</task-notification>" }, opts(), "a background task's report"],
    [{ prompt: wake }, opts({ scheduled: [{ h: promptHash(wake), k: "scheduled", t: Date.now() }] }), "a ScheduleWakeup prompt"],
    [{ prompt: wake }, opts({ scheduled: [{ h: promptHash(wake), k: "subagent", t: Date.now() }] }), "a subagent's last message"],
    [{ prompt: "never use npm here" }, opts({ env: { CLAUDE_CODE_SESSION_ATTENDED: "0" } }), "headless"],
    [{ prompt: "never use npm here" }, opts({ env: { AD_WORKER: "1" } }), "ad's worker"],
    [{ prompt: "never use npm here", source: "loop_wakeup" }, opts(), "a loop wake-up"],
    [{ prompt: "never use npm here" }, opts({ host: "codex" }), "a host not on the list"],
    [{ prompt: "never use npm here" }, opts({ version: "2.1.314" }), "an older version"],
  ];
  for (const [input, o, why] of others) assert.equal(promptSource(input, o).provisionalEligible, false, why);
});

test("prompt sources from the real S-HOOKS captures, and the other non-typed shapes", () => {
  const cc = JSON.parse(fs.readFileSync(path.join(FIXTURES, "claude-code", "scheduled.json"), "utf8"));
  const prompts = cc.hooks.filter((h) => h.payload?.hook_event_name === "UserPromptSubmit");
  assert.ok(prompts.length >= 2);
  // The spike ran headless: every prompt there is marked so.
  for (const h of prompts) assert.equal(promptSource(h.payload, { env: h.env ?? {}, scheduled: [] }).why, "headless");
  // Without the headless markers, the ScheduleWakeup prompt is told apart only by its recorded input.
  const wake = cc.hooks.find((h) => h.payload?.tool_name === "ScheduleWakeup");
  const wakePrompt = wake?.payload?.tool_input?.prompt;
  assert.ok(wakePrompt, "the capture holds the ScheduleWakeup input");
  const fired = prompts.find((h) => promptHash(h.payload.prompt) === promptHash(wakePrompt));
  assert.ok(fired, "the scheduled prompt fired as UserPromptSubmit");
  assert.equal(promptSource(fired.payload, { env: {}, scheduled: [] }).typed, true, "without the record it looks typed");
  assert.equal(promptSource(fired.payload, { env: {}, scheduled: [{ h: promptHash(wakePrompt), k: "scheduled", t: Date.now() }] }).why, "a scheduled prompt");
  // Other shapes.
  const env = {};
  assert.equal(promptSource({ prompt: "<task-notification>\n<task-id>x</task-id>\n</task-notification>" }, { env, scheduled: [] }).why, "not typed text");
  assert.equal(promptSource({ prompt: "hi", agent_id: "a1" }, { env, scheduled: [] }).why, "subagent");
  assert.equal(promptSource({ prompt: "hi", source: "loop_wakeup" }, { env, scheduled: [] }).why, "source loop_wakeup");
  assert.equal(promptSource({ prompt: "hi", source: "user" }, { env, scheduled: [] }).typed, true);
  assert.equal(promptSource({ prompt: "hi" }, { env: { AD_WORKER: "1" }, scheduled: [] }).why, "ad worker");
  assert.equal(promptSource({ prompt: "hi" }, { env: { CLAUDE_CODE_SESSION_ATTENDED: "0" }, scheduled: [] }).why, "headless");
});

test("scheduled-prompt hashes: recorded, read back, kept to a window", () => {
  const root = tmp();
  const t0 = Date.parse("2026-11-05T00:00:00Z");
  recordScheduled("  never   use npm ", { root, now: t0 });
  recordScheduled("old one", { root, now: t0 - 8 * 86_400_000 });
  const got = readScheduled({ root, now: t0 });
  assert.deepEqual(got.map((e) => e.h), [promptHash("never use npm")]);
  for (let i = 0; i < 520; i++) recordScheduled(`p${i}`, { root, now: t0 + i });
  assert.equal(readScheduled({ root, now: t0 + 600 }).length, 500);
  fs.writeFileSync(path.join(root, "hooks", "scheduled.jsonl"), "not json\n");
  assert.deepEqual(readScheduled({ root, now: t0 }), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("detached jobs start once per window, never twice at once", () => {
  const root = tmp();
  const calls = [];
  const spawnFn = (cmd, args) => (calls.push(args), { unref() {} });
  const t = Date.now();
  assert.equal(spawnDetached(["x.mjs"], { key: "digest-1", root, now: t, spawnFn }), true);
  assert.equal(spawnDetached(["x.mjs"], { key: "digest-1", root, now: t + 1000, spawnFn }), false);
  assert.equal(spawnDetached(["x.mjs"], { key: "digest-2", root, now: t + 1000, spawnFn }), true);
  assert.equal(calls.length, 2);
  // A job runs outside the hook: no hook-only variables (it may upgrade the store), in node's own folder.
  const seen = [];
  spawnDetached(["x.mjs"], { root, spawnFn: (cmd, args, o) => (seen.push(o), { unref() {} }), env: jobEnv({ AD_HOOK_NO_MIGRATE: "1", AD_HOOK_EVENT: "session.end", AGENT_DAEMON_FALLBACK_LLM: "1", KEEP: "1" }, ["AGENT_DAEMON_FALLBACK_LLM"]) });
  assert.deepEqual(seen[0].env, { KEEP: "1" });
  assert.equal(seen[0].cwd, path.dirname(process.execPath));
  assert.deepEqual(Object.keys(jobEnv({ AD_HOOK_NO_MIGRATE: "1", A: "x" })), ["A"]);
  fs.rmSync(root, { recursive: true, force: true });
});

function runHook(event, payload, { env = {}, root, home } = {}) {
  const e = { ...process.env, HOME: home, USERPROFILE: home, AD_ROOT: root, ...env };
  delete e.CLAUDE_PROJECT_DIR;
  delete e.CLAUDE_CODE_ENTRYPOINT;
  delete e.CLAUDE_CODE_SESSION_ATTENDED;
  delete e.AD_WORKER;
  return spawnSync(process.execPath, [HOOK, event], { input: JSON.stringify(payload), env: { ...e, ...env }, encoding: "utf8", timeout: 60_000 });
}

test("spawned tool.before: the decision on stdout, exit 0; an unknown event is a no-op", () => {
  const { base, root, project } = setup();
  const r = runHook("tool.before", bash("npm install", project), { root, home: base });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "ask");
  const none = runHook("tool.before", bash("ls", project), { root, home: base });
  assert.equal(none.stdout, "");
  const unknown = runHook("no.such.event", {}, { root, home: base });
  assert.deepEqual([unknown.status, unknown.stdout], [0, "{}"]);
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); // a store upgrade the hook started may still be running
});

test("tool.before never loads the memory store, the project registry or the full CLI", { skip: typeof (await import("node:module")).registerHooks !== "function" && "needs module.registerHooks (Node 22.15+)" }, () => {
  const { base, root, project } = setup();
  const preload = path.join(base, "trace.mjs");
  fs.writeFileSync(preload, 'import { registerHooks } from "node:module";\nregisterHooks({ resolve(spec, ctx, next) { const r = next(spec, ctx); if (r?.url) process.stderr.write("LOADED " + r.url + "\\n"); return r; } });\n');
  const e = { ...process.env, HOME: base, USERPROFILE: base, AD_ROOT: root };
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, HOOK, "tool.before"], { input: JSON.stringify(bash("npm install", project)), env: e, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const loaded = r.stderr.split("\n").filter((l) => l.startsWith("LOADED ")).map((l) => l.slice(7));
  assert.ok(loaded.some((u) => u.endsWith("/rules/match.mjs")), "the matcher is loaded");
  for (const banned of ["/cli-full.mjs", "/memory/sqlite.mjs", "/memory/driver.mjs", "/memory/episodic.mjs", "/memory/projects.mjs", "/lock.mjs", "better-sqlite3", "node:sqlite"]) {
    assert.ok(!loaded.some((u) => u.includes(banned)), `tool.before loaded ${banned}`);
  }
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); // a store upgrade the hook started may still be running
});

test("spawned prompt.submit: a typed correction is journaled with its source; a scheduled one isn't", () => {
  const base = tmp();
  const root = path.join(base, "ad");
  const project = path.join(base, "work", "app");
  fs.mkdirSync(path.join(project, ".agent-daemon", "memory"), { recursive: true });
  const journal = path.join(project, ".agent-daemon", "learning-journal.jsonl");
  const typed = runHook("prompt.submit", { session_id: "s1", cwd: project, prompt: "actually we use pnpm in this repo", hook_event_name: "UserPromptSubmit" }, { root, home: base });
  assert.equal(typed.status, 0, typed.stderr);
  const lines = fs.readFileSync(journal, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.length >= 1);
  assert.ok(lines.every((l) => l.prompt_source === "typed" && l.provisional_eligible === false));
  // The same words, scheduled earlier by ScheduleWakeup, come back: not captured.
  const scheduledText = "actually we use yarn in this repo";
  const after = runHook("tool.after", { session_id: "s1", cwd: project, tool_name: "ScheduleWakeup", tool_input: { prompt: scheduledText, delaySeconds: 60 } }, { root, home: base });
  assert.equal(after.status, 0, after.stderr);
  runHook("prompt.submit", { session_id: "s1", cwd: project, prompt: scheduledText, hook_event_name: "UserPromptSubmit" }, { root, home: base });
  const again = fs.readFileSync(journal, "utf8");
  assert.ok(!again.includes("yarn"), "the scheduled prompt isn't captured");
  // A subagent's last message, then the same text as a prompt: not captured either.
  runHook("subagent.stop", { session_id: "s1", cwd: project, last_assistant_message: "actually we use bun in this repo" }, { root, home: base });
  runHook("prompt.submit", { session_id: "s1", cwd: project, prompt: "actually we use bun in this repo" }, { root, home: base });
  assert.ok(!fs.readFileSync(journal, "utf8").includes("bun"));
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); // a store upgrade the hook started may still be running
});

test("toolDecision: an ask the host can't show becomes deny; the notice only where the host shows it", () => {
  assert.equal(toolDecision("ask", { host: "codex", reason: "r", notice: "n" }).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(toolDecision("ask", { host: "claude", permissionMode: "acceptEdits", reason: "r", notice: "n" }).hookSpecificOutput.permissionDecision, "ask");
  assert.equal(toolDecision("deny", { host: "claude", reason: "r", notice: "n" }).systemMessage, "n");
});

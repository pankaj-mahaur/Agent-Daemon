// L2 part 2: the hook routes (hooks/routes.mjs). The route table per profile
// and host, how ad's entries are recognised, the settings.json planner `ad
// init` uses, the duplicate-route test through a real `ad init` run twice, and
// the dispatcher events that took over the older `ad hook …` entries.
// Temp homes and AD_ROOT only; no host runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EVENTS, HOOK_PATH, ROUTES, claudeGroup, classifyHandler, duplicateSteps, entryAlive, installedSteps, planClaudeHooks, routesFor } from "../src/hooks/routes.mjs";
import { resolveProfile } from "../src/profiles.mjs";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ad-routes-"));
const stepsOf = async (profile) => (await resolveProfile(profile)).hooks.map((h) => h.id);
const key = (r) => `${r.hostEvent}:${r.event}`;

function cleanEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, AD_ROOT: path.join(home, "ad-root"), ...extra };
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_PROJECT_DIR", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED", "AD_WORKER", "AD_HOOK_HOST", "AD_PROFILE"]) if (!(k in extra)) delete env[k];
  return env;
}

test("routes per profile and host: one per host event and dispatcher event; the rules check on every install", async () => {
  for (const profile of ["minimal", "developer", "security"]) {
    const steps = await stepsOf(profile);
    for (const host of ["claude", "codex"]) {
      const routes = routesFor(steps, host);
      assert.equal(new Set(routes.map(key)).size, routes.length, `${profile}/${host}: a route twice`);
      assert.ok(routes.every((r) => EVENTS.includes(r.event)));
      const before = routes.find((r) => r.event === "tool.before");
      assert.ok(before, `${profile}/${host}: tool.before is installed at setup`);
      assert.deepEqual(before.matcher.split("|").sort(), (host === "claude" ? ["Bash", "PowerShell", "Write", "Edit"] : ["Bash", "Write", "Edit"]).sort());
      // Every step the profile names is served by exactly one route.
      for (const s of steps.filter((s) => routes.length && ROUTES.some((r) => r.steps.includes(s) || r.stepMatchers?.[s]))) {
        const serving = routes.filter((r) => r.steps.includes(s));
        const claudeOnly = ["skill-use", "slash-command-use"].includes(s);
        assert.equal(serving.length, host === "codex" && claudeOnly ? 0 : 1, `${profile}/${host}: ${s}`);
      }
    }
  }
  const c = routesFor(await stepsOf("minimal"), "claude");
  assert.equal(c.find((r) => r.event === "tool.after").matcher, "CronCreate|ScheduleWakeup", "Claude Code records scheduled prompts on every install");
  assert.ok(c.find((r) => r.event === "subagent.stop"));
  const x = routesFor(await stepsOf("minimal"), "codex");
  assert.deepEqual(x.map((r) => r.event).sort(), ["prompt.submit", "session.end", "session.start", "tool.before"]);
  assert.equal(x.find((r) => r.event === "session.end").timeout, 3, "Codex caps SessionEnd at 3 s");
  assert.ok(x.filter((r) => r.event !== "session.end").every((r) => r.timeout >= 10));
  const dev = routesFor(await stepsOf("developer"), "claude").find((r) => r.event === "tool.after");
  assert.deepEqual(dev.matcher.split("|").sort(), ["Bash", "CronCreate", "Edit", "MultiEdit", "ScheduleWakeup", "Write"]);
  const sec = routesFor(await stepsOf("security"), "claude").map((r) => r.event);
  assert.ok(sec.includes("bash.guard") && sec.includes("mcp.audit"));
});

test("classifyHandler: ad's older entries, dispatcher routes (exec and shell form), and what isn't ad's", () => {
  const cases = [
    [{ command: "ad hook user-prompt-extract" }, "UserPromptSubmit", null, "legacy", ["user-prompt-extract"]],
    [{ command: "agent-daemon session-start --output-json" }, "SessionStart", null, "legacy", ["session-start"]],
    [{ command: "ad.cmd query-retrieve --output-json" }, "UserPromptSubmit", null, "legacy", ["query-retrieve"]],
    [{ command: '"C:/n/node.exe" "D:/x/runtime/src/cli.mjs" hook bash-pre --host ad' }, "PreToolUse", "Bash", "legacy", ["bash-pre-guard"]],
    [{ command: "ad hook skill-use" }, "UserPromptExpansion", null, "legacy", ["slash-command-use"]],
    [{ command: "ad hook skill-use" }, "PreToolUse", "Skill", "legacy", ["skill-use"]],
    [{ command: "ad digest --fallback-to-llm" }, "SessionEnd", null, "legacy", ["session-end"]],
    [{ command: "node", args: ["/opt/ad/runtime/bin/hook.mjs", "tool.before"] }, "PreToolUse", "Bash|PowerShell|Write|Edit", "dispatcher", ["rules-check"]],
    [{ command: "node", args: ["C:\\ad\\runtime\\bin\\hook.mjs", "tool.after"] }, "PostToolUse", "CronCreate|ScheduleWakeup|Bash", "dispatcher", ["scheduled-hashes", "bash-post-log"]],
    [{ command: "'node' '/opt/ad/runtime/bin/hook.mjs' prompt.submit --host ad" }, "UserPromptSubmit", null, "dispatcher", ["user-prompt-extract", "capability-route-advice", "query-retrieve"]],
  ];
  for (const [h, hostEvent, matcher, kind, steps] of cases) {
    const got = classifyHandler(h, { hostEvent, matcher });
    assert.equal(got?.kind, kind, JSON.stringify(h));
    assert.deepEqual(got.steps, steps, JSON.stringify(h));
  }
  // Another tool's cli.mjs or hook.mjs, whatever word follows, is never ad's: ad init would delete it.
  const others = [
    { command: "ad digest-latest" },
    { command: "ad hook not-a-step" },
    { command: "my-tool session-start" },
    { command: "bash ~/.claude/hooks/session-start.sh" },
    { command: 'node "C:/Users/u/.mem-tool/dist/cli.mjs" session-start' },
    { command: "node ~/tools/notes/cli.mjs digest" },
    { command: "node", args: ["C:/tools/guard/hook.mjs", "tool.before"] },
    { command: "node /opt/guard/hook.mjs tool.before" },
    { command: "node", args: ["/x/server/hook.mjs", "prompt.submit"] },
    { command: "node", args: ["/x/runtime/bin/hook.mjs", "prompt"] },
    null,
  ];
  for (const h of others) assert.equal(classifyHandler(h, { hostEvent: "SessionStart" }), null, JSON.stringify(h));
  // The plugin's own entry is the dispatcher, marked so (it never counts as ad init's).
  assert.equal(classifyHandler({ command: 'node "${CLAUDE_PLUGIN_ROOT}/server/hook.mjs" session.start --host claude-code --plugin' }, { hostEvent: "SessionStart" }).plugin, true);
  // A shell-form route with a quoted path, spaces and a quote in it.
  const odd = "/opt/my ad/it's/runtime/bin/hook.mjs";
  const shell = classifyHandler(claudeGroup({ event: "session.start", hostEvent: "SessionStart", matcher: null, timeout: 10 }, { hookPath: odd, form: "string" }).hooks[0], { hostEvent: "SessionStart" });
  assert.deepEqual([shell.kind, shell.event, shell.script], ["dispatcher", "session.start", odd]);
  // A route whose script is gone can't run.
  assert.equal(entryAlive({ kind: "dispatcher", plugin: false, script: path.join(os.tmpdir(), "no-such-ad", "runtime", "bin", "hook.mjs") }), false);
  assert.equal(entryAlive({ kind: "dispatcher", plugin: false, script: HOOK_PATH }), true);
  assert.equal(entryAlive({ kind: "legacy", script: null }), true, "older entries go through PATH");
});

test("planClaudeHooks keeps the user's settings on ad's entries it replaces; the shell form for an older Claude Code", async () => {
  const hookPath = "/opt/ad/runtime/bin/hook.mjs";
  const steps = await stepsOf("minimal");
  const before = {
    SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "ad session-start --output-json", timeout: 30, if: "test -d .agent-daemon" }] }],
    SessionEnd: [{ hooks: [{ type: "command", command: "ad hook session-end-digest", async: true }] }],
  };
  const plan = planClaudeHooks(before, { steps, hookPath });
  const start = plan.hooks.SessionStart.at(-1);
  assert.equal(start.matcher, "startup", "a matcher every replaced entry shared");
  assert.equal(start.hooks[0].if, "test -d .agent-daemon");
  assert.equal(start.hooks[0].timeout, 30, "the longer timeout");
  assert.equal(plan.hooks.SessionEnd.at(-1).hooks[0].async, true);
  assert.equal(planClaudeHooks(plan.hooks, { steps, hookPath }).changed, false, "stable once carried");
  // Shell form: node '<path>' <event>; idempotent in that form; switching forms rewrites.
  const shell = planClaudeHooks(undefined, { steps, hookPath, form: "string" });
  const h = shell.hooks.UserPromptSubmit[0].hooks[0];
  assert.deepEqual([h.command, h.args], [`node '${hookPath}' prompt.submit`, undefined]);
  assert.equal(planClaudeHooks(shell.hooks, { steps, hookPath, form: "string" }).changed, false);
  assert.equal(planClaudeHooks(shell.hooks, { steps, hookPath, form: "exec" }).changed, true);
});

test("planClaudeHooks: older entries become routes; the user's hooks, a guard and onFailure stay; a second run changes nothing", async () => {
  const hookPath = "/opt/ad/runtime/bin/hook.mjs";
  const mine = { type: "command", command: "my-formatter --check", timeout: 2 };
  const before = {
    SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "ad session-start --output-json", timeout: 5 }] }],
    UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: "ad hook user-prompt-extract", timeout: 3 }, mine] }, { hooks: [{ type: "command", command: "ad query-retrieve --output-json" }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "ad hook bash-pre", timeout: 3 }] }, { matcher: "Bash|PowerShell|Write|Edit", hooks: [{ type: "command", command: "node", args: ["/old/place/runtime/bin/hook.mjs", "tool.before"], timeout: 5, onFailure: "block" }] }],
    Notification: [{ hooks: [mine] }],
  };
  const snapshot = JSON.stringify(before);
  const plan = planClaudeHooks(before, { steps: await stepsOf("minimal"), hookPath });
  assert.equal(JSON.stringify(before), snapshot, "the input isn't changed in place");
  assert.equal(plan.changed, true);
  const ours = Object.entries(plan.hooks).flatMap(([ev, gs]) => gs.flatMap((g) => g.hooks.map((h) => ({ ev, g, h, info: classifyHandler(h, { hostEvent: ev, matcher: g.matcher }) })))).filter((x) => x.info);
  assert.ok(ours.every((x) => x.info.kind === "dispatcher" && x.h.command === "node" && x.h.args[0] === hookPath), "every entry of ad's is a dispatcher route at this install's path");
  assert.equal(new Set(ours.map((x) => `${x.ev}:${x.info.event}`)).size, ours.length, "one route per host event and dispatcher event");
  assert.ok(ours.some((x) => x.info.event === "bash.guard"), "a guard the user had stays, though the profile doesn't name it");
  assert.equal(ours.find((x) => x.info.event === "tool.before").h.onFailure, "block", "fail-closed set by the review service is kept");
  assert.deepEqual(plan.hooks.Notification, before.Notification, "another event's hooks are untouched");
  assert.ok(plan.hooks.UserPromptSubmit.some((g) => g.hooks.includes(mine) || g.hooks.some((h) => h.command === mine.command)), "the user's own hook in a shared group stays");
  assert.equal(plan.removed.filter((o) => o.info.kind === "legacy").length, 4);
  const again = planClaudeHooks(plan.hooks, { steps: await stepsOf("minimal"), hookPath });
  assert.equal(again.changed, false);
  assert.equal(again.hooks, plan.hooks, "an exact install is left alone");
  // Moved install: the path changed, so the routes are rewritten at the new path.
  const moved = planClaudeHooks(plan.hooks, { steps: await stepsOf("minimal"), hookPath: "/new/runtime/bin/hook.mjs" });
  assert.equal(moved.changed, true);
  assert.ok(Object.values(moved.hooks).flat().flatMap((g) => g.hooks).filter((h) => h.args).every((h) => h.args[0] === "/new/runtime/bin/hook.mjs"));
  // Nothing of ad's at all: the routes are added.
  const fresh = planClaudeHooks(undefined, { steps: await stepsOf("minimal"), hookPath });
  assert.equal(fresh.changed, true);
  assert.deepEqual(Object.keys(fresh.hooks).sort(), ["PostToolUse", "PreToolUse", "SessionEnd", "SessionStart", "SubagentStop", "UserPromptExpansion", "UserPromptSubmit"]);
});

// The duplicate guard of agent-daemon-memory 3.1.0 (released; frozen here from its plugin-hook.mjs):
// it stands aside only when ad's own command words are in the settings.
const adCommand310 = (step) => new RegExp(String.raw`(?:(?:^|[\s"'/\\])(?:ad|agent-daemon)(?:\.cmd|\.ps1|\.exe)?["']?|[\\/]cli\.mjs["']?)\s+${step}(?:\s|$|["'])`);
const GUARD_310 = { "user-prompt-extract": ["UserPromptSubmit", adCommand310(String.raw`hook\s+user-prompt-extract`)], "query-retrieve": ["UserPromptSubmit", adCommand310("query-retrieve")], "session-start": ["SessionStart", adCommand310("session-start")] };
const guard310 = (hooks, step) => (hooks?.[GUARD_310[step][0]] ?? []).some((g) => (g?.hooks ?? []).some((h) => GUARD_310[step][1].test(String(h?.command ?? "")) && h?.if === undefined));

test("a memory plugin from before the dispatcher: the prompt and session-start routes carry the words it stands aside for", async () => {
  const hookPath = "C:\\Program Files\\ad\\runtime\\bin\\hook.mjs";
  const steps = await stepsOf("minimal");
  const exec = planClaudeHooks(undefined, { steps, hookPath });
  assert.deepEqual(["user-prompt-extract", "query-retrieve", "session-start"].map((s) => guard310(exec.hooks, s)), [false, false, false], "plain routes: the 3.1.0 plugin would run every step again");
  const tagged = planClaudeHooks(undefined, { steps, hookPath, oldPluginTags: true });
  assert.deepEqual(["user-prompt-extract", "query-retrieve", "session-start"].map((s) => guard310(tagged.hooks, s)), [true, true, true]);
  const prompt = tagged.hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(prompt.command, `node '${hookPath}' prompt.submit # ad hook user-prompt-extract ad query-retrieve`);
  const info = classifyHandler(prompt, { hostEvent: "UserPromptSubmit" });
  assert.deepEqual([info.kind, info.event, info.script], ["dispatcher", "prompt.submit", hookPath], "still ad's route, at its path");
  assert.ok(tagged.hooks.PreToolUse[0].hooks[0].args, "other routes stay in exec form");
  assert.equal(planClaudeHooks(tagged.hooks, { steps, hookPath, oldPluginTags: true }).changed, false);
  assert.equal(planClaudeHooks(tagged.hooks, { steps, hookPath }).changed, true, "the plugin updated: back to exec form");
  // The dispatcher runs the tagged command's event, whatever words follow.
  const home = tmp();
  try {
    const r = spawnSync(process.execPath, [HOOK_PATH, "session.start", "#", "ad", "session-start"], { input: "{}", env: cleanEnv(home, { AGENT_DAEMON_DISABLE_SWEEP: "1" }), cwd: home, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /hookSpecificOutput|^\{\}$/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});

function runInit(home, project, profile = "minimal") {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "init", "--cwd", project, "--profile", profile, "--skills-mode", "manual"], { env: cleanEnv(home), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
  });
}

test("duplicate routes: ad init twice leaves each route once; older and newer entries for one step are found, then merged", async () => {
  const home = tmp();
  const project = path.join(home, "work", "app");
  fs.mkdirSync(project, { recursive: true });
  const settingsFile = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const mine = { type: "command", command: "my-own-hook" };
  // An install halfway: the older capture entry and a dispatcher route both run the capture step,
  // the rules check is in twice, and the user had the Bash guard.
  const seeded = {
    model: "opus",
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "ad hook user-prompt-extract" }] }, { hooks: [{ type: "command", command: "node", args: [HOOK_PATH, "prompt.submit"], timeout: 10 }, mine] }],
      PreToolUse: [
        { matcher: "Bash|PowerShell|Write|Edit", hooks: [{ type: "command", command: "node", args: [HOOK_PATH, "tool.before"], timeout: 5 }] },
        { matcher: "Bash|PowerShell|Write|Edit", hooks: [{ type: "command", command: "node", args: [HOOK_PATH, "tool.before"], timeout: 5 }] },
        { matcher: "Bash", hooks: [{ type: "command", command: "ad hook bash-pre" }] },
      ],
    },
  };
  fs.writeFileSync(settingsFile, JSON.stringify(seeded));
  const dups = duplicateSteps([{ name: settingsFile, hooks: seeded.hooks }]).map((d) => d.step).sort();
  assert.deepEqual(dups, ["rules-check", "user-prompt-extract"]);
  try {
    const first = await runInit(home, project);
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /through the dispatcher/);
    const s1 = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert.equal(s1.model, "opus", "other settings stay");
    assert.deepEqual(duplicateSteps([{ name: "settings", hooks: s1.hooks }]), [], "no step runs twice");
    const ours = Object.entries(s1.hooks).flatMap(([ev, gs]) => gs.flatMap((g) => g.hooks.map((h) => [ev, classifyHandler(h, { hostEvent: ev, matcher: g.matcher })]))).filter(([, i]) => i);
    assert.equal(new Set(ours.map(([ev, i]) => `${ev}:${i.event}`)).size, ours.length, "each route once");
    assert.ok(ours.every(([, i]) => i.kind === "dispatcher"));
    assert.ok(installedSteps(s1.hooks).has("bash-pre-guard"), "the guard the user had is kept");
    assert.ok(JSON.stringify(s1.hooks).includes("my-own-hook"), "the user's own hook stays");
    const second = await runInit(home, project);
    assert.equal(second.code, 0, second.out);
    assert.doesNotMatch(second.out, /hook route/, "nothing to do the second time");
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")), s1, "the second run leaves the file as it was");
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); // a store upgrade the hook started may still be running
  }
});

function runHook(event, payload, { home, args = [], env = {} } = {}) {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  return spawnSync(process.execPath, [HOOK_PATH, event, ...args], { input, env: cleanEnv(home, env), cwd: home, encoding: "utf8", timeout: 60_000 });
}

test("spawned dispatcher: every event exits 0 with JSON (or nothing), whatever the input", () => {
  const home = tmp();
  try {
    const valid = { cwd: home, session_id: "s", tool_name: "Bash", tool_input: { command: "ls" }, prompt: "hello there friend" };
    const runs = [["{ torn", []], ["[]", []], [valid, []], [valid, ["--host", "ad"]], [valid, ["--host", "claude-code", "--plugin"]]];
    for (const event of [...EVENTS, "no.such.event"]) {
      for (const [payload, args] of runs) {
        const r = runHook(event, payload, { home, args });
        assert.equal(r.status, 0, `${event} ${JSON.stringify(payload)} ${args}: ${r.stderr}`);
        if (r.stdout !== "") assert.doesNotThrow(() => JSON.parse(r.stdout), `${event}: ${r.stdout}`);
      }
    }
    // A step that throws (a malformed edit payload): still exit 0 with {}, and the failure is logged.
    const broken = runHook("tool.after", { cwd: home, tool_name: "Edit", tool_input: { file_paths: { length: 1 } } }, { home });
    assert.deepEqual([broken.status, broken.stdout], [0, "{}"], broken.stderr);
    assert.match(fs.readFileSync(path.join(home, "ad-root", "hooks", "hook.log"), "utf8"), /tool\.after failed: /);
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); // a store upgrade the hook started may still be running
  }
});

test("the steps behind the routes act as their older hooks did", () => {
  const home = tmp();
  try {
    // bash.guard: blocks --no-verify; anything else passes through (never an allow).
    const blocked = runHook("bash.guard", { tool_name: "Bash", tool_input: { command: "git commit -m x --no-verify" } }, { home });
    assert.equal(JSON.parse(blocked.stdout).decision, "block");
    assert.deepEqual(JSON.parse(runHook("bash.guard", { tool_name: "Bash", tool_input: { command: "ls" } }, { home }).stdout), {});
    const engine = runHook("bash.guard", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push --no-verify" } }, { home, args: ["--host", "ad"] });
    assert.equal(JSON.parse(engine.stdout).hookSpecificOutput.permissionDecision, "deny", "the engine's deny shape");
    // mcp.audit: logged, a warning for an untrusted server, never an allow.
    const audit = runHook("mcp.audit", { tool_name: "mcp__sketchy__exfil", session_id: "s" }, { home });
    assert.deepEqual(JSON.parse(audit.stdout), {});
    assert.match(audit.stderr, /non-trusted server 'sketchy'/);
    // tool.after: Bash output is read, a CronCreate prompt recorded.
    const pr = runHook("tool.after", { tool_name: "Bash", tool_input: { command: "gh pr create" }, tool_response: { output: "https://github.com/o/r/pull/7" } }, { home });
    assert.match(pr.stderr, /PR created/);
    runHook("tool.after", { tool_name: "CronCreate", session_id: "s", tool_input: { prompt: "check the deploy" } }, { home });
    assert.ok(fs.readFileSync(path.join(home, "ad-root", "hooks", "scheduled.jsonl"), "utf8").length > 0);
    // prompt.submit: the routing advice and recall come back as one context.
    const advice = runHook("prompt.submit", { session_id: "s", cwd: home, prompt: "please run a security audit of the login flow", hook_event_name: "UserPromptSubmit" }, { home });
    const ctx = JSON.parse(advice.stdout).hookSpecificOutput;
    assert.equal(ctx.hookEventName, "UserPromptSubmit");
    assert.match(ctx.additionalContext, /security-audit/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); // a store upgrade the hook started may still be running
  }
});

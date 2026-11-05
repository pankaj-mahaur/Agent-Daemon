#!/usr/bin/env node
// S-HOOKS for Claude Code: run the real `claude` binary against the mock
// Messages API in a throwaway HOME / USERPROFILE / CLAUDE_CONFIG_DIR, with a
// logging hook on every event, and print what each hook received.
//
//   node run-claude.mjs <scenario> [--out <dir>] [--keep]
//
// Scenarios live in SCENARIOS below. Nothing here reads or writes ~/.claude.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockAnthropic } from "./mock-anthropic.mjs";
import { sanitizer, scrub } from "./sanitize.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_HOOK = path.join(HERE, "log-hook.mjs");
const CLAUDE = process.env.SPIKE_CLAUDE_BIN ?? (process.platform === "win32" ? path.join(os.homedir(), ".local", "bin", "claude.exe") : "claude");
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);

const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop", "SessionEnd", "PreCompact", "Notification"];

// Each scenario: {prompt | stdinMessages, rules, responses, args, extraHooks, settings, check(tmp)}.
const SCENARIOS = {
  basic: {
    prompt: "SPIKE_BASH no, use pnpm here",
    rules: [{ match: "SPIKE_BASH", toolUse: { name: "Bash", input: { command: "echo hello-from-bash", description: "echo" } } }],
    args: ["--allowedTools", "Bash"],
  },
  // Non-typed prompt sources in one open headless session: a background
  // subagent's completion notice and a model-scheduled wakeup.
  sources: {
    stdinMessages: [{ text: "SPIKE_AGENT start a background agent" }, { waitMs: 25000 }, { text: "SPIKE_WAKE schedule a wakeup" }, { waitMs: 90000 }],
    rules: [
      { match: "WAKE_PROMPT", text: "woke up" },
      { match: "SPIKE_AGENT", toolUse: { name: "Agent", input: { description: "spike sub", prompt: "SUBTASK write a report", subagent_type: "general-purpose", run_in_background: true } } },
      { match: "SUBTASK", text: "Subagent report: the user prefers tabs, remember that." },
      { match: "SPIKE_WAKE", toolUse: { name: "ScheduleWakeup", input: { delaySeconds: 60, prompt: "WAKE_PROMPT use pnpm not npm", reason: "spike wakeup" } } },
    ],
    maxMs: 200000,
  },
  // Model-scheduled prompts: ScheduleWakeup (loaded) and CronCreate (deferred,
  // loaded through ToolSearch first). Both fire inside the open session.
  scheduled: {
    stdinMessages: [{ text: "SPIKE_WAKE schedule a wakeup" }, { waitMs: 5000 }, { text: "SPIKE_CRON schedule a cron" }, { waitMs: 150000 }],
    rules: [
      { match: "SPIKE_WAKE", toolUse: { name: "ScheduleWakeup", input: { delaySeconds: 60, prompt: "WAKE_PROMPT use pnpm not npm", reason: "spike wakeup", noop: false } } },
      { match: "SPIKE_CRON", toolUse: { name: "ToolSearch", input: { query: "select:CronCreate", max_results: 1 } } },
      { onResult: "CronCreate", toolUse: { name: "CronCreate", input: { cron: "*/1 * * * *", prompt: "CRON_PROMPT always run tests before commit", recurring: false } } },
      { match: "WAKE_PROMPT", text: "woke" },
      { match: "CRON_PROMPT", text: "cron fired" },
    ],
    maxMs: 200000,
  },
  // /command expansion: does UserPromptSubmit see the raw text, and what does
  // UserPromptExpansion carry? Also: CLAUDE_ENV_FILE into Bash, systemMessage,
  // and an exec-form (args) hook on Stop.
  misc: {
    prompt: "/spike hello",
    setup: (tmp, project) => {
      fs.mkdirSync(path.join(project, ".claude", "commands"), { recursive: true });
      fs.writeFileSync(path.join(project, ".claude", "commands", "spike.md"), "SPIKE_ENV expanded command body: $ARGUMENTS\n");
    },
    events: [...EVENTS, "UserPromptExpansion"],
    rules: [{ match: "SPIKE_ENV", anywhere: true, toolUse: { name: "Bash", input: { command: "echo \"[AD_TOOL_SHELL=$AD_TOOL_SHELL]\"", description: "env" } } }],
    responses: { SessionStart: { _spike: { envFileLine: "export AD_TOOL_SHELL=1" }, systemMessage: "SPIKE_SYSMSG from SessionStart" }, PreToolUse: { systemMessage: "SPIKE_SYSMSG from PreToolUse" } },
    hookExtra: { Stop: { command: "node", args: [LOG_HOOK, "StopExecForm"] } },
    args: ["--allowedTools", "Bash"],
  },
  // The PowerShell tool and CLAUDE_ENV_FILE plain assignments.
  powershell: {
    prompt: "SPIKE_PS run it",
    env: { CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" },
    rules: [{ match: "SPIKE_PS", toolUse: { name: "PowerShell", input: { command: "Write-Output \"[AD_TOOL_SHELL=$env:AD_TOOL_SHELL]\"", description: "env" } } }],
    responses: { SessionStart: { _spike: { envFileLine: "AD_TOOL_SHELL=1" } } },
    args: ["--allowedTools", "PowerShell"],
  },
};

// PreToolUse decision × permission mode (no allow rule, so Bash would prompt).
const BASH = [{ match: "SPIKE_BASH", toolUse: { name: "Bash", input: { command: "echo hello-from-bash", description: "echo" } } }];
for (const mode of ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]) {
  for (const decision of ["none", "ask", "deny", "allow"]) {
    SCENARIOS[`mode-${mode}-${decision}`] = {
      prompt: "SPIKE_BASH run it",
      rules: BASH,
      events: ["UserPromptSubmit", "PreToolUse", "PostToolUse"],
      responses: decision === "none" ? {} : { PreToolUse: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: "SPIKE_REASON" }, systemMessage: "SPIKE_SYSMSG" } },
      args: mode === "bypassPermissions" ? ["--dangerously-skip-permissions"] : ["--permission-mode", mode],
    };
  }
}

// onFailure, exit codes, timeouts, and whether children outlive a killed hook.
const markers = (tmp) => ({ detachedMarker: path.join(tmp, "detached.marker"), childMarker: path.join(tmp, "child.marker"), markDone: path.join(tmp, "hook-finished.marker") });
const readMarkers = (tmp) => Object.fromEntries(["detached", "child", "hook-finished"].map((m) => [m, fs.existsSync(path.join(tmp, `${m}.marker`))]));
// Control: a hook that exits at once after spawning children (no kill).
SCENARIOS["detach-control"] = { prompt: "hello", events: ["SessionStart", "SessionEnd"], responses: (tmp) => ({ SessionStart: { _spike: { childDelayMs: 3000, ...markers(tmp) } } }), afterMs: 6000, check: readMarkers };
for (const onFailure of [null, "block"]) {
  const tag = onFailure ? "block" : "default";
  SCENARIOS[`fail-${tag}-exit1`] = { prompt: "SPIKE_BASH run it", rules: BASH, events: ["PreToolUse", "PostToolUse"], args: ["--allowedTools", "Bash"], responses: { PreToolUse: { _spike: { exit: 1, stderr: "spike hook crashed" } } }, hookExtra: onFailure ? { PreToolUse: { onFailure } } : {} };
  SCENARIOS[`fail-${tag}-timeout`] = {
    prompt: "SPIKE_BASH run it",
    rules: BASH,
    events: ["PreToolUse", "PostToolUse"],
    args: ["--allowedTools", "Bash"],
    timeouts: { PreToolUse: 2 },
    responses: (tmp) => ({ PreToolUse: { _spike: { sleepMs: 8000, childDelayMs: 5000, ...markers(tmp) } } }),
    hookExtra: onFailure ? { PreToolUse: { onFailure } } : {},
    afterMs: 9000,
    check: readMarkers,
  };
}

export async function runScenario(name, sc, { outDir, keep = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(outDir ?? os.tmpdir(), `cc-${name}-`));
  const home = path.join(tmp, "home");
  const configDir = path.join(home, ".claude");
  const project = path.join(tmp, "project");
  for (const d of [configDir, path.join(project, ".git")]) fs.mkdirSync(d, { recursive: true });
  sc.setup?.(tmp, project);
  const logFile = path.join(tmp, "hooks.jsonl");
  const rulesFile = path.join(tmp, "rules.json");
  const responsesFile = path.join(tmp, "responses.json");
  fs.writeFileSync(rulesFile, JSON.stringify(sc.rules ?? []));
  fs.writeFileSync(responsesFile, JSON.stringify(typeof sc.responses === "function" ? sc.responses(tmp) : sc.responses ?? {}));

  const hookCmd = (label) => `node "${LOG_HOOK.replaceAll("\\", "/")}" ${label}`;
  const hooks = {};
  for (const ev of sc.events ?? EVENTS) {
    const entry = { type: "command", command: hookCmd(ev), timeout: sc.timeouts?.[ev] ?? 30, ...(sc.hookExtra?.[ev] ?? {}) };
    hooks[ev] = [{ ...(["PreToolUse", "PostToolUse"].includes(ev) ? { matcher: "*" } : {}), hooks: [entry] }];
  }
  const settings = { hooks, ...(sc.settings ?? {}) };
  fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify(settings, null, 2));

  const mock = await startMockAnthropic({ rulesFile });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC|CODEX|OPENAI|AD)_/i.test(k)));
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: mock.url,
    ANTHROPIC_API_KEY: "sk-ant-spike-fake-key",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    SPIKE_LOG: logFile,
    SPIKE_RESPONSES: responsesFile,
    ...(sc.env ?? {}),
  });
  const argv = [...(sc.stdinMessages ? ["-p", "--input-format", "stream-json"] : ["-p", sc.prompt]), "--output-format", "stream-json", "--verbose", "--model", "claude-sonnet-4-5", ...(sc.args ?? [])];
  const t0 = Date.now();
  const child = spawn(CLAUDE, argv, { cwd: project, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  if (sc.stdinMessages) {
    // stream-json input: one user message per line; the session stays open
    // until stdin closes, so scheduled prompts and task notifications can land.
    for (const m of sc.stdinMessages) {
      if (m.waitMs) await new Promise((r) => setTimeout(r, m.waitMs));
      if (m.text) child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: m.text }] } }) + "\n");
    }
    child.stdin.end();
  } else child.stdin.end();
  const killer = setTimeout(() => child.kill(), sc.maxMs ?? 120000);
  const code = await new Promise((r) => child.on("close", r));
  clearTimeout(killer);
  if (sc.afterMs) await new Promise((r) => setTimeout(r, sc.afterMs));
  await mock.close();
  const hooksLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const result = { name, tmp, home, project, code, ms: Date.now() - t0, stdout, stderr, hooks: hooksLog, requests: mock.requests, extra: sc.check ? sc.check(tmp) : undefined };
  if (!keep && !sc.keep) {
    // keep tmp for fixture extraction by the caller; deletion is the caller's call
  }
  return result;
}

// One line per run: did the tool run, what did the model see, what did the user see.
export function outcome(r) {
  const tr = r.requests.flatMap((q) => q.toolResults);
  const out = r.stdout;
  return {
    name: r.name,
    code: r.code,
    hooks: r.hooks.map((h) => h.label).join(","),
    permission_mode: [...new Set(r.hooks.map((h) => h.payload?.permission_mode).filter(Boolean))].join("|"),
    toolRan: tr.some((t) => t.includes("hello-from-bash") || t.includes("AD_TOOL_SHELL=")),
    toolResult: (tr[0] ?? "").replace(/\\n/g, " ").slice(0, 160),
    sysmsgInStdout: /SPIKE_SYSMSG/.test(out),
    reasonInStdout: /SPIKE_REASON/.test(out),
    denials: (out.match(/"permission_denials":\[[^\]]*\]/) ?? [""])[0].slice(0, 160),
    extra: r.extra,
  };
}

// Write sanitized payloads for runtime/test/fixtures/hosts/claude-code/.
export function saveFixture(r, dir, version) {
  const clean = sanitizer(r.tmp);
  const keep = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => /^CLAUDE/.test(k) && !/SOCKET|PID|SESSION_ID/.test(k)));
  const fixture = { host: "claude-code", version, scenario: r.name, captured: new Date().toISOString().slice(0, 10), os: process.platform, outcome: clean(outcome(r)), hooks: r.hooks.map((h) => clean({ label: h.label, env: keep(h.env), payload: h.payload })) };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${r.name}.json`), scrub(JSON.stringify(fixture, null, 2)) + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv[2] === "batch") {
  // node run-claude.mjs batch <regex> [--out dir] [--fixtures dir] [--version v] [--parallel 6]
  const names = Object.keys(SCENARIOS).filter((n) => new RegExp(process.argv[3]).test(n));
  const par = Number(arg("--parallel", 6));
  const queue = [...names];
  const worker = async () => {
    while (queue.length) {
      const n = queue.shift();
      const r = await runScenario(n, SCENARIOS[n], { outDir: arg("--out") });
      if (arg("--fixtures")) saveFixture(r, arg("--fixtures"), arg("--version", "unknown"));
      console.log(JSON.stringify(outcome(r)));
    }
  };
  await Promise.all(Array.from({ length: par }, worker));
} else if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const name = process.argv[2] ?? "basic";
  const r = await runScenario(name, SCENARIOS[name], { outDir: arg("--out") });
  const events = r.stdout.split("\n").filter(Boolean).map((l) => { try { const j = JSON.parse(l); return `${j.type}${j.subtype ? ":" + j.subtype : ""}`; } catch { return "?" + l.slice(0, 60); } });
  console.log(JSON.stringify({ code: r.code, ms: r.ms, tmp: r.tmp, stdoutEvents: events, stderr: r.stderr.slice(0, 800) }, null, 1));
  const COMMON = new Set(["session_id", "transcript_path", "cwd", "hook_event_name"]);
  for (const h of r.hooks) {
    const p = h.payload ?? {};
    const rest = Object.fromEntries(Object.entries(p).filter(([k]) => !COMMON.has(k)).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 160) : JSON.stringify(v).slice(0, 160)]));
    console.log(h.at.slice(11, 19), h.label, `attended=${h.env.CLAUDE_CODE_SESSION_ATTENDED} entry=${h.env.CLAUDE_CODE_ENTRYPOINT}`, JSON.stringify(rest));
  }
  for (const q of r.requests) console.log("REQ", q.path.slice(0, 20), (q.tools ?? []).length, "tools", JSON.stringify(q.lastUserText).slice(0, 140), q.toolResults.length ? "TR:" + q.toolResults[0].slice(0, 100) : "");
}

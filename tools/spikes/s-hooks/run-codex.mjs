#!/usr/bin/env node
// S-HOOKS for Codex: run the real `codex` CLI against the repo's mock
// Responses server in a throwaway CODEX_HOME (and HOME/USERPROFILE), with a
// logging hook on every event. Trust is recorded the way /hooks records it
// (hooks/list → hooks.state."<key>".trusted_hash) unless a scenario skips it.
//
//   node run-codex.mjs batch <regex> [--out dir] [--fixtures dir] [--version v]
//
// SPIKE_CODEX_JS overrides the codex.js entry (default: the global npm one).
// Nothing here reads or writes ~/.codex.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sanitizer, scrub } from "./sanitize.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const { startMockResponses, writeMockCodexHome, ev, lastUserText } = await import(pathToFileURL(path.join(REPO, "runtime/testkit/mock-responses.mjs")).href);
const LOG_HOOK = path.join(HERE, "log-hook.mjs");
const CODEX_JS = process.env.SPIKE_CODEX_JS ?? path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd", "PreCompact", "PostCompact"];
const SHELL_CMD = process.platform === "win32" ? "cmd.exe /d /c echo hello-from-codex" : "echo hello-from-codex";

function script(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  const last = input.at(-1);
  if (last?.type === "function_call_output") return [ev.created(), ev.message("done"), ev.completed()];
  const text = lastUserText(body);
  if (text.includes("SPIKE_SHELL")) return [ev.created(), ev.functionCall(`call-${Date.now()}`, "exec_command", { cmd: SHELL_CMD }), ev.completed()];
  if (text.includes("SPIKE_BIND")) {
    const t = (body.tools ?? []).find((x) => /where_am_i/.test(x.name ?? ""));
    if (t) return [ev.created(), ev.functionCall(`call-${Date.now()}`, t.name, {}, t.namespace), ev.completed()];
    return [ev.created(), ev.message(`no where_am_i tool; tools: ${(body.tools ?? []).map((x) => x.name ?? x.type).join(",")}`), ev.completed()];
  }
  if (text.includes("SPIKE_PATCH")) {
    const patch = "*** Begin Patch\n*** Add File: spike.txt\n+hello\n*** End Patch";
    return [ev.created(), ev.functionCall(`call-${Date.now()}`, "apply_patch", { input: patch }), ev.completed()];
  }
  return [ev.created(), ev.message("ok"), ev.completed()];
}

function codex(args, { env, cwd, input, timeoutMs = 90000 }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CODEX_JS, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

// Minimal app-server client: list our hooks and record their trust.
async function trustHooks({ env, cwd, project, trust }) {
  const child = spawn(process.execPath, [CODEX_JS, "app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let buf = "";
  const pending = new Map();
  let id = 0;
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined && pending.has(m.id)) pending.get(m.id)(m);
      } catch {}
    }
  });
  child.stderr.resume();
  // A config Codex rejects (e.g. approval_policy "untrusted" in 0.164) makes
  // app-server exit without answering: give up after 30 s instead of hanging.
  const request = (method, params) => new Promise((r) => {
    const i = ++id;
    const t = setTimeout(() => r({ error: { message: `no answer to ${method} in 30 s` } }), 30000);
    pending.set(i, (m) => { clearTimeout(t); r(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
  });
  await request("initialize", { clientInfo: { name: "s_hooks_spike", title: "S-HOOKS spike", version: "0.0.0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
  const listed = await request("hooks/list", { cwds: [project] });
  const hooks = (listed.result?.data ?? []).flatMap((d) => d.hooks ?? []);
  let wrote = null;
  if (trust) {
    const edits = hooks.filter((h) => h.trustStatus !== "trusted" && h.currentHash).map((h) => ({ keyPath: `hooks.state.${JSON.stringify(h.key)}.trusted_hash`, value: h.currentHash, mergeStrategy: "replace" }));
    if (edits.length) wrote = await request("config/batchWrite", { edits, reloadUserConfig: false });
  }
  child.stdin.end();
  child.kill();
  return { hooks: hooks.map((h) => ({ key: h.key, eventName: h.eventName, trustStatus: h.trustStatus, hash: h.currentHash ? "present" : "missing" })), listError: listed.error, writeError: wrote?.error };
}

const SCENARIOS = {
  untrusted: { trust: false, prompt: "SPIKE_SHELL run it" },
  basic: { prompt: "SPIKE_SHELL no, use pnpm here" },
  patch: { prompt: "SPIKE_PATCH add a file" },
  "deny-never": { approval: "never", prompt: "SPIKE_SHELL run it", responses: { PreToolUse: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "SPIKE_REASON" }, systemMessage: "SPIKE_SYSMSG" } } },
  "ask-never": { approval: "never", prompt: "SPIKE_SHELL run it", responses: { PreToolUse: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "SPIKE_REASON" }, systemMessage: "SPIKE_SYSMSG" } } },
  "deny-on-request": { approval: "on-request", prompt: "SPIKE_SHELL run it", responses: { PreToolUse: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "SPIKE_REASON" } } } },
  "ask-on-request": { approval: "on-request", prompt: "SPIKE_SHELL run it", responses: { PreToolUse: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "SPIKE_REASON" } } } },
  "exit2-never": { approval: "never", prompt: "SPIKE_SHELL run it", responses: { PreToolUse: { _spike: { exit: 2, stderr: "SPIKE_REASON via exit 2" } } } },
  "crash-never": { approval: "never", prompt: "SPIKE_SHELL run it", responses: { PreToolUse: { _spike: { exit: 1, stderr: "spike hook crashed" } } } },
  "timeout-never": {
    approval: "never",
    prompt: "SPIKE_SHELL run it",
    timeouts: { PreToolUse: 2 },
    responses: (tmp) => ({ PreToolUse: { _spike: { sleepMs: 8000, childDelayMs: 5000, detachedMarker: path.join(tmp, "detached.marker"), childMarker: path.join(tmp, "child.marker"), markDone: path.join(tmp, "hook-finished.marker") } } }),
    afterMs: 9000,
    check: (tmp) => Object.fromEntries(["detached", "child", "hook-finished"].map((m) => [m, fs.existsSync(path.join(tmp, `${m}.marker`))])),
  },
  // permission_mode as Codex reports it for each sandbox × approval pair
  // (workspace-write commands may fail on Windows; the payload is the point).
  "pm-workspace-on-request": { sandbox: "workspace-write", approval: "on-request", prompt: "hello" },
  "pm-workspace-never": { sandbox: "workspace-write", approval: "never", prompt: "hello" },
  "pm-readonly-untrusted": { sandbox: "read-only", approval: "untrusted", prompt: "hello" },
  "pm-full-untrusted": { sandbox: "danger-full-access", approval: "untrusted", prompt: "hello" },
  // S-BIND, installer route: an [mcp_servers] entry with no cwd; the model
  // calls its tool so the per-call _meta is captured too.
  "bind-installer": {
    prompt: "SPIKE_BIND where am i",
    extraConfig: (tmp) => [``, `[mcp_servers.spike]`, `command = ${JSON.stringify(process.execPath)}`, `args = [${JSON.stringify(path.join(HERE, "..", "s-bind", "hello-server.mjs"))}]`, `env = { SPIKE_BIND_LOG = ${JSON.stringify(path.join(tmp, "bind.jsonl"))} }`, ``].join("\n"),
    check: (tmp) => (fs.existsSync(path.join(tmp, "bind.jsonl")) ? fs.readFileSync(path.join(tmp, "bind.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : "no server log"),
  },
  // SessionEnd: a hook that sleeps 6 s; does Codex cut it at its cap?
  "sessionend-cap": { prompt: "hello", timeouts: { SessionEnd: 30 }, responses: (tmp) => ({ SessionEnd: { _spike: { sleepMs: 6000, markDone: path.join(tmp, "hook-finished.marker"), detachedMarker: path.join(tmp, "detached.marker"), childDelayMs: 3000 } } }), afterMs: 9000, check: (tmp) => Object.fromEntries(["detached", "hook-finished"].map((m) => [m, fs.existsSync(path.join(tmp, `${m}.marker`))])) },
};

export async function runScenario(name, sc, { outDir } = {}) {
  const tmp = fs.mkdtempSync(path.join(outDir ?? os.tmpdir(), `cx-${name}-`));
  const home = path.join(tmp, "home");
  const codexHome = path.join(home, ".codex");
  const project = path.join(tmp, "project");
  for (const d of [codexHome, path.join(project, ".git")]) fs.mkdirSync(d, { recursive: true });
  const logFile = path.join(tmp, "hooks.jsonl");
  const responsesFile = path.join(tmp, "responses.json");
  fs.writeFileSync(responsesFile, JSON.stringify(typeof sc.responses === "function" ? sc.responses(tmp) : sc.responses ?? {}));
  const mock = await startMockResponses({ script, recordBodies: false });
  writeMockCodexHome(codexHome, { url: mock.url, approvalPolicy: sc.approval ?? "on-request", sandboxMode: sc.sandbox ?? "danger-full-access" });
  if (sc.extraConfig) fs.appendFileSync(path.join(codexHome, "config.toml"), sc.extraConfig(tmp));
  const ps = (s) => `'${s.replaceAll("'", "''")}'`;
  const hooks = {};
  for (const ev of EVENTS) {
    const handler = { type: "command", command: `"${process.execPath}" "${LOG_HOOK}" ${ev}`, commandWindows: `& ${ps(process.execPath)} ${ps(LOG_HOOK)} ${ev}`, timeout: sc.timeouts?.[ev] ?? 10 };
    hooks[ev] = [["PreToolUse", "PostToolUse"].includes(ev) ? { matcher: "*", hooks: [handler] } : { hooks: [handler] }];
  }
  fs.writeFileSync(path.join(codexHome, "hooks.json"), JSON.stringify({ hooks }, null, 2));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC|CODEX|OPENAI|AD)_/i.test(k)));
  Object.assign(env, { HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, SPIKE_LOG: logFile, SPIKE_RESPONSES: responsesFile });
  const trust = await trustHooks({ env, cwd: project, project, trust: sc.trust !== false });
  const t0 = Date.now();
  const run = await codex(["exec", "--skip-git-repo-check", "--json", "-C", project, sc.prompt], { env, cwd: project });
  const ms = Date.now() - t0;
  fs.writeFileSync(path.join(tmp, "stdout.jsonl"), run.stdout);
  fs.writeFileSync(path.join(tmp, "stderr.txt"), run.stderr);
  if (sc.afterMs) await new Promise((r) => setTimeout(r, sc.afterMs));
  await mock.close();
  const hooksLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { name, tmp, code: run.code, ms, stdout: run.stdout, stderr: run.stderr, trust, hooks: hooksLog, requests: mock.requests, extra: sc.check?.(tmp) };
}

export function outcome(r) {
  const items = r.stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const cmdItems = items.filter((i) => i.item?.type === "command_execution");
  return {
    name: r.name,
    code: r.code,
    ms: r.ms,
    trust: r.trust.hooks.map((h) => `${h.eventName}:${h.trustStatus}`).join(",") || JSON.stringify(r.trust.listError ?? "none"),
    hooks: r.hooks.map((h) => h.label).join(","),
    toolRan: cmdItems.some((i) => /hello-from-codex/.test(i.item?.aggregated_output ?? "")),
    commandStatus: [...new Set(cmdItems.map((i) => i.item?.status))].join("|"),
    sysmsgInStdout: /SPIKE_SYSMSG/.test(r.stdout + r.stderr),
    reasonSeenByModel: r.requests.some((q) => JSON.stringify(q).includes("SPIKE_REASON")),
    stderrTail: r.stderr.trim().split("\n").slice(-2).join(" | ").slice(0, 200),
    extra: r.extra,
  };
}

export function saveFixture(r, dir, version) {
  const clean = sanitizer(r.tmp);
  const keep = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => /^CODEX/.test(k)));
  const fixture = { host: "codex", version, scenario: r.name, captured: new Date().toISOString().slice(0, 10), os: process.platform, outcome: clean(outcome(r)), trust: r.trust, hooks: r.hooks.map((h) => clean({ label: h.label, env: keep(h.env), payload: h.payload })) };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${r.name}.json`), scrub(JSON.stringify(clean(fixture), null, 2)) + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv[2] === "batch") {
  const names = Object.keys(SCENARIOS).filter((n) => new RegExp(process.argv[3]).test(n));
  const par = Number(arg("--parallel", 3));
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
}

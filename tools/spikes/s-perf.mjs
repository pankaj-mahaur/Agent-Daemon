#!/usr/bin/env node
// L0 spike S-PERF (docs/plans/mcp-platform 06 §1): spawned-hook latency per
// event, the ratio to `node -e 0`, and the memory server's tools/list and
// first tools/call — p50/p95 over N runs on this OS.
//
// Every process runs with a throwaway HOME/USERPROFILE (and no CLAUDE_*,
// CODEX_* or AD_* variables), so nothing touches the real agent stores.
//
//   node tools/spikes/s-perf.mjs [--runs 20] [--json out.json]

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(REPO, "runtime/src/cli.mjs");
const SERVER = path.join(REPO, "runtime/src/mcp/memory-server.mjs");
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const RUNS = Number(arg("--runs", 20));
const WARMUP = 2;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s-perf-"));
const home = path.join(tmp, "home");
const project = path.join(tmp, "project");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(project, ".git"), { recursive: true });
fs.writeFileSync(path.join(project, "package.json"), '{"name":"s-perf-fixture"}\n');

const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX|AD|ANTHROPIC|OPENAI)_/i.test(k)),
);
Object.assign(env, { HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: project });

const stub = path.join(tmp, "stub-hook.mjs");
// The floor for any dispatcher: start node, read the payload, answer.
fs.writeFileSync(stub, "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{JSON.parse(s||'{}');process.stdout.write('{}');});\n");

const base = { session_id: "s-perf", transcript_path: path.join(tmp, "t.jsonl"), cwd: project };
const payload = {
  SessionStart: { ...base, hook_event_name: "SessionStart", source: "startup" },
  UserPromptSubmit: { ...base, hook_event_name: "UserPromptSubmit", permission_mode: "default", prompt: "no, use pnpm here, never npm" },
  PreToolUse: { ...base, hook_event_name: "PreToolUse", permission_mode: "default", tool_name: "Bash", tool_input: { command: "npm install lodash" }, tool_use_id: "t1" },
  PostToolUse: { ...base, hook_event_name: "PostToolUse", permission_mode: "default", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "a\n", stderr: "" }, tool_use_id: "t1" },
};

const cases = [
  { name: "baseline: node -e 0", argv: ["-e", "0"], input: "" },
  { name: "floor: stub hook (read stdin, answer)", argv: [stub], input: payload.UserPromptSubmit },
  { name: "session.start: session-start --output-json", argv: [CLI, "session-start", "--output-json"], input: payload.SessionStart },
  { name: "prompt.submit: hook user-prompt-extract", argv: [CLI, "hook", "user-prompt-extract"], input: payload.UserPromptSubmit },
  { name: "prompt.submit: query-retrieve --output-json", argv: [CLI, "query-retrieve", "--output-json"], input: payload.UserPromptSubmit },
  { name: "prompt.submit: hook capability-route-advice", argv: [CLI, "hook", "capability-route-advice"], input: payload.UserPromptSubmit },
  { name: "tool.before: hook bash-pre", argv: [CLI, "hook", "bash-pre"], input: payload.PreToolUse },
  { name: "tool.after: hook bash-post", argv: [CLI, "hook", "bash-post"], input: payload.PostToolUse },
];

function once(argv, input) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const child = spawn(process.execPath, argv, { cwd: project, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let err = "";
    child.stdout.resume();
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ ms: Number(process.hrtime.bigint() - t0) / 1e6, code, err }));
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

// Spawn the server, then time initialize→tools/list and the first tools/call.
function serverOnce() {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const child = spawn(process.execPath, [SERVER, "--project", project, "--host", "claude-code"], { cwd: project, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out = { };
    let buf = "";
    const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
    const timer = setTimeout(() => { child.kill(); reject(new Error("server timeout")); }, 15000);
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const now = Number(process.hrtime.bigint() - t0) / 1e6;
        if (msg.id === 1) { send({ jsonrpc: "2.0", method: "notifications/initialized" }); send({ jsonrpc: "2.0", id: 2, method: "tools/list" }); }
        else if (msg.id === 2) { out.toolsList = now; out.tools = msg.result?.tools?.length; send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_search", arguments: { query: "pnpm" } } }); out.callStart = now; }
        else if (msg.id === 3) { out.firstCall = now - out.callStart; out.callError = !!msg.error; clearTimeout(timer); child.stdin.end(); child.kill(); resolve(out); }
      }
    });
    child.stderr.resume();
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "s-perf", version: "0" } } });
  });
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const r0 = (x) => Math.round(x);

const results = [];
let baseP50 = null;
for (const c of cases) {
  const cold = await once(c.argv, c.input);
  for (let i = 1; i < WARMUP; i++) await once(c.argv, c.input);
  const ms = [];
  let failures = 0;
  let lastErr = "";
  for (let i = 0; i < RUNS; i++) {
    const r = await once(c.argv, c.input);
    ms.push(r.ms);
    if (r.code !== 0) { failures++; lastErr = r.err.slice(0, 200); }
  }
  const row = { name: c.name, cold: r0(cold.ms), p50: r0(pct(ms, 50)), p95: r0(pct(ms, 95)), max: r0(Math.max(...ms)), failures, lastErr };
  if (baseP50 === null) baseP50 = row.p50;
  row.ratioP50 = +(row.p50 / baseP50).toFixed(2);
  results.push(row);
}

const srv = [];
for (let i = 0; i < WARMUP + RUNS; i++) srv.push(await serverOnce());
const warm = srv.slice(WARMUP);
const server = {
  tools: warm[0].tools,
  coldToolsList: r0(srv[0].toolsList),
  toolsListP50: r0(pct(warm.map((x) => x.toolsList), 50)),
  toolsListP95: r0(pct(warm.map((x) => x.toolsList), 95)),
  firstCallP50: r0(pct(warm.map((x) => x.firstCall), 50)),
  firstCallP95: r0(pct(warm.map((x) => x.firstCall), 95)),
  callErrors: warm.filter((x) => x.callError).length,
};

const report = {
  spike: "S-PERF",
  date: new Date().toISOString(),
  os: `${os.platform()} ${os.release()} ${os.arch()}`,
  cpu: os.cpus()[0]?.model,
  cores: os.cpus().length,
  node: process.version,
  runs: RUNS,
  warmup: WARMUP,
  results,
  server,
};
console.table(results.map(({ lastErr, ...r }) => r));
console.log("memory server (spawn → tools/list; first tools/call):", server);
const jsonOut = arg("--json");
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2) + "\n");
for (const r of results) if (r.failures) console.error(`${r.name}: ${r.failures} non-zero exits; last stderr: ${r.lastErr}`);
// A detached job the hooks started may still hold the DB open (Windows EBUSY).
try {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
} catch (err) {
  console.error(`left ${tmp} behind: ${err.code}`);
}

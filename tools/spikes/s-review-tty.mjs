#!/usr/bin/env node
// L0 spike S-REVIEW-TTY (docs/plans/mcp-platform 06 §1), Windows part:
//   1. what one Win32_Process snapshot costs (Windows PowerShell and pwsh);
//   2. the ancestry shapes of every shell running right now (process NAMES
//      only — command lines are never printed), grouped, so standalone
//      terminals, editor terminals and agent shells can be told apart;
//   3. whether each chain keeps CreationDate order (parent older than child).
//
//   node tools/spikes/s-review-tty.mjs [--runs 10] [--json out.json]
//
// On macOS/Linux it prints the `ps -axo pid,ppid,lstart,comm` cost and shapes.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const RUNS = Number(arg("--runs", 10));
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];

const PS_QUERY = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,@{n='Created';e={$_.CreationDate.ToFileTimeUtc()}},CommandLine | ConvertTo-Json -Compress";

function snapshotWindows(shell) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", PS_QUERY], { encoding: "utf8", maxBuffer: 64 << 20, windowsHide: true });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.status !== 0) return { ms, error: (r.stderr || "").slice(0, 200) };
  return { ms, procs: JSON.parse(r.stdout).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, created: p.Created, cmd: p.CommandLine ?? "" })) };
}

function snapshotPosix() {
  const t0 = process.hrtime.bigint();
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,etimes=,comm=,args="], { encoding: "utf8", maxBuffer: 64 << 20 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const procs = out.trim().split("\n").map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    return m && { pid: +m[1], ppid: +m[2], created: -Number(m[3]), name: m[4].split("/").pop(), cmd: m[5] };
  }).filter(Boolean);
  return { ms, procs };
}

const isWin = process.platform === "win32";
const timings = {};
let procs = null;
for (const shell of isWin ? ["powershell.exe", "pwsh.exe"] : ["ps"]) {
  const ms = [];
  for (let i = 0; i < RUNS; i++) {
    const s = isWin ? snapshotWindows(shell) : snapshotPosix();
    if (s.error) { timings[shell] = { error: s.error }; break; }
    ms.push(s.ms);
    procs ??= s.procs;
  }
  if (ms.length) timings[shell] = { first: Math.round(ms[0]), p50: Math.round(pct(ms, 50)), p95: Math.round(pct(ms, 95)), processes: procs.length };
}

// Agent processes are recognised by name + command line (never printed).
const AGENT = [
  [/claude-code[\\/].*cli\.js|[\\/]claude(\.exe)?["\s]|^claude(\.exe)?$/i, "claude-agent"],
  [/codex(\.exe)?["\s].*(exec|app-server)|[\\/]codex\.js|^codex(\.exe)?$/i, "codex-agent"],
  [/gemini|copilot|cursor-agent|opencode/i, "other-agent"],
];
const label = (p) => {
  for (const [re, tag] of AGENT) if (re.test(p.name) || re.test(p.cmd)) return `${p.name}[${tag}]`;
  return p.name;
};
const byPid = new Map(procs.map((p) => [p.pid, p]));
function chain(p) {
  const out = [];
  let ordered = true;
  const seen = new Set();
  let cur = p;
  while (cur && !seen.has(cur.pid) && out.length < 30) {
    seen.add(cur.pid);
    out.push(label(cur));
    const parent = byPid.get(cur.ppid);
    // A reused PID shows up as a "parent" younger than its child.
    if (parent && parent.created > cur.created) { out.push(`<stale ppid ${cur.ppid}>`); ordered = false; break; }
    if (!parent) out.push(cur.ppid ? "<parent exited>" : "<root>");
    cur = parent;
  }
  return { shape: out.join(" <- "), ordered };
}

const SHELLS = isWin ? /^(pwsh|powershell|cmd|bash|zsh|sh|nu|fish)\.exe$/i : /^(-?bash|-?zsh|-?sh|fish|nu)$/;
const shapes = new Map();
for (const p of procs.filter((x) => SHELLS.test(x.name))) {
  const c = chain(p);
  const e = shapes.get(c.shape) ?? { count: 0, ordered: c.ordered };
  e.count++;
  shapes.set(c.shape, e);
}
const self = chain(byPid.get(process.pid) ?? { pid: process.pid, ppid: process.ppid, name: "node", cmd: "", created: 0 });

const report = { spike: "S-REVIEW-TTY", date: new Date().toISOString(), os: `${os.platform()} ${os.release()}`, runs: RUNS, snapshotMs: timings, self: self.shape, shellShapes: [...shapes].map(([shape, v]) => ({ shape, ...v })).sort((a, b) => b.count - a.count) };
console.log(JSON.stringify(report, null, 1));
if (arg("--json")) fs.writeFileSync(arg("--json"), JSON.stringify(report, null, 2) + "\n");

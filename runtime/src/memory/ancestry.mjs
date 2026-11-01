// Who is above `ad review` (MCP launch plan 02 §2.2, D38). The review token needs the
// process chain to reach a terminal or a login root with no agent process on the way:
//   terminal  a terminal emulator, sshd, the desktop shell or a login root: pass
//   agent     an agent CLI or app: refused, by name
//   editor    an editor's integrated terminal, where editor-hosted agents also run their
//             commands: needs the one-time code from a native dialog (dialog-code.mjs)
//   unknown   the chain breaks (an exited or reparented parent, a reused pid, a tmux or
//             screen server): needs the dialog code too
// Editors are never agents here: the user's own editor terminal is a real terminal, and
// the dialog code is what an agent inside it can't read.
//
// One walk per review: Windows asks CIM through PowerShell for each ancestor (about 1–2.5 s,
// S-REVIEW-TTY), Linux reads /proc, macOS asks `ps`. Executables are matched by name; the
// command line only for agents that run under node. The lists come from S-REVIEW-TTY, and
// the owner's terminal matrix (plan L9) extends them.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { systemTool } from "../safe-spawn.mjs";

const exe = (p) => path.basename(String(p?.name ?? "").replace(/\\/g, "/")).toLowerCase().replace(/\.exe$/, "");

// Agent processes: [label, test].
export const AGENTS = Object.freeze([
  ["claude", (p) => exe(p) === "claude" || /@anthropic-ai[\\/]claude-code|claude-code[\\/]cli\.js/i.test(p.cmd ?? "")],
  ["codex", (p) => exe(p) === "codex" || /@openai[\\/]codex/i.test(p.cmd ?? "")],
  ["gemini", (p) => exe(p) === "gemini" || /@google[\\/]gemini-cli/i.test(p.cmd ?? "")],
  ["copilot", (p) => exe(p) === "copilot" || /@github[\\/]copilot/i.test(p.cmd ?? "")],
  ["cursor-agent", (p) => exe(p) === "cursor-agent"],
  ["opencode", (p) => exe(p) === "opencode" || /opencode-ai/i.test(p.cmd ?? "")],
]);

export const EDITORS = Object.freeze(new Set([
  "code", "code - insiders", "code-insiders", "cursor", "windsurf", "kiro", "zed", "zed-editor", "fleet",
  "idea", "idea64", "pycharm", "pycharm64", "webstorm", "webstorm64", "goland", "goland64", "rider", "rider64",
  "clion", "clion64", "phpstorm", "phpstorm64", "rubymine", "rubymine64",
]));

export const TERMINALS = Object.freeze(new Set([
  // Windows: Windows Terminal (and its console host), the desktop shell, other terminals
  "windowsterminal", "openconsole", "explorer", "sshd", "wezterm-gui", "alacritty", "conemu", "conemu64", "mintty", "tabby", "hyper",
  // macOS
  "terminal", "iterm2", "kitty", "ghostty", "warp", "login",
  // Linux
  "gnome-terminal-server", "konsole", "xterm", "xfce4-terminal", "tilix", "terminator", "foot", "urxvt", "lxterminal", "mate-terminal", "sshd-session",
]));

const REPARENTED = new Set(["tmux", "tmux: server", "screen", "launchd", "systemd", "init"]);

/** Classify a chain [self, parent, grandparent, …]. → { verdict, agent?, editor?, root?, why? } */
export function classifyChain(chain) {
  let editor = null;
  for (let i = 1; i < chain.length; i++) {
    const p = chain[i];
    const child = chain[i - 1];
    // A reused pid: the "parent" started after its child, so the real parent is gone.
    if (p.reused || (p.created && child.created && Date.parse(p.created) > Date.parse(child.created))) return { verdict: "unknown", why: "reused-pid" };
    const agent = AGENTS.find(([, test]) => test(p));
    if (agent) return { verdict: "agent", agent: agent[0] };
    const name = exe(p);
    if (REPARENTED.has(name)) return { verdict: "unknown", why: name };
    if (EDITORS.has(name)) editor ??= name;
    if (TERMINALS.has(name)) return editor ? { verdict: "editor", editor } : { verdict: "terminal", root: name };
  }
  return { verdict: "unknown", why: "no-root" };
}

const MAX_DEPTH = 32;

// Windows: one PowerShell, one CIM query per ancestor. The script names only a pid.
const WIN_WALK = (pid) => `
$p = ${Number(pid)}; $out = @()
for ($i = 0; $i -lt ${MAX_DEPTH}; $i++) {
  $q = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -Property ProcessId,ParentProcessId,Name,CommandLine,CreationDate -ErrorAction SilentlyContinue
  if (-not $q) { break }
  $out += [pscustomobject]@{ pid = [int]$q.ProcessId; ppid = [int]$q.ParentProcessId; name = $q.Name; cmd = $q.CommandLine; created = $q.CreationDate.ToUniversalTime().ToString('o') }
  if ($q.ParentProcessId -eq 0) { break }
  $p = $q.ParentProcessId
}
ConvertTo-Json -InputObject @($out) -Compress`;

/** Parse the Windows walk's JSON into a chain. */
export function parseWindowsWalk(stdout) {
  const rows = JSON.parse(String(stdout).trim() || "[]");
  return (Array.isArray(rows) ? rows : [rows]).map((r) => ({ pid: r.pid, ppid: r.ppid, name: r.name ?? "", cmd: r.cmd ?? "", created: r.created ?? null }));
}

/** Linux: /proc/<pid>/stat holds the parent and the start time; cmdline the arguments. */
export function linuxNode(pid, read = (f) => readFileSync(f, "utf8")) {
  const stat = read(`/proc/${pid}/stat`);
  const close = stat.lastIndexOf(")");
  const name = stat.slice(stat.indexOf("(") + 1, close);
  const fields = stat.slice(close + 2).split(" ");
  let cmd = "";
  try {
    cmd = read(`/proc/${pid}/cmdline`).split("\0").join(" ").trim();
  } catch {
    // a process can end between the two reads
  }
  // fields[1] is the parent; fields[19] the start time in clock ticks since boot.
  return { pid, ppid: Number(fields[1]), name, cmd, started: Number(fields[19]) };
}

/** `ps` elapsed time ([[dd-]hh:]mm:ss) in seconds. */
export function etimeSeconds(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(etime ?? "").trim());
  if (!m) return 0;
  const [, d = 0, h = 0, min, s] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s);
}

/** macOS and other POSIX systems: `ps` per ancestor; null when the process is gone. */
function psNode(pid, run) {
  let head;
  try {
    head = run("ps", ["-o", "ppid=,etime=,comm=", "-p", String(pid)]);
  } catch {
    return null; // ps exits 1 for a pid that no longer exists: the chain ends there
  }
  const m = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(head);
  if (!m) return null;
  return { pid, ppid: Number(m[1]), name: m[3], cmd: run("ps", ["-ww", "-o", "args=", "-p", String(pid)]).trim(), etime: m[2] };
}

/** The chain from `pid` upward: [self, parent, …]. */
// powershell: Windows PowerShell by absolute path (a planted powershell.exe in the folder
// review runs from must never be the one started); null when it isn't there.
export function processChain({ pid = process.pid, platform = process.platform, spawn = spawnSync, powershell = () => systemTool("powershell.exe", { platform }) } = {}) {
  const run = (cmd, args, input) => {
    const r = spawn(cmd, args, { encoding: "utf8", timeout: 15_000, windowsHide: true, ...(input ? { input } : {}) });
    if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}`);
    return r.stdout ?? "";
  };
  if (platform === "win32") {
    const script = Buffer.from(WIN_WALK(pid), "utf16le").toString("base64");
    const exe = powershell();
    if (!exe) throw new Error("Windows PowerShell isn't in %SystemRoot%\\System32");
    return parseWindowsWalk(run(exe, ["-NoProfile", "-NonInteractive", "-EncodedCommand", script]));
  }
  const chain = [];
  for (let p = pid, i = 0; p > 0 && i < MAX_DEPTH; i++) {
    let node = null;
    try {
      node = platform === "linux" ? linuxNode(p) : psNode(p, run);
    } catch {
      // the process ended mid-walk: the chain stops there
    }
    if (!node) break;
    chain.push(node);
    if (node.ppid === p || node.ppid <= 0) break;
    p = node.ppid;
  }
  // Start order: a parent that started after its child is a reused pid (Linux: start
  // ticks; elsewhere: elapsed time, longer for an older process).
  for (let i = 1; i < chain.length; i++) {
    const [parent, child] = [chain[i], chain[i - 1]];
    if (parent.started !== undefined ? parent.started > child.started : etimeSeconds(parent.etime) < etimeSeconds(child.etime)) parent.reused = true;
  }
  return chain;
}

/** The review token's probe: the verdict for this process. A probe that fails is "unknown". */
export function probeAncestry(opts) {
  try {
    return classifyChain(processChain(opts));
  } catch {
    return { verdict: "unknown", why: "probe-failed" };
  }
}

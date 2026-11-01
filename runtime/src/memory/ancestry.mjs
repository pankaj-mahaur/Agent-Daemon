// Who is above `ad review` (MCP launch plan 02 §2.2, D38). The review token needs:
//   1. no agent process anywhere above (the AGENTS list below), however many shells,
//      terminals or renamed processes sit between;
//   2. a host it recognises: the first process above the shells (and npm's runners) that
//      started this terminal.
//        terminal  a terminal emulator from a protected install folder: pass
//        editor    an editor's integrated terminal, where editor-hosted agents also run
//                  their commands: needs the one-time code from a native dialog
//        unknown   anything else: a PTY wrapper or multiplexer (script, tmux, ssh), an
//                  unknown app, a terminal-named program outside an install folder, a broken
//                  chain (an exited parent, a reused pid): needs the dialog code too
// Names alone prove nothing (a copy or a symlink can take any name), so a terminal counts
// only from a folder the user's own processes can't write. Windows: explorer.exe in the
// Windows folder (found from the loaded system DLLs, never SystemRoot) or Program Files;
// nothing else under the Windows folder, which has user-writable corners (Tasks, Temp,
// spool). macOS and Linux: root owns the executable and every folder above it, and none of
// them is group- or world-writable (so /opt/homebrew, ~/.local or /usr/local don't count).
//
// One walk per review. Windows: one Windows PowerShell by absolute path, in a clean
// environment, using no cmdlets (a module on the caller's PSModulePath could answer for
// them): WMI through .NET, each field base64. Linux: /proc. macOS: /bin/ps for the chain
// and /usr/sbin/lsof for each executable (ps reports argv[0], which a process sets itself).
// A gate against accidents and injection, not a sandbox: an agent that drives a real
// terminal's own input (UI automation, a terminal's remote-control API) is a stated limit.

import { readFileSync, readlinkSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { loaderWindowsDir, systemTool } from "../safe-spawn.mjs";

// The executable's name: no folder, no .exe, no login shell's leading "-" (-zsh).
const exe = (p) => path.basename(String(p?.name ?? "").replace(/\\/g, "/")).toLowerCase().replace(/\.exe$/, "").replace(/^-/, "");
const cmdOf = (p) => String(p?.cmd ?? "");

// Agent processes: [label, test]. Node-hosted agents are matched by their package path.
export const AGENTS = Object.freeze([
  ["claude", (p) => exe(p) === "claude" || /@anthropic-ai[\\/]claude-code|claude-code[\\/]cli\.js/i.test(cmdOf(p))],
  ["codex", (p) => exe(p) === "codex" || /@openai[\\/]codex/i.test(cmdOf(p))],
  ["gemini", (p) => exe(p) === "gemini" || /@google[\\/]gemini-cli/i.test(cmdOf(p))],
  ["copilot", (p) => exe(p) === "copilot" || /@github[\\/]copilot/i.test(cmdOf(p))],
  ["cursor-agent", (p) => exe(p) === "cursor-agent" || /[\\/]cursor-agent[\\/]/i.test(cmdOf(p))],
  ["opencode", (p) => exe(p) === "opencode" || /opencode-ai/i.test(cmdOf(p))],
]);

// Shells and launchers between `ad review` and its host.
const LAUNCHERS = new Set(["cmd", "pwsh", "powershell", "bash", "sh", "dash", "zsh", "fish", "ksh", "mksh", "tcsh", "csh", "nu", "elvish", "xonsh", "login"]);
// npm and npx run `ad` and `npx agent-daemon-memory` through node.
const NPM_RUNNER = /[\\/](npm|npx)-cli\.js|[\\/]npm[\\/]bin[\\/]|[\\/]corepack[\\/]/i;
// Hosts that hand a terminal to whatever started them: never a trusted root.
const WRAPPERS = new Set(["script", "expect", "unbuffer", "winpty", "tmux", "tmux: server", "screen", "socat", "ssh", "sshd", "sshd-session", "setsid", "nohup", "su", "sudo", "doas", "runas", "launchd", "systemd", "init"]);

export const EDITORS = Object.freeze(new Set([
  "code", "code - insiders", "code-insiders", "codium", "cursor", "windsurf", "kiro", "zed", "zed-editor", "fleet", "antigravity", "trae", "void", "devenv",
  "idea", "idea64", "pycharm", "pycharm64", "webstorm", "webstorm64", "goland", "goland64", "rider", "rider64",
  "clion", "clion64", "phpstorm", "phpstorm64", "rubymine", "rubymine64",
]));

export const TERMINALS = Object.freeze(new Set([
  // Windows: Windows Terminal, the desktop shell (Run, Start), other terminals
  "windowsterminal", "openconsole", "explorer", "wezterm-gui", "alacritty", "conemu", "conemu64", "mintty", "tabby", "hyper",
  // macOS
  "terminal", "iterm2", "kitty", "ghostty", "warp",
  // Linux (Ptyxis hosts its shells in ptyxis-agent; GNOME Console is kgx)
  "gnome-terminal-server", "konsole", "xterm", "xfce4-terminal", "tilix", "terminator", "foot", "urxvt", "lxterminal", "mate-terminal", "ptyxis", "ptyxis-agent", "kgx",
]));

/**
 * Classify a chain [self, parent, grandparent, …]. Each process: { pid, name, cmd,
 * trusted (its executable is in a protected install folder), reused?, created? }.
 * → { verdict, agent? | editor?, host?, root?, why? }
 */
export function classifyChain(chain) {
  for (let i = 1; i < chain.length; i++) {
    const agent = AGENTS.find(([, test]) => test(chain[i]));
    if (agent) return { verdict: "agent", agent: agent[0] };
  }
  let host = null;
  for (let i = 1; i < chain.length; i++) {
    const p = chain[i];
    const child = chain[i - 1];
    // A reused pid: the "parent" started after its child, so the real parent is gone.
    if (p.reused || (p.created && child.created && Date.parse(p.created) > Date.parse(child.created))) return { verdict: "unknown", why: "reused-pid" };
    if (LAUNCHERS.has(exe(p)) || (exe(p) === "node" && NPM_RUNNER.test(cmdOf(p)))) continue;
    host = p;
    break;
  }
  if (!host) return { verdict: "unknown", why: "no-host" };
  const name = exe(host);
  if (WRAPPERS.has(name)) return { verdict: "unknown", why: name };
  if (EDITORS.has(name)) return { verdict: "editor", editor: name, host };
  if (TERMINALS.has(name) && host.trusted === true) return { verdict: "terminal", root: name };
  return { verdict: "unknown", why: TERMINALS.has(name) ? `${name} outside an install folder` : `host ${name}` };
}

const MAX_DEPTH = 32;
const W = path.win32;

/** Windows: explorer.exe in the Windows folder, or anything under Program Files (admin-only by default). */
export function trustedWindowsPath(file, windowsDir) {
  if (!file || !windowsDir) return false;
  const norm = W.normalize(String(file)).toLowerCase();
  const win = W.normalize(String(windowsDir)).toLowerCase().replace(/\\+$/, "");
  const drive = win.slice(0, 2);
  if (norm === `${win}\\explorer.exe`) return true;
  return [`${drive}\\program files\\`, `${drive}\\program files (x86)\\`].some((root) => norm.startsWith(root));
}

/** macOS and Linux: root owns the file and every folder above it, and none is group- or world-writable. */
export function rootOwnedPath(file, { stat = statSync } = {}) {
  const f = String(file ?? "");
  if (!f.startsWith("/")) return false;
  try {
    for (let p = path.posix.normalize(f); ; p = path.posix.dirname(p)) {
      const s = stat(p);
      if (s.uid !== 0 || (s.mode & 0o022) !== 0) return false;
      if (p === "/") return true;
    }
  } catch {
    return false;
  }
}

/** Is this executable in a folder the user's own processes can't write? */
export function trustedPath(file, { platform = process.platform, windowsDir = null, stat } = {}) {
  return platform === "win32" ? trustedWindowsPath(file, windowsDir) : rootOwnedPath(file, stat ? { stat } : {});
}

// Windows: one PowerShell, one WMI query per ancestor, no cmdlet anywhere (a module on the
// caller's PSModulePath could stand in for one). Each row: pid, ppid, then name, command
// line and path base64-encoded, then the start time, tab-separated. The script names only a pid.
const WIN_WALK = (pid) => `
$b64 = { param($s) if ($null -eq $s) { '' } else { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$s)) } }
$p = ${Number(pid)}
for ($i = 0; $i -lt ${MAX_DEPTH}; $i++) {
  $q = $null
  foreach ($o in ([wmisearcher]"SELECT ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath,CreationDate FROM Win32_Process WHERE ProcessId=$p").Get()) { $q = $o }
  if ($null -eq $q) { break }
  $created = [Management.ManagementDateTimeConverter]::ToDateTime($q.CreationDate).ToUniversalTime().ToString('o')
  [Console]::Out.WriteLine([string]$q.ProcessId + "\`t" + [string]$q.ParentProcessId + "\`t" + (& $b64 $q.Name) + "\`t" + (& $b64 $q.CommandLine) + "\`t" + (& $b64 $q.ExecutablePath) + "\`t" + $created)
  if ($q.ParentProcessId -eq 0) { break }
  $p = $q.ParentProcessId
}`;

/** The environment Windows PowerShell runs in for the review gate: nothing of the caller's. */
export function cleanWindowsEnv(windowsDir) {
  const sys = W.join(windowsDir, "System32");
  return { SystemRoot: windowsDir, windir: windowsDir, PATH: `${sys};${windowsDir}`, PSModulePath: W.join(sys, "WindowsPowerShell", "v1.0", "Modules"), TEMP: W.join(windowsDir, "Temp"), TMP: W.join(windowsDir, "Temp") };
}

/** Parse the Windows walk's rows into a chain. */
export function parseWindowsWalk(stdout, { windowsDir = null } = {}) {
  const text = (s) => (s ? Buffer.from(s, "base64").toString("utf8") : "");
  return String(stdout).split(/\r?\n/).filter((l) => l.includes("\t")).map((line) => {
    const [pid, ppid, name, cmd, file, created] = line.split("\t");
    const p = text(file);
    return { pid: Number(pid), ppid: Number(ppid), name: text(name), cmd: text(cmd), path: p, created: created || null, trusted: trustedWindowsPath(p, windowsDir) };
  });
}

/** Linux: the executable from /proc/<pid>/exe (full name, never the 15-character comm); parent and start from stat. */
export function linuxNode(pid, { read = (f) => readFileSync(f, "utf8"), link = readlinkSync, stat } = {}) {
  const procStat = read(`/proc/${pid}/stat`);
  const close = procStat.lastIndexOf(")");
  const comm = procStat.slice(procStat.indexOf("(") + 1, close);
  const fields = procStat.slice(close + 2).split(" ");
  let file = "";
  try {
    file = link(`/proc/${pid}/exe`); // another user's process (sshd, login): not readable
  } catch {
    file = "";
  }
  let cmd = "";
  try {
    cmd = read(`/proc/${pid}/cmdline`).split("\0").join(" ").trim();
  } catch {
    // a process can end between the reads
  }
  const real = file.replace(/ \(deleted\)$/, "");
  // fields[1] is the parent; fields[19] the start time in clock ticks since boot.
  return { pid, ppid: Number(fields[1]), name: real ? path.posix.basename(real) : comm, cmd, path: real, started: Number(fields[19]), trusted: Boolean(real) && real === file && rootOwnedPath(real, stat ? { stat } : {}) };
}

/** `ps` elapsed time ([[dd-]hh:]mm:ss) in seconds. */
export function etimeSeconds(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(etime ?? "").trim());
  if (!m) return 0;
  const [, d = 0, h = 0, min, s] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s);
}

/** macOS: the executable lsof reports for the process text (not argv[0]); null when unknown. */
function macExecutable(pid, run) {
  try {
    const out = run("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"]);
    const first = out.split("\n").find((l) => l.startsWith("n"));
    return first ? first.slice(1) : null;
  } catch {
    return null;
  }
}

/** macOS and other POSIX systems: /bin/ps per ancestor; null when the process is gone. */
function psNode(pid, run, stat) {
  let head;
  try {
    head = run("/bin/ps", ["-o", "ppid=,etime=,comm=", "-p", String(pid)]);
  } catch {
    return null; // ps exits 1 for a pid that no longer exists: the chain ends there
  }
  const m = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(head);
  if (!m) return null;
  const file = macExecutable(pid, run);
  return { pid, ppid: Number(m[1]), name: file ?? m[3], path: file ?? "", cmd: run("/bin/ps", ["-ww", "-o", "args=", "-p", String(pid)]).trim(), etime: m[2], trusted: Boolean(file) && rootOwnedPath(file, stat ? { stat } : {}) };
}

/**
 * The chain from `pid` upward: [self, parent, …].
 * windowsDir: the Windows folder the loader used (never SystemRoot, which the caller's
 * environment sets); powershell: Windows PowerShell by absolute path under it.
 */
export function processChain({ pid = process.pid, platform = process.platform, spawn = spawnSync, windowsDir = platform === "win32" ? loaderWindowsDir() : null, powershell = () => systemTool("powershell.exe", { platform, env: { SystemRoot: windowsDir } }), linux = linuxNode, stat } = {}) {
  const run = (cmd, args, env) => {
    const r = spawn(cmd, args, { encoding: "utf8", timeout: 15_000, windowsHide: true, ...(env ? { env } : {}) });
    if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}`);
    return r.stdout ?? "";
  };
  if (platform === "win32") {
    const exe = powershell();
    if (!exe || !windowsDir) throw new Error("Windows PowerShell isn't in the Windows folder");
    const script = Buffer.from(WIN_WALK(pid), "utf16le").toString("base64");
    return parseWindowsWalk(run(exe, ["-NoProfile", "-NonInteractive", "-EncodedCommand", script], cleanWindowsEnv(windowsDir)), { windowsDir });
  }
  const chain = [];
  for (let p = pid, i = 0; p > 0 && i < MAX_DEPTH; i++) {
    let node = null;
    try {
      node = platform === "linux" ? linux(p) : psNode(p, run, stat);
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

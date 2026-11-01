// Who is above `ad review` (MCP launch plan 02 §2.2, D38). The review token needs:
//   1. no agent process anywhere above (the AGENTS list below), however many shells,
//      terminals or renamed processes sit between;
//   2. a host it recognises: the first process above the shells (and npm's runners) that
//      started this terminal.
//        terminal  a terminal emulator running from a protected install folder: pass
//        editor    an editor's integrated terminal, where editor-hosted agents also run
//                  their commands: needs the one-time code from a native dialog
//        unknown   anything else: a PTY wrapper or multiplexer (script, tmux, ssh), an
//                  unknown app, a terminal-named program outside an install folder, a broken
//                  chain (an exited parent, a reused pid): needs the dialog code too
// Names alone prove nothing (a copy or a symlink can take any name), so a terminal counts
// only from a folder the user's own processes can't write: Program Files and the Windows
// folder (found from the loaded system DLLs, never from SystemRoot), /System, /Applications,
// /usr, /bin, /opt, /snap, /nix/store. Editors need the dialog code either way.
//
// One walk per review: Windows asks CIM through PowerShell by absolute path (about 1–2.5 s,
// S-REVIEW-TTY), Linux reads /proc, macOS runs /bin/ps. The owner's terminal matrix
// (plan L9) extends the lists. A gate against accidents and injection, not a sandbox.

import { readFileSync, readlinkSync } from "node:fs";
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
  // Linux
  "gnome-terminal-server", "konsole", "xterm", "xfce4-terminal", "tilix", "terminator", "foot", "urxvt", "lxterminal", "mate-terminal", "ptyxis",
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
const POSIX_SAFE = ["/system/", "/applications/", "/usr/", "/bin/", "/sbin/", "/opt/", "/snap/", "/nix/store/"];

/** Is this executable in a folder the user's own processes can't write? */
export function trustedPath(file, { platform = process.platform, windowsDir = null } = {}) {
  const f = String(file ?? "");
  if (!f) return false;
  if (platform === "win32") {
    if (!windowsDir) return false;
    const norm = path.win32.normalize(f).toLowerCase();
    const win = path.win32.normalize(windowsDir).toLowerCase();
    const drive = win.slice(0, 2);
    return [`${win}\\`, `${drive}\\program files\\`, `${drive}\\program files (x86)\\`].some((root) => norm.startsWith(root));
  }
  const norm = path.posix.normalize(f).toLowerCase();
  if (norm.startsWith("/usr/local/")) return false; // Homebrew and friends: often the user's
  return POSIX_SAFE.some((root) => norm.startsWith(root));
}

// Windows: one PowerShell, one CIM query per ancestor. The script names only a pid.
const WIN_WALK = (pid) => `
$p = ${Number(pid)}; $out = @()
for ($i = 0; $i -lt ${MAX_DEPTH}; $i++) {
  $q = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -Property ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath,CreationDate -ErrorAction SilentlyContinue
  if (-not $q) { break }
  $out += [pscustomobject]@{ pid = [int]$q.ProcessId; ppid = [int]$q.ParentProcessId; name = $q.Name; cmd = $q.CommandLine; path = $q.ExecutablePath; created = $q.CreationDate.ToUniversalTime().ToString('o') }
  if ($q.ParentProcessId -eq 0) { break }
  $p = $q.ParentProcessId
}
ConvertTo-Json -InputObject @($out) -Compress`;

/** Parse the Windows walk's JSON into a chain. */
export function parseWindowsWalk(stdout, { windowsDir = null } = {}) {
  const rows = JSON.parse(String(stdout).trim() || "[]");
  return (Array.isArray(rows) ? rows : [rows]).map((r) => ({
    pid: r.pid, ppid: r.ppid, name: r.name ?? "", cmd: r.cmd ?? "", path: r.path ?? "", created: r.created ?? null,
    trusted: trustedPath(r.path, { platform: "win32", windowsDir }),
  }));
}

/** Linux: the executable from /proc/<pid>/exe (full name, never the 15-character comm); parent and start from stat. */
export function linuxNode(pid, { read = (f) => readFileSync(f, "utf8"), link = readlinkSync } = {}) {
  const stat = read(`/proc/${pid}/stat`);
  const close = stat.lastIndexOf(")");
  const comm = stat.slice(stat.indexOf("(") + 1, close);
  const fields = stat.slice(close + 2).split(" ");
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
  // fields[1] is the parent; fields[19] the start time in clock ticks since boot.
  return { pid, ppid: Number(fields[1]), name: file ? path.posix.basename(file.replace(/ \(deleted\)$/, "")) : comm, cmd, path: file, started: Number(fields[19]), trusted: trustedPath(file, { platform: "linux" }) };
}

/** `ps` elapsed time ([[dd-]hh:]mm:ss) in seconds. */
export function etimeSeconds(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(etime ?? "").trim());
  if (!m) return 0;
  const [, d = 0, h = 0, min, s] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s);
}

/** macOS and other POSIX systems: /bin/ps per ancestor; null when the process is gone. */
function psNode(pid, run) {
  let head;
  try {
    head = run("/bin/ps", ["-o", "ppid=,etime=,comm=", "-p", String(pid)]);
  } catch {
    return null; // ps exits 1 for a pid that no longer exists: the chain ends there
  }
  const m = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(head);
  if (!m) return null;
  return { pid, ppid: Number(m[1]), name: m[3], path: m[3], cmd: run("/bin/ps", ["-ww", "-o", "args=", "-p", String(pid)]).trim(), etime: m[2], trusted: m[3].startsWith("/") && trustedPath(m[3], { platform: "darwin" }) };
}

/**
 * The chain from `pid` upward: [self, parent, …].
 * windowsDir: the Windows folder the loader used (never SystemRoot, which the caller's
 * environment sets); powershell: Windows PowerShell by absolute path under it.
 */
export function processChain({ pid = process.pid, platform = process.platform, spawn = spawnSync, windowsDir = platform === "win32" ? loaderWindowsDir() : null, powershell = () => systemTool("powershell.exe", { platform, env: { SystemRoot: windowsDir } }), linux = linuxNode } = {}) {
  const run = (cmd, args) => {
    const r = spawn(cmd, args, { encoding: "utf8", timeout: 15_000, windowsHide: true });
    if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}`);
    return r.stdout ?? "";
  };
  if (platform === "win32") {
    const exe = powershell();
    if (!exe) throw new Error("Windows PowerShell isn't in the Windows folder");
    const script = Buffer.from(WIN_WALK(pid), "utf16le").toString("base64");
    return parseWindowsWalk(run(exe, ["-NoProfile", "-NonInteractive", "-EncodedCommand", script]), { windowsDir });
  }
  const chain = [];
  for (let p = pid, i = 0; p > 0 && i < MAX_DEPTH; i++) {
    let node = null;
    try {
      node = platform === "linux" ? linux(p) : psNode(p, run);
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

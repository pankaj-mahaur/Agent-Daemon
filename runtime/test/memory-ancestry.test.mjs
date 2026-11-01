// L1 (MCP launch plan 02 §2.2, D38): who is above `ad review`, and the dialog code.
// Chains are fixtures in the shapes S-REVIEW-TTY saw (L0, Windows) plus the macOS and
// Linux shapes from the plan's terminal matrix, and the attack shapes the L1 review found:
// a renamed or copied "terminal", a PTY wrapper, ssh to localhost, an unknown app.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { classifyChain, etimeSeconds, linuxNode, parseWindowsWalk, processChain, trustedPath } from "../src/memory/ancestry.mjs";
import { confirmByDialog, dialogCommand, DIALOG_TEXTS, trustedDisplayEnv } from "../src/memory/dialog-code.mjs";
import { loaderWindowsDir } from "../src/safe-spawn.mjs";

// A process; `trusted` says its executable sits in a protected install folder.
const p = (name, extra = {}) => ({ name, cmd: extra.cmd ?? name, trusted: true, ...extra });
const SELF = p("node.exe", { cmd: "node ad review" });
// Windows PowerShell by absolute path, as the loader's Windows folder gives it (tests run on every OS).
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

test("an agent anywhere above refuses, whatever terminal or renamed process sits between", () => {
  const cases = [
    // S-REVIEW-TTY: the Claude desktop app's agent shells.
    [[SELF, p("bash.exe"), p("claude.exe"), p("claude.exe"), p("explorer.exe")], "claude"],
    // S-REVIEW-TTY: codex exec.
    [[SELF, p("pwsh.exe"), p("codex.exe"), p("node.exe", { cmd: "node C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js exec" })], "codex"],
    // The Claude Code CLI (node) inside Windows Terminal.
    [[SELF, p("bash.exe"), p("node.exe", { cmd: "node C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" }), p("pwsh.exe"), p("WindowsTerminal.exe")], "claude"],
    // Review finding H1: a copied "WindowsTerminal.exe", or a real terminal, between the agent and review.
    [[SELF, p("WindowsTerminal.exe", { trusted: false }), p("bash.exe"), p("claude.exe")], "claude"],
    [[SELF, p("sh"), p("script"), p("xterm"), p("bash"), p("claude")], "claude"],
    [[SELF, p("zsh"), p("node", { cmd: "node /usr/lib/node_modules/@google/gemini-cli/dist/index.js" }), p("zsh"), p("login"), p("Terminal")], "gemini"],
    [[SELF, p("bash"), p("copilot"), p("bash"), p("gnome-terminal-server")], "copilot"],
    [[SELF, p("bash"), p("node", { cmd: "node /home/sam/.local/share/cursor-agent/versions/2026.10/index.js" }), p("bash"), p("konsole")], "cursor-agent"],
    [[SELF, p("zsh"), p("opencode"), p("zsh"), p("login"), p("iTerm2")], "opencode"],
  ];
  for (const [chain, agent] of cases) assert.deepEqual(classifyChain(chain), { verdict: "agent", agent }, chain.map((x) => x.name).join(" ← "));
});

test("the host decides: a trusted terminal passes; an editor needs the code; anything else too", () => {
  const verdict = (chain) => classifyChain(chain).verdict;
  assert.deepEqual(classifyChain([SELF, p("pwsh.exe"), p("WindowsTerminal.exe"), p("explorer.exe")]), { verdict: "terminal", root: "windowsterminal" });
  assert.deepEqual(classifyChain([SELF, p("cmd.exe"), p("explorer.exe")]), { verdict: "terminal", root: "explorer" });
  assert.deepEqual(classifyChain([SELF, p("-zsh"), p("/usr/bin/login"), p("/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal")]), { verdict: "terminal", root: "terminal" });
  // npm's runner between review and the shell (npx agent-daemon-memory review).
  assert.equal(verdict([SELF, p("sh"), p("node", { cmd: "node /usr/lib/node_modules/npm/bin/npx-cli.js agent-daemon-memory review" }), p("zsh"), p("login"), p("iTerm2")]), "terminal");
  // Editors (never agents): the code.
  assert.equal(classifyChain([SELF, p("pwsh.exe"), p("Code.exe", { cmd: "Code.exe --type=ptyHost" }), p("Code.exe"), p("explorer.exe")]).editor, "code");
  assert.equal(classifyChain([SELF, p("pwsh.exe"), p("zed.exe"), p("explorer.exe")]).editor, "zed");
  assert.equal(classifyChain([SELF, p("bash"), p("idea64.exe"), p("explorer.exe")]).editor, "idea64");
  assert.equal(classifyChain([SELF, p("pwsh.exe"), p("Antigravity.exe"), p("explorer.exe")]).editor, "antigravity");
  // Review finding H1: names prove nothing; wrappers, ssh and unknown apps need the code.
  assert.deepEqual(classifyChain([SELF, p("xterm", { trusted: false }), p("systemd")]), { verdict: "unknown", why: "xterm outside an install folder" });
  assert.deepEqual(classifyChain([SELF, p("script"), p("xterm"), p("systemd")]), { verdict: "unknown", why: "script" });
  assert.deepEqual(classifyChain([SELF, p("bash"), p("sshd")]), { verdict: "unknown", why: "sshd" });
  assert.deepEqual(classifyChain([SELF, p("zsh"), p("tmux: server")]), { verdict: "unknown", why: "tmux: server" });
  assert.deepEqual(classifyChain([SELF, p("bash"), p("systemd")]), { verdict: "unknown", why: "systemd" });
  assert.deepEqual(classifyChain([SELF, p("pwsh.exe"), p("SomeApp.exe"), p("explorer.exe")]), { verdict: "unknown", why: "host someapp" });
  assert.deepEqual(classifyChain([SELF, p("node.exe", { cmd: "node pty-driver.js" }), p("WindowsTerminal.exe")]), { verdict: "unknown", why: "host node" });
  assert.deepEqual(classifyChain([SELF, p("sh.exe")]), { verdict: "unknown", why: "no-host" });
  // Broken chains.
  const reused = [{ ...SELF, created: "2026-11-01T10:00:00Z" }, p("pwsh.exe", { created: "2026-11-01T10:05:00Z" }), p("WindowsTerminal.exe", { created: "2026-11-01T09:00:00Z" })];
  assert.deepEqual(classifyChain(reused), { verdict: "unknown", why: "reused-pid" });
  assert.deepEqual(classifyChain([SELF, p("bash", { reused: true }), p("gnome-terminal-server")]), { verdict: "unknown", why: "reused-pid" });
});

test("trusted install folders: never from the environment, never the user's own folders", () => {
  const win = { platform: "win32", windowsDir: "C:\\Windows" };
  assert.equal(trustedPath("C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_1.21\\WindowsTerminal.exe", win), true);
  assert.equal(trustedPath("C:\\Windows\\explorer.exe", win), true);
  assert.equal(trustedPath("C:\\Users\\sam\\AppData\\Local\\Temp\\WindowsTerminal.exe", win), false);
  assert.equal(trustedPath("D:\\Program Files\\x.exe", win), false, "another drive's Program Files");
  assert.equal(trustedPath("C:\\Windows\\explorer.exe", { platform: "win32", windowsDir: null }), false, "no loader folder: nothing is trusted");
  assert.equal(trustedPath("/usr/bin/xterm", { platform: "linux" }), true);
  assert.equal(trustedPath("/usr/local/bin/xterm", { platform: "linux" }), false);
  assert.equal(trustedPath("/home/sam/bin/xterm", { platform: "linux" }), false);
  assert.equal(trustedPath("/tmp/xterm", { platform: "linux" }), false);
  assert.equal(trustedPath("/Applications/iTerm.app/Contents/MacOS/iTerm2", { platform: "darwin" }), true);
  // The loader's folder: found from ntdll.dll's path, whatever SystemRoot says.
  assert.equal(loaderWindowsDir({ report: () => ({ sharedObjects: ["C:\\Program Files\\nodejs\\node.exe", "C:\\WINDOWS\\SYSTEM32\\ntdll.dll"] }) }), "C:\\WINDOWS");
  assert.equal(loaderWindowsDir({ report: () => ({ sharedObjects: ["/usr/lib/libc.so.6"] }) }), null);
});

test("Windows: one PowerShell walk naming only the pid; paths decide trust", () => {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push([cmd, args]);
    return { status: 0, stdout: JSON.stringify([
      { pid: 50, ppid: 40, name: "node.exe", cmd: "node ad review", path: "C:\\Program Files\\nodejs\\node.exe", created: "2026-11-01T10:00:02Z" },
      { pid: 40, ppid: 30, name: "pwsh.exe", cmd: "pwsh", path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", created: "2026-11-01T10:00:01Z" },
      { pid: 30, ppid: 1, name: "WindowsTerminal.exe", cmd: "wt", path: "C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_1.21\\WindowsTerminal.exe", created: "2026-11-01T09:00:00Z" },
    ]) };
  };
  const chain = processChain({ pid: 50, platform: "win32", spawn, windowsDir: "C:\\Windows", powershell: () => PS });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], PS, "PowerShell by absolute path");
  const script = Buffer.from(calls[0][1].at(-1), "base64").toString("utf16le");
  assert.match(script, /\$p = 50;/);
  assert.deepEqual(classifyChain(chain), { verdict: "terminal", root: "windowsterminal" });
  // The same chain with Windows Terminal copied into the user's temp folder: not trusted.
  const fake = parseWindowsWalk(JSON.stringify([{ pid: 2, name: "node.exe" }, { pid: 1, name: "WindowsTerminal.exe", path: "C:\\Users\\sam\\AppData\\Local\\Temp\\WindowsTerminal.exe" }]), { windowsDir: "C:\\Windows" });
  assert.equal(classifyChain(fake).verdict, "unknown");
  assert.throws(() => processChain({ pid: 50, platform: "win32", spawn, windowsDir: null, powershell: () => null }), /PowerShell/);
});

test("Linux: the full executable name from /proc/<pid>/exe; a parent that started later is a reused pid", () => {
  const files = {
    "/proc/9/stat": "9 (node) S 8 9 9 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5000 0 0",
    "/proc/9/cmdline": "node\0ad\0review\0",
    "/proc/8/stat": "8 (we (ird) sh) S 7 8 8 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 4000 0 0",
    "/proc/8/cmdline": "bash\0",
    "/proc/7/stat": "7 (gnome-terminal-) S 1 7 7 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100 0 0",
    "/proc/7/cmdline": "/usr/libexec/gnome-terminal-server\0",
  };
  const links = { "/proc/9/exe": "/usr/bin/node", "/proc/8/exe": "/usr/bin/bash", "/proc/7/exe": "/usr/libexec/gnome-terminal-server" };
  const io = { read: (f) => { if (!(f in files)) throw new Error("gone"); return files[f]; }, link: (f) => { if (!(f in links)) throw new Error("EACCES"); return links[f]; } };
  const node7 = linuxNode(7, io);
  assert.equal(node7.name, "gnome-terminal-server", "not the 15-character comm");
  assert.equal(node7.trusted, true);
  const chain = processChain({ pid: 9, platform: "linux", linux: (pid) => linuxNode(pid, io) });
  assert.deepEqual(classifyChain(chain), { verdict: "terminal", root: "gnome-terminal-server" });
  files["/proc/8/stat"] = files["/proc/8/stat"].replace(" 4000 ", " 6000 ");
  assert.deepEqual(classifyChain(processChain({ pid: 9, platform: "linux", linux: (pid) => linuxNode(pid, io) })), { verdict: "unknown", why: "reused-pid" });
  // Another user's process (exe unreadable): its comm name, never trusted.
  delete links["/proc/7/exe"];
  assert.deepEqual({ name: linuxNode(7, io).name, trusted: linuxNode(7, io).trusted }, { name: "gnome-terminal-", trusted: false });
});

test("ps elapsed times parse in every form", () => {
  assert.equal(etimeSeconds("05:06"), 306);
  assert.equal(etimeSeconds("12:05:06"), 43506);
  assert.equal(etimeSeconds("1-02:03:04"), 93784);
  assert.equal(etimeSeconds("garbage"), 0);
});

test("macOS: /bin/ps per ancestor; trust from the executable's path; a younger parent is a reused pid", () => {
  const table = {
    20: { head: "10 00:05 /usr/local/bin/node", args: "node ad review" },
    10: { head: "5 00:02 -zsh", args: "-zsh" },
    5: { head: "2 1-00:00:00 /usr/bin/login", args: "login -pfl sam" },
    2: { head: "1 2-00:00:00 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal", args: "Terminal" },
  };
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push(cmd);
    const row = table[Number(args.at(-1))];
    if (!row) return { status: 1, stdout: "" };
    return { status: 0, stdout: args.includes("args=") ? `${row.args}\n` : `${row.head}\n` };
  };
  assert.deepEqual(classifyChain(processChain({ pid: 20, platform: "darwin", spawn })), { verdict: "unknown", why: "reused-pid" }, "zsh (2 s) is younger than node (5 s)");
  assert.ok(calls.every((c) => c === "/bin/ps"), "ps by absolute path, never PATH");
  table[10].head = "5 00:09 -zsh";
  assert.deepEqual(classifyChain(processChain({ pid: 20, platform: "darwin", spawn })), { verdict: "terminal", root: "terminal" });
});

test("the dialog: never on a command line, never chosen by the environment", () => {
  for (const [platform, tools] of [["win32", { powershell: PS }], ["darwin", {}], ["linux", { displayEnv: { DISPLAY: ":0" }, exists: () => true }]]) {
    const how = dialogCommand(platform, tools);
    assert.ok(how, platform);
    assert.ok(how.cmd.startsWith("/") || how.cmd === PS, `${platform}: ${how.cmd} by absolute path`);
    assert.ok(!how.args.join(" ").includes("731904"), `${platform}: the code is not in the arguments`);
    assert.match(how.input("731904"), /731904/, `${platform}: it goes through stdin`);
  }
  assert.deepEqual(dialogCommand("linux", { displayEnv: { DISPLAY: ":0" }, exists: () => true }).env, { DISPLAY: ":0" }, "zenity gets the trusted display only");
  assert.equal(dialogCommand("linux", { exists: () => true }), null, "no trusted display: no dialog");
  assert.equal(dialogCommand("linux", { displayEnv: { DISPLAY: ":0" }, exists: () => false }), null, "no /usr/bin/zenity: no dialog");
  assert.equal(dialogCommand("win32", { powershell: null }), null, "no PowerShell in the Windows folder: no dialog, never a bare name");
  // Linux: the display comes from the editor's own process, and only a trusted one.
  const environ = { "/proc/77/environ": "DISPLAY=:1\0HOME=/home/sam\0XAUTHORITY=/home/sam/.Xauthority\0" };
  const read = (f) => environ[f];
  assert.deepEqual(trustedDisplayEnv({ verdict: "editor", host: { pid: 77, trusted: true } }, { read }), { DISPLAY: ":1", XAUTHORITY: "/home/sam/.Xauthority" });
  assert.equal(trustedDisplayEnv({ verdict: "editor", host: { pid: 77, trusted: false } }, { read }), null, "an editor outside an install folder");
  assert.equal(trustedDisplayEnv({ verdict: "unknown", why: "tmux" }, { read }), null, "nothing to vouch for the display");
});

function fakeChild({ fail = false } = {}) {
  const child = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { written: "", end(s) { this.written += s; } });
  child.killed = false;
  child.kill = () => (child.killed = true);
  setImmediate(() => child.emit(fail ? "error" : "spawn", fail ? new Error("ENOENT") : undefined));
  return child;
}

test("confirmByDialog: the code typed back passes; a wrong one or no dialog refuses", async () => {
  const found = { verdict: "editor", editor: "zed" };
  let child;
  const spawned = [];
  const spawn = (cmd, args) => (spawned.push([cmd, ...args].join(" ")), (child = fakeChild()));
  const lines = [];
  const win = { platform: "win32", tools: { powershell: PS } };
  const ok = await confirmByDialog({ ask: async () => "123456", found, out: (l) => lines.push(l), ...win, spawn, code: "123456" });
  assert.deepEqual(ok, { ok: true });
  assert.equal(child.stdin.written, "123456\n");
  assert.ok(!spawned.join("\n").includes("123456"), "the code is not on the dialog's command line");
  assert.ok(child.killed, "the dialog closes after the answer");
  assert.match(lines[0], /inside zed/);
  assert.deepEqual(await confirmByDialog({ ask: async () => "000000", found, out: () => {}, ...win, spawn, code: "123456" }), { ok: false, text: DIALOG_TEXTS.wrongCode });
  assert.deepEqual(await confirmByDialog({ ask: async () => "123456", found, out: () => {}, platform: "linux", tools: { displayEnv: { DISPLAY: ":0" }, exists: () => true }, spawn: () => fakeChild({ fail: true }), code: "123456" }), { ok: false, text: DIALOG_TEXTS.noDialog });
  assert.deepEqual(await confirmByDialog({ ask: async () => "123456", found: { verdict: "unknown", why: "tmux" }, platform: "linux", spawn, code: "123456" }), { ok: false, text: DIALOG_TEXTS.noDialog }, "Linux with nothing to vouch for the display");
  assert.deepEqual(await confirmByDialog({ found, ...win, spawn, code: "123456" }), { ok: false, text: DIALOG_TEXTS.noDialog }, "no way to ask: refused");
});

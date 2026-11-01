// L1 (MCP launch plan 02 §2.2, D38): who is above `ad review`, and the dialog code.
// Chains are fixtures in the shapes S-REVIEW-TTY saw (L0, Windows) plus the macOS and
// Linux shapes from the plan's terminal matrix; the owner's matrix run extends them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { classifyChain, etimeSeconds, linuxNode, parseWindowsWalk, processChain } from "../src/memory/ancestry.mjs";
import { confirmByDialog, dialogCommand, DIALOG_TEXTS } from "../src/memory/dialog-code.mjs";

const p = (name, extra = {}) => ({ name, cmd: extra.cmd ?? name, ...extra });
const SELF = p("node.exe", { cmd: "node ad review" });
// Windows PowerShell by absolute path, as safe-spawn systemTool() resolves it (tests run on every OS).
const PS = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";

test("an agent anywhere above review refuses, whatever terminal it runs in", () => {
  const cases = [
    // S-REVIEW-TTY: the Claude desktop app's agent shells.
    [[SELF, p("bash.exe"), p("claude.exe"), p("claude.exe"), p("explorer.exe")], "claude"],
    // S-REVIEW-TTY: codex exec.
    [[SELF, p("pwsh.exe"), p("codex.exe"), p("node.exe", { cmd: "node C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js exec" })], "codex"],
    // The Claude Code CLI (node) inside Windows Terminal: the agent is found before the terminal.
    [[SELF, p("bash.exe"), p("node.exe", { cmd: "node C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" }), p("pwsh.exe"), p("WindowsTerminal.exe")], "claude"],
    [[SELF, p("zsh"), p("node", { cmd: "node /usr/lib/node_modules/@google/gemini-cli/dist/index.js" }), p("zsh"), p("login"), p("Terminal")], "gemini"],
    [[SELF, p("bash"), p("copilot"), p("bash"), p("gnome-terminal-server")], "copilot"],
    [[SELF, p("bash"), p("cursor-agent"), p("bash"), p("konsole")], "cursor-agent"],
    [[SELF, p("zsh"), p("opencode"), p("zsh"), p("login"), p("iTerm2")], "opencode"],
  ];
  for (const [chain, agent] of cases) assert.deepEqual(classifyChain(chain), { verdict: "agent", agent }, chain.map((x) => x.name).join(" ← "));
});

test("a terminal root passes; an editor's terminal needs the code; a broken chain too", () => {
  assert.deepEqual(classifyChain([SELF, p("pwsh.exe"), p("WindowsTerminal.exe"), p("explorer.exe")]), { verdict: "terminal", root: "windowsterminal" });
  assert.deepEqual(classifyChain([SELF, p("cmd.exe"), p("explorer.exe")]), { verdict: "terminal", root: "explorer" });
  assert.deepEqual(classifyChain([SELF, p("zsh"), p("login"), p("Terminal")]), { verdict: "terminal", root: "login" });
  assert.deepEqual(classifyChain([SELF, p("bash"), p("sshd")]), { verdict: "terminal", root: "sshd" });
  // Editors are never agents: they need the dialog code.
  assert.deepEqual(classifyChain([SELF, p("pwsh.exe"), p("Code.exe", { cmd: "Code.exe --type=ptyHost" }), p("Code.exe"), p("explorer.exe")]), { verdict: "editor", editor: "code" });
  assert.deepEqual(classifyChain([SELF, p("pwsh.exe"), p("zed.exe"), p("explorer.exe")]), { verdict: "editor", editor: "zed" });
  assert.deepEqual(classifyChain([SELF, p("bash"), p("idea64.exe"), p("explorer.exe")]), { verdict: "editor", editor: "idea64" });
  // Reparented or broken: tmux's server, init after setsid, an exited parent, a reused pid.
  assert.deepEqual(classifyChain([SELF, p("zsh"), p("tmux: server")]), { verdict: "unknown", why: "tmux: server" });
  assert.deepEqual(classifyChain([SELF, p("bash"), p("systemd")]), { verdict: "unknown", why: "systemd" });
  assert.deepEqual(classifyChain([SELF, p("sh.exe")]), { verdict: "unknown", why: "no-root" });
  const reused = [{ ...SELF, created: "2026-11-01T10:00:00Z" }, p("pwsh.exe", { created: "2026-11-01T10:05:00Z" }), p("WindowsTerminal.exe", { created: "2026-11-01T09:00:00Z" })];
  assert.deepEqual(classifyChain(reused), { verdict: "unknown", why: "reused-pid" });
  assert.deepEqual(classifyChain([SELF, p("bash", { reused: true }), p("sshd")]), { verdict: "unknown", why: "reused-pid" });
});

test("Windows: one PowerShell walk naming only the pid; its JSON parses into the chain", () => {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push([cmd, args]);
    return { status: 0, stdout: JSON.stringify([{ pid: 50, ppid: 40, name: "node.exe", cmd: "node ad review", created: "2026-11-01T10:00:02Z" }, { pid: 40, ppid: 30, name: "pwsh.exe", cmd: "pwsh", created: "2026-11-01T10:00:01Z" }, { pid: 30, ppid: 1, name: "WindowsTerminal.exe", cmd: "wt", created: "2026-11-01T09:00:00Z" }]) };
  };
  const chain = processChain({ pid: 50, platform: "win32", spawn, powershell: () => PS });
  assert.equal(calls.length, 1);
  const script = Buffer.from(calls[0][1].at(-1), "base64").toString("utf16le");
  assert.match(script, /ProcessId=\$p/);
  assert.match(script, /\$p = 50;/);
  assert.deepEqual(classifyChain(chain), { verdict: "terminal", root: "windowsterminal" });
  assert.equal(parseWindowsWalk(JSON.stringify({ pid: 1, ppid: 0, name: "x.exe" })).length, 1, "a single object is a chain of one");
});

test("Linux: /proc stat with odd process names; a parent that started later is a reused pid", () => {
  const files = {
    "/proc/9/stat": "9 (node) S 8 9 9 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5000 0 0",
    "/proc/9/cmdline": "node\0ad\0review\0",
    "/proc/8/stat": "8 (we (ird) sh) S 7 8 8 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 6000 0 0",
    "/proc/8/cmdline": "sh\0",
    "/proc/7/stat": "7 (sshd) S 1 7 7 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100 0 0",
    "/proc/7/cmdline": "sshd: sam@pts/0\0",
  };
  const read = (f) => {
    if (!(f in files)) throw new Error("gone");
    return files[f];
  };
  assert.deepEqual(linuxNode(8, read), { pid: 8, ppid: 7, name: "we (ird) sh", cmd: "sh", started: 6000 });
  // processChain reads /proc itself; here the same walk by hand shows the start-order rule.
  const chain = [linuxNode(9, read), linuxNode(8, read), linuxNode(7, read)];
  if (chain[1].started > chain[0].started) chain[1].reused = true;
  assert.deepEqual(classifyChain(chain), { verdict: "unknown", why: "reused-pid" });
});

test("ps elapsed times parse in every form", () => {
  assert.equal(etimeSeconds("05:06"), 306);
  assert.equal(etimeSeconds("12:05:06"), 43506);
  assert.equal(etimeSeconds("1-02:03:04"), 93784);
  assert.equal(etimeSeconds("garbage"), 0);
});

test("macOS: ps per ancestor; a parent younger than its child is a reused pid", () => {
  const table = {
    20: { head: "10 00:05 node", args: "node ad review" },
    10: { head: "5 00:02 -zsh", args: "-zsh" },
    5: { head: "1 1-00:00:00 login", args: "login -pfl sam" },
  };
  const spawn = (cmd, args) => {
    const pid = Number(args.at(-1));
    const row = table[pid];
    if (!row) return { status: 1, stdout: "" };
    return { status: 0, stdout: args.includes("args=") ? `${row.args}\n` : `${row.head}\n` };
  };
  const chain = processChain({ pid: 20, platform: "darwin", spawn });
  assert.equal(chain.length, 3);
  assert.deepEqual(classifyChain(chain), { verdict: "unknown", why: "reused-pid" }, "zsh (2 s) is younger than node (5 s)");
  table[10].head = "5 00:09 -zsh";
  assert.deepEqual(classifyChain(processChain({ pid: 20, platform: "darwin", spawn })), { verdict: "terminal", root: "login" });
});

test("the dialog code never travels on a command line", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const how = dialogCommand(platform, { DISPLAY: ":0" }, { powershell: PS });
    assert.ok(how, platform);
    assert.ok(!how.args.join(" ").includes("731904"), `${platform}: the code is not in the arguments`);
    assert.match(how.input("731904"), /731904/, `${platform}: it goes through stdin`);
  }
  assert.equal(dialogCommand("linux", {}), null, "no display: no dialog");
  assert.equal(dialogCommand("win32", {}, { powershell: null }), null, "no PowerShell in System32: no dialog, never a bare name");
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
  const ok = await confirmByDialog({ ask: async () => "123456", found, out: (l) => lines.push(l), platform: "win32", tools: { powershell: PS }, spawn, code: "123456" });
  assert.deepEqual(ok, { ok: true });
  assert.equal(child.stdin.written, "123456\n");
  assert.ok(!spawned.join("\n").includes("123456"), "the code is not on the dialog's command line");
  assert.ok(child.killed, "the dialog closes after the answer");
  assert.match(lines[0], /inside zed/);
  assert.deepEqual(await confirmByDialog({ ask: async () => "000000", found, out: () => {}, platform: "win32", tools: { powershell: PS }, spawn, code: "123456" }), { ok: false, text: DIALOG_TEXTS.wrongCode });
  assert.deepEqual(await confirmByDialog({ ask: async () => "123456", found, out: () => {}, platform: "linux", env: { DISPLAY: ":0" }, spawn: () => fakeChild({ fail: true }), code: "123456" }), { ok: false, text: DIALOG_TEXTS.noDialog });
  assert.deepEqual(await confirmByDialog({ ask: async () => "123456", found, platform: "linux", env: {}, spawn, code: "123456" }), { ok: false, text: DIALOG_TEXTS.noDialog });
  assert.deepEqual(await confirmByDialog({ found, platform: "win32", tools: { powershell: PS }, spawn, code: "123456" }), { ok: false, text: DIALOG_TEXTS.noDialog }, "no way to ask: refused");
});

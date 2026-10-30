// The clipboard (P2.3): which tools run and which bytes reach the terminal,
// for native ok/failed × tmux / SSH / neither; the size limit; WSL; a tool
// that hangs; and the copy-on-select and right-click-paste tables.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { TERMINAL_MAX, copyOnSelectDefault, copyText, readClipboard, rightClickPaste } from "../src/tui/terminal/clipboard.mjs";

// A fake spawn: `results` maps a command to "ok" | "fail" | "hang" | {out}.
function fakeSpawn(results = {}) {
  const ran = [];
  const spawnFn = (cmd, args) => {
    ran.push([cmd, ...args].join(" "));
    const child = new EventEmitter();
    const r = results[cmd] ?? "fail";
    child.stdout = new EventEmitter();
    child.kill = () => (child.killed = true);
    child.stdin = { on: () => {}, end: () => {
      if (r === "hang") return;
      setImmediate(() => {
        if (r?.out != null) child.stdout.emit("data", r.out);
        child.emit("exit", r === "fail" ? 1 : 0);
      });
    } };
    return child;
  };
  return { spawnFn, ran };
}

const OSC = (t) => `\x1b]52;c;${Buffer.from(t).toString("base64")}\x07`;
const TMUX_OSC = (t) => `\x1bPtmux;${OSC(t).replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;

async function copy(text, { native = "ok", env = {}, platform = "darwin", tmux = "fail", timeoutMs = 2000, readFile = () => "" } = {}) {
  const { spawnFn, ran } = fakeSpawn({ pbcopy: native, "clip.exe": native, "wl-copy": native, tmux });
  const written = [];
  const r = await copy0(text, { terminalWrite: (s) => written.push(s), env, platform, spawnFn, timeoutMs, readFile });
  return { r, ran, written };
}
const copy0 = copyText;

test("native ok outside tmux and SSH writes no OSC 52", async () => {
  const { r, ran, written } = await copy("hi");
  assert.deepEqual(r, { ok: true, via: "pbcopy" });
  assert.deepEqual(ran, ["pbcopy"]);
  assert.deepEqual(written, []);
});

test("native failed, nothing else: plain OSC 52, via terminal", async () => {
  const { r, written } = await copy("hi", { native: "fail" });
  assert.deepEqual(r, { ok: true, via: "terminal" });
  assert.deepEqual(written, [OSC("hi")]);
});

test("over SSH: native, plus plain OSC 52 for the local terminal", async () => {
  const { r, written } = await copy("hi", { env: { SSH_CONNECTION: "1 2 3 4" } });
  assert.deepEqual(r, { ok: true, via: "pbcopy" });
  assert.deepEqual(written, [OSC("hi")]);
});

test("in tmux: tmux's buffer when it takes it, else OSC 52 wrapped for tmux", async () => {
  const a = await copy("hi", { env: { TMUX: "/tmp/t" }, tmux: "ok" });
  assert.deepEqual(a.ran, ["pbcopy", "tmux load-buffer -w -"]);
  assert.deepEqual(a.written, []);
  const b = await copy("hi", { env: { TMUX: "/tmp/t" }, tmux: "fail", native: "fail" });
  assert.deepEqual(b.written, [TMUX_OSC("hi")]);
  assert.deepEqual(b.r, { ok: true, via: "terminal" });
  const c = await copy("hi", { env: { TMUX: "/tmp/t", SSH_TTY: "/dev/pts/1" }, tmux: "ok" });
  assert.deepEqual(c.written, [TMUX_OSC("hi")], "over SSH inside tmux the sequence is wrapped");
});

test("100,000 bytes go through; 100,001 are refused for the terminal", async () => {
  const ok = await copy("x".repeat(TERMINAL_MAX), { native: "fail" });
  assert.equal(ok.r.ok, true);
  const big = await copy("x".repeat(TERMINAL_MAX + 1), { native: "fail" });
  assert.deepEqual(big.r, { ok: false, via: null, error: "too large for the terminal clipboard" });
  assert.deepEqual(big.written, []);
});

test("WSL tries clip.exe first", async () => {
  const { ran } = await copy("hi", { platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } });
  assert.equal(ran[0], "clip.exe");
  const byProc = await copy("hi", { platform: "linux", readFile: () => "Linux version 5.15 (microsoft-standard-WSL2)" });
  assert.equal(byProc.ran[0], "clip.exe");
});

test("empty text writes nothing and runs nothing", async () => {
  const { r, ran, written } = await copy("");
  assert.deepEqual(r, { ok: false, via: null, error: "nothing to copy" });
  assert.deepEqual([ran, written], [[], []]);
});

test("a native tool that never exits is killed after the timeout, and OSC 52 is written", async () => {
  const { r, written } = await copy("hi", { native: "hang", timeoutMs: 50 });
  assert.deepEqual(r, { ok: true, via: "terminal" });
  assert.deepEqual(written, [OSC("hi")]);
});

test("readClipboard: the platform's tool, CRLF to LF; null when none works", async () => {
  const { spawnFn } = fakeSpawn({ "powershell.exe": { out: "a\r\nb" } });
  assert.equal(await readClipboard({ platform: "win32", spawnFn, env: {} }), "a\nb");
  assert.equal(await readClipboard({ platform: "darwin", spawnFn: fakeSpawn().spawnFn, env: {} }), null);
});

test("copy-on-select defaults per terminal", () => {
  const d = (env, platform) => copyOnSelectDefault({ env, platform });
  assert.equal(d({ TMUX: "x", WT_SESSION: "1" }, "linux"), true, "tmux wins");
  assert.equal(d({ ZELLIJ: "0" }, "darwin"), true);
  assert.equal(d({ WT_SESSION: "1" }, "win32"), false, "Windows Terminal copies its own selection");
  assert.equal(d({ TERM_PROGRAM: "vscode" }, "win32"), false);
  assert.equal(d({ TERM_PROGRAM: "vscode" }, "darwin"), true);
  assert.equal(d({ KITTY_WINDOW_ID: "1" }, "darwin"), false);
  assert.equal(d({ KITTY_WINDOW_ID: "1" }, "linux"), true);
  assert.equal(d({ TERM_PROGRAM: "ghostty", TERM_PROGRAM_VERSION: "1.2.0" }, "darwin"), false);
  assert.equal(d({ TERM_PROGRAM: "ghostty", TERM_PROGRAM_VERSION: "1.1.9" }, "darwin"), true);
  for (const tp of ["zed", "iTerm.app", "WezTerm", "Apple_Terminal", undefined]) assert.equal(d(tp ? { TERM_PROGRAM: tp } : {}, "darwin"), true, String(tp));
  assert.equal(copyOnSelectDefault({ env: { WT_SESSION: "1" }, platform: "win32", setting: "always" }), true);
  assert.equal(copyOnSelectDefault({ env: {}, platform: "darwin", setting: "never" }), false);
});

test("right-click paste: auto on Windows, WSL and Linux; never over SSH or in VS Code", () => {
  const p = (env, platform, setting) => rightClickPaste({ env, platform, setting, readFile: () => "" });
  assert.equal(p({}, "win32"), true);
  assert.equal(p({}, "linux"), true);
  assert.equal(p({}, "darwin"), false);
  assert.equal(p({}, "darwin", "on"), true);
  assert.equal(p({}, "win32", "off"), false);
  assert.equal(p({ SSH_TTY: "x" }, "linux", "on"), false);
  assert.equal(p({ TERM_PROGRAM: "vscode" }, "win32", "on"), false);
});

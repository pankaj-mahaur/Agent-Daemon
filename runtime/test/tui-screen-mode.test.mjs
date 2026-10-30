// Which screen mode ad starts in, and whether it captures the mouse (P2.1):
// one case per precedence row, the explicit-setting rule over config layers,
// and the per-terminal mouse defaults from P0.1's probe record.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FULLSCREEN_DEFAULT, MOUSE_RECORD, explicitIn, mouseDefault, resolveScreenMode } from "../src/tui/screen-mode.mjs";

const on = { fullscreenTranscript: true, fullscreenExplicit: true };

test("ad's default is inline for now (until the owner picks fullscreen)", () => {
  assert.equal(FULLSCREEN_DEFAULT, false);
  const r = resolveScreenMode({});
  assert.equal(r.mode, "inline");
  assert.match(r.reason, /ad's default/);
});

test("an explicit fullscreen_transcript = true wins over ad's default", () => {
  const r = resolveScreenMode(on);
  assert.equal(r.mode, "fullscreen");
  assert.equal(r.mouse, true);
});

test("a non-explicit true (the engine's packaged default) doesn't switch ad", () => {
  assert.equal(resolveScreenMode({ fullscreenTranscript: true, fullscreenExplicit: false }).mode, "inline");
});

test("precedence: --no-alt-screen, then alternate_screen = never, then fullscreen_transcript = false", () => {
  const flag = resolveScreenMode({ ...on, noAltScreen: true, altScreen: "always" });
  assert.deepEqual([flag.mode, /--no-alt-screen/.test(flag.reason)], ["inline", true], "--no-alt-screen beats alternate_screen = always");
  const never = resolveScreenMode({ ...on, altScreen: "never" });
  assert.deepEqual([never.mode, /alternate_screen/.test(never.reason)], ["inline", true]);
  const off = resolveScreenMode({ fullscreenTranscript: false, fullscreenExplicit: true });
  assert.deepEqual([off.mode, /fullscreen_transcript/.test(off.reason)], ["inline", true]);
});

test("Apple Terminal over SSH: inline on auto, fullscreen when alternate_screen = always", () => {
  assert.equal(resolveScreenMode({ ...on, altScreen: "auto", appleTerminalOverSsh: true }).mode, "inline");
  assert.equal(resolveScreenMode({ ...on, appleTerminalOverSsh: true }).mode, "inline", "auto is the default");
  assert.equal(resolveScreenMode({ ...on, altScreen: "always", appleTerminalOverSsh: true }).mode, "fullscreen");
});

test("mouse: screen.mouse wins; else tmux's mouse off turns it off; else the terminal's default", () => {
  assert.equal(resolveScreenMode({ ...on, mousePref: false }).mouse, false, "screen.mouse = false keeps fullscreen with the mouse off");
  assert.equal(resolveScreenMode({ ...on, mousePref: false }).mode, "fullscreen");
  assert.equal(resolveScreenMode({ ...on, mousePref: true, tmuxMouse: "off" }).mouse, true);
  assert.equal(resolveScreenMode({ ...on, tmuxMouse: "off" }).mouse, false);
  assert.equal(resolveScreenMode({ ...on, tmuxMouse: "on", mouseDefault: false }).mouse, false);
  assert.equal(resolveScreenMode({ ...on, mouseDefault: false }).mouse, false);
  assert.ok(resolveScreenMode({ ...on, tmuxMouse: "off" }).mouseReason.includes("tmux"));
});

test("explicitIn counts enabled user and sessionFlags layers only", () => {
  const set = (type, extra = {}) => ({ name: { type }, config: { tui: { fullscreen_transcript: true } }, ...extra });
  assert.equal(explicitIn([set("user")], "tui.fullscreen_transcript"), true);
  assert.equal(explicitIn([set("sessionFlags")], "tui.fullscreen_transcript"), true);
  for (const type of ["packagedDefault", "system", "mdm", "project"]) assert.equal(explicitIn([set(type)], "tui.fullscreen_transcript"), false, type);
  assert.equal(explicitIn([set("user", { disabledReason: "untrusted" })], "tui.fullscreen_transcript"), false, "a disabled user layer");
  assert.equal(explicitIn([{ name: { type: "user" }, config: { tui: {} } }], "tui.fullscreen_transcript"), false, "not set");
  assert.equal(explicitIn([{ name: { type: "user" }, config: { tui: { fullscreen_transcript: false } } }], "tui.fullscreen_transcript"), true, "false is explicit too");
  assert.equal(explicitIn(undefined, "tui.fullscreen_transcript"), false);
});

test("mouseDefault per terminal, from P0.1's record", () => {
  const win = (env) => mouseDefault({ env, platform: "win32" });
  assert.equal(MOUSE_RECORD["windows-terminal"], true);
  assert.equal(MOUSE_RECORD.zed, true);
  assert.equal(win({ WT_SESSION: "x" }), true, "Windows Terminal");
  assert.equal(win({ TERM_PROGRAM: "zed" }), true, "Zed");
  assert.equal(win({ TERM_PROGRAM: "vscode" }), true, "VS Code on Windows (not probed: on, screen.mouse turns it off)");
  assert.equal(win({}), false, "the legacy console host: Node can't turn QuickEdit off");
  assert.equal(mouseDefault({ env: {}, platform: "darwin" }), true, "macOS");
  assert.equal(mouseDefault({ env: {}, platform: "linux" }), true, "Linux");
  assert.equal(mouseDefault({ env: { WT_SESSION: "x" }, platform: "win32", record: { "windows-terminal": false } }), false, "the record decides");
});

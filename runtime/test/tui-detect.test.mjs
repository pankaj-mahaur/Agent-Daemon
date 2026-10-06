// Terminal detection (tui/terminal/detect.mjs): name, reflow model, width profile probe.

import { test } from "node:test";
import assert from "node:assert/strict";
import { terminalName, reflowModel, probeWidthProfile } from "../src/tui/terminal/detect.mjs";
import { modelScreen } from "../testkit/screen.mjs";

test("terminalName from the environment", () => {
  assert.equal(terminalName({ WT_SESSION: "x" }), "windows-terminal");
  assert.equal(terminalName({ TERM_PROGRAM: "zed" }), "zed");
  assert.equal(terminalName({ TERM_PROGRAM: "vscode" }), "vscode");
  assert.equal(terminalName({ TERM_PROGRAM: "iTerm.app" }), "iterm2");
  assert.equal(terminalName({ KITTY_WINDOW_ID: "1" }), "kitty");
  assert.equal(terminalName({}), "unknown");
});

test("terminalName: an editor started from Windows Terminal inherits WT_SESSION but is not Windows Terminal", () => {
  assert.equal(terminalName({ WT_SESSION: "x", TERM_PROGRAM: "vscode" }), "vscode");
  assert.equal(terminalName({ WT_SESSION: "x", TERM_PROGRAM: "zed" }), "zed");
  assert.equal(terminalName({ WT_SESSION: "x", TERM_PROGRAM: "Apple_Terminal" }), "unknown");
});

test("reflowModel: known terminals reflow, unknown ones are not assumed to", () => {
  assert.equal(reflowModel({ WT_SESSION: "x" }), "reflow");
  assert.equal(reflowModel({ TERM_PROGRAM: "zed" }), "reflow");
  assert.equal(reflowModel({ TERM: "xterm-256color" }), "unknown");
});

// cprs: the columns successive CPR queries answer (null = no answer).
function fakeIo(cprs) {
  const writes = [];
  const answers = [...cprs];
  return { writes, write: (s) => writes.push(s), cpr: async () => {
    const col = answers.shift();
    return col == null ? null : { row: 5, col };
  } };
}

test("probeWidthProfile: Windows Terminal clusters without probing", async () => {
  const io = fakeIo([1, 7]);
  assert.equal(await probeWidthProfile({ io, env: { WT_SESSION: "x" } }), "grapheme");
  assert.deepEqual(io.writes, [], "no probe written");
});

test("probeWidthProfile: VS Code started from Windows Terminal is probed, not assumed", async () => {
  const io = fakeIo([1, 7]);
  assert.equal(await probeWidthProfile({ io, env: { WT_SESSION: "x", TERM_PROGRAM: "vscode" } }), "codepoint");
});

test("probeWidthProfile: cursor at column 3 after a ZWJ family means clustering", async () => {
  const io = fakeIo([1, 3]);
  assert.equal(await probeWidthProfile({ io, env: {} }), "grapheme");
  assert.ok(io.writes[0].startsWith("\r\u{1f468}\u{200d}"), "the family is written at column 1");
  assert.equal(io.writes.at(-1), "\r\x1b[0m\x1b[K", "and erased");
});

test("probeWidthProfile: summing terminals, no answer, or no io stay on codepoint", async () => {
  assert.equal(await probeWidthProfile({ io: fakeIo([1, 7]), env: {} }), "codepoint");
  const silent = fakeIo([1, null]);
  assert.equal(await probeWidthProfile({ io: silent, env: {} }), "codepoint");
  assert.equal(silent.writes.at(-1), "\r\x1b[0m\x1b[K", "erased even without an answer");
  const deaf = fakeIo([null]);
  assert.equal(await probeWidthProfile({ io: deaf, env: {} }), "codepoint");
  assert.deepEqual(deaf.writes, [], "no CPR at all: nothing written");
  assert.equal(await probeWidthProfile({ env: {} }), "codepoint");
});

test("probeWidthProfile never erases text on the cursor's row", async () => {
  const scr = modelScreen({ cols: 40, rows: 6 });
  scr.feed("$ ad\r\nprompt without newline");
  await probeWidthProfile({ io: scr.io, env: {} });
  assert.deepEqual(scr.lines(), ["$ ad", "prompt without newline"]);
  const c = scr.cursor();
  assert.equal(c.col, 0, "left on an empty row at column 1");
});

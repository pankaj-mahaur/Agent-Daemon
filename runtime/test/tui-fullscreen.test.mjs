// The fullscreen renderer (P2.1) against xterm.js headless: the alternate
// screen, the transcript drawn from the top, the live region at the bottom,
// the write gate, resize re-wrap, stderr capture, and a clean main screen after.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createFullscreenRenderer, followText } from "../src/tui/terminal/fullscreen.mjs";
import { enterBytes, isActive, releaseAltScreen } from "../src/tui/terminal/alt-screen.mjs";
import { xtermScreen } from "../testkit/screen.mjs";

const line = (s) => [{ text: s }];
const timers = () => {
  const q = [];
  return {
    setTimeout: (fn) => (q.push(fn), q.length),
    clearTimeout: (id) => { q[id - 1] = null; },
    flush() { for (let i = 0; i < q.length; i++) { const f = q[i]; q[i] = null; f?.(); } },
  };
};
const fakeStderr = () => {
  const real = [];
  return { real, stream: { write(s) { real.push(String(s)); return true; } } };
};

function setup({ cols = 40, rows = 10, mouse = true, prefill, promptLast, sync = true } = {}) {
  const scr = xtermScreen({ cols, rows, prefill, promptLast, sync });
  const clock = timers();
  const err = fakeStderr();
  const sunk = [];
  const r = createFullscreenRenderer({ io: scr.io, caps: scr.io.caps, resizeSource: scr.resizeSource, mouse, stderr: err.stream, stderrSink: (t) => sunk.push(t), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  return { scr, r, clock, err, sunk };
}

afterEach(() => releaseAltScreen(() => {}));

test("start writes, in order: ?1049h, the keyboard push, mouse on, home and clear; mouse: false writes ?1007l and no mouse mode", async () => {
  const a = setup();
  a.r.start();
  assert.ok(a.scr.writes[0].startsWith(enterBytes({ mouse: true })), JSON.stringify(a.scr.writes[0]));
  await a.scr.settle();
  assert.equal(a.scr.bufferType(), "alternate");
  assert.equal(a.scr.modes().mouseTrackingMode, "drag");
  a.r.dispose();
  const b = setup({ mouse: false });
  b.r.start();
  assert.ok(b.scr.writes[0].startsWith(enterBytes({ mouse: false })));
  await b.scr.settle();
  assert.equal(b.scr.modes().mouseTrackingMode, "none");
  b.r.dispose();
});

test("start() throws when io isn't entered", () => {
  const a = setup();
  a.scr.io.entered = false;
  assert.throws(() => a.r.start(), /entered/);
  assert.equal(isActive(), false);
});

test("the shell's screen and scrollback are identical after dispose", async () => {
  const shell = Array.from({ length: 30 }, (_, i) => `shell line ${i}`);
  const a = setup({ prefill: shell });
  await a.scr.settle();
  const before = a.scr.normalLines();
  a.r.start();
  for (let i = 0; i < 100; i++) a.r.commit([line(`history ${i}`)]);
  a.clock.flush();
  a.r.frame({ lines: [line("› typing")], cursor: { row: 0, col: 9 } });
  a.scr.resize(30, 8);
  a.clock.flush();
  a.r.dispose();
  await a.scr.settle();
  assert.equal(a.scr.bufferType(), "normal");
  assert.deepEqual(a.scr.normalLines(), before);
  assert.equal(a.scr.modes().mouseTrackingMode, "none");
});

test("history fills from the top; the live region sits on the bottom rows; following shows the newest rows", async () => {
  const a = setup({ rows: 6 });
  a.r.start();
  a.r.commit([line("h1"), line("h2")]);
  a.clock.flush();
  a.r.frame({ lines: [line("live")], cursor: { row: 0, col: 0 } });
  await a.scr.settle();
  assert.deepEqual(a.scr.altLines(), ["h1", "h2", "", "", "", "live"]);
  for (let i = 3; i <= 9; i++) a.r.commit([line(`h${i}`)]);
  a.clock.flush();
  await a.scr.settle();
  assert.deepEqual(a.scr.altLines(), ["h5", "h6", "h7", "h8", "h9", "live"]);
  a.r.dispose();
});

test("an idle frame writes nothing; one write per frame, inside ?2026 with autowrap off", async () => {
  const a = setup();
  a.r.start();
  a.r.frame({ lines: [line("same")], cursor: { row: 0, col: 2 } });
  const n = a.scr.writes.length;
  a.r.frame({ lines: [line("same")], cursor: { row: 0, col: 2 } });
  assert.equal(a.scr.writes.length, n, "no change, no bytes");
  a.r.frame({ lines: [line("changed")], cursor: { row: 0, col: 2 } });
  assert.equal(a.scr.writes.length, n + 1);
  const w = a.scr.writes.at(-1);
  assert.ok(w.startsWith("\x1b[?2026h\x1b[?7l") && w.endsWith("\x1b[?7h\x1b[?2026l"), JSON.stringify(w));
  a.r.dispose();
});

test("while suspended nothing is written; resume repaints every committed entry, then sends queued terminal bytes", async () => {
  const a = setup();
  a.r.start();
  a.r.suspend();
  const n = a.scr.writes.length;
  a.r.commit([line("while away")]);
  a.r.frame({ lines: [line("live")] });
  a.scr.resize(50, 12);
  a.clock.flush();
  a.r.redraw();
  a.r.clear([line("header")]);
  a.r.terminalWrite("\x1b]52;c;aGk=\x07");
  assert.equal(a.scr.writes.length, n, "zero bytes while suspended");
  a.r.resume();
  await a.scr.settle();
  const after = a.scr.writes.slice(n).join("");
  assert.ok(after.includes("while away") || a.scr.altLines().includes("while away"));
  assert.ok(after.indexOf("\x1b]52;c;aGk=\x07") > after.lastIndexOf("live"), "the queued bytes come after the repaint");
  assert.equal(a.scr.bufferType(), "alternate");
  a.r.dispose();
});

test("resize re-renders entries from their render functions: wide → narrow → wide gives the original rows", async () => {
  const a = setup({ cols: 40, rows: 8 });
  a.r.start();
  a.r.commit([line("alpha beta gamma delta")], { render: (w) => (w >= 30 ? [line("alpha beta gamma delta")] : [line("alpha beta"), line("gamma delta")]) });
  a.clock.flush();
  await a.scr.settle();
  const wide = a.scr.altLines();
  a.scr.resize(20, 8);
  a.clock.flush();
  await a.scr.settle();
  assert.deepEqual(a.scr.altLines().slice(0, 2), ["alpha beta", "gamma delta"]);
  a.scr.resize(40, 8);
  a.clock.flush();
  await a.scr.settle();
  assert.deepEqual(a.scr.altLines(), wide);
  a.r.dispose();
});

test("clear() never writes CSI 3J; the shell's scrollback survives", async () => {
  const shell = Array.from({ length: 30 }, (_, i) => `shell ${i}`);
  const a = setup({ prefill: shell });
  await a.scr.settle();
  const before = a.scr.normalLines();
  a.r.start();
  a.r.commit([line("old")]);
  a.clock.flush();
  assert.equal(a.r.clear([line("header")]), true);
  await a.scr.settle();
  assert.ok(!a.scr.writes.join("").includes("\x1b[3J"));
  assert.deepEqual(a.scr.altLines(), ["header"]);
  a.r.dispose();
  await a.scr.settle();
  assert.deepEqual(a.scr.normalLines(), before);
});

test("settle() replaces a streamed group with one entry", async () => {
  const a = setup();
  a.r.start();
  a.r.commit([line("chunk one")], { key: "m1" });
  a.r.commit([line("chunk two")], { key: "m1" });
  a.r.settle("m1", () => [line("the whole answer")]);
  a.clock.flush();
  await a.scr.settle();
  assert.deepEqual(a.scr.altLines(), ["the whole answer"]);
  a.r.dispose();
});

test("stderr while fullscreen goes to the sink, not the screen; it reaches the real stderr after dispose", async () => {
  const a = setup();
  a.r.start();
  a.r.frame({ lines: [line("live")] });
  a.err.stream.write("warning: something\n");
  assert.deepEqual(a.sunk, ["warning: something\n"]);
  assert.deepEqual(a.err.real, [], "held while the alternate screen is up");
  a.r.dispose();
  assert.deepEqual(a.err.real, ["warning: something\n"]);
  a.err.stream.write("later\n");
  assert.deepEqual(a.err.real, ["warning: something\n", "later\n"], "the original write is back");
});

test("after the guard is released elsewhere (io.restore on a crash), frame and dispose write nothing", async () => {
  const a = setup();
  a.r.start();
  releaseAltScreen(a.scr.io.writeSync);
  const n = a.scr.writes.length;
  a.r.frame({ lines: [line("too late")] });
  a.r.commit([line("too late")]);
  a.clock.flush();
  a.r.dispose();
  assert.equal(a.scr.writes.length, n);
  a.err.stream.write("x\n");
  assert.deepEqual(a.err.real, ["x\n"], "stderr given back on release");
});

/* The follow control (P2.2) */


test("the follow control shows the widest engine text that fits, with and without new activity", () => {
  assert.equal(followText(80, true), " New activity \u{b7} \u{2193} Back to bottom \u{b7} esc ");
  assert.equal(followText(30, true), " New activity \u{b7} \u{2193} Bottom ");
  assert.equal(followText(12, true), " \u{2193} Bottom ");
  assert.equal(followText(4, true), " \u{2193} ");
  assert.equal(followText(80, false), " \u{2193} Back to bottom \u{b7} esc ");
  assert.equal(followText(30, false), " \u{2193} Back to bottom \u{b7} esc ");
  assert.equal(followText(12, false), " \u{2193} Bottom ");
  assert.equal(followText(4, false), " \u{2193} ");
});

test("scrolled: the last transcript row is the follow control; new output leaves every other row unchanged", async () => {
  const a = setup({ cols: 40, rows: 8 });
  a.r.start();
  for (let i = 0; i < 30; i++) a.r.commit([line(`h${i}`)]);
  a.clock.flush();
  a.r.frame({ lines: [line("live")] });
  a.r.transcript.scroll(-5);
  await a.scr.settle();
  const before = a.scr.altLines();
  assert.equal(before[6].trim(), followText(40, false).trim());
  assert.equal(a.r.transcript.following, false);
  a.r.commit([line("fresh output")]);
  a.clock.flush();
  await a.scr.settle();
  const after = a.scr.altLines();
  assert.deepEqual(after.slice(0, 6), before.slice(0, 6));
  assert.equal(after[6].trim(), followText(40, true).trim());
  assert.equal(after[7], "live");
  assert.equal(a.r.transcript.rowAt(6), "control");
  a.r.transcript.jumpLatest();
  await a.scr.settle();
  assert.equal(a.scr.altLines()[6], "fresh output");
  a.r.dispose();
});

test("transcript.height is the rows above the live region; page() scrolls by it", async () => {
  const a = setup({ cols: 40, rows: 10 });
  a.r.start();
  for (let i = 0; i < 40; i++) a.r.commit([line(`h${i}`)]);
  a.clock.flush();
  a.r.frame({ lines: [line("live 1"), line("live 2")] });
  assert.equal(a.r.transcript.height, 8);
  a.r.transcript.scroll(-(a.r.transcript.height - 1));
  await a.scr.settle();
  assert.equal(a.scr.altLines()[0], "h25");
  a.r.dispose();
});

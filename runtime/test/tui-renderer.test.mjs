// Inline renderer (tui/terminal/renderer.mjs) against two terminals: real
// xterm.js (reflows on resize, like Windows Terminal and Zed) and a model that
// never reflows. Invisible characters are written as \u{...} escapes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRenderer } from "../src/tui/terminal/renderer.mjs";
import { truncate, lineWidth } from "../src/tui/terminal/text.mjs";
import { xtermScreen, modelScreen } from "../testkit/screen.mjs";

const SCREENS = [
  ["xterm (reflows)", (o) => xtermScreen(o), "reflow"],
  ["model (no reflow)", (o) => modelScreen(o), "none"],
];

const plain = (line) => (typeof line === "string" ? line : line.map((s) => s.text).join(""));
const cut = (line, cols) => truncate(typeof line === "string" ? [{ text: line }] : line, cols - 1).map((s) => s.text).join("").replace(/\s+$/, "");

async function setup(make, reflow, opts = {}) {
  const scr = make({ cols: 40, rows: 10, ...opts });
  if (opts.preamble !== false) scr.feed("$ ad\r\n");
  const r = createRenderer({ io: scr.io, reflow, resizeSource: scr.resizeSource, ...opts.renderer });
  await scr.settle();
  await r.start();
  await scr.settle();
  return { scr, r };
}

for (const [name, make, reflow] of SCREENS) {
  test(`${name}: a frame draws below what was there; commits land above it`, async () => {
    const { scr, r } = await setup(make, reflow);
    r.frame({ lines: ["> composer", "  footer"], cursor: { row: 0, col: 2 } });
    await scr.settle();
    assert.deepEqual(scr.lines(), ["$ ad", "> composer", "  footer"]);
    r.commit(["history one", [{ text: "history two", style: { bold: true } }]]);
    await scr.settle();
    assert.deepEqual(scr.lines(), ["$ ad", "history one", "history two", "> composer", "  footer"]);
    const c = scr.cursor();
    assert.equal(c.col, 2, "parked at the composer column");
    assert.equal(scr.lines()[c.row], "> composer");
  });

  test(`${name}: frames shrink and grow without touching history`, async () => {
    const { scr, r } = await setup(make, reflow);
    r.commit(["kept"]);
    r.frame({ lines: ["a", "b", "c", "d"] });
    await scr.settle();
    r.frame({ lines: ["a"] });
    await scr.settle();
    assert.deepEqual(scr.lines(), ["$ ad", "kept", "a"]);
    r.frame({ lines: ["x", "y", "z"] });
    await scr.settle();
    assert.deepEqual(scr.lines(), ["$ ad", "kept", "x", "y", "z"]);
    r.frame({ lines: [] });
    await scr.settle();
    assert.deepEqual(scr.lines(), ["$ ad", "kept"]);
  });

  test(`${name}: lines longer than the screen are cut to cols − 1, never wrapped`, async () => {
    const { scr, r } = await setup(make, reflow);
    const long = "x".repeat(100);
    const wide = "\u{65e5}".repeat(30);
    r.commit([long]);
    r.frame({ lines: [wide, "end"] });
    await scr.settle();
    const lines = scr.lines();
    // Cut to 39 columns, the last one an ellipsis.
    assert.deepEqual(lines.slice(1), ["x".repeat(38) + "\u{2026}", "\u{65e5}".repeat(19) + "\u{2026}", "end"]);
  });

  test(`${name}: the live region is at most rows − 1 lines, bottom kept`, async () => {
    const { scr, r } = await setup(make, reflow, { rows: 5 });
    const many = Array.from({ length: 12 }, (_, i) => `line ${i}`);
    r.frame({ lines: many, cursor: { row: 11, col: 0 } });
    await scr.settle();
    assert.deepEqual(scr.lines().slice(-4), ["line 8", "line 9", "line 10", "line 11"]);
    assert.ok(scr.lines().includes("$ ad"), "history kept");
  });

  test(`${name}: tiny screens (2 rows) still work`, async () => {
    const { scr, r } = await setup(make, reflow, { rows: 2, cols: 10 });
    r.frame({ lines: ["one", "two"] });
    r.commit(["h1", "h2"]);
    r.frame({ lines: ["three"] });
    await scr.settle();
    assert.deepEqual(scr.lines(), ["$ ad", "h1", "h2", "three"]);
  });

  test(`${name}: start on a row that already has text moves to a fresh row`, async () => {
    const scr = make({ cols: 40, rows: 10 });
    scr.feed("prompt without newline");
    const r = createRenderer({ io: scr.io, reflow });
    await scr.settle();
    await r.start();
    r.frame({ lines: ["live"] });
    await scr.settle();
    assert.deepEqual(scr.lines(), ["prompt without newline", "live"]);
  });

  test(`${name}: resize (narrower, then wider) re-anchors without ghost rows or lost history`, async () => {
    const { scr, r } = await setup(make, reflow);
    r.commit(["short history"]);
    r.frame({ lines: ["a".repeat(35), "b".repeat(35), "> type here"], cursor: { row: 2, col: 11 } });
    await scr.settle();
    let resized = 0;
    r.onResize(() => resized++);
    scr.resize(20, 10);
    await new Promise((res) => setTimeout(res, 120));
    await scr.settle();
    r.frame({ lines: ["a".repeat(15), "> type here"], cursor: { row: 1, col: 11 } });
    await scr.settle();
    assert.equal(resized, 1);
    assert.deepEqual(scr.lines(), ["$ ad", "short history", "a".repeat(15), "> type here"]);
    scr.resize(50, 10);
    await new Promise((res) => setTimeout(res, 120));
    await scr.settle();
    r.frame({ lines: ["wide again", "> type here"], cursor: { row: 1, col: 11 } });
    await scr.settle();
    assert.deepEqual(scr.lines(), ["$ ad", "short history", "wide again", "> type here"]);
  });

  test(`${name}: suspend erases the live region; the child's output stays; resume redraws below it`, async () => {
    const { scr, r } = await setup(make, reflow);
    r.frame({ lines: ["> composer", "footer"] });
    r.commit(["before handoff"]);
    await scr.settle();
    r.suspend();
    r.frame({ lines: ["not drawn while suspended"] });
    r.commit(["queued during handoff"]);
    await scr.settle();
    scr.feed("child output\r\nmore child\r\n");
    await scr.settle();
    await r.resume();
    r.frame({ lines: ["> composer"] });
    await scr.settle();
    assert.deepEqual(scr.lines(), ["$ ad", "before handoff", "child output", "more child", "queued during handoff", "> composer"]);
  });

  test(`${name}: redraw (Ctrl+L) keeps the screen as it is`, async () => {
    const { scr, r } = await setup(make, reflow);
    r.commit(["h"]);
    r.frame({ lines: ["l1", "l2"], cursor: { row: 0, col: 1 } });
    await scr.settle();
    const before = scr.lines();
    await r.redraw();
    await scr.settle();
    assert.deepEqual(scr.lines(), before);
  });
}

/* ------------------------------------------------------------------ */
/* Escape-level rules                                                  */
/* ------------------------------------------------------------------ */

test("escape rules: no 2J/3J, no zero-count moves, resets before K/J/CRLF, one write per frame in ?2026", async () => {
  const { scr, r } = await setup((o) => xtermScreen(o), "reflow");
  const startIdx = scr.writes.length;
  r.frame({ lines: [[{ text: "red", style: { bg: "red" } }], "plain"], cursor: { row: 0, col: 0 } });
  r.frame({ lines: [[{ text: "red", style: { bg: "red" } }], "changed"], cursor: { row: 1, col: 3 } });
  r.commit([[{ text: "styled history", style: { fg: "green" } }]]);
  r.frame({ lines: ["only"] });
  r.frame({ lines: ["only", [{ text: "grown", style: { bg: "blue" } }], "and more"] }); // appends below the last row
  await scr.settle();
  const writes = scr.writes.slice(startIdx);
  assert.equal(writes.length, 5, "one write per frame/commit");
  for (const w of writes) {
    assert.ok(w.startsWith("\x1b[?2026h") && w.endsWith("\x1b[?2026l"), "synchronized");
    assert.ok(!/\x1b\[[23]J/.test(w), "never clears screen or scrollback");
    assert.ok(!/\x1b\[0[ABCD]/.test(w), "no zero-count cursor moves");
    for (const m of w.matchAll(/\x1b\[K|\x1b\[J|\r\n/g)) {
      const before = w.slice(0, m.index);
      assert.ok(before.endsWith("\x1b[0m") || before.endsWith("\x1b[K"), `reset before ${JSON.stringify(m[0])} in ${JSON.stringify(w)}`);
    }
    assert.ok(w.includes("\x1b[?7l") && w.lastIndexOf("\x1b[?7h") > w.lastIndexOf("\x1b[?7l"), "autowrap off, then back on");
  }
});

test("only changed lines are rewritten", async () => {
  const { scr, r } = await setup((o) => xtermScreen(o), "reflow");
  r.frame({ lines: ["same 1", "same 2", "old 3"] });
  await scr.settle();
  const i = scr.writes.length;
  r.frame({ lines: ["same 1", "same 2", "new 3"] });
  await scr.settle();
  const w = scr.writes.slice(i).join("");
  assert.ok(w.includes("new 3") && !w.includes("same 1") && !w.includes("same 2"), JSON.stringify(w));
  const j = scr.writes.length;
  r.frame({ lines: ["same 1", "same 2", "new 3"] });
  await scr.settle();
  assert.equal(scr.writes.length, j, "an identical frame writes nothing");
});

test("without ?2026, commits are batched at least 150 ms apart", async () => {
  let t = 1000;
  const timers = [];
  const scr = xtermScreen({ cols: 40, rows: 10, sync: false });
  const r = createRenderer({
    io: scr.io,
    now: () => t,
    setTimeout: (fn, ms) => {
      const h = { fn, at: t + ms };
      timers.push(h);
      return h;
    },
    clearTimeout: (h) => timers.splice(timers.indexOf(h), 1),
  });
  await r.start();
  r.frame({ lines: ["live"] });
  const i = scr.writes.length;
  r.commit(["one"]);
  r.commit(["two"]);
  r.commit(["three"]);
  assert.equal(scr.writes.length, i + 1, "first commit goes out, the next two wait");
  t += 150;
  for (const h of timers.splice(0)) h.fn();
  assert.equal(scr.writes.length, i + 2, "then one write for both");
  await scr.settle();
  assert.deepEqual(scr.lines(), ["one", "two", "three", "live"]);
  assert.ok(!scr.writes.slice(i).some((w) => w.includes("\x1b[?2026h")));
});

/* ------------------------------------------------------------------ */
/* Races with a slow CPR answer (review 1c: C1, C2, H1–H3)             */
/* ------------------------------------------------------------------ */

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

for (const [name, make, reflow] of SCREENS) {
  test(`${name}: commits made while redraw waits for CPR are not erased`, async () => {
    const { scr, r } = await setup(make, reflow, { cprDelayMs: 60 });
    r.commit(["h0"]);
    r.frame({ lines: ["live1", "live2"] });
    await scr.settle();
    const p = r.redraw();
    r.commit(["h1", "h2"]);
    await p;
    await wait(20);
    await scr.settle();
    assert.deepEqual(scr.lines(), ["$ ad", "h0", "h1", "h2", "live1", "live2"]);
  });

  test(`${name}: a commit queued during a resize survives a second resize with a slow CPR`, async () => {
    const { scr, r } = await setup(make, reflow, { cprDelayMs: 150 });
    r.frame({ lines: ["live"] });
    await scr.settle();
    scr.resize(36, 10);
    r.commit(["queued during resize"]);
    await wait(100); // the first re-anchor is now waiting for its CPR
    scr.resize(34, 10);
    await wait(500);
    await scr.settle();
    assert.deepEqual(scr.lines(), ["$ ad", "queued during resize", "live"]);
  });

  test(`${name}: a cursor column far past the line doesn't make a resize erase history`, async () => {
    const { scr, r } = await setup(make, reflow);
    r.commit(["hist A", "hist B", "hist C"]);
    r.frame({ lines: ["L1", "> z"], cursor: { row: 1, col: 100 } });
    await scr.settle();
    scr.resize(20, 10);
    await wait(120);
    await scr.settle();
    assert.deepEqual(scr.lines(), ["$ ad", "hist A", "hist B", "hist C", "L1", "> z"]);
  });

  test(`${name}: a live line measured wider than the terminal draws doesn't make a resize erase history`, async () => {
    const { scr, r } = await setup(make, reflow);
    r.commit(["hist A", "hist B", "hist C"]);
    // U+1FAE8 is wide in Unicode 15+, one cell in xterm.js's Unicode 11 table.
    r.frame({ lines: ["\u{1fae8}".repeat(15), "> z"], cursor: { row: 1, col: 3 } });
    await scr.settle();
    scr.resize(20, 10);
    await wait(120);
    await scr.settle();
    const lines = scr.lines();
    for (const h of ["hist A", "hist B", "hist C"]) assert.ok(lines.includes(h), `${h} kept: ${JSON.stringify(lines)}`);
    assert.equal(lines.at(-1), "> z");
  });

  test(`${name}: a resize just before suspend doesn't draw over the child's output`, async () => {
    const { scr, r } = await setup(make, reflow);
    r.frame({ lines: ["> composer"] });
    await scr.settle();
    scr.resize(30, 10);
    r.suspend();
    scr.feed("child output\r\n");
    await wait(150);
    r.frame({ lines: ["drawn while suspended?"] });
    await scr.settle();
    assert.deepEqual(scr.lines(), ["$ ad", "child output"]);
    assert.equal(r.state.suspended, true);
    await r.resume();
    r.frame({ lines: ["> composer"] });
    await scr.settle();
    assert.deepEqual(scr.lines(), ["$ ad", "child output", "> composer"]);
  });

  test(`${name}: a redraw waiting for CPR when suspend comes doesn't overwrite the child's output`, async () => {
    const { scr, r } = await setup(make, reflow, { cprDelayMs: 60 });
    r.frame({ lines: ["> composer"] });
    await scr.settle();
    const p = r.redraw();
    r.suspend();
    scr.feed("child output\r\n");
    await p;
    r.frame({ lines: ["drawn while suspended?"] });
    await wait(20);
    await scr.settle();
    assert.deepEqual(scr.lines(), ["$ ad", "child output"]);
  });

  test(`${name}: a resize during a redraw's CPR wait leaves no stale visible row`, async () => {
    const { scr, r } = await setup(make, reflow, { cprDelayMs: 60 });
    r.commit(["hist"]);
    r.frame({ lines: ["a".repeat(35), "> z"], cursor: { row: 1, col: 3 } });
    await scr.settle();
    const p = r.redraw();
    scr.resize(20, 10);
    await p;
    r.frame({ lines: ["a".repeat(15), "> z"], cursor: { row: 1, col: 3 } });
    await wait(250);
    r.frame({ lines: ["a".repeat(15), "> z"], cursor: { row: 1, col: 3 } });
    await scr.settle();
    assert.deepEqual(scr.visible(), ["$ ad", "hist", "a".repeat(15), "> z"]);
  });
}

test("a resize while a redraw waits for CPR: only the resize's re-anchor writes", async () => {
  const scr = modelScreen({ cols: 40, rows: 10, cprDelayMs: 60 });
  const r = createRenderer({ io: scr.io, reflow: "none", resizeSource: scr.resizeSource });
  await r.start();
  r.frame({ lines: ["a".repeat(30), "> z"] });
  const p = r.redraw();
  scr.resize(20, 10);
  const i = scr.writes.length;
  await p;
  await wait(250);
  const anchors = scr.writes.slice(i).filter((w) => /\x1b\[\d+;1H/.test(w));
  assert.equal(anchors.length, 1, "the redraw's stale re-anchor wrote nothing");
});

test("no CPR query reaches the terminal while a child owns it", async () => {
  const scr = modelScreen({ cols: 40, rows: 10 });
  const r = createRenderer({ io: scr.io, reflow: "none", resizeSource: scr.resizeSource });
  await r.start();
  r.frame({ lines: ["> z"] });
  scr.resize(30, 10);
  r.suspend();
  const i = scr.writes.length;
  await wait(150); // past the 75 ms resize quiet time
  await r.redraw();
  assert.ok(!scr.writes.slice(i).some((w) => w.includes("\x1b[6n")), JSON.stringify(scr.writes.slice(i)));
});

test("suspend and an immediate resume while a redraw waits for CPR: the stale redraw writes nothing", async () => {
  const scr = modelScreen({ cols: 40, rows: 10, cprDelayMs: 60 });
  const r = createRenderer({ io: scr.io, reflow: "none" });
  scr.feed("$ ad\r\n");
  await r.start();
  r.frame({ lines: ["> composer"] });
  const p = r.redraw();
  r.suspend();
  scr.feed("child output\r\n");
  const q = r.resume();
  await Promise.all([p, q]);
  r.frame({ lines: ["> composer"] });
  await wait(20);
  assert.deepEqual(scr.lines(), ["$ ad", "child output", "> composer"]);
});

test("an identical frame whose cursor column is past the edge writes nothing", async () => {
  const scr = modelScreen({ cols: 20, rows: 10 });
  const r = createRenderer({ io: scr.io, reflow: "none" });
  await r.start();
  r.frame({ lines: ["> long composer"], cursor: { row: 0, col: 50 } });
  let i = scr.writes.length;
  r.frame({ lines: ["> long composer"], cursor: { row: 0, col: 50 } });
  assert.equal(scr.writes.length, i, "after a frame");
  r.commit(["history"]); // redraws the live region through the other path
  i = scr.writes.length;
  r.frame({ lines: ["> long composer"], cursor: { row: 0, col: 50 } });
  assert.equal(scr.writes.length, i, "after a commit");
});

test("suspend writes commits still waiting for their batch before the child's output", async () => {
  let t = 1000;
  const timers = [];
  const scr = modelScreen({ cols: 40, rows: 10, sync: false });
  const r = createRenderer({
    io: scr.io,
    now: () => t,
    setTimeout: (fn, ms) => {
      const h = { fn, at: t + ms };
      timers.push(h);
      return h;
    },
    clearTimeout: (h) => timers.splice(timers.indexOf(h), 1),
  });
  await r.start();
  r.frame({ lines: ["live"] });
  r.commit(["first"]);
  r.commit(["waiting for the batch"]);
  r.suspend();
  scr.feed("child output\r\n");
  await r.resume();
  r.frame({ lines: ["live"] });
  assert.deepEqual(scr.lines(), ["first", "waiting for the batch", "child output", "live"]);
  assert.equal(timers.length, 0, "the batch timer was cancelled");
});

/* ------------------------------------------------------------------ */
/* Property: screen = history + last frame                             */
/* ------------------------------------------------------------------ */

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const WORDS = ["alpha", "beta", "\u{65e5}\u{672c}", "\u{1f44d}", "gamma-delta", "x", "caf\u{e9}", "long".repeat(12)];

// Random sessions. `exact` keeps every live line narrower than any width the
// run uses and never shrinks the height, so nothing is pushed into scrollback
// by the terminal: then the screen must be exactly history + last frame. The
// general run allows long lines and height shrinks, where a terminal may push
// live rows into scrollback (ghost rows, plan 1c): history must still be
// intact and in order, and the last lines must be exactly the last frame.
async function randomSession(make, reflow, seed, exact) {
  const random = rng(seed);
  const minCols = 14;
  let cols = 30 + Math.floor(random() * 30);
  let rows = 4 + Math.floor(random() * 8);
  const scr = make({ cols, rows });
  const r = createRenderer({ io: scr.io, reflow, resizeSource: scr.resizeSource });
  scr.feed("$ ad\r\n");
  await scr.settle();
  await r.start();
  const history = ["$ ad"];
  let narrowed = false; // a width decrease happened
  let frame = [];
  const sentence = (max) =>
    Array.from({ length: 1 + Math.floor(random() * 4) }, () => WORDS[Math.floor(random() * WORDS.length)])
      .join(" ")
      .slice(0, max)
      .replace(/[\u{d800}-\u{dbff}]$/u, "");
  // At most minCols − 1 columns wide (display width), so it fits every width the run uses.
  const narrow = () => cut(sentence(80), minCols);
  for (let step = 0; step < 25; step++) {
    const op = random();
    if (op < 0.45) {
      frame = Array.from({ length: Math.floor(random() * (rows + 3)) }, () => (exact ? narrow() : sentence(80)));
      const row = frame.length ? Math.floor(random() * frame.length) : 0;
      // Cursor columns up to 70: past the line and past narrow widths too.
      r.frame({ lines: frame, cursor: { row, col: Math.floor(random() * 70) } });
    } else if (op < 0.55) {
      await r.redraw();
    } else if (op < 0.62) {
      // A handoff: the child prints, then the UI comes back below it.
      r.suspend();
      const out = `child ${step}`;
      scr.feed(`${out}\r\n`);
      history.push(out);
      await r.resume();
    } else if (op < 0.82) {
      // History stays narrower than any width the run uses, so a reflowing
      // terminal never re-wraps it (that part is the terminal's business).
      const h = Array.from({ length: 1 + Math.floor(random() * 3) }, narrow);
      r.commit(h);
      history.push(...h.map((l) => l.replace(/\s+$/, "")));
    } else {
      const newCols = minCols + Math.floor(random() * 50);
      if (newCols < cols) narrowed = true;
      cols = newCols;
      rows = exact ? rows + Math.floor(random() * 3) : 3 + Math.floor(random() * 10);
      scr.resize(cols, rows);
      await new Promise((res) => setTimeout(res, 100));
    }
    await scr.settle();
  }
  await new Promise((res) => setTimeout(res, 100));
  await scr.settle();
  r.dispose();
  const live = frame.slice(-Math.max(1, rows - 1)).map((l) => cut(l, cols));
  while (live.length && live.at(-1) === "") live.pop();
  return { lines: scr.lines(), visible: scr.visible(), history, live, cols, rows, narrowed };
}

for (const [name, make, reflow] of SCREENS) {
  test(`${name}: property (exact) — screen = history + last frame`, async () => {
    for (let round = 0; round < 12; round++) {
      const { lines, history, live, cols, rows } = await randomSession(make, reflow, 1000 + round * 7 + name.length, true);
      const expected = [...history, ...live];
      while (expected.length && expected.at(-1) === "") expected.pop();
      assert.deepEqual(lines, expected, `round ${round} (${cols}x${rows})`);
    }
  });

  test(`${name}: property (any resize) — history intact and in order, last frame at the bottom`, async () => {
    for (let round = 0; round < 12; round++) {
      const { lines, visible, history, live, cols, rows, narrowed } = await randomSession(make, reflow, 5000 + round * 13 + name.length, false);
      const ctx = `round ${round} (${cols}x${rows})`;
      assert.deepEqual(lines.slice(lines.length - live.length), live, `${ctx}: bottom is the last frame`);
      // History is a subsequence (ghost rows may sit between its lines).
      let i = 0;
      for (const line of lines) if (i < history.length && line === history[i]) i++;
      assert.equal(i, history.length, `${ctx}: history line ${i} (${JSON.stringify(history[i])}) missing or out of order`);
      // The viewport is an exact tail, except on a reflowing terminal after a
      // width decrease: xterm.js keeps the cursor on its screen row while rows
      // below it wrap and scroll the content, so a few ghost rows can stay
      // visible (accepted: history is never erased; see plan 1c).
      if (narrowed && reflow === "reflow") continue;
      const expected = [...history, ...live];
      assert.deepEqual(visible, expected.slice(expected.length - visible.length), `${ctx}: stale row in the visible screen`);
    }
  });
}

test("plain helper sanity", () => {
  assert.equal(plain([{ text: "a" }, { text: "b" }]), "ab");
});

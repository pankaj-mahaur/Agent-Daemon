// The fullscreen transcript buffer (P2.1): entries kept as render functions or
// fixed lines, laid out lazily from the bottom, re-wrapped on resize, capped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTranscript, TRIMMED_TEXT } from "../src/tui/terminal/transcript.mjs";

const text = (rows) => rows.map((l) => l.map((s) => s.text).join(""));
const line = (s) => [{ text: s }];

test("fixed entries come back in order; a short transcript is all of it, top flagged", () => {
  const t = createTranscript();
  t.append({ lines: [line("one"), line("two")] });
  t.append({ lines: [line("three")] });
  const w = t.window({ width: 40, height: 10 });
  assert.deepEqual(text(w.rows), ["one", "two", "three"]);
  assert.equal(w.top, true);
  assert.equal(t.size(), 2);
  assert.equal(t.following, true);
});

test("a tall transcript shows its newest rows", () => {
  const t = createTranscript();
  for (let i = 0; i < 50; i++) t.append({ lines: [line(`row ${i}`)] });
  const w = t.window({ width: 40, height: 5 });
  assert.deepEqual(text(w.rows), ["row 45", "row 46", "row 47", "row 48", "row 49"]);
  assert.equal(w.top, false);
});

test("render entries are called with the width and re-render after a resize; wide → narrow → wide gives the original rows", () => {
  const t = createTranscript();
  const words = "alpha beta gamma delta epsilon";
  const widths = [];
  t.append({
    render: (w) => {
      widths.push(w);
      return w >= 40 ? [line(words)] : [line("alpha beta"), line("gamma delta"), line("epsilon")];
    },
  });
  const wide = text(t.window({ width: 60, height: 10 }).rows);
  t.window({ width: 60, height: 10 });
  assert.deepEqual(widths, [60], "cached at the same width");
  t.layout(20);
  assert.deepEqual(text(t.window({ width: 20, height: 10 }).rows), ["alpha beta", "gamma delta", "epsilon"]);
  t.layout(60);
  assert.deepEqual(text(t.window({ width: 60, height: 10 }).rows), wide);
  assert.deepEqual(widths, [60, 20, 60]);
});

test("fixed lines are re-wrapped at a narrow width without losing a character", () => {
  const t = createTranscript();
  const long = "The quick brown fox jumps over the lazy dog and keeps running far away";
  t.append({ lines: [line(long), [], line("x")] });
  const rows = text(t.window({ width: 20, height: 50 }).rows);
  assert.ok(rows.every((r) => r.length <= 20), rows.join("|"));
  assert.equal(rows.join(" ").replace(/\s+/g, " ").trim(), `${long} x`);
  assert.ok(rows.includes(""), "the blank line stays");
});

test("lazy layout: a resize with 5,000 entries renders only about two screens", () => {
  const t = createTranscript();
  let calls = 0;
  for (let i = 0; i < 5000; i++) t.append({ render: () => { calls++; return [line(`entry ${i}`)]; } });
  t.window({ width: 80, height: 30 });
  calls = 0;
  t.layout(60);
  const w = t.window({ width: 60, height: 30 });
  assert.equal(w.rows.length, 30);
  assert.ok(calls <= 60, `rendered ${calls} entries`);
  assert.equal(text(w.rows).at(-1), "entry 4999");
});

test("past maxEntries the oldest tenth goes and one trimmed marker stays first", () => {
  const t = createTranscript({ maxEntries: 100 });
  for (let i = 0; i < 101; i++) t.append({ lines: [line(`e${i}`)] });
  const all = text(t.window({ width: 120, height: 1000 }).rows);
  assert.equal(all[0], TRIMMED_TEXT);
  assert.equal(all[1], "e10");
  assert.equal(all.at(-1), "e100");
  for (let i = 101; i < 200; i++) t.append({ lines: [line(`e${i}`)] });
  const again = text(t.window({ width: 120, height: 1000 }).rows);
  assert.equal(again.filter((r) => r === TRIMMED_TEXT).length, 1, "one marker");
  assert.equal(again[0], TRIMMED_TEXT);
  assert.ok(t.size() <= 101);
});

test("an entry taller than entryMaxRows keeps its last rows behind a count line", () => {
  const t = createTranscript({ entryMaxRows: 10 });
  t.append({ render: () => Array.from({ length: 25 }, (_, i) => line(`r${i}`)) });
  const rows = text(t.window({ width: 40, height: 100 }).rows);
  assert.equal(rows.length, 10);
  assert.equal(rows[0], "… 16 earlier lines (Ctrl+T shows them)");
  assert.equal(rows[1], "r16");
  assert.equal(rows.at(-1), "r24");
});

test("settle() replaces a streamed group with one entry where the group began", () => {
  const t = createTranscript();
  t.append({ lines: [line("before")] });
  t.append({ lines: [line("chunk 1")], key: "msg-1" });
  t.append({ lines: [line("chunk 2")], key: "msg-1" });
  t.append({ lines: [line("other")], key: "msg-2" });
  t.settle("msg-1", (w) => [line(`whole answer at ${w}`)]);
  assert.deepEqual(text(t.window({ width: 30, height: 10 }).rows), ["before", "whole answer at 30", "other"]);
  assert.equal(t.size(), 3);
  t.settle("msg-3", () => [line("new")]);
  assert.deepEqual(text(t.window({ width: 30, height: 10 }).rows).at(-1), "new", "an unknown key appends");
});

test("clear() empties the transcript (the marker too)", () => {
  const t = createTranscript({ maxEntries: 10 });
  for (let i = 0; i < 20; i++) t.append({ lines: [line(`e${i}`)] });
  t.clear();
  assert.equal(t.size(), 0);
  assert.deepEqual(t.window({ width: 30, height: 10 }).rows, []);
  t.append({ lines: [line("fresh")] });
  assert.deepEqual(text(t.window({ width: 30, height: 10 }).rows), ["fresh"]);
});

test("append needs lines or a render function; render output is copied, not kept by reference", () => {
  const t = createTranscript();
  assert.throws(() => t.append({}), TypeError);
  const out = [line("kept")];
  t.append({ render: () => out });
  t.window({ width: 30, height: 5 });
  out.push(line("added later"));
  assert.deepEqual(text(t.window({ width: 30, height: 5 }).rows), ["kept"]);
});

/* Scrolling (P2.2) */

const rowsOfN = (n, prefix = "r") => Array.from({ length: n }, (_, i) => line(`${prefix}${i}`));
const fill = (t, n) => { for (let i = 0; i < n; i++) t.append({ lines: [line(`e${i}`)] }); };
const view = (t, height = 5, width = 40) => text(t.window({ width, height }).rows);

test("scroll up stops at the top; scrolling down to the bottom resumes following", () => {
  const t = createTranscript();
  fill(t, 20);
  assert.deepEqual(view(t), ["e15", "e16", "e17", "e18", "e19"]);
  t.scroll(-3, { width: 40, height: 5 });
  assert.equal(t.following, false);
  assert.deepEqual(view(t), ["e12", "e13", "e14", "e15", "e16"]);
  t.scroll(-100, { width: 40, height: 5 });
  assert.deepEqual(view(t), ["e0", "e1", "e2", "e3", "e4"]);
  assert.equal(t.window({ width: 40, height: 5 }).top, true);
  t.scroll(-1, { width: 40, height: 5 });
  assert.deepEqual(view(t), ["e0", "e1", "e2", "e3", "e4"], "never past the top");
  t.scroll(100, { width: 40, height: 5 });
  assert.equal(t.following, true);
  assert.deepEqual(view(t), ["e15", "e16", "e17", "e18", "e19"]);
});

test("scrolling crosses entries of several rows, row by row", () => {
  const t = createTranscript();
  t.append({ lines: rowsOfN(4, "a") });
  t.append({ lines: rowsOfN(4, "b") });
  t.append({ lines: rowsOfN(4, "c") });
  t.scroll(-2, { width: 40, height: 3 });
  assert.deepEqual(view(t, 3), ["b3", "c0", "c1"]);
  t.scroll(-4, { width: 40, height: 3 });
  assert.deepEqual(view(t, 3), ["a3", "b0", "b1"]);
});

test("commits while scrolled keep the anchor and set newActivity; jumpLatest clears it", () => {
  const t = createTranscript();
  fill(t, 20);
  t.scroll(-5, { width: 40, height: 5 });
  const before = view(t);
  t.append({ lines: [line("new")] });
  assert.deepEqual(view(t), before);
  assert.equal(t.newActivity, true);
  t.jumpLatest();
  assert.equal(t.following, true);
  assert.equal(t.newActivity, false);
  assert.deepEqual(view(t).at(-1), "new");
});

test("jumpTop shows the first rows; with everything on one screen it stays following", () => {
  const t = createTranscript();
  fill(t, 20);
  t.jumpTop();
  assert.deepEqual(view(t), ["e0", "e1", "e2", "e3", "e4"]);
  const s = createTranscript();
  fill(s, 2);
  s.jumpTop();
  view(s);
  assert.equal(s.following, true);
});

test("resize while scrolled keeps the anchor entry and moves its row in proportion", () => {
  const t = createTranscript();
  // 2 rows per entry when wide, 4 when narrow: half way into an entry stays half way.
  const part = (i, n) => Array.from({ length: n }, (_, k) => line(`entry ${i} part ${k} of ${n}`));
  for (let i = 0; i < 10; i++) t.append({ render: (w) => (w >= 30 ? part(i, 2) : part(i, 4)) });
  t.scroll(-8, { width: 40, height: 3 });
  assert.equal(view(t, 3, 40)[0], "entry 4 part 1 of 2");
  t.layout(20);
  assert.equal(view(t, 3, 20)[0], "entry 4 part 2 of 4");
  assert.equal(t.following, false);
});

test("a retention trim that drops the anchor entry moves the view to the first entry", () => {
  const t = createTranscript({ maxEntries: 20 });
  fill(t, 20);
  t.jumpTop();
  view(t);
  for (let i = 20; i < 30; i++) t.append({ lines: [line(`e${i}`)] });
  assert.equal(view(t, 5, 120)[0], TRIMMED_TEXT);
  assert.equal(t.following, false);
});

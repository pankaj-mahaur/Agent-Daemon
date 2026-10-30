// The fullscreen selection model (P2.3): click counting, word and line
// units, and the copied text (soft wraps joined, hard breaks kept).

import { test } from "node:test";
import assert from "node:assert/strict";
import { clickCount, rowRanges, selectedText } from "../src/tui/terminal/selection.mjs";
import { wrap, withPrefix } from "../src/tui/terminal/text.mjs";

const line = (s) => [{ text: s }];
const at = (entryId, row, col) => ({ entryId, row, col });
const sel = (anchor, head, unit = "char") => ({ anchor, head, unit });

test("click count: same cell within 400 ms cycles 1-2-3-1; 400 ms or another cell restarts", () => {
  let c = clickCount(null, { x: 1, y: 1, at: 0 });
  assert.equal(c.count, 1);
  c = clickCount(c, { x: 1, y: 1, at: 399 });
  assert.equal(c.count, 2);
  c = clickCount(c, { x: 1, y: 1, at: 700 });
  assert.equal(c.count, 3);
  c = clickCount(c, { x: 1, y: 1, at: 800 });
  assert.equal(c.count, 1, "cycles back");
  assert.equal(clickCount(c, { x: 1, y: 1, at: 1200 }).count, 1, "exactly 400 ms is too late");
  assert.equal(clickCount({ x: 1, y: 1, at: 0, count: 1 }, { x: 2, y: 1, at: 10 }).count, 1, "another cell");
});

test("a char selection copies the cells between anchor and head, inclusive, in either direction", () => {
  const entries = [{ id: 1, rows: [line("hello world")] }];
  assert.equal(selectedText(entries, sel(at(1, 0, 0), at(1, 0, 4))), "hello");
  assert.equal(selectedText(entries, sel(at(1, 0, 4), at(1, 0, 0))), "hello", "reversed gives the same text");
  const wide = [{ id: 1, rows: [line("漢字x")] }];
  assert.equal(selectedText(wide, sel(at(1, 0, 1), at(1, 0, 2))), "漢字", "a wide grapheme counts once when either of its cells is selected");
});

test("word and line units (ASCII, CJK, punctuation runs)", () => {
  const entries = [{ id: 1, rows: [line("say foo_bar1 now"), line("a--b 漢字テスト end")] }];
  assert.equal(selectedText(entries, sel(at(1, 0, 6), at(1, 0, 6), "word")), "foo_bar1");
  assert.equal(selectedText(entries, sel(at(1, 1, 1), at(1, 1, 1), "word")), "--");
  assert.equal(selectedText(entries, sel(at(1, 1, 7), at(1, 1, 7), "word")), "漢字テスト", "a wide grapheme's second cell counts");
  assert.equal(selectedText(entries, sel(at(1, 0, 2), at(1, 0, 2), "line")), "say foo_bar1 now");
});

test("selected text joins soft wraps by their marker, keeps hard breaks, trims trailing spaces", () => {
  const rows = wrap([{ text: "alpha beta gamma\nnext line   " }], 11).map((r, i) => withPrefix([{ text: i ? "  " : "• " }], r));
  const entries = [{ id: 1, rows }];
  const last = rows.length - 1;
  assert.equal(selectedText(entries, sel(at(1, 0, 0), at(1, last, 40))), "• alpha beta gamma\n  next line");
  assert.equal(selectedText(entries, sel(at(1, 1, 0), at(1, 1, 40), "line")), "• alpha beta gamma", "the logical line spans its soft rows");
});

test("a selection across entries", () => {
  const entries = [{ id: 1, rows: [line("first entry")] }, { id: 2, rows: [line("second entry")] }];
  assert.equal(selectedText(entries, sel(at(1, 0, 6), at(2, 0, 5))), "entry\nsecond");
});

test("rowRanges gives the highlighted columns per row", () => {
  const entries = [{ id: 1, rows: [line("abc"), line("defg")] }];
  const r = rowRanges(entries, sel(at(1, 0, 1), at(1, 1, 2)));
  assert.deepEqual([...r.entries()], [["1:0", [1, Infinity]], ["1:1", [0, 2]]]);
});

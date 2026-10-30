// Find in the fullscreen transcript (P2.3b): literal, case-insensitive,
// newest first, across soft wraps, the query cap, and batched scanning.

import { test } from "node:test";
import assert from "node:assert/strict";
import { QUERY_MAX, clampQuery, findMatches } from "../src/tui/terminal/find.mjs";
import { wrap } from "../src/tui/terminal/text.mjs";

const line = (s) => [{ text: s }];
const entry = (id, ...rows) => ({ id, rows: rows.map(line) });

test("literal and case-insensitive, Unicode letters included; regex characters are plain", async () => {
  const entries = [entry(1, "Error: ÉCOLE failed"), entry(2, "a.b*c (x)")];
  assert.equal((await findMatches(entries, "école")).length, 1);
  assert.equal((await findMatches(entries, "ERROR")).length, 1);
  assert.equal((await findMatches(entries, ".b*c (")).length, 1);
  assert.equal((await findMatches(entries, "a.c")).length, 0);
});

test("newest match first, each mapped to its entry, row and columns", async () => {
  const entries = [entry(1, "foo one"), entry(2, "two", "foo foo")];
  const m = await findMatches(entries, "foo");
  assert.deepEqual(m.map((x) => [x.entryId, x.segments]), [
    [2, [{ row: 1, c0: 4, c1: 6 }]],
    [2, [{ row: 1, c0: 0, c1: 2 }]],
    [1, [{ row: 0, c0: 0, c1: 2 }]],
  ]);
});

test("a match across a soft wrap is found and mapped to both rows", async () => {
  const rows = wrap([{ text: "the quick brown fox" }], 10);
  const m = await findMatches([{ id: 7, rows }], "quick brown");
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].segments.map((s) => s.row), [0, 1]);
  assert.equal(m[0].segments[0].c0, 4);
});

test("a hard break is not a space: no match across it", async () => {
  assert.equal((await findMatches([entry(1, "end of", "line")], "of line")).length, 0);
});

test("the query stops at 4096 bytes with a note", () => {
  const long = "é".repeat(3000); // 6000 bytes
  const r = clampQuery(long);
  assert.ok(Buffer.byteLength(r.query) <= QUERY_MAX);
  assert.equal(r.limited, true);
  assert.deepEqual(clampQuery("short"), { query: "short", limited: false });
});

test("a 5,000-entry scan yields between batches of 200", async () => {
  const entries = Array.from({ length: 5000 }, (_, i) => entry(i, `row ${i} needle`));
  let ticks = 0;
  const m = await findMatches(entries, "needle", { tick: async () => void ticks++ });
  assert.equal(m.length, 5000);
  assert.equal(ticks, 24, "5,000 / 200 − 1 yields");
});

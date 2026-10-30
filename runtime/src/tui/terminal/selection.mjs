// The fullscreen selection model (plan P2.3). Pure.
//
// A point is {entryId, row, col}: a transcript entry, a row of it, a display
// column. A selection is {anchor, head, unit: "char" | "word" | "line"}; both
// ends are inclusive. `entries` is the transcript in order, [{id, rows}], at
// least from the selection's first entry to its last.
//
// clickCount(last, {x, y, at}) → {x, y, at, count}   1 → 2 → 3 → 1 on one cell within 400 ms
// selectedText(entries, sel)  → the text to copy: soft-wrapped rows joined by
//                               their marker (text.mjs wrap), hard breaks kept,
//                               trailing spaces trimmed
// rowRanges(entries, sel)     → Map "entryId:row" → [fromCol, toCol] (inclusive)

import { graphemes, graphemeWidth } from "./width.mjs";

const CLICK_MS = 400;

export function clickCount(last, { x, y, at }) {
  const again = last && last.x === x && last.y === y && at - last.at < CLICK_MS;
  return { x, y, at, count: again ? (last.count % 3) + 1 : 1 };
}

// The row's graphemes with their columns.
function cellsOf(line) {
  const cells = [];
  let col = 0;
  for (const g of graphemes(line.map((s) => s.text).join(""))) {
    const w = graphemeWidth(g);
    if (w === 0 && cells.length) cells[cells.length - 1].g += g;
    else {
      cells.push({ g, col, w: Math.max(1, w) });
      col += Math.max(1, w);
    }
  }
  return cells;
}

const kind = (g) => (/^\s+$/u.test(g) ? "space" : /^[\p{L}\p{N}_]/u.test(g) ? "word" : "punct");

const before = (entries, a, b) => {
  const ia = entries.findIndex((e) => e.id === a.entryId);
  const ib = entries.findIndex((e) => e.id === b.entryId);
  return ia - ib || a.row - b.row || a.col - b.col;
};

function rowsOf(entries, id) {
  return entries.find((e) => e.id === id)?.rows ?? [];
}

// The run of same-kind cells around a column.
function wordAt(line, col) {
  const cells = cellsOf(line);
  const i = cells.findIndex((c) => col >= c.col && col < c.col + c.w);
  if (i < 0) return { from: col, to: col };
  const k = kind(cells[i].g);
  let a = i;
  let b = i;
  while (a > 0 && kind(cells[a - 1].g) === k) a--;
  while (b < cells.length - 1 && kind(cells[b + 1].g) === k) b++;
  return { from: cells[a].col, to: cells[b].col + cells[b].w - 1 };
}

// The logical line around a row: the soft-wrapped rows together.
function lineAt(rows, row) {
  let a = row;
  let b = row;
  while (a > 0 && rows[a]?.cont) a--;
  while (b + 1 < rows.length && rows[b + 1]?.cont) b++;
  return { first: a, last: b };
}

/** The selection's ends in order, widened to its unit. */
function span(entries, { anchor, head, unit = "char" }) {
  let [start, end] = before(entries, anchor, head) <= 0 ? [anchor, head] : [head, anchor];
  if (unit === "word") {
    start = { ...start, col: wordAt(rowsOf(entries, start.entryId)[start.row] ?? [], start.col).from };
    end = { ...end, col: wordAt(rowsOf(entries, end.entryId)[end.row] ?? [], end.col).to };
  } else if (unit === "line") {
    start = { ...start, row: lineAt(rowsOf(entries, start.entryId), start.row).first, col: 0 };
    end = { ...end, row: lineAt(rowsOf(entries, end.entryId), end.row).last, col: Infinity };
  }
  return { start, end };
}

// Every selected row, in order, with its inclusive column range.
function* selectedRows(entries, sel) {
  const { start, end } = span(entries, sel);
  const from = entries.findIndex((e) => e.id === start.entryId);
  const to = entries.findIndex((e) => e.id === end.entryId);
  if (from < 0 || to < 0) return;
  for (let i = from; i <= to; i++) {
    const rows = entries[i].rows;
    const r0 = i === from ? start.row : 0;
    const r1 = i === to ? end.row : rows.length - 1;
    for (let r = r0; r <= r1; r++) {
      const c0 = i === from && r === start.row ? start.col : 0;
      const c1 = i === to && r === end.row ? end.col : Infinity;
      yield { entryId: entries[i].id, row: r, line: rows[r] ?? [], c0, c1, first: i === from && r === r0 };
    }
  }
}

export function rowRanges(entries, sel) {
  const out = new Map();
  for (const r of selectedRows(entries, sel)) out.set(`${r.entryId}:${r.row}`, [r.c0, r.c1]);
  return out;
}

export function selectedText(entries, sel) {
  let text = "";
  for (const r of selectedRows(entries, sel)) {
    const cont = r.first ? null : r.line.cont;
    const from = cont ? Math.max(r.c0, cont.indent) : r.c0;
    // A wide grapheme counts when either of its cells is selected.
    const piece = cellsOf(r.line)
      .filter((c) => c.col + c.w - 1 >= from && c.col <= r.c1)
      .map((c) => c.g)
      .join("")
      .replace(/\s+$/u, "");
    if (r.first) text = piece;
    else text += (cont ? cont.join : "\n") + piece;
  }
  return text.replace(/[ \t]+$/gmu, "");
}

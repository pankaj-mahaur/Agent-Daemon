// The fullscreen transcript buffer (plan P2.1). Pure: nothing here writes.
//
// The inline renderer hands committed lines to the terminal's scrollback; the
// fullscreen one keeps them here so it can redraw and re-wrap them. An entry
// is a render function over the content width (preferred: it re-renders on
// resize) or fixed lines (re-wrapped per line, never truncated).
//
// createTranscript({maxEntries, entryMaxRows})
//   → {append({lines, render, key}), settle(key, render), layout(width),
//      window({width, height}) → {rows, top}, clear(), size(), following}
//
// Layout is lazy: window() renders from the bottom up until it knows the rows
// asked for plus one screen of margin, so a resize never re-renders the whole
// history.

import { wrap } from "./text.mjs";

export const TRIMMED_TEXT = "Earlier output was trimmed here. Ctrl+T shows the whole conversation.";
const DIM = { dim: true };
const tallText = (n) => `… ${n} earlier lines (Ctrl+T shows them)`;

export function createTranscript({ maxEntries = 5000, entryMaxRows = 2000 } = {}) {
  let entries = [];
  let nextId = 1;
  let width = null;

  const rowsOf = (entry, w) => {
    if (entry.cache && entry.cache.width === w) return entry.cache.rows;
    let rows = entry.render ? [...entry.render(w)] : entry.fixed.flatMap((l) => wrap(l, w));
    if (rows.length > entryMaxRows) {
      const keep = entryMaxRows - 1;
      rows = [[{ text: tallText(rows.length - keep), style: DIM }], ...rows.slice(rows.length - keep)];
    }
    entry.cache = { width: w, rows };
    return rows;
  };

  const hasMarker = () => entries[0]?.marker === true;

  // The view (P2.2): null follows the bottom; else the top visible row, as an
  // entry and a row inside it, so new entries and re-wraps don't move it.
  let anchor = null;
  let newActivity = false;
  const indexOf = (id) => entries.findIndex((e) => e.id === id);

  function trim() {
    const first = hasMarker() ? 1 : 0;
    if (entries.length - first <= maxEntries) return;
    const drop = Math.max(1, Math.ceil(maxEntries / 10));
    const marker = hasMarker() ? entries[0] : { id: nextId++, marker: true, fixed: [[{ text: TRIMMED_TEXT, style: DIM }]] };
    // A view whose entry was dropped shows the first entry (topPos falls back to it).
    entries = [marker, ...entries.slice(first + drop)];
  }

  function append({ lines, render, key } = {}) {
    if (typeof render !== "function" && !Array.isArray(lines)) throw new TypeError("transcript.append needs lines or a render function");
    const entry = { id: nextId++, key, render: typeof render === "function" ? render : undefined, fixed: render ? undefined : lines.map((l) => [...l]), cache: null };
    entries.push(entry);
    if (anchor) newActivity = true;
    trim();
    return entry.id;
  }

  function settle(key, render) {
    const at = entries.findIndex((e) => e.key === key);
    if (at < 0) return append({ render });
    const entry = { id: nextId++, render, cache: null };
    if (anchor && entries[indexOf(anchor.entryId)]?.key === key) anchor = { entryId: entry.id, row: 0 };
    entries = entries.flatMap((e, i) => (i === at ? [entry] : e.key === key ? [] : [e]));
    return entry.id;
  }

  // Caches carry their width, so a stale one is simply not used. A scrolled
  // view keeps its entry and moves its row in proportion.
  function layout(w) {
    if (anchor && width != null && w !== width) {
      const e = entries[indexOf(anchor.entryId)];
      if (e) {
        const before = rowsOf(e, width).length;
        const after = rowsOf(e, w).length;
        anchor = { entryId: e.id, row: before ? Math.max(0, Math.min(after - 1, Math.round((anchor.row * after) / before))) : 0 };
      }
    }
    width = w;
  }

  const len = (i, w) => rowsOf(entries[i], w).length;

  /** The top visible row as {i, row}, for the anchor or for the bottom view. */
  function topPos(w, height) {
    if (anchor) {
      const i = indexOf(anchor.entryId);
      if (i >= 0) return { i, row: Math.max(0, Math.min(anchor.row, len(i, w) - 1)) };
      return { i: 0, row: 0 };
    }
    let need = height;
    for (let i = entries.length - 1; i >= 0; i--) {
      const n = len(i, w);
      if (n >= need) return { i, row: n - need };
      need -= n;
    }
    return { i: 0, row: 0 };
  }

  // Rows from pos to the end, counting at most `limit`.
  function rowsFrom({ i, row }, w, limit) {
    let n = entries.length ? len(i, w) - row : 0;
    for (let j = i + 1; j < entries.length && n < limit; j++) n += len(j, w);
    return n;
  }

  function scroll(delta, { width: w = width, height }) {
    if (!entries.length || !delta) return;
    if (w !== width) layout(w);
    let { i, row } = topPos(w, height);
    const up = () => {
      if (row > 0) return (row--, true);
      for (let j = i - 1; j >= 0; j--) if (len(j, w) > 0) return ((i = j), (row = len(j, w) - 1), true);
      return false;
    };
    const down = () => {
      if (row < len(i, w) - 1) return (row++, true);
      for (let j = i + 1; j < entries.length; j++) if (len(j, w) > 0) return ((i = j), (row = 0), true);
      return false;
    };
    for (let k = 0; k < Math.abs(delta); k++) if (!(delta < 0 ? up() : down())) break;
    if (rowsFrom({ i, row }, w, height + 1) <= height) jumpLatest();
    else anchor = { entryId: entries[i].id, row };
  }

  function jumpLatest() {
    anchor = null;
    newActivity = false;
  }

  function jumpTop() {
    if (entries.length) anchor = { entryId: entries[0].id, row: 0 };
  }

  // `refs[k]` is {entryId, row} for `rows[k]`: what a click or a selection points at.
  function window({ width: w = width, height }) {
    if (w !== width) layout(w);
    const withRefs = (i, from) => rowsOf(entries[i], w).slice(from).map((line, k) => ({ line, ref: { entryId: entries[i].id, row: from + k } }));
    if (anchor) {
      const pos = topPos(w, height);
      if (rowsFrom(pos, w, height + 1) <= height) jumpLatest(); // the end came into view
      else {
        const out = withRefs(pos.i, pos.row);
        for (let j = pos.i + 1; j < entries.length && out.length < height; j++) out.push(...withRefs(j, 0));
        const shown = out.slice(0, height);
        return { rows: shown.map((x) => x.line), refs: shown.map((x) => x.ref), top: pos.i === 0 && pos.row === 0 };
      }
    }
    const want = height * 2;
    const collected = [];
    let i = entries.length - 1;
    let known = 0;
    for (; i >= 0 && known < want; i--) {
      const rows = withRefs(i, 0);
      collected.push(rows);
      known += rows.length;
    }
    const all = collected.reverse().flat();
    const top = i < 0 && all.length <= height;
    const shown = all.slice(Math.max(0, all.length - height));
    return { rows: shown.map((x) => x.line), refs: shown.map((x) => x.ref), top };
  }

  /** Stops following without moving the view (a selection keeps its rows put). → whether it was following. */
  function hold({ width: w = width, height }) {
    if (anchor || !entries.length) return false;
    const { i, row } = topPos(w, height);
    anchor = { entryId: entries[i].id, row };
    return true;
  }

  /** The entries from id `a` to id `b` (either order), with their rows at the width: a selection's source. */
  function entriesBetween(a, b, w = width) {
    let i = indexOf(a);
    let j = indexOf(b);
    if (i < 0 || j < 0) return [];
    if (i > j) [i, j] = [j, i];
    return entries.slice(i, j + 1).map((e) => ({ id: e.id, rows: rowsOf(e, w) }));
  }

  function clear() {
    entries = [];
    jumpLatest();
  }

  return {
    append,
    settle,
    layout,
    window,
    clear,
    scroll,
    jumpTop,
    jumpLatest,
    hold,
    entriesBetween,
    size: () => entries.length,
    get following() {
      return anchor === null;
    },
    get newActivity() {
      return newActivity;
    },
    canReturn: () => anchor !== null,
  };
}

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

  function trim() {
    const first = hasMarker() ? 1 : 0;
    if (entries.length - first <= maxEntries) return;
    const drop = Math.max(1, Math.ceil(maxEntries / 10));
    const marker = hasMarker() ? entries[0] : { id: nextId++, marker: true, fixed: [[{ text: TRIMMED_TEXT, style: DIM }]] };
    entries = [marker, ...entries.slice(first + drop)];
  }

  function append({ lines, render, key } = {}) {
    if (typeof render !== "function" && !Array.isArray(lines)) throw new TypeError("transcript.append needs lines or a render function");
    const entry = { id: nextId++, key, render: typeof render === "function" ? render : undefined, fixed: render ? undefined : lines.map((l) => [...l]), cache: null };
    entries.push(entry);
    trim();
    return entry.id;
  }

  function settle(key, render) {
    const at = entries.findIndex((e) => e.key === key);
    if (at < 0) return append({ render });
    const entry = { id: nextId++, render, cache: null };
    entries = entries.flatMap((e, i) => (i === at ? [entry] : e.key === key ? [] : [e]));
    return entry.id;
  }

  // Caches carry their width, so a stale one is simply not used.
  function layout(w) {
    width = w;
  }

  function window({ width: w = width, height }) {
    if (w !== width) layout(w);
    const want = height * 2;
    const collected = [];
    let i = entries.length - 1;
    let known = 0;
    for (; i >= 0 && known < want; i--) {
      const rows = rowsOf(entries[i], w);
      collected.push(rows);
      known += rows.length;
    }
    const all = collected.reverse().flat();
    const top = i < 0 && all.length <= height;
    return { rows: all.slice(Math.max(0, all.length - height)), top };
  }

  function clear() {
    entries = [];
  }

  return {
    append,
    settle,
    layout,
    window,
    clear,
    size: () => entries.length,
    // P2.2 adds scrolling; until then the window always shows the newest rows.
    get following() {
      return true;
    },
  };
}

// Find in the fullscreen transcript (plan P2.3b). Pure.
//
// Literal and case-insensitive (per character). Each entry is searched as the
// text a copy of it would give (soft-wrapped rows joined by their marker, hard
// breaks as "\n"), so a match across a soft wrap is found. Matches come back
// newest first: [{entryId, segments: [{row, c0, c1}]}], columns inclusive.
//
// findMatches(entries, query, {batch, tick}) scans `batch` entries between
// awaits of tick(), so typing stays responsive on a long transcript.

import { graphemes, graphemeWidth } from "./width.mjs";

export const QUERY_MAX = 4096;
const BATCH = 200;

/** The query cut to QUERY_MAX bytes (whole characters). */
export function clampQuery(query) {
  if (Buffer.byteLength(query) <= QUERY_MAX) return { query, limited: false };
  let out = "";
  for (const ch of query) {
    if (Buffer.byteLength(out + ch) > QUERY_MAX) break;
    out += ch;
  }
  return { query: out, limited: true };
}

// One code unit lower-cased when that keeps the length (so indices still map back).
const lower = (s) => [...s].map((c) => (c.toLowerCase().length === c.length ? c.toLowerCase() : c)).join("");

// The entry as searchable text, with each code unit's row and columns.
function textOf(rows) {
  let text = "";
  const at = [];
  rows.forEach((row, r) => {
    const cont = r > 0 ? row.cont : null;
    if (r > 0) {
      const sep = cont ? cont.join : "\n";
      for (const ch of sep) {
        text += ch;
        at.push(null);
      }
    }
    let col = 0;
    for (const g of graphemes(row.map((s) => s.text).join(""))) {
      const w = Math.max(1, graphemeWidth(g));
      if (!(cont && col < cont.indent)) {
        for (let k = 0; k < g.length; k++) at.push({ row: r, c0: col, c1: col + w - 1 });
        text += g;
      }
      col += w;
    }
  });
  return { text, at };
}

function matchesIn(e, needle) {
  const { text, at } = textOf(e.rows);
  const hay = lower(text);
  const found = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const segments = [];
    for (let k = i; k < i + needle.length; k++) {
      const p = at[k];
      if (!p) continue;
      const last = segments[segments.length - 1];
      if (last && last.row === p.row) last.c1 = Math.max(last.c1, p.c1);
      else segments.push({ row: p.row, c0: p.c0, c1: p.c1 });
    }
    found.push({ entryId: e.id, segments });
  }
  return found.reverse(); // newest (last) first
}

export async function findMatches(entries, query, { batch = BATCH, tick = () => new Promise((r) => setImmediate(r)) } = {}) {
  const needle = lower(clampQuery(query).query);
  if (!needle) return [];
  const out = [];
  let n = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    out.push(...matchesIn(entries[i], needle));
    if (++n % batch === 0 && i > 0) await tick();
  }
  return out;
}

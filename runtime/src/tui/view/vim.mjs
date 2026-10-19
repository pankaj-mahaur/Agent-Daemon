// The Vim mode for the composer (parity Part 8), after the engine
// 0.160–0.163's textarea/vim.rs, vim_commands.rs and vim_search.rs (0.163 only adds: Enter is ignored in single-line editors, which ad's composer isn't):
//
//   - Normal, Insert and Replace. No counts, no Visual mode, no `P`, `X`,
//     `;` or `,` (upstream has none of them).
//   - Operators d y c with the engine's motions (h l j k w b e 0 $ f F t T gg G,
//     / ? n N) and text objects (iw aw iW aW, ( ) b [ ] { } B, " ' `).
//   - One unnamed register shared with the composer's Ctrl+K/U/W/Y, linewise
//     or charwise; undo/redo by whole command or Insert session; `.` repeats
//     the last change.
//
//   createVim(core, {now, mode}) → {handle(ev), mode, pending, hint, search,
//     wantsEscape(), reset(), enter(mode)}
//
// `core` is the composer's buffer: {text, cursor, set(text, cursor), place(at),
// kill, setKill(text), vertical(dir) → bool, history(dir) → bool, recalled,
// passThrough(ev)}. handle() returns undefined to let the composer's own
// editing take the event (Insert mode), null for a key Vim leaves to the app
// (Esc with nothing pending, Ctrl shortcuts), else a composer result.

import { sanitize } from "../terminal/sanitize.mjs";
import { graphemeSegments } from "../terminal/width.mjs";

const SEPARATORS = new Set([..."`~!@#$%^&*()-=+[{]}\\|;:'\",.<>/?"]);
const IDEOGRAPH = /[\p{Ideographic}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const isSpace = (g) => /^\s+$/u.test(g);
const UNDO_STEPS = 64;
const UNDO_BYTES = 1024 * 1024;
const CHORD_MS = 1000;
const BRACKETS = { "(": ["(", ")"], ")": ["(", ")"], b: ["(", ")"], "[": ["[", "]"], "]": ["[", "]"], "{": ["{", "}"], "}": ["{", "}"], B: ["{", "}"] };
const QUOTES = new Set(['"', "'", "`"]);

/* ------------------------------------------------------------------ */
/* Text helpers (offsets are code units on grapheme boundaries)        */
/* ------------------------------------------------------------------ */

function graphemes(t) {
  const out = [];
  for (const { segment, index } of graphemeSegments(t)) out.push({ g: segment, at: index });
  return out;
}
// Boundaries next to an offset, without walking the text from its start (a
// long draft stays fast): the text's segments are kept while it doesn't change.
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
let segmented = { text: null, segments: null };
const segmentsOf = (t) => (segmented.text === t ? segmented.segments : (segmented = { text: t, segments: GRAPHEMES.segment(t) }).segments);
const nextB = (t, i) => {
  if (i >= t.length) return t.length;
  const s = segmentsOf(t).containing(i);
  return s ? s.index + s.segment.length : t.length;
};
const prevB = (t, i) => (i <= 0 ? 0 : (segmentsOf(t).containing(i - 1)?.index ?? 0));
const charAt = (t, i) => t.slice(i, nextB(t, i));
const bol = (t, i) => t.lastIndexOf("\n", i - 1) + 1;
const eol = (t, i) => {
  const n = t.indexOf("\n", i);
  return n < 0 ? t.length : n;
};
function firstNonBlank(t, ls) {
  const end = eol(t, ls);
  let j = ls;
  while (j < end && isSpace(charAt(t, j))) j = nextB(t, j);
  return j;
}

// The engine's words: whitespace splits runs; a run splits where separators meet
// other characters and at Unicode word boundaries (each CJK character is a
// word); consecutive separators are one piece.
let segmenter = null;
function pieces(t) {
  const runs = [];
  let cur = null;
  for (const { g, at } of graphemes(t)) {
    const cls = isSpace(g) ? "space" : SEPARATORS.has(g) ? "sep" : "word";
    if (cur && cur.cls === cls) cur.end = at + g.length;
    else runs.push((cur = { cls, start: at, end: at + g.length }));
  }
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "word" });
  const out = [];
  for (const p of runs) {
    if (p.cls !== "word") {
      out.push(p);
      continue;
    }
    for (const seg of segmenter.segment(t.slice(p.start, p.end))) {
      const start = p.start + seg.index;
      // ICU groups CJK into dictionary words; the engine's segmentation keeps each character apart.
      if (!IDEOGRAPH.test(seg.segment)) out.push({ cls: "word", start, end: start + seg.segment.length });
      else for (const { g, at } of graphemes(seg.segment)) out.push({ cls: "word", start: start + at, end: start + at + g.length });
    }
  }
  return out;
}
const pieceAt = (ps, i) => ps.find((p) => p.start <= i && i < p.end) ?? null;

function motionW(t, c) {
  const ps = pieces(t);
  const p = pieceAt(ps, c);
  const from = !p || p.cls === "space" ? c : p.end;
  return ps.find((x) => x.start >= from && x.cls !== "space")?.start ?? t.length;
}
function motionB(t, c) {
  let j = c;
  while (j > 0 && isSpace(charAt(t, prevB(t, j)))) j = prevB(t, j);
  if (j === 0) return 0;
  return pieceAt(pieces(t), prevB(t, j))?.start ?? 0;
}
function motionE(t, c) {
  if (c >= t.length) return c;
  let j = nextB(t, c);
  while (j < t.length && isSpace(charAt(t, j))) j = nextB(t, j);
  if (j >= t.length) {
    const last = prevB(t, t.length);
    return last > c ? last : c;
  }
  return prevB(t, pieceAt(pieces(t), j).end);
}
const lastCharOfLine = (t, c) => {
  const ls = bol(t, c);
  const le = eol(t, c);
  return le > ls ? prevB(t, le) : ls;
};
// f F t T: the line's next/previous grapheme whose base character is `ch`.
function findInLine(t, c, kind, ch) {
  const ls = bol(t, c);
  const le = eol(t, c);
  const hits = graphemes(t.slice(ls, le)).filter((x) => String.fromCodePoint(x.g.codePointAt(0)) === ch).map((x) => ({ start: ls + x.at, end: ls + x.at + x.g.length }));
  if (kind === "f" || kind === "t") return hits.find((h) => h.start > c) ?? null;
  return hits.findLast((h) => h.start < c) ?? null;
}

/* ------------------------------------------------------------------ */
/* Text objects                                                        */
/* ------------------------------------------------------------------ */

function wordObject(t, c, around, big) {
  const ps = big ? bigPieces(t) : pieces(t);
  let p = pieceAt(ps, c);
  // Right after a word (on the next blank, or at the line's end) counts as in it.
  if (!p || p.cls === "space") {
    const before = c > 0 ? pieceAt(ps, prevB(t, c)) : null;
    if (!before || before.cls === "space" || (p && p.start !== c)) return null;
    p = before;
  }
  let { start, end } = p;
  if (around) {
    let e = end;
    while (e < t.length && isSpace(charAt(t, e))) e = nextB(t, e);
    if (e > end) end = e;
    else while (start > 0 && isSpace(charAt(t, prevB(t, start)))) start = prevB(t, start);
  }
  return { start, end };
}
function bigPieces(t) {
  const out = [];
  let cur = null;
  for (const { g, at } of graphemes(t)) {
    const cls = isSpace(g) ? "space" : "word";
    if (cur && cur.cls === cls) cur.end = at + g.length;
    else out.push((cur = { cls, start: at, end: at + g.length }));
  }
  return out;
}
function bracketObject(t, c, open, close, around) {
  let s = -1;
  if (t[c] === open) s = c;
  else {
    let depth = 0;
    for (let i = c - 1; i >= 0; i--) {
      if (t[i] === close) depth++;
      else if (t[i] === open) {
        if (depth === 0) {
          s = i;
          break;
        }
        depth--;
      }
    }
  }
  if (s < 0) return null;
  let depth = 0;
  for (let i = s + 1; i < t.length; i++) {
    if (t[i] === open) depth++;
    else if (t[i] === close) {
      if (depth === 0) return i < c ? null : around ? { start: s, end: i + 1 } : { start: s + 1, end: i };
      depth--;
    }
  }
  return null;
}
function quoteObject(t, c, q, around) {
  const ls = bol(t, c);
  const le = eol(t, c);
  const at = [];
  for (let i = ls; i < le; i++) {
    if (t[i] !== q) continue;
    let slashes = 0;
    for (let k = i - 1; k >= ls && t[k] === "\\"; k--) slashes++;
    if (slashes % 2 === 0) at.push(i);
  }
  let best = null;
  for (let k = 0; k + 1 < at.length; k += 2) {
    const [o, e] = [at[k], at[k + 1]];
    if (o <= c && c <= e && (!best || e - o < best[1] - best[0])) best = [o, e];
  }
  if (!best) return null;
  return around ? { start: best[0], end: best[1] + 1 } : { start: best[0] + 1, end: best[1] };
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

function findMatch(t, c, q, forward) {
  const starts = new Set(graphemes(t).map((x) => x.at));
  const hits = [];
  for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + 1)) if (starts.has(i)) hits.push(i);
  if (!hits.length) return null;
  return forward ? (hits.find((h) => h > c) ?? hits[0]) : (hits.findLast((h) => h < c) ?? hits.at(-1));
}

/* ------------------------------------------------------------------ */
/* The machine                                                         */
/* ------------------------------------------------------------------ */

export function createVim(core, { now = () => Date.now(), mode: startMode = "normal" } = {}) {
  let mode = startMode; // "normal" | "insert" | "replace"
  let pending = null; // {op, obj?, find?, replace?}
  let gChord = null; // {at, op}: the first g of gg
  let search = null; // {dir: "/"|"?", query, op}
  let lastSearch = null; // {query, dir}
  let register = { text: "", linewise: false };
  let undo = [];
  let redo = [];
  let step = null; // the buffer before the command (or Insert session) now running
  let rec = null; // the events of the change being recorded, for "."
  let dot = null;
  let replaying = false;

  const T = () => core.text;
  const C = () => core.cursor;
  const set = (text, cursor) => core.set(text, cursor);
  const move = (cursor) => core.set(core.text, Math.max(0, Math.min(cursor, core.text.length)));

  /* ---- register ---- */
  function store(text, linewise) {
    if (!text) return;
    register = { text, linewise };
    core.setKill(text);
  }
  function current() {
    // The composer's own kills (Ctrl+K/U/W in Insert) are charwise.
    if (core.kill !== register.text) register = { text: core.kill, linewise: false };
    return register;
  }

  /* ---- undo ---- */
  function beginStep() {
    step ??= { text: T(), cursor: C() };
  }
  function endStep() {
    if (step && step.text !== T()) {
      if (T().length > UNDO_BYTES) undo = [];
      else {
        undo.push(step);
        if (undo.length > UNDO_STEPS) undo.shift();
      }
      redo = [];
      if (rec && !replaying) dot = rec;
    }
    step = null;
    if (!replaying) rec = null;
  }
  function undoRedo(from, to) {
    const snap = from.pop();
    if (!snap) return;
    to.push({ text: T(), cursor: C() });
    set(snap.text, snap.cursor);
    mode = "normal";
  }

  /* ---- modes ---- */
  function toInsert(cursor = C(), as = "insert") {
    move(cursor);
    mode = as;
  }
  function escapeToNormal() {
    const c = C();
    mode = "normal";
    if (c > bol(T(), c)) move(prevB(T(), c));
    endStep();
  }

  /* ---- operators ---- */
  function apply(op, start, end, { linewise = false, keepCursor = false, toStart = false } = {}) {
    const t = T();
    const c = C();
    const text = t.slice(start, end);
    if (op === "y") {
      store(linewise && !text.endsWith("\n") ? `${text}\n` : text, linewise);
      if (toStart) move(start);
      else if (!keepCursor) move(c);
      return;
    }
    if (start === end) {
      if (op === "c") toInsert(start);
      return;
    }
    store(linewise && !text.endsWith("\n") ? `${text}\n` : text, linewise);
    set(t.slice(0, start) + t.slice(end), start);
    if (op === "c") toInsert(start);
  }

  function lineOp(op) {
    const t = T();
    const c = C();
    const ls = bol(t, c);
    const le = eol(t, c);
    const line = t.slice(ls, le);
    if (op === "y") return void store(`${line}\n`, true);
    if (op === "c") {
      store(`${line}\n`, true);
      set(t.slice(0, ls) + t.slice(le), ls);
      return toInsert(ls);
    }
    // dd: the line and its newline; the last line keeps the newline before it.
    store(`${line}\n`, true);
    if (le < t.length) set(t.slice(0, ls) + t.slice(le + 1), ls);
    else set(t.slice(0, ls), ls);
  }

  // An operator with a motion key (or null when the key isn't a motion).
  function operate(op, key) {
    const t = T();
    const c = C();
    const ls = bol(t, c);
    const le = eol(t, c);
    switch (key) {
      case "h":
        return apply(op, prevB(t, c), c), true;
      case "l":
        return apply(op, c, nextB(t, c)), true;
      case "w": {
        if (op === "c") {
          const p = pieceAt(pieces(t), c);
          if (p && p.cls !== "space") return apply(op, c, p.end), true;
          const to = Math.min(motionW(t, c), le);
          return to === c ? toInsert(c) : apply(op, c, to), true;
        }
        return apply(op, c, motionW(t, c), { keepCursor: true }), true;
      }
      case "b":
        return apply(op, motionB(t, c), c), true;
      case "e":
        return apply(op, c, nextB(t, motionE(t, c)), { keepCursor: true }), true;
      case "0":
        return apply(op, ls, c), true;
      case "$":
        return apply(op, c, le, { keepCursor: true }), true;
      case "j":
      case "k": {
        const down = key === "j";
        const otherStart = down ? (le < t.length ? le + 1 : -1) : ls > 0 ? bol(t, ls - 1) : -1;
        if (op === "c") {
          if (otherStart < 0) return true; // no-op on the last/first line
          const start = down ? ls : otherStart;
          const endLine = eol(t, down ? otherStart : ls);
          store(`${t.slice(start, endLine)}\n`, true);
          set(t.slice(0, start) + t.slice(endLine), start);
          return toInsert(start), true;
        }
        if (otherStart < 0) return apply(op, ls, le < t.length ? le + 1 : le), true;
        const start = down ? ls : otherStart;
        const endLine = eol(t, down ? otherStart : ls);
        return apply(op, start, endLine < t.length ? endLine + 1 : endLine), true;
      }
      case "G":
        return apply(op, ls, t.length, { linewise: true }), true;
      default:
        return false;
    }
  }

  // A search as an operator's range: exclusive; ending at a line's start, it is linewise
  // when it began at (or before) its line's first non-blank, else the newline is left out.
  function searchRange(op, from, to) {
    const t = T();
    let start = Math.min(from, to);
    let end = Math.max(from, to);
    if (end > start && end === bol(t, end)) {
      if (start <= firstNonBlank(t, bol(t, start))) {
        start = bol(t, start);
        if (op === "c") {
          store(t.slice(start, end), true);
          set(`${t.slice(0, start)}\n${t.slice(end)}`, start);
          return toInsert(start);
        }
        return apply(op, start, end, { linewise: true, toStart: true });
      }
      end -= 1;
    }
    return apply(op, start, end, { toStart: true });
  }

  function doSearch(dir, q, op) {
    if (!q) return;
    lastSearch = { query: q, dir };
    const at = findMatch(T(), C(), q, dir === "/");
    if (at === null) return;
    if (op) searchRange(op, C(), at);
    else move(at);
  }

  /* ---- paste ---- */
  function put() {
    const r = current();
    if (!r.text) return;
    const t = T();
    const c = C();
    if (!r.linewise) {
      const at = nextB(t, c);
      return set(t.slice(0, at) + r.text + t.slice(at), at + r.text.length);
    }
    const le = eol(t, c);
    const body = r.text.endsWith("\n") ? r.text : `${r.text}\n`;
    if (le < t.length) return set(t.slice(0, le + 1) + body + t.slice(le + 1), le + 1);
    set(`${t}\n${body.replace(/\n$/, "")}`, le + 1);
  }

  /* ---- one Normal-mode key ---- */
  // `k` is a single character ("x", "G", "$") or a key name ("escape", "up").
  function normalKey(k, ev) {
    const t = T();
    const c = C();
    // A pending gg chord: a second g completes it; anything else drops it.
    if (gChord) {
      const chord = gChord;
      gChord = null;
      if (k === "g" && now() - chord.at <= CHORD_MS) {
        if (chord.op) return apply(chord.op, 0, nextB(t, eol(t, c)) > eol(t, c) ? eol(t, c) + 1 : eol(t, c), { linewise: true }), finish();
        move(firstNonBlank(t, 0));
        return finish();
      }
      if (chord.op) return finish(); // the operator is cancelled with it
    }
    if (pending?.replace) {
      pending = null;
      if (k === "escape" || ev?.ctrl || (ev?.alt && !ev?.altGr)) return finish();
      if (c >= t.length || t[c] === "\n") return finish();
      const ch = k === "enter" ? "\n" : k.length && [...k].length === 1 ? k : null;
      if (!ch) return finish();
      set(t.slice(0, c) + ch + t.slice(nextB(t, c)), ch === "\n" ? c + 1 : c);
      return finish();
    }
    if (pending?.find) {
      const { find, op } = pending;
      pending = null;
      if (k === "escape" || k.length !== 1 && [...k].length !== 1) return finish();
      const hit = findInLine(t, c, find, k);
      if (!hit) return finish();
      if (op) {
        const range = find === "f" ? [c, hit.end] : find === "F" ? [hit.start, c] : find === "t" ? [c, hit.start] : [hit.end, c];
        apply(op, range[0], range[1], { toStart: true });
      } else move(find === "f" ? hit.start : find === "F" ? hit.start : find === "t" ? prevB(t, hit.start) : hit.end);
      return finish();
    }
    if (pending?.obj) {
      const { op, obj } = pending;
      pending = null;
      const around = obj === "a";
      const range =
        k === "w" || k === "W" ? wordObject(t, c, around, k === "W") : BRACKETS[k] ? bracketObject(t, c, BRACKETS[k][0], BRACKETS[k][1], around) : QUOTES.has(k) ? quoteObject(t, c, k, around) : null;
      if (range) apply(op, range.start, range.end, { keepCursor: op === "y" });
      return finish();
    }
    if (pending?.op) {
      const { op } = pending;
      if (k === op) {
        pending = null;
        lineOp(op);
        return finish();
      }
      if (k === "i" || k === "a") {
        pending = { op, obj: k };
        return { changed: true };
      }
      if ("fFtT".includes(k) && k.length === 1) {
        pending = { find: k, op };
        return { changed: true };
      }
      if (k === "g") {
        pending = null;
        gChord = { at: now(), op };
        return { changed: true };
      }
      if (k === "/" || k === "?") {
        pending = null;
        search = { dir: k, query: "", op };
        return { changed: true };
      }
      if (k === "n" || k === "N") {
        pending = null;
        if (lastSearch) doSearch(k === "n" ? lastSearch.dir : lastSearch.dir === "/" ? "?" : "/", lastSearch.query, op);
        return finish();
      }
      pending = null;
      operate(op, k); // any other key (Esc included) cancels the operator
      return finish();
    }
    switch (k) {
      case "h":
      case "left":
      case "backspace":
        move(prevB(t, c));
        return motion();
      case "l":
      case "right":
        move(nextB(t, c));
        return motion();
      case "j":
      case "k":
      case "up":
      case "down": {
        const dir = k === "j" || k === "down" ? 1 : -1;
        if (!t || core.recalled) {
          core.history(dir);
          if (T()) core.place(prevB(T(), T().length));
          return motion();
        }
        if (!core.vertical(dir)) move(dir > 0 ? t.length : 0);
        return motion();
      }
      case "w":
        move(motionW(t, c));
        return motion();
      case "b":
        move(motionB(t, c));
        return motion();
      case "e":
        move(motionE(t, c));
        return motion();
      case "0":
      case "home":
        move(bol(t, c));
        return motion();
      case "$":
      case "end":
        move(lastCharOfLine(t, c));
        return motion();
      case "G":
        move(firstNonBlank(t, bol(t, t.length)));
        return motion();
      case "g":
        gChord = { at: now(), op: null };
        return { changed: true };
      case "f":
      case "F":
      case "t":
      case "T":
        pending = { find: k, op: null };
        return { changed: true };
      case "x":
      case "delete":
        if (c < t.length && t[c] !== "\n") {
          store(charAt(t, c), false);
          set(t.slice(0, c) + t.slice(nextB(t, c)), c);
        }
        return finish();
      case "s":
        if (c < t.length && t[c] !== "\n") {
          store(charAt(t, c), false);
          set(t.slice(0, c) + t.slice(nextB(t, c)), c);
        }
        return toInsert(c), { changed: true };
      case "D":
      case "C": {
        const le = eol(t, c);
        if (le > c) {
          store(t.slice(c, le), false);
          set(t.slice(0, c) + t.slice(le), c);
        }
        if (k === "C") return toInsert(c), { changed: true };
        return finish();
      }
      case "r":
        pending = { replace: true };
        return { changed: true };
      case "R":
        return toInsert(c, "replace"), { changed: true };
      case "Y":
        store(`${t.slice(bol(t, c), eol(t, c))}\n`, true);
        return finish();
      case "p":
        put();
        return finish();
      case "d":
      case "y":
      case "c":
        pending = { op: k };
        return { changed: true };
      case "i":
      case "insert":
        return toInsert(c), { changed: true };
      case "a":
        return toInsert(nextB(t, c)), { changed: true };
      case "A":
        return toInsert(eol(t, c)), { changed: true };
      case "I":
        return toInsert(firstNonBlank(t, bol(t, c))), { changed: true };
      case "o": {
        const le = eol(t, c);
        set(`${t.slice(0, le)}\n${t.slice(le)}`, le + 1);
        return toInsert(le + 1), { changed: true };
      }
      case "O": {
        const ls = bol(t, c);
        set(`${t.slice(0, ls)}\n${t.slice(ls)}`, ls);
        return toInsert(ls), { changed: true };
      }
      case "!":
        // "!" on an empty draft starts a shell command.
        if (t) return finish();
        set("!", 1);
        return toInsert(1), { changed: true };
      case "/":
      case "?":
        search = { dir: k, query: "", op: null };
        return { changed: true };
      case "n":
      case "N":
        if (lastSearch) doSearch(k === "n" ? lastSearch.dir : lastSearch.dir === "/" ? "?" : "/", lastSearch.query, null);
        return motion();
      case "u":
        step = null;
        rec = null;
        undoRedo(undo, redo);
        return { changed: true };
      case ".":
        return repeat();
      default:
        return finish(); // ignored, as upstream does
    }
  }

  // A motion: never an undo step, never a change for ".".
  function motion() {
    step = null;
    rec = null;
    return { changed: true };
  }
  // The command ended: a change becomes an undo step (and "." repeats it), unless it opened Insert.
  function finish() {
    if (mode === "normal" && !pending && !gChord && !search) endStep();
    return { changed: true };
  }

  // "." replays the recorded change: its command keys, then what was typed in
  // Insert. A change that can't start (cj on the last line, ci( outside any
  // parentheses) stops there: its typing never runs as Normal commands (as upstream does).
  function repeat() {
    step = null;
    rec = null;
    if (!dot) return { changed: true };
    replaying = true;
    try {
      for (const { kind, ev } of dot) {
        if (kind === "ins" && mode === "normal") break;
        if (handle(ev) === undefined) core.passThrough(ev);
      }
      if (mode !== "normal") escapeToNormal();
    } finally {
      replaying = false;
    }
    return { changed: true };
  }
  const record = (kind, ev) => {
    if (rec && !replaying) rec.push({ kind, ev });
  };
  const chordLive = () => Boolean(gChord) && now() - gChord.at <= CHORD_MS;

  /* ---- search query editing ---- */
  function searchKey(ev) {
    record("cmd", ev);
    if (ev.type === "text" || ev.type === "paste") {
      search.query += String(ev.text).split("\n")[0];
      return { changed: true };
    }
    if (ev.type !== "key") return { changed: false };
    if (ev.name === "escape" || (ev.ctrl && ev.name === "c") || (ev.name === "backspace" && !search.query)) {
      search = null;
      return finish();
    }
    if (ev.name === "backspace") {
      search.query = [...search.query].slice(0, -1).join("");
      return { changed: true };
    }
    if (ev.name === "enter") {
      const { dir, query, op } = search;
      search = null;
      doSearch(dir, query || lastSearch?.query, op);
      return op ? finish() : motion();
    }
    return { changed: false };
  }

  /* ---- the entry point ---- */
  function handle(ev) {
    if (gChord && !chordLive()) gChord = null; // the second g came too late
    if (search) return searchKey(ev);
    if (mode !== "normal") return insertKey(ev);
    // A paste in Normal goes in at the cursor as its own step (a pending command is dropped; not for ".").
    if (ev.type === "paste") {
      pending = null;
      gChord = null;
      rec = null;
      beginStep();
      core.passThrough(ev);
      return finish();
    }
    // Enter with nothing pending submits (the composer); with something pending it's Vim's.
    if (ev.type === "key" && ev.name === "enter" && !pending && !gChord) return undefined;
    if (ev.type === "key" && ev.name === "escape" && !pending && !gChord) return null;
    if (ev.type === "key" && ev.ctrl && ev.name === "r" && !pending) {
      step = null;
      rec = null;
      undoRedo(redo, undo);
      return { changed: true };
    }
    // Other Ctrl and Alt keys are the app's (Ctrl+T, Ctrl+G…) unless a command waits for its key.
    if (ev.type === "key" && (ev.ctrl || ev.alt) && !pending?.replace) return pending || gChord ? cancel() : null;
    const keys = ev.type === "text" ? [...String(ev.text)] : ev.type === "key" ? [ev.name.length === 1 && ev.shift ? ev.name.toUpperCase() : ev.name] : [];
    if (!keys.length) return null;
    let out = { changed: false };
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (mode !== "normal") {
        // A burst that switched to Insert ("ihello"): the rest is typed there.
        const rest = { type: "text", text: keys.slice(i).join("") };
        if (insertKey(rest) === undefined) core.passThrough(rest);
        return { changed: true };
      }
      if (!pending && !gChord) {
        beginStep();
        if (!replaying) rec = [];
      }
      // Keys are recorded as they came: a Delete key stays a Delete key in ".".
      record("cmd", ev.type === "key" ? ev : { type: "text", text: k });
      out = normalKey(k, ev) ?? out;
      // A burst that opened a search ("/foo" in one event): the rest is the query.
      if (search && i < keys.length - 1) {
        searchKey({ type: "text", text: keys.slice(i + 1).join("") });
        return { changed: true };
      }
    }
    return out;
  }

  function cancel() {
    pending = null;
    gChord = null;
    return finish();
  }

  function insertKey(ev) {
    if (ev.type === "key" && ev.name === "escape") {
      record("ins", ev);
      escapeToNormal();
      return { changed: true };
    }
    // Legacy terminals send Alt+x for a fast Esc then x: in Insert it is that.
    if (ev.type === "key" && ev.alt && !ev.ctrl && ev.name.length === 1) {
      record("ins", { type: "key", name: "escape" });
      escapeToNormal();
      return handle({ type: "text", text: ev.shift ? ev.name.toUpperCase() : ev.name });
    }
    // Enter (send) and Ctrl+R (the history search) are the composer's, never part of a change.
    if (ev.type === "key" && ((ev.name === "enter" && !ev.alt && !ev.shift && !ev.ctrl) || (ev.ctrl && ev.name === "r"))) return undefined;
    // An Insert session (also one not begun by a Normal command, as after a submit) is one undo step.
    beginStep();
    if (mode === "replace" && ev.type === "text") {
      const typed = sanitize(String(ev.text), "transcript").replace(/\n/g, "");
      for (const { g } of graphemes(typed)) {
        const t = T();
        const c = C();
        if (c < t.length && t[c] !== "\n") set(t.slice(0, c) + g + t.slice(nextB(t, c)), c + g.length);
        else set(t.slice(0, c) + g + t.slice(c), c + g.length);
      }
      record("ins", ev);
      return { changed: true };
    }
    if (mode === "replace" && ev.type === "key" && ev.name === "backspace") {
      move(prevB(T(), C()));
      record("ins", ev);
      return { changed: true };
    }
    // The composer's own editing; "." keeps what moved or changed (a Backspace with nothing to delete isn't kept).
    const before = T();
    const at = C();
    const r = core.passThrough(ev);
    const deleting = ev.type === "key" && (ev.name === "backspace" || ev.name === "delete");
    if (T() !== before || (!deleting && (C() !== at || ev.type === "text" || ev.type === "paste"))) record("ins", ev);
    return r;
  }

  return {
    handle,
    get mode() {
      return mode;
    },
    get pending() {
      return Boolean(pending || chordLive() || search);
    },
    /** The footer hint while gg waits for its second key. */
    get hint() {
      return chordLive() ? "g then \u{b7} g jump top \u{b7} esc cancel" : null;
    },
    get search() {
      return search ? { dir: search.dir, query: search.query } : null;
    },
    /** Esc is Vim's: in Insert or Replace, or with a command or search pending. */
    wantsEscape() {
      return mode !== "normal" || Boolean(pending || chordLive() || search);
    },
    /** The draft was replaced (a submit, history, /new): the mode goes to Insert, history and "." go. */
    reset({ mode: next = "insert" } = {}) {
      mode = next;
      pending = null;
      gChord = null;
      search = null;
      undo = [];
      redo = [];
      step = null;
      rec = null;
      dot = null;
    },
  };
}

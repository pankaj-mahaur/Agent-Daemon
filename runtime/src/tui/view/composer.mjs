// The composer (plan Part 5a): a multi-line text field as a pure state
// machine. Input events in, span lines + a cursor out; no terminal.
//
//   createComposer({history, pasteLines, pasteChars, mask})
//     .handle(ev) → {submit: text} | {changed} | {cancel: true} | null (not ours)
//     .render({width, prompt, placeholder}) → {lines, cursor: {row, col}}
//
// Keys:
//   - Graphemes are the cursor unit. ←/→ by grapheme; Ctrl/Alt+←/→ and
//     Alt+B/F by word; Home/End and Ctrl+A/E to the visual row's ends.
//   - Ctrl+K/U kill to the line's end/start, Ctrl+W and Ctrl/Alt+Backspace the
//     word before; Ctrl+Y yanks the last kill.
//   - Up/Down move between visual rows; on the first/last row they walk the
//     history. Ctrl+R searches it backwards.
//   - The FC0 newline keys (isNewline) and "\" + Enter insert a newline; Enter
//     submits.
// A paste of more than `pasteLines` lines (or `pasteChars` characters) shows
// as "[Pasted N lines]" and expands on submit. With `mask`, the text renders
// as dots and never reaches the history.

import { isNewline } from "../terminal/input.mjs";
import { graphemeSegments, graphemeWidth, stringWidth } from "../terminal/width.mjs";
import { sanitize } from "../terminal/sanitize.mjs";

const TAB_WIDTH = 4;
const ACCENT = { fg: "cyan", bold: true };
const DIM = { dim: true };
const isWordChar = (g) => /[\p{L}\p{N}_]/u.test(g);
// How a segment is drawn: a tab as spaces, a space hidden at a wrap point as nothing.
const shown = (seg, mask) => (mask ? "\u{2022}" : seg.g === "\t" || seg.hidden ? " ".repeat(seg.w) : seg.g);

/** Grapheme boundaries of a string as code-unit offsets (0 … length). */
function boundaries(text) {
  const out = [0];
  for (const { segment, index } of graphemeSegments(text)) out.push(index + segment.length);
  return out;
}

/**
 * Visual rows of `text` at `room` cells: [{start, end, segs: [{g, at, w}]}].
 * Long lines break after the last space when there is one (a space that
 * overflows stays at the row's end, zero cells wide); nothing is dropped, so
 * every offset maps to exactly one row (a soft-wrap point belongs to the row
 * it starts). Masked text wraps by cells only, so it shows no word lengths.
 */
export function layout(text, room, mask = false) {
  const rows = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    let row = { start: offset, end: offset, segs: [] };
    let w = 0;
    let lastSpace = -1; // index into row.segs just after a space
    for (const { segment, index } of graphemeSegments(line)) {
      const gw = mask ? 1 : segment === "\t" ? Math.min(TAB_WIDTH, room) : graphemeWidth(segment);
      if (w + gw > room && row.segs.length) {
        if (segment === " " && !mask) {
          row.segs.push({ g: segment, at: offset + index, w: 0, hidden: true });
          row.end = offset + index + 1;
          rows.push(row);
          row = { start: row.end, end: row.end, segs: [] };
          w = 0;
          lastSpace = -1;
          continue;
        }
        // Carry the last word over only when it fits on the next row with this grapheme.
        const carried = lastSpace > 0 ? row.segs.slice(lastSpace).reduce((n, x) => n + x.w, 0) : Infinity;
        const cut = lastSpace > 0 && lastSpace < row.segs.length && carried + gw <= room ? lastSpace : row.segs.length;
        const rest = row.segs.slice(cut);
        row.segs = row.segs.slice(0, cut);
        row.end = rest.length ? rest[0].at : offset + index;
        rows.push(row);
        row = { start: row.end, end: row.end, segs: rest };
        w = rest.reduce((n, s) => n + s.w, 0);
        lastSpace = -1;
      }
      row.segs.push({ g: segment, at: offset + index, w: gw });
      row.end = offset + index + segment.length;
      w += gw;
      if (segment === " " && !mask) lastSpace = row.segs.length;
    }
    rows.push(row);
    offset += line.length + 1;
  }
  return rows;
}

function rowOf(rows, at) {
  for (let r = rows.length - 1; r >= 0; r--) if (rows[r].start <= at) return r;
  return 0;
}

function colOf(row, at) {
  let col = 0;
  for (const s of row.segs) {
    if (s.at >= at) break;
    col += s.w;
  }
  return col;
}

function offsetAt(row, col) {
  let w = 0;
  for (const s of row.segs) {
    if (w + s.w > col) return s.at;
    w += s.w;
  }
  return row.end;
}

export function createComposer({ history = null, pasteLines = 5, pasteChars = 1000, mask = false } = {}) {
  let text = "";
  let cursor = 0; // a code-unit offset on a grapheme boundary
  let kill = "";
  const pastes = new Map(); // token → full text
  let histIndex = null; // index into history entries while browsing
  let draft = "";
  let search = null; // {query, match} during Ctrl+R
  let room = 78; // text cells per row, from the last render
  let goalCol = null; // the column Up/Down aim for across short rows

  const entries = () => history?.entries() ?? [];
  const rows = () => layout(text, room, mask);

  function set(next, at = next.length) {
    text = next;
    const b = boundaries(text);
    cursor = b.find((x) => x >= Math.max(0, at)) ?? text.length;
  }

  const prevBoundary = () => boundaries(text).findLast((b) => b < cursor) ?? 0;
  const nextBoundary = () => boundaries(text).find((b) => b > cursor) ?? text.length;
  const lineStart = () => text.lastIndexOf("\n", cursor - 1) + 1;
  const lineEnd = () => {
    const i = text.indexOf("\n", cursor);
    return i < 0 ? text.length : i;
  };

  function wordLeft() {
    const b = boundaries(text).filter((x) => x < cursor).reverse();
    let i = 0;
    const g = (k) => text.slice(b[k], k ? b[k - 1] : cursor);
    while (i < b.length && !isWordChar(g(i))) i++;
    while (i < b.length && isWordChar(g(i))) i++;
    return i ? b[i - 1] : cursor;
  }

  function wordRight() {
    const b = boundaries(text).filter((x) => x > cursor);
    let prev = cursor;
    let i = 0;
    while (i < b.length && !isWordChar(text.slice(prev, b[i]))) prev = b[i++];
    while (i < b.length && isWordChar(text.slice(prev, b[i]))) prev = b[i++];
    return prev;
  }

  function insert(s) {
    if (!s) return;
    histIndex = null;
    set(text.slice(0, cursor) + s + text.slice(cursor), cursor + s.length);
  }

  function cut(from, to) {
    if (from === to) return;
    kill = text.slice(from, to);
    set(text.slice(0, from) + text.slice(to), from);
  }

  function paste(raw) {
    const clean = sanitize(raw, "transcript");
    const lines = clean.split("\n").length;
    if (!mask && (lines > pasteLines || clean.length > pasteChars)) {
      let token = `[Pasted ${lines} lines]`;
      for (let n = 2; pastes.has(token) || text.includes(token); n++) token = `[Pasted ${lines} lines #${n}]`;
      pastes.set(token, clean);
      insert(token);
    } else insert(mask ? clean.replace(/\n/g, "") : clean);
  }

  /** The text as it will be sent: paste tokens still present are expanded. */
  function expanded() {
    let out = text;
    for (const [token, full] of pastes) out = out.split(token).join(full);
    return out;
  }

  function reset() {
    set("");
    pastes.clear();
    histIndex = null;
    goalCol = null;
  }

  function historyMove(dir) {
    const list = entries();
    if (!list.length || mask) return false;
    if (histIndex === null) {
      if (dir > 0) return false;
      draft = text;
      histIndex = list.length;
    }
    const next = histIndex + dir;
    if (next < 0) return true;
    if (next >= list.length) {
      histIndex = null;
      set(draft);
    } else {
      histIndex = next;
      set(list[next]);
    }
    return true;
  }

  function verticalMove(dir) {
    const r = rows();
    const at = rowOf(r, cursor);
    const target = at + dir;
    if (target < 0 || target >= r.length) {
      goalCol = null;
      return historyMove(dir);
    }
    goalCol ??= colOf(r[at], cursor);
    cursor = offsetAt(r[target], goalCol);
    return true;
  }

  function searchFind(from) {
    const list = entries();
    if (!search.query) return null;
    for (let i = Math.min(from, list.length - 1); i >= 0; i--) if (list[i].includes(search.query)) return i;
    return null;
  }

  function handleSearch(ev) {
    const list = entries();
    if (ev.type === "text" || ev.type === "paste") {
      search.query += sanitize(ev.text, "transcript").split("\n")[0];
      search.match = searchFind(list.length - 1);
      return { changed: true };
    }
    if (ev.type !== "key") return { changed: false };
    if (ev.ctrl && ev.name === "r") {
      if (search.match !== null) search.match = searchFind(search.match - 1) ?? search.match;
      return { changed: true };
    }
    if (ev.name === "backspace") {
      search.query = [...search.query].slice(0, -1).join("");
      search.match = searchFind(list.length - 1);
      return { changed: true };
    }
    if (ev.name === "escape" || (ev.ctrl && (ev.name === "c" || ev.name === "g"))) {
      search = null;
      return { changed: true };
    }
    if (["enter", "tab", "left", "right", "home", "end"].includes(ev.name)) {
      if (search.match !== null) set(list[search.match]);
      search = null;
      return { changed: true };
    }
    return { changed: false };
  }

  function handle(ev) {
    if (search) return handleSearch(ev);
    if (ev.type === "text") {
      goalCol = null;
      insert(sanitize(ev.text, "transcript").replace(/\n/g, ""));
      return { changed: true };
    }
    if (ev.type === "paste") {
      goalCol = null;
      paste(ev.text);
      return { changed: true };
    }
    if (ev.type !== "key") return null;
    const { name, ctrl, alt } = ev;
    if (name !== "up" && name !== "down") goalCol = null;
    if (isNewline(ev)) {
      if (mask) return { changed: false };
      insert("\n");
      return { changed: true };
    }
    if (name === "enter" && !alt) {
      // "\" + Enter is a newline everywhere (the FC0 fallback).
      if (!mask && text.slice(0, cursor).endsWith("\\")) {
        set(text.slice(0, cursor - 1) + "\n" + text.slice(cursor), cursor);
        return { changed: true };
      }
      const out = expanded();
      if (!out.trim()) return { changed: false };
      if (!mask) history?.add(out);
      reset();
      return { submit: out };
    }
    if (ctrl && name === "r" && !mask) {
      search = { query: "", match: null };
      return { changed: true };
    }
    if (name === "backspace") {
      if (ctrl || alt) cut(wordLeft(), cursor);
      else if (cursor > 0) {
        const from = prevBoundary();
        set(text.slice(0, from) + text.slice(cursor), from);
      }
      return { changed: true };
    }
    if (name === "delete") {
      if (cursor < text.length) set(text.slice(0, cursor) + text.slice(nextBoundary()), cursor);
      return { changed: true };
    }
    if (name === "left") cursor = ctrl || alt ? wordLeft() : prevBoundary();
    else if (name === "right") cursor = ctrl || alt ? wordRight() : nextBoundary();
    else if (alt && name === "b") cursor = wordLeft();
    else if (alt && name === "f") cursor = wordRight();
    else if (name === "home" || (ctrl && name === "a")) {
      const r = rows();
      cursor = r[rowOf(r, cursor)].start;
    } else if (name === "end" || (ctrl && name === "e")) {
      // A soft-wrapped row's end is the next row's start: stop before its last grapheme.
      const r = rows();
      const i = rowOf(r, cursor);
      const soft = r[i + 1]?.start === r[i].end && r[i].segs.length;
      cursor = soft ? r[i].segs.at(-1).at : r[i].end;
    }
    // At a line's end Ctrl+K joins the next line; at its start Ctrl+U the previous.
    else if (ctrl && name === "k") cut(cursor, lineEnd() === cursor ? Math.min(text.length, cursor + 1) : lineEnd());
    else if (ctrl && name === "u") cut(lineStart() === cursor ? Math.max(0, cursor - 1) : lineStart(), cursor);
    else if (ctrl && name === "w") cut(wordLeft(), cursor);
    else if (ctrl && name === "y") insert(kill);
    else if (name === "up" || name === "down") {
      if (!verticalMove(name === "up" ? -1 : 1)) return { changed: false };
    } else if (name === "escape" && text) return { cancel: true };
    else return null;
    return { changed: true };
  }

  /** The word under the cursor when it starts with `@` (anywhere) or `/` (at the start). */
  function token() {
    if (mask) return null;
    const before = text.slice(0, cursor);
    const m = /(?:^|\s)([@/]\S*)$/u.exec(before);
    if (!m) return null;
    if (m[1][0] === "/" && before.length !== m[1].length) return null;
    const after = /^\S*/u.exec(text.slice(cursor))[0];
    const start = cursor - m[1].length;
    return { kind: m[1][0] === "@" ? "mention" : "command", text: m[1] + after, start, end: cursor + after.length };
  }

  /** Replaces a token() range (accepting a popup choice). */
  function replace(start, end, value) {
    histIndex = null;
    set(text.slice(0, start) + value + text.slice(end), start + value.length);
  }

  function render({ width = 80, prompt = "\u{203a} ", placeholder = "" } = {}) {
    const pw = stringWidth(prompt);
    // One cell stays free so a cursor after a full row never wraps the terminal.
    room = Math.max(1, width - pw - 1);
    if (search) {
      const list = entries();
      const found = search.match !== null ? list[search.match].split("\n")[0] : null;
      const label = "(reverse-i-search) ";
      const tail = found !== null ? `  \u{2192} ${found}` : search.query ? "  (no match)" : "";
      return {
        lines: [[{ text: label, style: DIM }, { text: search.query }, { text: tail, style: DIM }]],
        cursor: { row: 0, col: Math.min(width - 1, stringWidth(label + search.query)) },
      };
    }
    const r = rows();
    const lines = r.map((row, i) => [
      { text: i === 0 ? prompt : " ".repeat(pw), style: ACCENT },
      { text: row.segs.map((s) => shown(s, mask)).join("") },
    ]);
    if (!text && placeholder) lines[0].push({ text: placeholder, style: DIM });
    const at = rowOf(r, cursor);
    return { lines, cursor: { row: at, col: Math.min(width - 1, pw + colOf(r[at], cursor)) } };
  }

  return {
    handle,
    render,
    expanded,
    token,
    replace,
    clear: reset,
    set: (t) => set(String(t ?? "")),
    get text() {
      return text;
    },
    get cursor() {
      return cursor;
    },
    get searching() {
      return search !== null;
    },
  };
}

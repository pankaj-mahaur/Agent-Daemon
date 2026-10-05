// Markdown for the transcript (plan Part 5b): agent messages rendered to span
// lines (text.mjs), whole or as a stream. Pure; untrusted text is sanitized
// here, so callers pass the raw model output.
//
//   renderMarkdown(text, {width})       → lines
//   createMarkdownStream({width})        → {push(delta) → lines now final,
//                                           live() → provisional lines,
//                                           finish() → the remaining lines}
//   createPacer({now})                  → commit pacing (one line per tick)
//
// Blocks: ATX and setext headings, paragraphs, nested lists (bullet and
// ordered), block quotes, fenced code, tables (GFM) and rules. Inline: code,
// bold, italic, strike, links (the URL is shown after the text when they
// differ, so a link can't pose as another; OSC 8 when the renderer allows),
// autolinks and bare URLs, backslash escapes, hard breaks.
//
// Streaming: only complete lines are parsed (the newline gate). Every block
// before the last is final and commits; so does a last block nothing can
// extend (an ATX heading, a rule, a closed fence), and the finished lines of
// an open fence. A paragraph's last line is held back (it may turn into a
// setext heading or a table header), and a table until it ends. Concatenating
// everything a stream commits gives exactly renderMarkdown(full text).

import { sanitize } from "../terminal/sanitize.mjs";
import { graphemeSegments, graphemeWidth, stringWidth } from "../terminal/width.mjs";
import { lineWidth, normalize, truncate, wrap } from "../terminal/text.mjs";

const S = {
  h1: { bold: true, underline: true },
  h: { bold: true },
  code: { fg: "cyan" },
  block: { fg: "cyan" },
  quote: { dim: true },
  bullet: { dim: true },
  rule: { dim: true },
  border: { dim: true },
  url: { dim: true },
};

/* ------------------------------------------------------------------ */
/* Block structure                                                     */
/* ------------------------------------------------------------------ */

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( {0,3})([-+*]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const blank = (l) => /^[ \t]*$/.test(l);

function fenceOpen(line) {
  const m = FENCE.exec(line);
  if (!m || (m[2][0] === "`" && m[3].includes("`"))) return null;
  return { indent: m[1].length, char: m[2][0], len: m[2].length, info: m[3].trim().split(/\s+/)[0] ?? "" };
}

function fenceCloses(line, f) {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return !!m && m[1][0] === f.char && m[1].length >= f.len;
}

const cellsOfRow = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

function tableStart(lines, i) {
  return lines[i] !== undefined && lines[i].includes("|") && lines[i + 1] !== undefined && DELIM.test(lines[i + 1]) && lines[i + 1].includes("|") || (lines[i]?.includes("|") && lines[i + 1] !== undefined && DELIM.test(lines[i + 1]) && cellsOfRow(lines[i]).length === cellsOfRow(lines[i + 1]).length && cellsOfRow(lines[i]).length > 1);
}

function itemOf(line) {
  const m = ITEM.exec(line);
  if (!m) return null;
  const spaces = m[3] ?? "";
  // 1–4 spaces after the marker; more means indented code inside the item, which we treat as 1.
  const pad = !m[4] ? 1 : spaces.length > 4 ? 1 : spaces.length;
  return {
    ordered: /\d/.test(m[2]),
    marker: m[2],
    start: /\d/.test(m[2]) ? Number.parseInt(m[2], 10) : null,
    offset: m[1].length + m[2].length + pad, // where the item's content starts
    first: m[4] ?? "",
  };
}

// Does line i start a block that interrupts a paragraph?
function interrupts(lines, i) {
  const l = lines[i];
  if (ATX.test(l) || fenceOpen(l) || QUOTE.test(l) || RULE.test(l)) return true;
  const it = itemOf(l);
  if (it && it.first && (!it.ordered || it.start === 1)) return true;
  return tableStart(lines, i);
}

const dedent = (line, n) => {
  let i = 0;
  while (i < n && line[i] === " ") i++;
  return line.slice(i);
};

/**
 * Splits lines into blocks: [{type, start, end, ...}], `end` exclusive.
 * `complete` says nothing more can be added to the block (used by streams).
 */
export function parseBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (blank(l)) {
      i++;
      continue;
    }
    const start = i;
    let m;
    if ((m = ATX.exec(l))) {
      blocks.push({ type: "heading", level: m[1].length, text: m[2] ?? "", start, end: ++i, complete: true });
      continue;
    }
    const f = fenceOpen(l);
    if (f) {
      const body = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (fenceCloses(lines[i], f)) {
          closed = true;
          i++;
          break;
        }
        body.push(dedent(lines[i], f.indent));
        i++;
      }
      blocks.push({ type: "code", info: f.info, body, start, end: i, complete: closed, open: !closed });
      continue;
    }
    if (RULE.test(l)) {
      blocks.push({ type: "rule", start, end: ++i, complete: true });
      continue;
    }
    if (QUOTE.test(l)) {
      const inner = [];
      let lazy = false;
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i]);
        if (q) {
          inner.push(q[1]);
          lazy = !blank(q[1]) && !fenceOpen(q[1]);
        } else if (lazy && !blank(lines[i]) && !interrupts(lines, i)) inner.push(lines[i]);
        else break;
        i++;
      }
      blocks.push({ type: "quote", blocks: parseBlocks(inner), start, end: i, complete: false });
      continue;
    }
    const it = itemOf(l);
    if (it) {
      const items = [];
      const ordered = it.ordered;
      let lastBlank = false;
      while (i < lines.length) {
        const cur = itemOf(lines[i]);
        if (!cur || cur.ordered !== ordered) break;
        const body = [cur.first];
        let prevBlank = !cur.first;
        i++;
        while (i < lines.length) {
          const x = lines[i];
          if (blank(x)) {
            body.push("");
            prevBlank = true;
            i++;
            continue;
          }
          const indent = x.length - x.trimStart().length;
          if (indent >= cur.offset) body.push(dedent(x, cur.offset));
          else if (!prevBlank && !itemOf(x) && !interrupts(lines, i) && !SETEXT.test(x)) body.push(x.trimStart()); // lazy
          else break;
          prevBlank = false;
          i++;
        }
        // Trailing blank lines belong between items, not to this one.
        let trail = 0;
        while (body.length && blank(body.at(-1))) {
          body.pop();
          trail++;
        }
        lastBlank = trail > 0;
        items.push({ marker: cur.marker, start: cur.start, blocks: parseBlocks(body) });
        if (lastBlank && (i >= lines.length || !itemOf(lines[i]))) break;
      }
      blocks.push({ type: "list", ordered, items, start, end: i, complete: false });
      continue;
    }
    if (tableStart(lines, i)) {
      const head = cellsOfRow(lines[i]);
      const align = cellsOfRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"));
      const rows = [];
      i += 2;
      while (i < lines.length && !blank(lines[i]) && lines[i].includes("|") && !interrupts(lines, i)) rows.push(cellsOfRow(lines[i++]));
      blocks.push({ type: "table", head, align, rows, start, end: i, complete: false });
      continue;
    }
    // Paragraph (or a setext heading).
    const para = [l];
    i++;
    let level = 0;
    while (i < lines.length && !blank(lines[i])) {
      const s = SETEXT.exec(lines[i]);
      if (s) {
        level = s[1][0] === "=" ? 1 : 2;
        i++;
        break;
      }
      if (interrupts(lines, i)) break;
      para.push(lines[i++]);
    }
    if (level) blocks.push({ type: "heading", level, text: para.map((p) => p.trim()).join(" "), start, end: i, complete: true });
    else blocks.push({ type: "paragraph", lines: para, start, end: i, complete: false });
  }
  return blocks;
}

/* ------------------------------------------------------------------ */
/* Inline                                                              */
/* ------------------------------------------------------------------ */

const ESCAPABLE = /[!-/:-@[-`{-~]/;
const BARE_URL = /^https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_~]/;

const merge = (style, extra) => (style ? { ...style, ...extra } : extra);

/** Inline markdown to spans. `base` is the surrounding style. */
export function inline(text, base = undefined) {
  // Per-text indexes so unmatched openers cost O(n) in all, not O(n) each.
  const ctx = { text, fail: new Map(), brackets: null, ticks: new Map() };
  const out = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push(base ? { text: buf, style: base } : { text: buf });
    buf = "";
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) {
      if (text[i + 1] === "\n") {
        flush();
        out.push({ text: "\n" });
        i += 2;
        continue;
      }
      if (ESCAPABLE.test(text[i + 1])) {
        buf += text[i + 1];
        i += 2;
        continue;
      }
    }
    if (c === "\n") {
      // Two trailing spaces make a hard break; otherwise a soft break is a space.
      if (buf.endsWith("  ")) {
        buf = buf.replace(/ +$/, "");
        flush();
        out.push({ text: "\n" });
      } else buf = buf.replace(/ +$/, "") + " ";
      i++;
      continue;
    }
    if (c === "`") {
      let n = 0;
      while (text[i + n] === "`") n++;
      const fence = "`".repeat(n);
      let j = text.indexOf(fence, i + n);
      while (j >= 0 && text[j + n] === "`") {
        let k = j;
        while (text[k] === "`") k++;
        j = text.indexOf(fence, k);
      }
      if (j >= 0) {
        flush();
        let code = text.slice(i + n, j).replace(/\n/g, " ");
        if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1);
        out.push({ text: code, style: merge(base, S.code) });
        i = j + n;
        continue;
      }
      buf += fence;
      i += n;
      continue;
    }
    if (c === "[") {
      const link = parseLink(ctx, i);
      if (link) {
        flush();
        const label = inline(link.label, merge(base, { underline: true, link: link.url }));
        out.push(...label);
        const shown = label.map((s) => s.text).join("");
        if (shown !== link.url && `mailto:${shown}` !== link.url) out.push({ text: ` (${link.url})`, style: merge(base, S.url) });
        i = link.end;
        continue;
      }
    }
    if (c === "<") {
      const m = /^<((?:https?|mailto):[^\s<>]+)>/.exec(text.slice(i));
      if (m) {
        flush();
        out.push({ text: m[1], style: merge(base, { underline: true, link: m[1] }) });
        i += m[0].length;
        continue;
      }
    }
    if (c === "h" && (i === 0 || /[\s(]/.test(text[i - 1]))) {
      const m = BARE_URL.exec(text.slice(i));
      if (m) {
        flush();
        out.push({ text: m[0], style: merge(base, { underline: true, link: m[0] }) });
        i += m[0].length;
        continue;
      }
    }
    if (c === "*" || c === "_" || c === "~") {
      const em = parseEmphasis(ctx, i);
      if (em) {
        flush();
        out.push(...inline(em.inner, merge(base, em.style)));
        i = em.end;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

// "[" position → its matching "]" (balanced, backslash escapes skipped), one pass.
function bracketPairs(text) {
  const pairs = new Map();
  const stack = [];
  for (let j = 0; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === "[") stack.push(j);
    else if (text[j] === "]" && stack.length) pairs.set(stack.pop(), j);
  }
  return pairs;
}

function parseLink(ctx, i) {
  // [label](url "title") with balanced brackets in the label.
  const text = ctx.text;
  ctx.brackets ??= bracketPairs(text);
  const j = ctx.brackets.get(i);
  if (j === undefined || text[j + 1] !== "(") return null;
  const m = /^\(\s*<?([^\s()<>]*)>?(?:\s+"[^"]*")?\s*\)/.exec(text.slice(j + 1));
  if (!m || !m[1]) return null;
  return { label: text.slice(i + 1, j), url: m[1], end: j + 1 + m[0].length };
}

// The end of the code span whose backtick run starts at j, or -1 (cached per text).
function codeSpanEnd(ctx, j) {
  if (ctx.ticks.has(j)) return ctx.ticks.get(j);
  const text = ctx.text;
  let n = 0;
  while (text[j + n] === "`") n++;
  const close = text.indexOf("`".repeat(n), j + n);
  const end = close > 0 ? close + n - 1 : -1;
  ctx.ticks.set(j, end);
  return end;
}

// No closer exists after a failed opener of the same kind, so later openers
// of that kind fail at once (they search a subset of the same range).
function failedFrom(ctx, key, i) {
  const at = ctx.fail.get(key);
  return at !== undefined && i >= at;
}
function markFailed(ctx, key, i) {
  const at = ctx.fail.get(key);
  if (at === undefined || i < at) ctx.fail.set(key, i);
}

function parseEmphasis(ctx, i) {
  const text = ctx.text;
  const c = text[i];
  let n = 0;
  while (text[i + n] === c) n++;
  if (c === "~" && n !== 2) return null;
  const run = c.repeat(Math.min(n, c === "~" ? 2 : 3));
  const len = run.length;
  const after = text[i + len];
  // A left-flanking opener: not followed by whitespace; "_" not inside a word.
  if (after === undefined || /\s/.test(after)) return null;
  if (c === "_" && i > 0 && /[\p{L}\p{N}]/u.test(text[i - 1])) return null;
  const key = `${c}${len}`;
  if (failedFrom(ctx, key, i)) return len > 1 && c !== "~" ? parseEmphasisRun(ctx, i, len - 1) : null;
  for (let j = i + len + 1; j <= text.length - len; j++) {
    if (text[j] === "\\") {
      j++;
      continue;
    }
    if (text[j] === "`") {
      // Skip code spans: emphasis never closes inside one.
      const end = codeSpanEnd(ctx, j);
      if (end > 0) j = end;
      else while (text[j + 1] === "`") j++;
      continue;
    }
    if (text.startsWith(run, j) && text[j + len] !== c && !/\s/.test(text[j - 1])) {
      if (c === "_" && /[\p{L}\p{N}]/u.test(text[j + len] ?? "")) continue;
      const style = c === "~" ? { strike: true } : len === 3 ? { bold: true, italic: true } : len === 2 ? { bold: true } : { italic: true };
      return { inner: text.slice(i + len, j), style, end: j + len };
    }
  }
  markFailed(ctx, key, i);
  // "***x**" and the like: try a shorter run.
  if (len > 1 && c !== "~") {
    const shorter = parseEmphasisRun(ctx, i, len - 1);
    if (shorter) return shorter;
  }
  return null;
}

function parseEmphasisRun(ctx, i, len) {
  const text = ctx.text;
  const c = text[i];
  const run = c.repeat(len);
  const key = `run${c}${len}`;
  if (failedFrom(ctx, key, i)) return null;
  for (let j = i + len + 1; j <= text.length - len; j++) {
    if (text.startsWith(run, j) && !/\s/.test(text[j - 1]) && text[j - 1] !== c) {
      const style = len === 2 ? { bold: true } : { italic: true };
      return { inner: text.slice(i + len, j), style, end: j + len };
    }
  }
  markFailed(ctx, key, i);
  return null;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

// Wraps spans in `width - prefix` columns, the first line after `first` and
// the rest after `rest` (a hanging indent).
export function wrapPrefixed(spans, width, first, rest = first) {
  const pw = Math.max(lineWidth(first), lineWidth(rest));
  const lines = wrap(spans, Math.max(1, width - pw));
  return lines.map((l, i) => normalize([...(i === 0 ? first : rest), ...l]));
}

// Code: hard-wrapped by grapheme (spaces are content), tabs as 4 spaces.
export function codeLines(line, width, style) {
  const text = line.replace(/\t/g, "    ");
  const out = [];
  let cur = "";
  let w = 0;
  for (const { segment } of graphemeSegments(text)) {
    const gw = graphemeWidth(segment);
    if (w + gw > width && cur) {
      out.push(cur);
      cur = "";
      w = 0;
    }
    cur += segment;
    w += gw;
  }
  out.push(cur);
  return out.map((t) => (t ? [{ text: t, style }] : []));
}

const BULLETS = ["\u{2022}", "\u{25e6}", "\u{25aa}"];

function renderList(block, width, depth) {
  const out = [];
  block.items.forEach((item, n) => {
    const marker = block.ordered ? `${(block.items[0].start ?? 1) + n}.` : BULLETS[depth % BULLETS.length];
    const first = [{ text: `${marker} `, style: S.bullet }];
    const rest = [{ text: " ".repeat(stringWidth(marker) + 1) }];
    const inner = renderBlocks(item.blocks, Math.max(1, width - lineWidth(rest)), depth + 1);
    if (!inner.length) inner.push([]);
    inner.forEach((l, i) => out.push(normalize([...(i === 0 ? first : rest), ...l])));
  });
  return out;
}

function renderTable(block, width) {
  const cols = Math.max(block.head.length, ...block.rows.map((r) => r.length));
  // Cells may be cut to fit, which would hide a link's " (url)" suffix: no hyperlinks in tables.
  const noLink = (spans) => spans.map((sp) => (sp.style?.link ? { ...sp, style: (({ link, ...rest }) => rest)(sp.style) } : sp));
  const cells = [block.head, ...block.rows].map((r) => Array.from({ length: cols }, (_, k) => normalize(noLink(inline(r[k] ?? "")))));
  let widths = Array.from({ length: cols }, (_, k) => Math.max(1, ...cells.map((r) => lineWidth(r[k]))));
  const sep = 3; // " │ "
  const total = () => widths.reduce((a, b) => a + b, 0) + sep * (cols - 1);
  // Too wide: shrink the widest column first, down to 3 cells each.
  while (total() > width && Math.max(...widths) > 3) {
    const k = widths.indexOf(Math.max(...widths));
    widths[k]--;
  }
  if (total() > width) {
    // Still too wide: one "header: value" line per cell.
    const out = [];
    for (const row of cells.slice(1)) {
      row.forEach((c, k) => out.push(...wrapPrefixed(c, width, [{ text: `${block.head[k] ?? ""}: `, style: S.h }], [{ text: "  " }])));
      out.push([]);
    }
    if (out.length) out.pop();
    return out;
  }
  const pad = (line, k) => {
    const cut = truncate(line, widths[k]);
    const room = widths[k] - lineWidth(cut);
    const a = block.align[k] ?? "left";
    const left = a === "right" ? room : a === "center" ? Math.floor(room / 2) : 0;
    return [{ text: " ".repeat(left) }, ...cut, { text: " ".repeat(room - left) }];
  };
  const row = (r, head) =>
    normalize(
      r.flatMap((c, k) => [...(k ? [{ text: " \u{2502} ", style: S.border }] : []), ...pad(head ? c.map((s) => ({ ...s, style: merge(s.style, S.h) })) : c, k)]),
    ).map((s, i, all) => (i === all.length - 1 && !s.style ? { text: s.text.replace(/ +$/, "") } : s));
  const out = [row(cells[0], true), [{ text: widths.map((w) => "\u{2500}".repeat(w)).join("\u{2500}\u{253c}\u{2500}"), style: S.border }]];
  for (const r of cells.slice(1)) out.push(row(r, false));
  return out.map(normalize);
}

function renderBlock(b, width, depth = 0) {
  switch (b.type) {
    case "heading": {
      const style = b.level === 1 ? S.h1 : S.h;
      return wrap(inline(b.text.trim(), style), width);
    }
    case "paragraph":
      return wrap(inline(b.lines.map((l) => l.replace(/^[ \t]+/, "")).join("\n").replace(/[ \t]+$/, "")), width);
    case "code":
      return b.body.flatMap((l) => codeLines(l, Math.max(1, width - 4), S.block).map((x) => normalize([{ text: "    " }, ...x])));
    case "rule":
      return [[{ text: "\u{2500}".repeat(Math.max(1, Math.min(width, 40))), style: S.rule }]];
    case "quote":
      return renderBlocks(b.blocks, Math.max(1, width - 2), depth).map((l) => normalize([{ text: "\u{258e} ", style: S.quote }, ...l.map((s) => ({ ...s, style: merge(s.style, S.quote) }))]));
    case "list":
      return renderList(b, width, depth);
    case "table":
      return renderTable(b, width);
    default:
      return [];
  }
}

function renderBlocks(blocks, width, depth = 0) {
  const out = [];
  blocks.forEach((b, i) => {
    // Lists nested in a list item sit right under its text.
    if (i > 0 && !(depth > 0 && b.type === "list")) out.push([]);
    out.push(...renderBlock(b, width, depth));
  });
  return out;
}

// Lines of a text; a final newline ends the last line rather than starting an empty one.
const toLinesOf = (text) => {
  const lines = sanitize(text, "transcript").split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
};

/** Renders a whole markdown text to lines at `width`. */
export function renderMarkdown(text, { width = 80 } = {}) {
  return renderBlocks(parseBlocks(toLinesOf(String(text ?? ""))), Math.max(1, width));
}

/* ------------------------------------------------------------------ */
/* Streaming                                                           */
/* ------------------------------------------------------------------ */

const LIVE_EXACT_CHARS = 8000;
const LIVE_TAIL_CHARS = 3000;

export function createMarkdownStream({ width = 80 } = {}) {
  width = Math.max(1, width);
  let raw = ""; // everything pushed
  let gated = 0; // raw.length up to (and including) the last newline
  let base = 0; // line index where the non-final region starts
  let blocksBefore = 0; // final blocks already emitted
  let codeEmitted = 0; // lines of an open fence (at `base`) already emitted
  let finished = false;
  // Complete lines, sanitized once each. A newline ends every escape
  // sequence sanitize() recognises, so line-by-line equals all at once.
  const done = [];
  let doneAt = 0;

  function lines() {
    if (doneAt < gated) {
      const parts = sanitize(raw.slice(doneAt, gated), "transcript").split("\n");
      parts.pop(); // after the last newline: nothing
      for (const l of parts) done.push(l);
      doneAt = gated;
    }
    return done;
  }

  // Lines that became final since the last call.
  function advance(final) {
    const all = lines();
    const out = [];
    const region = all.slice(base);
    const blocks = parseBlocks(region);
    const lastIndex = blocks.length - 1;
    for (let k = 0; k < blocks.length; k++) {
      const b = blocks[k];
      const isLast = k === lastIndex;
      if (isLast && !final && !b.complete) {
        if (b.type === "code" && b.open) {
          // An open fence: its finished lines commit as they come.
          if (codeEmitted === 0 && b.body.length && blocksBefore > 0) out.push([]);
          const rendered = renderBlock({ ...b, body: b.body.slice(codeEmitted) }, width);
          out.push(...rendered);
          codeEmitted = b.body.length;
          base += b.start;
          // Keep the fence's opening line at `base`.
          return { out, region: region.slice(b.start) };
        }
        base += b.start;
        return { out };
      }
      if (b.type === "code" && codeEmitted > 0 && k === 0) {
        // The rest of a fence that was streaming.
        out.push(...renderBlock({ ...b, body: b.body.slice(codeEmitted) }, width));
        codeEmitted = 0;
      } else {
        if (blocksBefore > 0) out.push([]);
        out.push(...renderBlock(b, width));
      }
      blocksBefore++;
      codeEmitted = 0;
      if (isLast) base += b.end;
    }
    if (!blocks.length) base = all.length;
    return { out };
  }

  function liveTail(region) {
    const tail = [];
    let size = 0;
    for (let i = region.length - 1; i >= 0 && size < LIVE_TAIL_CHARS; i--) {
      tail.unshift(region[i]);
      size += region[i].length + 1;
    }
    // One enormous line: keep its end, from a word boundary.
    if (tail.length === 1 && tail[0].length > LIVE_TAIL_CHARS) {
      const cut = tail[0].slice(-LIVE_TAIL_CHARS);
      tail[0] = cut.slice(Math.max(0, cut.indexOf(" ") + 1));
    }
    return [[{ text: "  \u{2026}", style: { dim: true } }], ...renderBlocks(parseBlocks(tail), width)];
  }

  return {
    push(delta) {
      if (finished || !delta) return [];
      raw += String(delta);
      const nl = raw.lastIndexOf("\n");
      if (nl + 1 <= gated) return [];
      gated = nl + 1;
      return advance(false).out;
    },
    /** Provisional lines for the live region: the held-back block, partial line included. */
    live() {
      if (finished) return [];
      const region = lines().slice(base);
      const partial = sanitize(raw.slice(gated), "transcript");
      if (partial) region.push(partial);
      let size = 0;
      for (const l of region) size += l.length + 1;
      // A very long held-back block (a huge paragraph or list) is shown by its
      // tail only: rendering all of it on every frame would be too slow. What
      // commits stays exact; only this provisional view is cut.
      if (size > LIVE_EXACT_CHARS) return liveTail(region);
      const blocks = parseBlocks(region);
      if (!blocks.length) return [];
      const b = blocks[0];
      const rest = b.type === "code" && codeEmitted ? [{ ...b, body: b.body.slice(codeEmitted) }, ...blocks.slice(1)] : blocks;
      const out = [];
      rest.forEach((x, i) => {
        if (i > 0 || (blocksBefore > 0 && !(x === rest[0] && codeEmitted))) out.push([]);
        out.push(...renderBlock(x, width));
      });
      return out;
    },
    /** Ends the stream: everything not yet committed. */
    finish() {
      if (finished) return [];
      finished = true;
      if (!raw.endsWith("\n")) raw += "\n";
      gated = raw.length;
      return advance(true).out;
    },
    get text() {
      return raw;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Pacing                                                              */
/* ------------------------------------------------------------------ */

/**
 * Commit pacing: final lines leave one per tick, so a burst reads as typing;
 * when 8 or more wait, or the oldest has waited 120 ms, all go at once.
 */
export function createPacer({ now = () => Date.now(), batch = 8, maxWaitMs = 120 } = {}) {
  const queue = []; // [{line, at}]
  return {
    push(lines) {
      const t = now();
      for (const line of lines) queue.push({ line, at: t });
    },
    tick() {
      if (!queue.length) return [];
      if (queue.length >= batch || now() - queue[0].at >= maxWaitMs) return queue.splice(0).map((q) => q.line);
      return [queue.shift().line];
    },
    flush: () => queue.splice(0).map((q) => q.line),
    get size() {
      return queue.length;
    },
  };
}

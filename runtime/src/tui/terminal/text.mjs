// Styled text for the terminal: spans, colour depth, SGR rendering, word wrap
// and truncation. Pure functions; nothing here writes to a stream.
//
// A span is {text, style?}. A line is an array of spans. Style fields: fg, bg
// (a name from COLORS or "#rrggbb"), bold, dim, italic, underline, inverse,
// strike. Span text must already be sanitized (sanitize.mjs); tabs and
// newlines are handled here.

import { graphemes, graphemeSegments, graphemeWidth, stringWidth } from "./width.mjs";

export const RESET = "\x1b[0m";
const TAB_STOP = 8;

const COLORS = {
  black: 0, red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6, white: 7,
  gray: 8, brightRed: 9, brightGreen: 10, brightYellow: 11,
  brightBlue: 12, brightMagenta: 13, brightCyan: 14, brightWhite: 15,
};
// xterm's default palette for the 16 named colours, used to downsample "#rrggbb".
const PALETTE16 = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];

/**
 * Colour depth in bits: 0 (none), 4 (16 colours), 8 (256) or 24 (truecolor).
 * FORCE_COLOR wins over NO_COLOR, as in Node, and is a floor: on a TTY that
 * can do more, the detected depth is used. A non-TTY gets none unless forced.
 */
export function colorDepth({ env = process.env, isTTY = false, platform = process.platform } = {}) {
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === "0" || force === "false") return 0;
    const forced = force === "3" ? 24 : force === "2" ? 8 : 4;
    return isTTY ? Math.max(forced, detectDepth(env, platform)) : forced;
  }
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return 0;
  if (!isTTY) return 0;
  return detectDepth(env, platform);
}

function detectDepth(env, platform) {
  if (env.TERM === "dumb") return 0;
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return 24;
  if (env.WT_SESSION) return 24;
  if (/256/.test(env.TERM ?? "")) return 8;
  if (platform === "win32") return 24;
  return 4;
}

function parseHex(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function nearest16([r, g, b]) {
  let best = 0;
  let bestD = Infinity;
  PALETTE16.forEach(([pr, pg, pb], i) => {
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestD) [best, bestD] = [i, d];
  });
  return best;
}

// xterm's 256-colour palette: a 6x6x6 cube on levels 0,95,135,175,215,255
// (indices 16-231) and 24 greys 8,18,...,238 (232-255). Pick whichever of the
// nearest cube colour and the nearest grey is closer.
const CUBE = [0, 95, 135, 175, 215, 255];
const cubeIndex = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
const dist = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

export function to256(rgb) {
  const [ri, gi, bi] = rgb.map(cubeIndex);
  const cube = [CUBE[ri], CUBE[gi], CUBE[bi]];
  const avg = (rgb[0] + rgb[1] + rgb[2]) / 3;
  const greyIndex = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const grey = 8 + 10 * greyIndex;
  return dist(rgb, [grey, grey, grey]) < dist(rgb, cube) ? 232 + greyIndex : 16 + 36 * ri + 6 * gi + bi;
}

function colorCodes(color, depth, background) {
  if (color == null || depth === 0) return [];
  let index = COLORS[color];
  if (index === undefined) {
    const rgb = parseHex(color);
    if (!rgb) return [];
    if (depth >= 24) return [background ? 48 : 38, 2, ...rgb];
    if (depth >= 8) return [background ? 48 : 38, 5, to256(rgb)];
    index = nearest16(rgb);
  }
  if (depth >= 8 && index >= 8) return [background ? 48 : 38, 5, index];
  const base = index < 8 ? (background ? 40 : 30) : background ? 100 : 90;
  return [base + (index % 8)];
}

/** The SGR sequence that turns `style` on, or "" if it adds nothing at this depth. */
export function sgr(style, depth) {
  if (!style) return "";
  const codes = [];
  // Attributes still apply without colour (NO_COLOR only forbids colour).
  if (style.bold) codes.push(1);
  if (style.dim) codes.push(2);
  if (style.italic) codes.push(3);
  if (style.underline) codes.push(4);
  if (style.inverse) codes.push(7);
  if (style.strike) codes.push(9);
  codes.push(...colorCodes(style.fg, depth, false), ...colorCodes(style.bg, depth, true));
  return codes.length ? `\x1b[${codes.join(";")}m` : "";
}

// Cells share their span's style object, so the reference check is the usual path.
const sameStyle = (a, b) => a === b || JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

/** Joins adjacent spans with equal styles and drops empty ones. */
export function normalize(line) {
  const out = [];
  for (const span of line) {
    if (!span.text) continue;
    const last = out[out.length - 1];
    if (last && sameStyle(last.style, span.style)) last.text += span.text;
    else out.push(span.style ? { text: span.text, style: span.style } : { text: span.text });
  }
  return out;
}

/** One line to a string. Ends with RESET whenever it emitted any SGR. */
export function renderLine(line, depth) {
  let out = "";
  let styled = false;
  for (const span of line) {
    const on = sgr(span.style, depth);
    if (on) {
      out += (styled ? RESET : "") + on + span.text;
      styled = true;
    } else {
      out += (styled ? RESET : "") + span.text;
      styled = false;
    }
  }
  return styled ? out + RESET : out;
}

// Measured over the joined text: a cluster can straddle two spans.
export function lineWidth(line) {
  return stringWidth(line.map((span) => span.text).join(""));
}

/** Splits spans on "\n" into lines and expands tabs to the next 8-column stop. */
export function toLines(spans) {
  const lines = [[]];
  let col = 0;
  for (const span of spans) {
    const parts = String(span.text ?? "").split("\n");
    parts.forEach((part, i) => {
      if (i > 0) {
        lines.push([]);
        col = 0;
      }
      let text = "";
      for (const g of graphemes(part)) {
        if (g === "\t") {
          const n = TAB_STOP - (col % TAB_STOP);
          text += " ".repeat(n);
          col += n;
        } else {
          text += g;
          col += graphemeWidth(g);
        }
      }
      if (text) lines[lines.length - 1].push(span.style ? { text, style: span.style } : { text });
    });
  }
  return lines;
}

// One cell per grapheme of the joined text, styled by the span it starts in,
// so a cluster split across spans is measured once, whole.
function cellsOf(line) {
  const spans = normalize(line);
  const starts = [];
  let text = "";
  for (const span of spans) {
    starts.push(text.length);
    text += span.text;
  }
  const cells = [];
  let si = 0;
  for (const { segment, index } of graphemeSegments(text)) {
    while (si + 1 < spans.length && starts[si + 1] <= index) si++;
    cells.push({ g: segment, style: spans[si].style, w: graphemeWidth(segment) });
  }
  return cells;
}

function cellsToLine(cells) {
  return normalize(cells.map((c) => (c.style ? { text: c.g, style: c.style } : { text: c.g })));
}

const isSpace = (g) => g === " ";

/**
 * Word-wraps spans to `width` columns. Newlines start new lines; words longer
 * than a line break at grapheme boundaries; spaces at a wrap point are dropped,
 * but leading indentation of each source line is kept. A wide grapheme never
 * straddles the edge. Returns an array of lines (each an array of spans).
 */
export function wrap(spans, width) {
  if (!(width >= 1)) throw new RangeError(`wrap: width must be >= 1, got ${width}`);
  const out = [];
  for (const source of toLines(spans)) {
    const cells = cellsOf(source);
    if (cells.length === 0) {
      out.push([]);
      continue;
    }
    let line = [];
    let col = 0;
    let i = 0;
    let atSourceStart = true;
    while (i < cells.length) {
      if (isSpace(cells[i].g)) {
        let j = i;
        while (j < cells.length && isSpace(cells[j].g)) j++;
        const run = cells.slice(i, j);
        const runW = run.length;
        if (atSourceStart || col + runW < width) {
          // Indentation, or spaces between words that leave room on this line.
          const room = width - col;
          line.push(...run.slice(0, Math.max(0, Math.min(runW, room))));
          col += Math.min(runW, room);
        } else if (j < cells.length) {
          // The spaces reach the edge: wrap here and drop them.
          out.push(cellsToLine(line));
          line = [];
          col = 0;
        }
        i = j;
        atSourceStart = false;
        continue;
      }
      atSourceStart = false;
      let j = i;
      let wordW = 0;
      while (j < cells.length && !isSpace(cells[j].g)) wordW += cells[j++].w;
      const word = cells.slice(i, j);
      if (col + wordW <= width) {
        // A loop, not push(...word): a long zero-width run would overflow the stack.
        for (const cell of word) line.push(cell);
        col += wordW;
      } else {
        // A word that fits a fresh line moves there, unless this line holds
        // only indentation: then it hard-breaks here and keeps the indent.
        const onlyIndent = line.every((c) => isSpace(c.g));
        if (wordW <= width && col > 0 && !onlyIndent) {
          trimTrailingSpaces(line);
          out.push(cellsToLine(line));
          line = [];
          col = 0;
        }
        for (const cell of word) {
          if (col + cell.w > width && col > 0) {
            trimTrailingSpaces(line);
            if (line.length) out.push(cellsToLine(line));
            line = [];
            col = 0;
          }
          line.push(cell);
          col += cell.w;
        }
      }
      i = j;
    }
    trimTrailingSpaces(line);
    out.push(cellsToLine(line));
  }
  return out;
}

function trimTrailingSpaces(cells) {
  while (cells.length && isSpace(cells[cells.length - 1].g)) cells.pop();
}

/**
 * Cuts a line to at most `width` columns, ending in `ellipsis` when anything
 * was cut. Tabs and newlines must already be gone (see toLines).
 */
export function truncate(line, width, ellipsis = "…") {
  if (lineWidth(line) <= width) return normalize(line);
  const ew = stringWidth(ellipsis);
  if (width < ew) return [];
  const cells = cellsOf(line);
  const kept = [];
  let col = 0;
  for (const cell of cells) {
    if (col + cell.w > width - ew) break;
    kept.push(cell);
    col += cell.w;
  }
  const last = kept[kept.length - 1];
  return normalize([...cellsToLine(kept), last?.style ? { text: ellipsis, style: last.style } : { text: ellipsis }]);
}

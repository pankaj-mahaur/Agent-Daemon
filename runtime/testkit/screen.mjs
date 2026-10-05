// Test terminals for the inline renderer (plan Part 1c): each gives the
// renderer an `io`, answers CPR, can be resized, and exposes the screen plus
// scrollback as plain text.
//
//   xtermScreen({cols, rows})   real xterm.js (headless + unicode11): reflows
//                               rows on resize, like Windows Terminal and Zed
//   modelScreen({cols, rows})   a minimal VT model that never reflows: rows are
//                               clipped on shrink, as in terminals without reflow
//
// Both: {io, resizeSource, resize(cols, rows), settle(), lines(), visible(), cursor()};
// cprDelayMs delays CPR answers, to expose races with the renderer's awaits.

import { EventEmitter } from "node:events";
import xtermHeadless from "@xterm/headless";
import unicode11 from "@xterm/addon-unicode11";
import { graphemes, graphemeWidth } from "../src/tui/terminal/width.mjs";

const { Terminal } = xtermHeadless;
const { Unicode11Addon } = unicode11;

function trimBlank(rows) {
  const out = rows.map((r) => r.replace(/\s+$/, ""));
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

function makeIo({ write, size, caps }) {
  const pending = [];
  return {
    pending,
    io: {
      caps,
      write,
      size,
      cpr() {
        return new Promise((resolve) => {
          pending.push(resolve);
          write("\x1b[6n");
        });
      },
    },
  };
}

export function xtermScreen({ cols = 40, rows = 10, sync = true, scrollback = 1000, cprDelayMs = 0 } = {}) {
  const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  const resizeSource = new EventEmitter();
  let chain = Promise.resolve();
  const writes = [];
  const { io, pending } = makeIo({
    caps: { sync },
    size: () => ({ cols: term.cols, rows: term.rows }),
    write: (s) => {
      writes.push(s);
      chain = chain.then(() => new Promise((r) => term.write(s, r)));
    },
  });
  term.onData((d) => {
    const m = /^\x1b\[(\d+);(\d+)R$/.exec(d);
    if (!m) return;
    const answer = { row: Number(m[1]), col: Number(m[2]) };
    const resolve = pending.shift();
    if (cprDelayMs) setTimeout(() => resolve?.(answer), cprDelayMs);
    else resolve?.(answer);
  });
  return {
    kind: "xterm",
    term,
    io,
    writes,
    resizeSource,
    resize(c, r) {
      term.resize(c, r);
      resizeSource.emit("resize");
    },
    async settle() {
      for (let i = 0; i < 5; i++) {
        await chain;
        await new Promise((r) => setImmediate(r));
      }
    },
    lines() {
      const b = term.buffer.active;
      const rows2 = [];
      for (let i = 0; i < b.length; i++) rows2.push(b.getLine(i).translateToString(true));
      return trimBlank(rows2);
    },
    /** Only the rows in the viewport (not scrollback), trailing blanks trimmed. */
    visible() {
      const b = term.buffer.active;
      const rows2 = [];
      for (let i = b.viewportY; i < b.viewportY + term.rows; i++) rows2.push(b.getLine(i)?.translateToString(true) ?? "");
      return trimBlank(rows2);
    },
    cursor() {
      const b = term.buffer.active;
      return { row: b.baseY + b.cursorY, col: b.cursorX };
    },
    feed(s) {
      io.write(s);
    },
  };
}

// ---------------------------------------------------------------------------
// A minimal VT model without reflow. Supports what the renderer emits:
// printable text (cell widths from width.mjs), \r, \n, CSI A B C H J K m 6n,
// ?7h/l, ?2026h/l, ?25h/l. Scrolls into a scrollback on \n at the bottom.

export function modelScreen({ cols = 40, rows = 10, sync = true, cprDelayMs = 0 } = {}) {
  let C = cols;
  let R = rows;
  const scroll = []; // rows that left the top
  let screen = Array.from({ length: R }, () => []);
  let x = 0;
  let y = 0;
  let autowrap = true;
  let pendingWrap = false;
  const resizeSource = new EventEmitter();
  const writes = [];
  let replies = [];

  const blankRow = () => [];
  const lineFeed = () => {
    if (y === R - 1) {
      scroll.push(screen.shift());
      screen.push(blankRow());
    } else y++;
  };
  const put = (g, w) => {
    if (pendingWrap && autowrap) {
      x = 0;
      lineFeed();
    }
    pendingWrap = false;
    const row = screen[y];
    if (x + w > C) {
      if (!autowrap) x = C - w; // overwrite the last cell(s)
    }
    row[x] = g;
    for (let k = 1; k < w; k++) row[x + k] = "";
    if (x + w >= C) {
      x = C - 1;
      pendingWrap = true;
    } else x += w;
  };

  function run(s) {
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "\x1b" && s[i + 1] === "[") {
        const m = /^\x1b\[([\x30-\x3f]*)([\x20-\x2f]*)([\x40-\x7e])/.exec(s.slice(i));
        i += m[0].length;
        const [, params, , final] = m;
        const priv = params.startsWith("?");
        const nums = params.replace("?", "").split(";").map((n) => (n === "" ? undefined : Number(n)));
        const n = nums[0] ?? 1;
        pendingWrap = false;
        if (priv) {
          if (params === "?7") autowrap = final === "h";
          continue;
        }
        if (final === "A") y = Math.max(0, y - n);
        else if (final === "B") y = Math.min(R - 1, y + n);
        else if (final === "C") x = Math.min(C - 1, x + n);
        else if (final === "H") {
          y = Math.min(R - 1, (nums[0] ?? 1) - 1);
          x = Math.min(C - 1, (nums[1] ?? 1) - 1);
        } else if (final === "K") screen[y].length = Math.min(screen[y].length, x);
        else if (final === "J") {
          screen[y].length = Math.min(screen[y].length, x);
          for (let k = y + 1; k < R; k++) screen[k] = blankRow();
        } else if (final === "n" && n === 6) replies.push({ row: y + 1, col: x + 1 });
        continue;
      }
      if (ch === "\r") {
        x = 0;
        pendingWrap = false;
        i++;
        continue;
      }
      if (ch === "\n") {
        pendingWrap = false;
        lineFeed();
        i++;
        continue;
      }
      // One grapheme of text.
      const g = graphemes(s.slice(i, i + 16))[0];
      put(g, Math.max(1, graphemeWidth(g)));
      i += g.length;
    }
  }

  const pending = [];
  const io = {
    caps: { sync },
    size: () => ({ cols: C, rows: R }),
    write: (s) => {
      writes.push(s);
      run(s);
      for (const r of replies.splice(0)) {
        const resolve = pending.shift();
        if (cprDelayMs) setTimeout(() => resolve?.(r), cprDelayMs);
        else resolve?.(r);
      }
    },
    cpr() {
      return new Promise((resolve) => {
        pending.push(resolve);
        io.write("\x1b[6n");
      });
    },
  };

  return {
    kind: "model",
    io,
    writes,
    resizeSource,
    resize(c, r) {
      // No reflow: rows are clipped to the new width (content is lost).
      for (const row of [...scroll, ...screen]) row.length = Math.min(row.length, c);
      // Height: keep the cursor row visible, pushing rows into scrollback.
      while (screen.length > r) {
        if (y > 0 && y >= r) {
          scroll.push(screen.shift());
          y--;
        } else screen.pop();
      }
      while (screen.length < r) screen.push(blankRow());
      C = c;
      R = r;
      x = Math.min(x, C - 1);
      resizeSource.emit("resize");
    },
    async settle() {
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    },
    lines() {
      return trimBlank([...scroll, ...screen].map((row) => Array.from(row, (c) => c ?? " ").join("")));
    },
    visible() {
      return trimBlank(screen.map((row) => Array.from(row, (c) => c ?? " ").join("")));
    },
    cursor() {
      return { row: scroll.length + y, col: x };
    },
    feed(s) {
      io.write(s);
    },
  };
}

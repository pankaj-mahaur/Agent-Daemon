// Inline renderer (plan Part 1c). History goes into the terminal's own
// scrollback and is never repainted; only the live region at the bottom
// (at most rows − 1 lines) is redrawn.
//
// createRenderer({io, caps, depth, reflow, resizeSource, now, setTimeout, clearTimeout})
//   start()                 anchor at the cursor (CPR); call once after io.enter()
//   frame({lines, cursor})  draw the live region; lines are span arrays (text.mjs)
//                           or plain strings, cursor {row, col} is where to park
//   commit(lines)           write history lines above the live region
//   suspend() / resume()    erase the live region for a handoff, then re-anchor
//   redraw()                Ctrl+L: re-anchor by CPR and redraw the live region
//   onResize(fn)            called after a resize has been handled (re-layout)
//
// Terminal rules (research/terminal-engineering.md):
//   - never ESC[2J / ESC[3J; history above the live top is never erased
//   - every write runs with autowrap off (?7l), and every line is cut to
//     cols − 1, so a line is exactly one row whatever the width tables say
//   - a cursor move with count 0 is never sent (ESC[0A moves one row)
//   - ESC[0m before every ESC[K / ESC[J / \r\n
//   - one write() per frame, inside ?2026 when the terminal supports it;
//     without it, commits are batched at least 150 ms apart
//   - resize: pause, wait 75 ms of quiet, re-anchor by CPR with the terminal's
//     reflow model, redraw

import { renderLine, truncate } from "./text.mjs";
import { graphemes, graphemeWidth } from "./width.mjs";

// Blocks every terminal has drawn two cells wide for decades (CJK, kana,
// Hangul syllables, fullwidth forms). Newer wide code points (recent emoji)
// may be drawn one cell wide by terminals with older tables.
const STABLE_WIDE = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6],
];

/** The fewest cells any terminal draws for this line (for the reflow lower bound). */
export function minCells(line) {
  let n = 0;
  for (const span of line) {
    for (const g of graphemes(span.text)) {
      if (graphemeWidth(g) === 0) continue;
      const cp = g.codePointAt(0);
      n += STABLE_WIDE.some(([a, b]) => cp >= a && cp <= b) ? 2 : 1;
    }
  }
  return n;
}

const CSI = "\x1b[";
const RESET = `${CSI}0m`;
const EOL = `${RESET}${CSI}K`;
const AUTOWRAP_OFF = `${CSI}?7l`;
const AUTOWRAP_ON = `${CSI}?7h`;
const SYNC_ON = `${CSI}?2026h`;
const SYNC_OFF = `${CSI}?2026l`;

const up = (n) => (n > 0 ? `${CSI}${n}A` : "");
const down = (n) => (n > 0 ? `${CSI}${n}B` : "");
const right = (n) => (n > 0 ? `${CSI}${n}C` : "");

export const RESIZE_QUIET_MS = 75;
export const COMMIT_BATCH_MS = 150;

export function createRenderer({
  io,
  caps = io.caps ?? {},
  depth = 0,
  reflow = "unknown", // "reflow" | "none" | "unknown" (per terminal, from S1b)
  resizeSource = null,
  now = () => Date.now(),
  setTimeout: setT = setTimeout,
  clearTimeout: clearT = clearTimeout,
} = {}) {
  let started = false;
  let paused = false; // resize in progress or suspended
  let suspended = false;
  let current = { lines: [], cursor: { row: 0, col: 0 } };
  let prev = []; // rendered strings of the live rows on screen
  let cursorRow = 0; // where the cursor is parked, as a row of the live region
  let cursorCol = 0;
  let prevMinWidths = []; // lower bounds of what the terminal drew (reflow estimate)
  let queued = []; // history lines waiting to be committed
  let lastCommitAt = -Infinity;
  let commitTimer = null;
  let resizeTimer = null;
  // Bumped by every resize, redraw and suspend. A re-anchor that finds the
  // generation changed after its CPR await writes nothing: its geometry is stale.
  let generation = 0;
  const resizeListeners = new Set();

  const size = () => io.size();
  const wrapSync = (s) => (caps.sync ? SYNC_ON + s + SYNC_OFF : s);

  function toLine(line) {
    return typeof line === "string" ? [{ text: line }] : line;
  }

  function renderRows(lines, cols) {
    const max = Math.max(1, cols - 1);
    const cut = lines.map((l) => truncate(toLine(l), max));
    return { strings: cut.map((l) => renderLine(l, depth)), widths: cut.map(minCells) };
  }

  // The visible part of the live frame: at most rows − 1 lines, bottom kept.
  function clampFrame() {
    const { rows } = size();
    const maxLive = Math.max(1, rows - 1);
    let { lines } = current;
    let row = current.cursor?.row ?? Math.max(0, lines.length - 1);
    const col = current.cursor?.col ?? 0;
    if (lines.length > maxLive) {
      const drop = lines.length - maxLive;
      lines = lines.slice(drop);
      row -= drop;
    }
    row = Math.max(0, Math.min(row, Math.max(0, lines.length - 1)));
    return { lines, row, col };
  }

  const toTop = () => "\r" + up(cursorRow);

  function park(at, row, col, cols) {
    const c = Math.max(0, Math.min(col, cols - 1));
    return up(at - row) + down(row - at) + "\r" + right(c);
  }

  // Draws the whole live frame from the current cursor position, which must be
  // column 1 of the live top. Returns the escape string; updates state.
  function fullLive(cols) {
    const { lines, row, col } = clampFrame();
    const { strings, widths } = renderRows(lines, cols);
    let out = strings.map((s) => s + EOL).join("\r\n");
    out += `${RESET}${CSI}J`;
    const at = Math.max(0, strings.length - 1);
    out += park(at, row, col, cols);
    prev = strings;
    prevMinWidths = widths;
    cursorRow = strings.length ? row : 0;
    cursorCol = Math.max(0, Math.min(col, cols - 1));
    return out;
  }

  function drawFrame() {
    const { cols } = size();
    const { lines, row, col } = clampFrame();
    const { strings, widths } = renderRows(lines, cols);
    let f = 0;
    while (f < strings.length && f < prev.length && strings[f] === prev[f]) f++;
    const changed = f < strings.length || strings.length !== prev.length;
    const parkCol = Math.max(0, Math.min(col, cols - 1));
    if (!changed && row === cursorRow && parkCol === cursorCol) return;

    let out = toTop() + AUTOWRAP_OFF;
    let at = 0;
    if (changed) {
      if (f < prev.length) {
        out += down(f);
        at = f;
      } else if (prev.length > 0) {
        // Appending below the last drawn row: \r\n may scroll, which is fine.
        out += down(prev.length - 1) + RESET + "\r\n";
        at = prev.length;
      }
      if (f < strings.length) {
        out += strings.slice(f).map((s) => s + EOL).join("\r\n");
        at = strings.length - 1;
      }
      if (strings.length < prev.length) out += `${RESET}${CSI}J`;
    }
    out += park(at, strings.length ? row : 0, col, cols) + AUTOWRAP_ON;
    io.write(wrapSync(out));
    prev = strings;
    prevMinWidths = widths;
    cursorRow = strings.length ? row : 0;
    cursorCol = parkCol;
  }

  function doCommit(history) {
    const { cols } = size();
    const { strings } = renderRows(history, cols);
    let out = toTop() + AUTOWRAP_OFF;
    for (const s of strings) out += s + EOL + "\r\n";
    out += fullLive(cols) + AUTOWRAP_ON;
    io.write(wrapSync(out));
    lastCommitAt = now();
  }

  function flushCommits() {
    if (commitTimer) clearT(commitTimer);
    commitTimer = null;
    if (!queued.length || paused || !started) return;
    const batch = queued;
    queued = [];
    doCommit(batch);
  }

  /**
   * Rows between the live top and the cursor after a resize to `newCols`. A
   * LOWER bound: everything from the live top down is erased, so counting one
   * row too many erases a history row, while one too few only leaves a ghost
   * row (accepted). Live rows above the cursor re-wrap on a reflowing terminal
   * (counted from a minimum of what was drawn); the cursor's own row doesn't
   * (xterm.js keeps the cursor on its row and clamps the column).
   */
  function rowsAboveCursor(newCols, kind) {
    if (kind !== "resize" || reflow !== "reflow") return cursorRow;
    let p = 0;
    for (let i = 0; i < cursorRow; i++) p += Math.max(1, Math.ceil((prevMinWidths[i] ?? 0) / newCols));
    return p;
  }

  async function reanchor(kind) {
    const mine = ++generation;
    paused = true;
    // (Never called while suspended: suspend() cancels a pending resize and
    // redraw() returns while paused. A CPR query then would reach the child.)
    const pos = await io.cpr();
    // A newer resize, redraw or suspend happened meanwhile: this geometry is stale.
    if (mine !== generation || suspended) return false;
    const { cols } = size();
    const p = rowsAboveCursor(cols, kind);
    let out;
    if (pos) {
      const liveTop = Math.max(1, pos.row - p);
      out = `${CSI}${liveTop};1H${RESET}${CSI}J`;
    } else {
      // No CPR answer: move relatively, as well as we can.
      out = "\r" + up(p) + `${RESET}${CSI}J`;
    }
    prev = [];
    prevMinWidths = [];
    cursorRow = 0;
    const history = queued;
    queued = [];
    out += AUTOWRAP_OFF;
    for (const s of renderRows(history, cols).strings) out += s + EOL + "\r\n";
    out += fullLive(cols) + AUTOWRAP_ON;
    io.write(wrapSync(out));
    if (history.length) lastCommitAt = now();
    // A resize arriving during the await would have made this run stale, so
    // nothing else is pending here.
    paused = false;
    return true;
  }

  function onResizeSignal() {
    if (!started || suspended) return;
    generation++; // a re-anchor waiting for CPR now has stale geometry
    paused = true;
    if (resizeTimer) clearT(resizeTimer);
    resizeTimer = setT(async () => {
      resizeTimer = null;
      if (await reanchor("resize")) for (const fn of resizeListeners) fn(size());
    }, RESIZE_QUIET_MS);
  }
  resizeSource?.on?.("resize", onResizeSignal);

  return {
    async start() {
      if (started) return;
      const pos = await io.cpr();
      // Not at column 1 (a prompt without a newline): start on a fresh row.
      if (pos && pos.col !== 1) io.write(RESET + "\r\n");
      started = true;
      prev = [];
      cursorRow = 0;
      const history = queued;
      queued = [];
      if (history.length) doCommit(history);
      else if (current.lines.length) drawFrame();
    },
    frame({ lines = [], cursor } = {}) {
      current = { lines, cursor: cursor ?? { row: Math.max(0, lines.length - 1), col: 0 } };
      if (!started || paused) return;
      drawFrame();
    },
    commit(lines) {
      if (!lines?.length) return;
      queued.push(...lines);
      if (!started || paused) return;
      const wait = caps.sync ? 0 : lastCommitAt + COMMIT_BATCH_MS - now();
      if (wait <= 0) flushCommits();
      else if (!commitTimer) commitTimer = setT(flushCommits, wait);
    },
    suspend() {
      if (!started || suspended) return;
      generation++; // cancels a re-anchor waiting for CPR
      if (commitTimer) clearT(commitTimer);
      commitTimer = null;
      if (resizeTimer) clearT(resizeTimer);
      resizeTimer = null;
      // Commits still waiting go out now, so they land above the child's output.
      const history = queued;
      queued = [];
      const { cols } = size();
      let out = toTop() + AUTOWRAP_OFF;
      for (const s of renderRows(history, cols).strings) out += s + EOL + "\r\n";
      out += `${RESET}${CSI}J` + AUTOWRAP_ON;
      io.write(wrapSync(out));
      suspended = true;
      paused = true;
      prev = [];
      cursorRow = 0;
    },
    async resume() {
      if (!suspended) return;
      suspended = false;
      paused = false;
      started = false;
      await this.start();
      if (!prev.length && current.lines.length) drawFrame();
    },
    async redraw() {
      if (!started || paused) return; // a resize re-anchors anyway
      await reanchor("redraw");
    },
    onResize(fn) {
      resizeListeners.add(fn);
      return () => resizeListeners.delete(fn);
    },
    dispose() {
      resizeSource?.off?.("resize", onResizeSignal);
      if (commitTimer) clearT(commitTimer);
      if (resizeTimer) clearT(resizeTimer);
    },
    get state() {
      return { started, paused, suspended, rows: prev.length, cursorRow, queued: queued.length };
    },
  };
}

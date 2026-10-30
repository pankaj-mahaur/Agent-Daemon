// Fullscreen renderer (plan P2.1): ad draws the whole alternate screen, the
// transcript from the top and the live region on the bottom rows, and the
// shell's screen comes back exactly as it was on exit.
//
// createFullscreenRenderer({io, caps, depth, hyperlinks, resizeSource, mouse,
//   contentWidth, stderr, stderrSink, transcript, setTimeout, clearTimeout})
//   → the inline renderer's interface (start, frame, commit, suspend, resume,
//     redraw, clear, onResize, dispose, state) plus fullscreen: true,
//     settle(key, render) and terminalWrite(bytes)
//
// Rules:
//   - every write goes through io.writeSync (synchronous, ordered with io's
//     restore) and through one gate, writable(): nothing reaches the terminal
//     while suspended, paused for a resize, disposed, or after the guard was
//     released elsewhere (io.restore on a crash). Blocked draws mark the
//     screen dirty; the next one repaints it whole.
//   - only changed rows are rewritten, one write per frame, inside ?2026 when
//     the terminal supports it, autowrap off, every row cut to cols − 1; an
//     idle frame writes nothing
//   - never CSI 3J: it would wipe the shell's scrollback (2J only clears the
//     alternate screen)
//   - stderr is held while the alternate screen is up (it would land on top of
//     the frame), handed to stderrSink, and written out on leaving

import { enterAltScreen, isActive, onRelease, releaseAltScreen } from "./alt-screen.mjs";
import { COMMIT_BATCH_MS, RESIZE_QUIET_MS } from "./renderer.mjs";
import { renderLine, restyle, truncate } from "./text.mjs";
import { createTranscript } from "./transcript.mjs";
import { stringWidth } from "./width.mjs";

const CSI = "\x1b[";
const SYNC_BATCH_MS = 16;
const STDERR_HOLD_MAX = 64 * 1024;
const asLine = (line) => (typeof line === "string" ? [{ text: line }] : line);

// The engine's follow control texts (0.163 follow_control.rs), widest first.
const FOLLOW_TEXTS = {
  true: [" New activity \u{b7} \u{2193} Back to bottom \u{b7} esc ", " New activity \u{b7} \u{2193} Bottom ", " New \u{b7} \u{2193} Bottom ", " \u{2193} Bottom ", " \u{2193} "],
  false: [" \u{2193} Back to bottom \u{b7} esc ", " \u{2193} Back to bottom ", " \u{2193} Bottom \u{b7} esc ", " \u{2193} Bottom ", " \u{2193} "],
};

/** The widest follow-control text that fits in `cols − 1` cells. */
export function followText(cols, newActivity) {
  const list = FOLLOW_TEXTS[Boolean(newActivity)];
  return list.find((t) => stringWidth(t) <= cols - 1) ?? list.at(-1);
}

export function createFullscreenRenderer({
  io,
  caps = io.caps ?? {},
  depth = 0,
  hyperlinks = false,
  resizeSource = null,
  mouse = true,
  contentWidth = (cols) => Math.max(10, cols - 2),
  stderr = process.stderr,
  stderrSink = null,
  transcript = createTranscript(),
  setTimeout: setT = setTimeout,
  clearTimeout: clearT = clearTimeout,
} = {}) {
  let started = false;
  let suspended = false;
  let paused = false; // a resize waiting for quiet
  let disposed = false;
  let dirty = false;
  let current = { lines: [], cursor: { row: 0, col: 0 } };
  let prev = []; // the rendered rows on screen
  let parked = null; // where the cursor was left, "row;col"
  let drawTimer = null;
  let resizeTimer = null;
  let pendingBytes = [];
  let offRelease = null;
  let areaHeight = null; // the transcript's rows at the last draw
  let controlRow = -1; // the follow control's screen row, or -1
  let shownRefs = []; // {entryId, row} per transcript screen row at the last draw
  let marks = null; // (ref) → [[fromCol, toCol, style], …]: what to highlight
  const resizeListeners = new Set();

  const writable = () => started && !disposed && !suspended && !paused && isActive();

  // ---- stderr while the alternate screen is up ----
  let stderrWrite = null;
  let held = [];
  let heldSize = 0;
  function holdStderr() {
    if (!stderr || stderrWrite) return;
    stderrWrite = stderr.write;
    stderr.write = (chunk, enc, cb) => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      if (heldSize < STDERR_HOLD_MAX) {
        held.push(text);
        heldSize += text.length;
      }
      try {
        stderrSink?.(text);
      } catch {
        // The sink is a notice; losing one must not break the caller's write.
      }
      dirty = true; // text that reached the screen anyway is painted over
      (typeof enc === "function" ? enc : cb)?.();
      return true;
    };
  }
  function releaseStderr() {
    if (!stderrWrite) return;
    stderr.write = stderrWrite;
    stderrWrite = null;
    const text = held.join("");
    held = [];
    heldSize = 0;
    if (text) {
      try {
        stderr.write(text);
      } catch {
        // stderr is gone: nothing to tell.
      }
    }
  }

  function draw({ full = false } = {}) {
    if (!writable()) {
      dirty = true;
      return;
    }
    if (dirty) full = true;
    dirty = false;
    const { cols, rows } = io.size();
    const lines = current.lines.map(asLine);
    const live = lines.length > rows - 1 ? lines.slice(lines.length - (rows - 1)) : lines;
    const cut = lines.length - live.length;
    const top = rows - live.length;
    areaHeight = top;
    // Scrolled up: the last transcript row is the follow control (window() may
    // find the end in view and follow again, so ask it first).
    let win = transcript.following ? null : transcript.window({ width: contentWidth(cols), height: Math.max(0, top - 1) });
    const control = !transcript.following && top > 0;
    if (!control) win = transcript.window({ width: contentWidth(cols), height: top });
    const next = [];
    shownRefs = [];
    for (let r = 0; r < (control ? top - 1 : top); r++) {
      const ref = win.refs?.[r] ?? null;
      let row = win.rows[r] ?? [];
      // Highlights (a selection, Find's matches) as [fromCol, toCol, style] per row.
      for (const [c0, c1, style] of (ref && marks?.(ref)) || []) row = restyle(row, c0, c1, style);
      next.push(row);
      shownRefs.push(ref);
    }
    if (control) next.push([{ text: followText(cols, transcript.newActivity), style: { dim: true } }]);
    controlRow = control ? top - 1 : -1;
    next.push(...live);
    const strings = next.map((l) => renderLine(truncate(l, cols - 1), depth, { hyperlinks }));
    let out = "";
    if (full) {
      out += `${CSI}H${CSI}2J`;
      prev = [];
    }
    for (let r = 0; r < strings.length; r++) {
      if (strings[r] !== prev[r]) out += `${CSI}${r + 1};1H${strings[r]}${CSI}0m${CSI}K`;
    }
    const crow = Math.min(rows - 1, Math.max(0, top + (current.cursor?.row ?? 0) - cut));
    const ccol = Math.max(0, Math.min(cols - 1, current.cursor?.col ?? 0));
    const at = `${crow};${ccol}`;
    if (!out && at === parked) return;
    out += `${CSI}${crow + 1};${ccol + 1}H`;
    io.writeSync((caps.sync ? `${CSI}?2026h` : "") + `${CSI}?7l` + out + `${CSI}?7h` + (caps.sync ? `${CSI}?2026l` : ""));
    prev = strings;
    parked = at;
  }

  function scheduleDraw() {
    if (drawTimer || disposed) return;
    drawTimer = setT(() => {
      drawTimer = null;
      draw();
    }, caps.sync ? SYNC_BATCH_MS : COMMIT_BATCH_MS);
  }

  function flushBytes() {
    if (!writable()) return;
    for (const b of pendingBytes.splice(0)) io.writeSync(b);
  }

  function onResizeSignal() {
    if (disposed) return;
    paused = true;
    if (resizeTimer) clearT(resizeTimer);
    resizeTimer = setT(() => {
      resizeTimer = null;
      paused = false;
      const size = io.size();
      transcript.layout(contentWidth(size.cols));
      for (const fn of resizeListeners) fn(size);
      draw({ full: true });
    }, RESIZE_QUIET_MS);
  }

  function cancelTimers() {
    if (drawTimer) clearT(drawTimer);
    if (resizeTimer) clearT(resizeTimer);
    drawTimer = resizeTimer = null;
    paused = false;
  }

  function enter() {
    enterAltScreen(io.writeSync, { mouse });
    holdStderr();
    prev = [];
    parked = null;
  }

  // The transcript area's height: rows above the live region (the app keeps it ≤ rows − 1).
  const height = () => areaHeight ?? Math.max(1, io.size().rows - Math.min(current.lines.length, io.size().rows - 1));
  const view = (fn) => {
    if (disposed) return;
    fn();
    draw();
  };
  const transcriptHandle = {
    scroll: (rows) => view(() => transcript.scroll(rows, { width: contentWidth(io.size().cols), height: height() })),
    jumpTop: () => view(() => transcript.jumpTop()),
    jumpLatest: () => view(() => transcript.jumpLatest()),
    get following() {
      return transcript.following;
    },
    get newActivity() {
      return transcript.newActivity;
    },
    get height() {
      return height();
    },
    /** What screen row y shows: "control", {entryId, row} of the transcript, or null (the live region). */
    rowAt: (y) => (y === controlRow ? "control" : shownRefs[y] ?? null),
    /** The transcript screen row that shows `ref`, or -1. */
    yOf: (ref) => shownRefs.findIndex((r) => r && r.entryId === ref.entryId && r.row === ref.row),
    hold: () => transcript.hold({ width: contentWidth(io.size().cols), height: height() }),
    entriesBetween: (a, b) => transcript.entriesBetween(a, b, contentWidth(io.size().cols)),
    /** Sets what to highlight: (ref) → [[fromCol, toCol, style], …], or null. */
    setMarks: (fn) => view(() => (marks = fn)),
    allEntries: () => transcript.allEntries(contentWidth(io.size().cols)),
    reveal: (ref) => view(() => transcript.reveal(ref, { width: contentWidth(io.size().cols), height: height() })),
    getView: () => transcript.getView(),
    setView: (v) => view(() => transcript.setView(v)),
  };

  return {
    fullscreen: true,
    transcript: transcriptHandle,
    start() {
      if (started || disposed) return;
      if (!io.entered) throw new Error("the fullscreen renderer needs io entered first (its exit hooks must be live before ?1049h)");
      offRelease = onRelease(releaseStderr);
      resizeSource?.on?.("resize", onResizeSignal);
      started = true;
      enter();
      draw({ full: true });
    },
    frame({ lines = [], cursor } = {}) {
      if (disposed) return;
      current = { lines, cursor: cursor ?? { row: Math.max(0, lines.length - 1), col: 0 } };
      draw();
    },
    commit(lines, { render, key } = {}) {
      if (disposed || (!render && !lines?.length)) return;
      transcript.append(render ? { render, key } : { lines: lines.map(asLine), key });
      scheduleDraw();
    },
    settle(key, render) {
      if (disposed) return;
      transcript.settle(key, render);
      scheduleDraw();
    },
    terminalWrite(bytes) {
      if (disposed) return;
      if (writable()) io.writeSync(bytes);
      else pendingBytes.push(bytes);
    },
    suspend() {
      if (!started || suspended || disposed) return;
      cancelTimers();
      suspended = true;
      releaseAltScreen(io.writeSync);
    },
    resume() {
      if (!suspended || disposed) return;
      suspended = false;
      enter();
      draw({ full: true });
      flushBytes();
    },
    redraw() {
      draw({ full: true });
    },
    /** /clear: the transcript starts over with `header`. → false when there's no screen to clear. */
    clear(header = []) {
      if (!started || suspended || disposed) return false;
      transcript.clear();
      if (header.length) transcript.append({ lines: header.map(asLine) });
      draw({ full: true });
      return true;
    },
    onResize(fn) {
      resizeListeners.add(fn);
      return () => resizeListeners.delete(fn);
    },
    dispose() {
      if (disposed) return;
      resizeSource?.off?.("resize", onResizeSignal);
      cancelTimers();
      // After a crash-path release the guard is already inactive: nothing to write.
      if (started && !suspended) releaseAltScreen(io.writeSync);
      releaseStderr();
      offRelease?.();
      disposed = true;
    },
    get state() {
      return { started, paused, suspended, disposed, rows: prev.length, entries: transcript.size() };
    },
  };
}

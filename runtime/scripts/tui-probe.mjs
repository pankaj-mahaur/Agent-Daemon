#!/usr/bin/env node
// Terminal probe for the `ad` terminal UI — what does THIS terminal send and do?
//
//   node runtime/scripts/tui-probe.mjs keys     every key/paste as raw bytes + a best-effort name
//   node runtime/scripts/tui-probe.mjs screen   wrap, autowrap-off, sync output, resize reflow
//   node runtime/scripts/tui-probe.mjs screen --bottom
//                                               the same with the live region flush with the
//                                               bottom of the window (narrowing ghosts, plan Part 7)
//
// Quit: type qqq, or press Ctrl+C three times in a row (single Ctrl+C presses
// are shown, since they are part of what is being probed).
//
// Results also go to ~/.agent-daemon/logs/tui-probe-<mode>-<time>.log so they can
// be attached to a bug report. It changes nothing but this terminal's modes, and
// restores them on every exit path.

import { appendFileSync, mkdirSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const mode = process.argv[2];
if (mode !== "keys" && mode !== "screen") {
  console.error("usage: node tui-probe.mjs keys|screen");
  process.exit(2);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("tui-probe needs an interactive terminal (stdin and stdout must be TTYs).");
  process.exit(1);
}

const logDir = join(homedir(), ".agent-daemon", "logs");
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, `tui-probe-${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
const log = (line) => appendFileSync(logFile, line + "\n");
const out = (line) => { process.stdout.write(line + "\r\n"); log(line); };

const [major, minor] = process.versions.node.split(".").map(Number);
// The VT-input concern is Windows-only: POSIX raw mode always passes the terminal's bytes through.
const vtInput = process.platform !== "win32" || (major === 22 && minor >= 17) || (major === 24 && minor >= 2) || major >= 25;
out(`tui-probe ${mode} · node ${process.version} · ${process.platform} · ${process.stdout.columns}x${process.stdout.rows}`);
out(`TERM=${process.env.TERM ?? "-"} TERM_PROGRAM=${process.env.TERM_PROGRAM ?? "-"} WT_SESSION=${process.env.WT_SESSION ? "set" : "-"} COLORTERM=${process.env.COLORTERM ?? "-"}`);
out(`raw mode: ${vtInput ? "VT input (bracketed paste, CSI-u possible)" : "LEGACY (Node < 22.17 on Windows: no paste markers, Shift+Tab = Tab)"}`);

const hex = (s) => [...Buffer.from(s, "latin1")].map((b) => b.toString(16).padStart(2, "0")).join(" ");
const show = (s) => s.replace(/[\x00-\x1f\x7f]/g, (c) => (c === "\x1b" ? "ESC" : `^${String.fromCharCode(c.charCodeAt(0) ^ 64)}`));
const MODS = (m) => ["Shift", "Alt", "Ctrl", "Super"].filter((_, i) => ((m - 1) >> i) & 1).join("+");
const NAMED = { 13: "Enter", 9: "Tab", 27: "Esc", 127: "Backspace", 8: "Backspace", 32: "Space" };
const FINAL = { A: "Up", B: "Down", C: "Right", D: "Left", H: "Home", F: "End", P: "F1", Q: "F2", R: "F3", S: "F4" };
const TILDE = { 1: "Home", 2: "Insert", 3: "Delete", 4: "End", 5: "PageUp", 6: "PageDown", 15: "F5", 17: "F6", 18: "F7", 19: "F8", 20: "F9", 21: "F10", 23: "F11", 24: "F12" };
const SINGLE = { "\r": "Enter", "\n": "Ctrl+J / Ctrl+Enter", "\t": "Tab", "\x7f": "Backspace", "\x08": "Ctrl+Backspace / Ctrl+H", "\x03": "Ctrl+C", "\x1a": "Ctrl+Z", "\x16": "Ctrl+V", "\x1b": "Esc", "\x1b\r": "Alt+Enter", "\x1b[Z": "Shift+Tab", "\x1b[I": "focus in", "\x1b[O": "focus out" };

function name(seq) {
  if (SINGLE[seq]) return SINGLE[seq];
  let m;
  // `CSI row;col R` is also what Shift/Ctrl+F3 send on some terminals.
  if ((m = /^\x1b\[(\d+);(\d+)R$/.exec(seq))) return `cursor report row ${m[1]} col ${m[2]} (or modified F3)`;
  if ((m = /^\x1b\[\?([\d;]*)c$/.exec(seq))) return `reply: DA1 (${m[1]})`;
  if ((m = /^\x1b\[\?(\d+);(\d)\$y$/.exec(seq))) return `reply: mode ?${m[1]} = ${["not recognized", "set", "reset", "permanently set", "permanently reset"][Number(m[2])] ?? m[2]}`;
  if ((m = /^\x1b\[\?(\d+)u$/.exec(seq))) return `reply: kitty keyboard flags ${m[1]}`;
  if ((m = /^\x1b\[(\d+)(?::\d+)*(?:;(\d+))?u$/.exec(seq))) {
    const code = Number(m[1]);
    const key = NAMED[code] ?? (code >= 32 && code < 127 ? String.fromCharCode(code) : `code ${code}`);
    return `CSI-u: ${[MODS(Number(m[2] ?? 1)), key].filter(Boolean).join("+")}`;
  }
  if ((m = /^\x1b\[27;(\d+);(\d+)~$/.exec(seq))) {
    const code = Number(m[2]);
    return `modifyOtherKeys: ${[MODS(Number(m[1])), NAMED[code] ?? String.fromCharCode(code)].filter(Boolean).join("+")}`;
  }
  if ((m = /^\x1b\[(?:1;(\d+))?([A-DHFPQRS])$/.exec(seq)) || (m = /^\x1bO()([A-DHFPQRS])$/.exec(seq))) return [MODS(Number(m[1] || 1)), FINAL[m[2]]].filter(Boolean).join("+");
  if ((m = /^\x1b\[(\d+)(?:;(\d+))?~$/.exec(seq))) return [MODS(Number(m[2] ?? 1)), TILDE[m[1]] ?? `key ${m[1]}~`].filter(Boolean).join("+");
  if (seq.length === 2 && seq[0] === "\x1b") return `Alt+${show(seq[1])}`;
  if (seq.length === 1 && seq.charCodeAt(0) < 32) return `Ctrl+${String.fromCharCode(seq.charCodeAt(0) + 64)}`;
  return null;
}

// Split a chunk into escape sequences and text runs (enough for a probe).
function split(chunk) {
  const parts = [];
  const re = /\x1b\[200~[\s\S]*?\x1b\[201~|\x1b\[[0-?]*[ -/]*[@-~]|\x1bO.|\x1b[\s\S]|[\s\S]/g;
  let m;
  while ((m = re.exec(chunk))) parts.push(m[0]);
  const merged = [];
  for (const p of parts) {
    const last = merged[merged.length - 1];
    if (last !== undefined && !p.startsWith("\x1b") && p >= " " && p !== "\x7f" && !last.startsWith("\x1b") && last >= " " && last !== "\x7f") merged[merged.length - 1] = last + p;
    else merged.push(p);
  }
  return merged;
}

// Only what we set: kitty flags (pushed), bracketed paste, autowrap (toggled),
// cursor visibility, a synchronized update left open by a kill.
const SETUP = "\x1b[?2004h\x1b[>1u";
const RESTORE = "\x1b[?2026l\x1b[<u\x1b[?2004l\x1b[?7h\x1b[?25h";
let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  // Synchronous: TTY writes are async on Windows and would be lost at exit.
  try { writeSync(1, RESTORE); } catch {}
  try { process.stdin.setRawMode(false); } catch {}
  process.stdin.pause();
}
let onQuit = null;
const quit = (code = 0) => { onQuit?.(); out(`log: ${logFile}`); restore(); process.exit(code); };
process.on("exit", restore);
process.on("uncaughtException", (err) => { restore(); console.error(err); process.exit(1); });
for (const sig of ["SIGTERM", "SIGHUP", "SIGBREAK", "SIGINT"]) {
  try { process.on(sig, () => { restore(); process.exit(1); }); } catch { /* signal not supported on this platform */ }
}

process.stdin.setRawMode(true);
process.stdin.setEncoding("latin1");
process.stdout.write(SETUP);

// One dispatcher. Quit is checked before anything else, so no handler state
// can ever swallow it. While a query is in flight its replies are collected;
// otherwise data goes to the mode's handler.
let collector = null;
let handler = null;
let quitRun = "";
let carry = "";
// Ctrl+C as a byte, or as kitty CSI-u (`c` = 99) with the Ctrl bit set —
// lock keys (CapsLock 64, NumLock 128) add bits we ignore.
const isCtrlC = (part) => {
  if (part === "\x03") return true;
  const m = /^\x1b\[99(?::\d+)*;(\d+)(?::\d+)?u$/.exec(part);
  return Boolean(m) && ((Number(m[1]) - 1) & 4) !== 0;
};
const deliver = (chunk) => {
  for (const part of split(chunk)) {
    if (/^q+$/i.test(part)) quitRun += "q".repeat(part.length);
    else if (isCtrlC(part)) quitRun += "c";
    else quitRun = "";
    if (/q{3}$|c{3}$/.test(quitRun)) quit(0);
  }
  if (collector) collector.push(chunk);
  else handler?.(chunk);
};
let carryTimer = null;
process.stdin.on("data", (raw) => {
  // An escape sequence split across reads is held back until it completes;
  // a lone ESC that nothing follows within 50 ms is delivered as the Esc key.
  clearTimeout(carryTimer);
  let chunk = carry + raw;
  carry = "";
  const tail = /\x1b(\[[0-?]*[ -/]*)?$/.exec(chunk);
  if (tail) {
    carry = chunk.slice(tail.index);
    chunk = chunk.slice(0, tail.index);
    carryTimer = setTimeout(() => {
      const lone = carry;
      carry = "";
      if (lone) deliver(lone);
    }, 50);
  }
  if (chunk) deliver(chunk);
});

// Queries run one at a time; a reply that misses its window is reported, not misread.
let queue = Promise.resolve();
const ask = (query, ms = 800) => {
  const run = () => new Promise((resolve) => {
    collector = [];
    process.stdout.write(query);
    setTimeout(() => { const got = collector.join(""); collector = null; resolve(got); }, ms);
  });
  const result = queue.then(run);
  queue = result.catch(() => {});
  return result;
};

const capabilities = await ask("\x1b[?u\x1b[?2026$p\x1b[6n\x1b[c", 1000);
for (const p of split(capabilities)) out(`  ${name(p) ?? "reply"}  [${show(p)}]`);
if (!/\x1b\[\?\d+u/.test(capabilities)) out("  (no kitty keyboard reply: Shift+Enter will look like Enter here)");
if (!/\x1b\[\?2026;\d\$y/.test(capabilities)) out("  (no reply about synchronized output ?2026)");

if (mode === "keys") {
  out("");
  out("Press keys: Enter, Shift+Enter, Ctrl+Enter, Alt+Enter, Ctrl+J, Esc, Tab, Shift+Tab, arrows with Shift/Ctrl/Alt,");
  out("Backspace, Ctrl+Backspace, Ctrl+C, Ctrl+Z, Ctrl+V (text, then an image), and paste a few lines.");
  out("Quit: qqq, or Ctrl+C three times.");
  let t0 = Date.now();
  handler = (chunk) => {
    const dt = Date.now() - t0;
    t0 = Date.now();
    for (const part of split(chunk)) {
      const paste = part.startsWith("\x1b[200~");
      const label = paste ? `PASTE (${part.length - 12} chars, ${(part.match(/\r\n|\r|\n/g) ?? []).length} line breaks)` : name(part) ?? `text "${show(part)}"`;
      out(`+${String(dt).padStart(5)}ms  ${label.padEnd(40)} ${hex(part).slice(0, 72)}`);
    }
    if (chunk.length > 1 && !chunk.startsWith("\x1b") && /\r/.test(chunk)) out("        ^ text and Enter in one chunk: an unbracketed paste would look like this");
  };
} else {
  const cpr = async () => {
    const reply = await ask("\x1b[6n", 800);
    const m = /\x1b\[(\d+);(\d+)R/.exec(reply);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const verdict = (pos, ok, yes, no) => (pos ? (ok ? yes : no) : "unknown (no cursor report)");
  const cols = process.stdout.columns;
  out("");
  process.stdout.write("\r" + "X".repeat(cols));
  const afterFull = await cpr();
  process.stdout.write("\r\n");
  const afterNewline = await cpr();
  out(`full-width line: cursor ${JSON.stringify(afterFull)} then after \\r\\n ${JSON.stringify(afterNewline)} → ${verdict(afterFull, afterFull?.[1] === cols, "deferred wrap (xterm-like)", "immediate wrap (Windows-console-like)")}`);
  process.stdout.write("\x1b[?7l\r" + "Y".repeat(cols + 5));
  const noWrap = await cpr();
  process.stdout.write("\x1b[?7h\r\n");
  out(`autowrap off (?7l) + ${cols + 5} chars: cursor ${JSON.stringify(noWrap)} → ${verdict(noWrap, noWrap?.[1] === cols, "DECAWM honoured", "DECAWM NOT honoured")}`);
  out("");
  const atBottom = process.argv.includes("--bottom");
  // Flush with the bottom: scroll everything up so the region's last line is the window's last row.
  if (atBottom) process.stdout.write("\r\n".repeat(process.stdout.rows));
  out("Resize test: a 6-line live region is drawn below. Make the window narrower, then wider.");
  out("Each resize logs where the cursor ended up. Quit: qqq, or Ctrl+C three times.");
  const widths = [10, 30, 50, 70, 20, 40];
  const draw = () => {
    const c = process.stdout.columns;
    const lines = widths.map((w, i) => `${i + 1}`.padEnd(Math.min(w, c - 1), "·"));
    process.stdout.write("\x1b[?2026h\x1b[?7l" + lines.join("\r\n") + "\x1b[3A\r\x1b[10C\x1b[?7h\x1b[?2026l");
    return lines;
  };
  const lines = draw();
  let before = await cpr();
  // From here on, results go to the log only: printing them would move the
  // cursor and spoil the next measurement. They are printed again on quit.
  const results = [];
  const note = (line) => { results.push(line); log(line); };
  // Below the 6-line region (the cursor is parked on its line 3), synchronously.
  onQuit = () => writeSync(1, "\x1b[3B\r\n" + results.map((l) => l + "\r\n").join(""));
  note(`  drawn at ${process.stdout.columns}x${process.stdout.rows}${atBottom ? " flush with the bottom" : ""}; cursor parked on live line 3, col 11: ${JSON.stringify(before)}`);
  note("  after quitting, please also screenshot the window: ghost rows (old copies of the region's lines) show there");
  let timer = null;
  process.stdout.on("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const C = process.stdout.columns;
      const now = await cpr();
      const reflowRows = lines.slice(0, 2).reduce((n, l) => n + Math.max(1, Math.ceil(l.length / C)), 0) + Math.floor(10 / C);
      note(`  resized to ${C}x${process.stdout.rows}: cursor ${JSON.stringify(now)} (was ${JSON.stringify(before)}); rows above cursor if reflowing ≈ ${reflowRows}, if not = 2`);
      before = now;
    }, 200);
  });
}

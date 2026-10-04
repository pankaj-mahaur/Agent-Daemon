#!/usr/bin/env node
// Terminal probe for the `ad` terminal UI — what does THIS terminal send and do?
//
//   node runtime/scripts/tui-probe.mjs keys     every key/paste as raw bytes + a best-effort name
//   node runtime/scripts/tui-probe.mjs screen   wrap, autowrap-off, sync output, resize reflow
//
// Results also go to ~/.agent-daemon/logs/tui-probe-<mode>-<time>.log so they can
// be attached to a bug report. Read-only: it changes nothing but this terminal's
// modes, and restores them on exit.

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
  if ((m = /^\x1b\[(\d+);(\d+)R$/.exec(seq))) return `reply: cursor at row ${m[1]} col ${m[2]}`;
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

let restored = false;
const SETUP = "\x1b[?2004h\x1b[>1u";
const RESTORE = "\x1b[<u\x1b[>4;0m\x1b[?2004l\x1b[?1004l\x1b[?7h\x1b[?25h\x1b[r";
function restore() {
  if (restored) return;
  restored = true;
  // Synchronous: TTY writes are async on Windows and would be lost at exit.
  try { writeSync(1, RESTORE); } catch {}
  try { process.stdin.setRawMode(false); } catch {}
  process.stdin.pause();
}
process.on("exit", restore);
process.on("uncaughtException", (err) => { restore(); console.error(err); process.exit(1); });

process.stdin.setRawMode(true);
process.stdin.setEncoding("latin1");
process.stdout.write(SETUP);

let t0 = Date.now();
const replies = [];
let onData = null;
process.stdin.on("data", (chunk) => onData?.(chunk));
const ask = (query, ms = 400) => new Promise((resolve) => {
  const got = [];
  const prev = onData;
  onData = (chunk) => got.push(chunk);
  process.stdout.write(query);
  setTimeout(() => { onData = prev; resolve(got.join("")); }, ms);
});

const capabilities = await ask("\x1b[?u\x1b[?2026$p\x1b[6n\x1b[c", 600);
for (const p of split(capabilities)) { replies.push(p); out(`  ${name(p) ?? "reply"}  [${show(p)}]`); }
if (!/\x1b\[\?\d+u/.test(capabilities)) out("  (no kitty keyboard reply: Shift+Enter will look like Enter here)");

if (mode === "keys") {
  out("");
  out("Press keys: Enter, Shift+Enter, Ctrl+Enter, Alt+Enter, Ctrl+J, Esc, Tab, Shift+Tab, arrows with Shift/Ctrl/Alt,");
  out("Backspace, Ctrl+Backspace, Ctrl+C, Ctrl+Z, Ctrl+V (text, then an image), and paste a few lines. Type qqq to quit.");
  let quit = "";
  onData = (chunk) => {
    const dt = Date.now() - t0;
    t0 = Date.now();
    for (const part of split(chunk)) {
      const paste = part.startsWith("\x1b[200~");
      const label = paste ? `PASTE (${part.length - 12} chars, ${(part.match(/\r\n|\r|\n/g) ?? []).length} line breaks)` : name(part) ?? `text "${show(part)}"`;
      out(`+${String(dt).padStart(5)}ms  ${label.padEnd(36)} ${hex(part).slice(0, 72)}`);
      quit = part === "q" ? quit + "q" : part.length > 1 && /^q+$/.test(part) ? quit + part : "";
      if (quit.length >= 3) { out(`log: ${logFile}`); restore(); process.exit(0); }
    }
    if (chunk.length > 1 && !chunk.startsWith("\x1b") && /\r/.test(chunk)) out("        ^ one chunk with text and Enter: an unbracketed paste would look like this");
  };
} else {
  const cpr = async () => { const r = await ask("\x1b[6n", 300); const m = /\x1b\[(\d+);(\d+)R/.exec(r); return m ? [Number(m[1]), Number(m[2])] : null; };
  const cols = process.stdout.columns;
  out("");
  process.stdout.write("\r" + "X".repeat(cols));
  const afterFull = await cpr();
  process.stdout.write("\r\n");
  const afterNewline = await cpr();
  out(`full-width line: cursor ${JSON.stringify(afterFull)} then after \\r\\n ${JSON.stringify(afterNewline)} → ${afterFull && afterFull[1] === cols ? "deferred wrap (xterm-like)" : "immediate wrap (Windows-console-like)"}`);
  process.stdout.write("\x1b[?7l\r" + "Y".repeat(cols + 5));
  const noWrap = await cpr();
  process.stdout.write("\x1b[?7h\r\n");
  out(`autowrap off (?7l) + ${cols + 5} chars: cursor ${JSON.stringify(noWrap)} → ${noWrap && noWrap[1] === cols ? "DECAWM honoured" : "DECAWM NOT honoured"}`);
  out("");
  out("Resize test: a 6-line live region is drawn below. Make the window narrower, then wider.");
  out("Each resize logs where the cursor ended up. Type q to quit.");
  const widths = [10, 30, 50, 70, 20, 40];
  const draw = () => {
    const c = process.stdout.columns;
    const lines = widths.map((w, i) => `${i + 1}`.padEnd(Math.min(w, c - 1), "·"));
    process.stdout.write("\x1b[?2026h\x1b[?7l" + lines.join("\r\n") + "\x1b[3A\r\x1b[10C\x1b[?7h\x1b[?2026l");
    return lines;
  };
  let lines = draw();
  let before = await cpr();
  out(`  drawn at ${process.stdout.columns}x${process.stdout.rows}; cursor parked on live line 3, col 11: ${JSON.stringify(before)}`);
  let timer = null;
  process.stdout.on("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const C = process.stdout.columns;
      const now = await cpr();
      const reflowRows = lines.slice(0, 2).reduce((n, l) => n + Math.max(1, Math.ceil(l.length / C)), 0) + Math.floor(10 / C);
      out(`  resized to ${C}x${process.stdout.rows}: cursor ${JSON.stringify(now)} (was ${JSON.stringify(before)}); rows above cursor if reflowing ≈ ${reflowRows}, if not = 2`);
      before = now;
    }, 200);
  });
  onData = (chunk) => { if (chunk.includes("q")) { out(`log: ${logFile}`); restore(); process.exit(0); } };
}

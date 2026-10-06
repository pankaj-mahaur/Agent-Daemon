#!/usr/bin/env node
// Live check for the terminal layer (plan Part 1c done-when): the inline
// renderer, input decoder and terminal session together, with no engine.
//
//   node runtime/scripts/tui-demo.mjs
//
// Type, Enter sends (the message and a canned answer go into scrollback),
// Ctrl+J / Shift+Enter (Zed) / Ctrl+Enter (Windows Terminal) adds a line,
// Ctrl+L redraws, resize the window, scroll back, select and copy.
// Ctrl+C clears the composer; Ctrl+C on an empty composer quits.
// Ctrl+Z suspends (Linux/macOS). Nothing is sent anywhere.

import { createIo } from "../src/tui/terminal/io.mjs";
import { createRenderer } from "../src/tui/terminal/renderer.mjs";
import { isNewline } from "../src/tui/terminal/input.mjs";
import { colorDepth, wrap } from "../src/tui/terminal/text.mjs";
import { sanitize } from "../src/tui/terminal/sanitize.mjs";
import { setWidthProfile, stringWidth } from "../src/tui/terminal/width.mjs";
import { probeWidthProfile, reflowModel, terminalName } from "../src/tui/terminal/detect.mjs";

const io = createIo();
const caps = await io.enter();
const profile = await probeWidthProfile({ io });
setWidthProfile(profile);
const depth = colorDepth({ isTTY: true });
const renderer = createRenderer({ io, caps, depth, reflow: reflowModel(), resizeSource: process.stdout });
await renderer.start();

const dim = { dim: true };
const accent = { fg: "cyan", bold: true };
const term = terminalName();
const newlineHint = term === "zed" || caps.kitty ? "shift+enter" : term === "windows-terminal" ? "ctrl+enter" : "ctrl+j";
let composer = "";
let turns = 0;

function header(cols) {
  const inner = Math.max(20, Math.min(76, cols - 3));
  const row = (text) => {
    const pad = Math.max(0, inner - 2 - stringWidth(text));
    return [{ text: "\u{2502} ", style: dim }, { text }, { text: " ".repeat(pad) + " \u{2502}", style: dim }];
  };
  return [
    [{ text: "\u{256d}" + "\u{2500}".repeat(inner) + "\u{256e}", style: dim }],
    row(">_ Agent Daemon terminal demo (no engine)"),
    row(""),
    row(`terminal:  ${term} \u{b7} ${caps.kitty ? "kitty keys" : "legacy keys"} \u{b7} ${caps.sync ? "sync output" : "no sync"}`),
    row(`widths:    ${profile} \u{b7} colours ${depth} bit \u{b7} reflow ${reflowModel()}`),
    [{ text: "\u{2570}" + "\u{2500}".repeat(inner) + "\u{256f}", style: dim }],
    [],
  ];
}

function draw() {
  const { cols } = io.size();
  const width = Math.max(10, cols - 3);
  const body = composer.split("\n");
  const lines = [];
  // No clock here: an idle screen must not redraw (each write restarts the
  // terminal's cursor blink, so a ticking timer keeps the cursor solid).
  lines.push([{ text: "\u{25e6} ", style: { fg: "cyan" } }, { text: `Idle \u{b7} ${turns} turns`, style: dim }]);
  lines.push([]);
  body.forEach((l, i) => lines.push([{ text: i === 0 ? "\u{203a} " : "  ", style: accent }, { text: l }]));
  if (!composer) lines[lines.length - 1].push({ text: "Type something", style: dim });
  lines.push([{ text: `  enter send \u{b7} ${newlineHint} newline \u{b7} ctrl+l redraw \u{b7} ctrl+c quit`, style: dim }]);
  const last = body[body.length - 1];
  renderer.frame({
    lines: lines.map((l) => l),
    cursor: { row: 2 + body.length - 1, col: Math.min(width, 2 + stringWidth(last)) },
  });
}

function send() {
  const text = composer;
  composer = "";
  turns++;
  const { cols } = io.size();
  const width = Math.max(10, cols - 3);
  const out = [];
  text.split("\n").forEach((l, i) => out.push([{ text: i === 0 ? "\u{203a} " : "  ", style: accent }, { text: l }]));
  out.push([]);
  const answer = `You wrote ${stringWidth(text)} columns of text. This answer is word-wrapped to ${width} columns before it goes into scrollback, so resizing later never breaks words in half. Scroll up: everything above the composer is ordinary terminal history.`;
  for (const l of wrap([{ text: answer }], width)) out.push([{ text: "  " }, ...l]);
  out.push([]);
  renderer.commit(out);
  draw();
}

async function quit() {
  renderer.frame({ lines: [] });
  renderer.dispose();
  await io.close();
  process.exit(0);
}

io.onInput((ev) => {
  if (ev.type === "paste") composer += sanitize(ev.text, "transcript");
  else if (ev.type === "paste-empty") composer += "[image paste: not supported in the demo]";
  else if (ev.type === "text") composer += sanitize(ev.text, "transcript");
  else if (ev.type === "key") {
    if (isNewline(ev)) composer += "\n";
    else if (ev.name === "enter" && !ev.alt) {
      if (composer.trim()) send();
    } else if (ev.name === "backspace") composer = ev.ctrl ? composer.replace(/\S+\s*$/, "") : [...composer].slice(0, -1).join("");
    else if (ev.ctrl && ev.name === "c") {
      if (!composer) return void quit();
      composer = "";
    } else if (ev.ctrl && ev.name === "l") return void renderer.redraw();
    else if (ev.ctrl && ev.name === "z" && process.platform !== "win32") {
      // Ctrl+Z does nothing on Windows (no SIGTSTP). If stopping fails, carry on.
      renderer.suspend();
      if (!io.suspend()) return void renderer.resume().then(draw);
    }
  }
  draw();
});
io.onResume(async () => {
  await renderer.resume();
  draw();
});
renderer.onResize(draw);

renderer.commit(header(io.size().cols));
draw();

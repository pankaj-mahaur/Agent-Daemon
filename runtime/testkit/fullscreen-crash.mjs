#!/usr/bin/env node
// Enters ad's terminal I/O and the fullscreen renderer for real, draws
// "FRAME-TEXT", then fails one way (P2.1's crash paths, for the pty test):
//   node testkit/fullscreen-crash.mjs <throw|reject|exit|sigterm|catch-finally>
// catch-finally replays cmdTui's catch then finally order and prints
// "ERROR-TEXT" to stderr, as cmdTui does.

import { createIo } from "../src/tui/terminal/io.mjs";
import { createFullscreenRenderer } from "../src/tui/terminal/fullscreen.mjs";

const mode = process.argv[2];
const io = createIo({ queryTimeoutMs: 1000 });
await io.enter();
const renderer = createFullscreenRenderer({ io, resizeSource: process.stdout });
renderer.start();
renderer.frame({ lines: [[{ text: "FRAME-TEXT" }]], cursor: { row: 0, col: 10 } });
await new Promise((r) => setTimeout(r, 300));

if (mode === "throw") setTimeout(() => { throw new Error("boom"); }, 0);
else if (mode === "reject") Promise.reject(new Error("boom"));
else if (mode === "exit") process.exit(3);
else if (mode === "sigterm") process.kill(process.pid, "SIGTERM");
else if (mode === "catch-finally") {
  try {
    throw new Error("boom");
  } catch {
    io.restore();
    process.stderr.write("ERROR-TEXT\n");
  } finally {
    if (!renderer.fullscreen) renderer.frame({ lines: [] });
    renderer.frame({ lines: [[{ text: "FRAME-TEXT after the error" }]] }); // an inert renderer writes nothing
    renderer.dispose();
    await io.close();
  }
  process.exit(1);
} else {
  console.error("usage: fullscreen-crash.mjs <throw|reject|exit|sigterm|catch-finally>");
  process.exit(2);
}

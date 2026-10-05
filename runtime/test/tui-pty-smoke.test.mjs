// End-to-end smoke: scripts/tui-demo.mjs in a real pseudo-terminal (ConPTY on
// Windows), its output fed into headless xterm.js, which answers the demo's
// queries. Type, send, resize, quit; the terminal must come back restored.
// Skipped where @lydell/node-pty can't load.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import xtermHeadless from "@xterm/headless";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(here, "..", "scripts", "tui-demo.mjs");

let pty = null;
try {
  pty = (await import("@lydell/node-pty")).default;
} catch {
  pty = null;
}

function screenText(term) {
  const b = term.buffer.active;
  const rows = [];
  for (let i = 0; i < b.length; i++) rows.push(b.getLine(i).translateToString(true));
  return rows.join("\n");
}

async function waitFor(fn, what, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("ad tui --preview in a real pty, on the fake engine: turn, approval, quit", { skip: !pty && "node-pty unavailable", timeout: 60000 }, async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(path.join(tmpdir(), "ad-tui-pty-"));
  const term = new xtermHeadless.Terminal({ cols: 80, rows: 24, scrollback: 500, allowProposedApi: true });
  const env = { ...process.env, TERM: "xterm-256color" };
  delete env.WT_SESSION;
  delete env.TERM_PROGRAM;
  delete env.CODEX_HOME;
  const script = path.join(here, "..", "testkit", "tui-preview-fake.mjs");
  const child = pty.spawn(process.execPath, [script, path.join(root, "home"), root], { cols: 80, rows: 24, cwd: root, env, name: "xterm-256color" });
  let raw = "";
  let exit = null;
  child.onData((d) => {
    raw += d;
    term.write(d);
  });
  child.onExit((e) => {
    exit = e;
  });
  term.onData((d) => child.write(d));
  try {
    await waitFor(() => screenText(term).includes("Ask ad to do anything"), "the composer");
    assert.match(screenText(term), /terminal UI preview/);
    child.write("hello\r");
    await waitFor(() => screenText(term).includes("Run command?"), "the approval prompt");
    await new Promise((r) => setTimeout(r, 500)); // prompts take an answer only after 400 ms
    child.write("y");
    await waitFor(() => screenText(term).includes("[accept]"), "the approved turn to finish");
    child.write("\x03");
    await waitFor(() => exit !== null, "ad tui to exit", 15000);
    assert.equal(exit.exitCode, 0);
    assert.ok(raw.includes("\x1b[?2004l"), "terminal restored");
  } finally {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    term.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("demo in a real pty: type, send, resize, quit, restored", { skip: !pty && "node-pty unavailable", timeout: 60000 }, async () => {
  const term = new xtermHeadless.Terminal({ cols: 70, rows: 20, scrollback: 500, allowProposedApi: true });
  const env = { ...process.env, TERM: "xterm-256color" };
  delete env.WT_SESSION;
  delete env.TERM_PROGRAM;
  const child = pty.spawn(process.execPath, [DEMO], { cols: 70, rows: 20, cwd: path.join(here, ".."), env, name: "xterm-256color" });
  let raw = "";
  let exit = null;
  child.onData((d) => {
    raw += d;
    term.write(d);
  });
  child.onExit((e) => {
    exit = e;
  });
  term.onData((d) => child.write(d)); // xterm answers CPR / DA1 / DECRQM
  try {
    await waitFor(() => screenText(term).includes("Type something"), "the composer");
    assert.ok(screenText(term).includes("Agent Daemon terminal demo"), "header committed");

    child.write("hello pty");
    await waitFor(() => screenText(term).includes("hello pty"), "typed text");
    child.write("\r");
    await waitFor(() => screenText(term).includes("You wrote 9 columns"), "the canned answer");
    assert.match(screenText(term), /\u{203a} hello pty/u, "the sent message is in history");

    child.resize(50, 16);
    term.resize(50, 16);
    await new Promise((r) => setTimeout(r, 400));
    child.write("x");
    await waitFor(() => /\u{203a} x/u.test(screenText(term)), "typing after the resize");

    child.write("\x03"); // clears the composer
    child.write("\x03"); // empty composer: quit
    await waitFor(() => exit !== null, "the demo to exit");
    assert.equal(exit.exitCode, 0);
    assert.ok(raw.includes("\x1b[?2004l") || !raw.includes("\x1b[?2004h"), "bracketed paste turned off again");
    assert.ok(!/\x1b\[3J/.test(raw), "scrollback never cleared by the demo");
  } finally {
    // Also after a clean exit: the pty's own handles would keep the test alive.
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    term.dispose();
  }
});

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

test("ad tui in a real pty, on the fake engine: trust, turn, approval, /status, quit", { skip: !pty && "node-pty unavailable", timeout: 90000 }, async () => {
  const { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(path.join(tmpdir(), "ad-tui-app-pty-"));
  const cwd = path.join(root, "project");
  mkdirSync(cwd);
  const term = new xtermHeadless.Terminal({ cols: 90, rows: 28, scrollback: 1000, allowProposedApi: true });
  const env = { ...process.env, TERM: "xterm-256color" };
  delete env.WT_SESSION;
  delete env.TERM_PROGRAM;
  delete env.CODEX_HOME;
  const script = path.join(here, "..", "testkit", "tui-fake.mjs");
  const child = pty.spawn(process.execPath, [script, root, cwd], { cols: 90, rows: 28, cwd, env, name: "xterm-256color" });
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
    await waitFor(() => screenText(term).includes("Do you trust"), "the trust prompt");
    child.write("\r");
    await waitFor(() => screenText(term).includes("Ask ad to do anything"), "the composer");
    assert.match(screenText(term), /Agent Daemon \(vtest\)/);
    child.write("hello\r");
    await waitFor(() => screenText(term).includes("Run command?"), "the approval modal");
    await new Promise((r) => setTimeout(r, 600));
    child.write("y");
    await waitFor(() => screenText(term).includes("Worked for"), "the turn's end");
    child.write("/status\r");
    await waitFor(() => /conversation +thread-/.test(screenText(term)), "the status report");
    child.write("\x03");
    child.write("\x03");
    await waitFor(() => exit !== null, "ad tui to exit", 15000);
    assert.equal(exit.exitCode, 0);
    assert.ok(raw.includes("\x1b[?2004l"), "terminal restored");
    assert.match(raw, /To continue: ad tui --resume thread-/);
    assert.ok(existsSync(path.join(root, "history.jsonl")));
    assert.match(readFileSync(path.join(root, "history.jsonl"), "utf8"), /hello/);
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

// P2.1: fullscreen through the real start-up paths. `prefs` seeds ad's prefs.json
// (path A: last mode fullscreen); `config` the fake engine's user layer.
async function fullscreenRun({ prefs = null, config = null, promptLast = false }) {
  const { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(path.join(tmpdir(), "ad-tui-fs-pty-"));
  const cwd = path.join(root, "project");
  mkdirSync(cwd);
  if (prefs) writeFileSync(path.join(root, "prefs.json"), JSON.stringify(prefs));
  if (config) {
    mkdirSync(path.join(root, "home"), { recursive: true });
    writeFileSync(path.join(root, "home", "fake-config.json"), JSON.stringify(config));
  }
  const rows = 28;
  const term = new xtermHeadless.Terminal({ cols: 90, rows, scrollback: 1000, allowProposedApi: true });
  const shell = ["SHELL-TEXT-ONE", "SHELL-TEXT-TWO"];
  await new Promise((r) => term.write(shell.join("\r\n") + (promptLast ? "\r\n".repeat(rows - shell.length) + "$ " : "\r\n"), r));
  const lines = (b) => {
    const out = [];
    for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true).replace(/\s+$/, ""));
    while (out.length && out.at(-1) === "") out.pop();
    return out;
  };
  const before = lines(term.buffer.normal);
  const env = { ...process.env, TERM: "xterm-256color" };
  delete env.WT_SESSION;
  delete env.TERM_PROGRAM;
  delete env.CODEX_HOME;
  const child = pty.spawn(process.execPath, [path.join(here, "..", "testkit", "tui-fake.mjs"), root, cwd], { cols: 90, rows, cwd, env, name: "xterm-256color" });
  let exit = null;
  let sawAlternate = false;
  child.onData((d) => term.write(d, () => (sawAlternate ||= term.buffer.active.type === "alternate")));
  child.onExit((e) => (exit = e));
  term.onData((d) => child.write(d));
  try {
    await waitFor(() => screenText(term).includes("Do you trust"), "the trust prompt");
    child.write("\r");
    await waitFor(() => screenText(term).includes("Ask ad to do anything"), "the composer");
    const during = term.buffer.active.type;
    child.write("\x03");
    child.write("\x03");
    await waitFor(() => exit !== null, "ad tui to exit");
    await new Promise((r) => term.write("", r));
    const prefsNow = existsSync(path.join(root, "prefs.json")) ? JSON.parse(readFileSync(path.join(root, "prefs.json"), "utf8")) : {};
    return { exit, during, sawAlternate, before, after: lines(term.buffer.normal), active: term.buffer.active.type, mouse: term.modes.mouseTrackingMode, prefs: prefsNow };
  } finally {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    term.dispose();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
// ConPTY repaints the whole main screen when the child starts, so text written
// into the test terminal beforehand can't survive on Windows (whatever ad does).
const shellTextSurvives = process.platform !== "win32";

test("ad tui with fullscreen_transcript = true (path B): alternate screen while running; the shell's text and the exit hint on the main screen after quit", { skip: !pty && "node-pty unavailable", timeout: 90000 }, async () => {
  const r = await fullscreenRun({ config: { tui: { fullscreen_transcript: true } } });
  assert.equal(r.exit.exitCode, 0);
  assert.equal(r.during, "alternate");
  assert.equal(r.active, "normal");
  assert.equal(r.mouse, "none", "mouse modes off after quit");
  if (shellTextSurvives) assert.deepEqual(r.after.slice(0, 2), ["SHELL-TEXT-ONE", "SHELL-TEXT-TWO"]);
  assert.ok(!r.after.some((l) => l.includes("Ask ad to do anything")), "no frame text on the main screen");
  assert.equal(r.prefs["screen.lastMode"], "fullscreen");
});

test("path A: with screen.lastMode = fullscreen and the shell prompt on the last row, the main screen is unchanged by the session", { skip: !pty && "node-pty unavailable", timeout: 90000 }, async () => {
  const r = await fullscreenRun({ prefs: { "screen.lastMode": "fullscreen" }, config: { tui: { fullscreen_transcript: true } }, promptLast: true });
  assert.equal(r.exit.exitCode, 0);
  assert.equal(r.during, "alternate");
  assert.equal(r.active, "normal");
  if (shellTextSurvives) assert.deepEqual(r.after.slice(0, r.before.length), r.before, `before:\n${r.before.join("\n")}\nafter:\n${r.after.join("\n")}`);
  assert.ok(!r.after.some((l) => l.includes("Starting the engine") || l.includes("Ask ad to do anything")), "nothing of the session on the main screen");
});

test("path A, then the setting is gone: ad swaps back to inline and remembers it", { skip: !pty && "node-pty unavailable", timeout: 90000 }, async () => {
  const r = await fullscreenRun({ prefs: { "screen.lastMode": "fullscreen" } });
  assert.equal(r.exit.exitCode, 0);
  assert.equal(r.during, "normal", "inline once the app runs");
  assert.equal(r.sawAlternate, true, "the start-up ran on the alternate screen");
  assert.equal(r.prefs["screen.lastMode"], "inline");
});

for (const mode of ["throw", "reject", "exit", "sigterm", "catch-finally"]) {
  const skip = !pty ? "node-pty unavailable" : mode === "sigterm" && process.platform === "win32" ? "no SIGTERM to self on Windows" : false;
  test(`fullscreen crash path ${mode}: the main screen comes back with no frame text, mouse off`, { skip, timeout: 30000 }, async () => {
    const term = new xtermHeadless.Terminal({ cols: 60, rows: 12, scrollback: 100, allowProposedApi: true });
    const env = { ...process.env, TERM: "xterm-256color" };
    const child = pty.spawn(process.execPath, [path.join(here, "..", "testkit", "fullscreen-crash.mjs"), mode], { cols: 60, rows: 12, env, name: "xterm-256color" });
    let exit = null;
    let sawFrame = false;
    child.onData((d) => term.write(d, () => (sawFrame ||= term.buffer.active.type === "alternate" && screenText(term).includes("FRAME-TEXT"))));
    child.onExit((e) => (exit = e));
    term.onData((d) => child.write(d));
    try {
      await waitFor(() => exit !== null, `the ${mode} exit`);
      await new Promise((r) => term.write("", r));
      assert.equal(sawFrame, true, "the frame was drawn on the alternate screen");
      assert.equal(term.buffer.active.type, "normal");
      assert.equal(term.modes.mouseTrackingMode, "none");
      assert.equal(term.modes.bracketedPasteMode, false);
      const main = screenText(term);
      assert.ok(!main.includes("FRAME-TEXT"), main);
      if (mode === "catch-finally") assert.match(main, /ERROR-TEXT/);
    } finally {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      term.dispose();
    }
  });
}

test("fullscreen editor handoff in a real pty: ad's screen during and after, the edited text in the prompt (P2.4)", { skip: !pty && "node-pty unavailable", timeout: 90000 }, async () => {
  const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(path.join(tmpdir(), "ad-tui-editor-pty-"));
  const cwd = path.join(root, "project");
  mkdirSync(cwd);
  mkdirSync(path.join(root, "home"), { recursive: true });
  writeFileSync(path.join(root, "home", "fake-config.json"), JSON.stringify({ tui: { fullscreen_transcript: true } }));
  const term = new xtermHeadless.Terminal({ cols: 90, rows: 28, scrollback: 1000, allowProposedApi: true });
  const env = { ...process.env, TERM: "xterm-256color", EDITOR: `"${process.execPath}" "${path.join(here, "..", "testkit", "fake-editor.mjs")}"` };
  delete env.VISUAL;
  delete env.WT_SESSION;
  delete env.TERM_PROGRAM;
  delete env.CODEX_HOME;
  const child = pty.spawn(process.execPath, [path.join(here, "..", "testkit", "tui-fake.mjs"), root, cwd], { cols: 90, rows: 28, cwd, env, name: "xterm-256color" });
  let exit = null;
  child.onData((d) => term.write(d));
  child.onExit((e) => (exit = e));
  term.onData((d) => child.write(d));
  try {
    await waitFor(() => screenText(term).includes("Do you trust"), "the trust prompt");
    child.write("\r");
    await waitFor(() => screenText(term).includes("Ask ad to do anything"), "the composer");
    assert.equal(term.buffer.active.type, "alternate");
    child.write("draft");
    await waitFor(() => screenText(term).includes("draft"), "the typed draft");
    child.write("\x07"); // Ctrl+G
    await waitFor(() => screenText(term).includes("draft EDITED-BY-FAKE"), "the edited text back in the prompt");
    assert.equal(term.buffer.active.type, "alternate", "back on ad's screen after the editor");
    child.write("\x03");
    child.write("\x03");
    child.write("\x03");
    await waitFor(() => exit !== null, "ad tui to exit");
    await new Promise((r) => term.write("", r));
    assert.equal(term.buffer.active.type, "normal");
  } finally {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    term.dispose();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("Ctrl+Z under bash job control: ad stops, the shell has its screen, fg brings back a repainted fullscreen (P2.4)", { skip: !pty ? "node-pty unavailable" : process.platform === "win32" ? "POSIX job control" : false, timeout: 90000 }, async () => {
  const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(path.join(tmpdir(), "ad-tui-jobs-pty-"));
  const cwd = path.join(root, "project");
  mkdirSync(cwd);
  mkdirSync(path.join(root, "home"), { recursive: true });
  writeFileSync(path.join(root, "home", "fake-config.json"), JSON.stringify({ tui: { fullscreen_transcript: true } }));
  const term = new xtermHeadless.Terminal({ cols: 90, rows: 28, scrollback: 1000, allowProposedApi: true });
  const env = { ...process.env, TERM: "xterm-256color", PS1: "JOBS$ " };
  delete env.CODEX_HOME;
  const child = pty.spawn("bash", ["--norc", "--noprofile", "-i"], { cols: 90, rows: 28, cwd, env, name: "xterm-256color" });
  child.onData((d) => term.write(d));
  term.onData((d) => child.write(d));
  try {
    await waitFor(() => screenText(term).includes("JOBS$"), "the shell prompt");
    child.write(`'${process.execPath}' '${path.join(here, "..", "testkit", "tui-fake.mjs")}' '${root}' '${cwd}'\r`);
    await waitFor(() => screenText(term).includes("Do you trust"), "the trust prompt");
    child.write("\r");
    await waitFor(() => screenText(term).includes("Ask ad to do anything"), "the composer");
    assert.equal(term.buffer.active.type, "alternate");
    child.write("\x1a"); // Ctrl+Z
    await waitFor(() => term.buffer.active.type === "normal" && /Stopped/.test(screenText(term)), "bash reporting the stopped job");
    child.write("fg\r");
    await waitFor(() => term.buffer.active.type === "alternate" && screenText(term).includes("Ask ad to do anything"), "fullscreen back and repainted");
    child.write("\x03");
    child.write("\x03");
    await waitFor(() => term.buffer.active.type === "normal", "ad quit");
  } finally {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    term.dispose();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

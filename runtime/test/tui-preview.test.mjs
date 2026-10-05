// `ad tui --preview` walking skeleton (tui/preview.mjs): transcript, approval
// keys, and the whole app against the fake Codex app-server on a test screen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine } from "../src/engine/index.mjs";
import { createChatSession } from "../src/harness/chat.mjs";
import { createTranscript, approvalKey, createPreviewApp, boxed } from "../src/tui/preview.mjs";
import { createRenderer } from "../src/tui/terminal/renderer.mjs";
import { createInputDecoder } from "../src/tui/terminal/input.mjs";
import { modelScreen } from "../testkit/screen.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };

/* ------------------------------------------------------------------ */
/* Transcript                                                          */
/* ------------------------------------------------------------------ */

function transcript(width = 20) {
  const committed = [];
  const t = createTranscript({ commit: (lines) => committed.push(...lines), width: () => width });
  const text = (lines) => lines.map((l) => l.map((s) => s.text).join(""));
  return { t, committed, text };
}

test("transcript: complete lines are committed, the unfinished one stays live", () => {
  const { t, committed, text } = transcript();
  t.write("out", "hel");
  t.write("out", "lo\nwor");
  assert.deepEqual(text(committed), ["hello"]);
  assert.deepEqual(text(t.live()), ["wor"]);
  t.write("out", "ld\n\nnext");
  assert.deepEqual(text(committed), ["hello", "world", ""]);
  t.end();
  assert.deepEqual(text(committed), ["hello", "world", "", "next"]);
  assert.deepEqual(t.live(), []);
});

test("transcript: long lines are word-wrapped to the width", () => {
  const { t, committed, text } = transcript(12);
  t.write("out", "the quick brown fox jumps\n");
  assert.deepEqual(text(committed), ["the quick", "brown fox", "jumps"]);
});

test("transcript: escape sequences are stripped even when split across chunks", () => {
  const { t, committed, text } = transcript(40);
  t.write("out", "red \x1b[3");
  t.write("out", "1mtext\x1b[0m and \x1b]0;title\x07done\x1b[2J\n");
  assert.deepEqual(text(committed), ["red text and done"]);
});

test("transcript: activity rows (err) are dim, and switching kinds ends the other's line", () => {
  const { t, committed, text } = transcript(40);
  t.write("out", "partial answer");
  t.write("err", "\n\u{2022} Ran npm test\n");
  assert.deepEqual(text(committed), ["partial answer", "", "\u{2022} Ran npm test"]);
  assert.deepEqual(committed[2][0].style, { dim: true });
  assert.equal(committed[0][0].style, undefined);
});

/* ------------------------------------------------------------------ */
/* Approval keys                                                       */
/* ------------------------------------------------------------------ */

test("approvalKey: y / a / n, Esc and Ctrl+C decline, anything else is ignored", () => {
  assert.equal(approvalKey({ type: "text", text: "y" }), "y");
  assert.equal(approvalKey({ type: "text", text: "A" }), "a");
  assert.equal(approvalKey({ type: "text", text: "n" }), "n");
  assert.equal(approvalKey({ type: "key", name: "escape", ctrl: false, alt: false }), "n");
  assert.equal(approvalKey({ type: "key", name: "c", ctrl: true, alt: false }), "n");
  assert.equal(approvalKey({ type: "text", text: "yes please" }), null, "a pasted word is not an answer");
  assert.equal(approvalKey({ type: "key", name: "enter", ctrl: false, alt: false }), null, "Enter alone doesn't approve");
  assert.equal(approvalKey({ type: "paste", text: "y" }), null, "a paste never answers");
  assert.equal(approvalKey({ type: "key", name: "y", ctrl: true, alt: false }), null);
});

/* ------------------------------------------------------------------ */
/* The app against the fake engine                                    */
/* ------------------------------------------------------------------ */

async function withApp(fn, appOpts = {}) {
  const root = mkdtempSync(join(tmpdir(), "ad-tui-"));
  const engine = await createEngine({ home: join(root, "home"), command });
  const scr = modelScreen({ cols: 60, rows: 16 });
  const listeners = new Set();
  const io = { ...scr.io, onInput: (f) => (listeners.add(f), () => listeners.delete(f)) };
  const decoder = createInputDecoder({ onEvent: (e) => listeners.forEach((f) => f(e)), escTimeoutMs: 5 });
  const type = (s) => decoder.feed(s);
  const renderer = createRenderer({ io, reflow: "none" });
  await renderer.start();
  const app = createPreviewApp({
    io,
    renderer,
    header: [[{ text: "header line" }], []],
    makeSession: ({ out, err, ask }) => createChatSession({ engine, cwd: root, out, err, ask }),
    armMs: 60,
    ...appOpts,
  });
  const until = async (pred, what, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out waiting for ${what}: ${JSON.stringify(scr.lines())}`);
  };
  try {
    await fn({ app, scr, type, until, engine });
  } finally {
    app.dispose();
    renderer.dispose();
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("preview app: a turn streams, asks for approval, y approves, the answer lands in history", async () => {
  await withApp(async ({ app, scr, type, until }) => {
    assert.ok(scr.lines().includes("header line"));
    type("hello");
    type("\r");
    await until(() => app.state.approval, "the approval prompt");
    const live = scr.lines().join("\n");
    assert.match(live, /Run command\?/);
    assert.match(live, /y yes {2}a always this session {2}n no \(esc\)/);
    await new Promise((r) => setTimeout(r, 80)); // the prompt arms after armMs
    type("y");
    await until(() => !app.state.busy, "the turn to finish");
    const lines = scr.lines();
    assert.ok(lines.includes("\u{203a} hello"), "the message is in history");
    // The fake streams "po", an error notification (shown as an activity row), then "ng".
    const po = lines.indexOf("po");
    const retry = lines.findIndex((l) => l.includes("[retrying]"));
    const approved = lines.findIndex((l) => l.includes("approved: Run command?"));
    const rest = lines.findIndex((l) => l === "ng[accept]");
    assert.ok(po >= 0 && po < retry && retry < approved && approved < rest, JSON.stringify(lines));
    assert.ok(lines.at(-1).includes("enter send"), "composer and footer at the bottom");
  });
});

test("preview app: n declines; letters typed during an approval never reach the composer", async () => {
  await withApp(async ({ app, scr, type, until }) => {
    type("hello\r");
    await until(() => app.state.approval, "the approval prompt");
    type("q");
    assert.ok(app.state.approval, "q is not an answer");
    type("n");
    await until(() => !app.state.busy, "the turn to finish");
    assert.ok(scr.lines().some((l) => l.includes("declined: Run command?")));
    assert.ok(scr.lines().some((l) => l.includes("[decline]")));
    assert.equal(app.state.composer, "", "the q went nowhere");
  });
});

test("preview app: Esc interrupts a running turn", async () => {
  await withApp(async ({ app, scr, type, until }) => {
    type("hang\r");
    await until(() => app.state.busy && scr.lines().some((l) => l.includes("Working (")), "the working row");
    await new Promise((r) => setTimeout(r, 100)); // let turn/start answer
    type("\x1b");
    await until(() => !app.state.busy, "the turn to stop");
    assert.ok(scr.lines().some((l) => /interrupted/.test(l)), JSON.stringify(scr.lines()));
  });
});

test("preview app: multi-line composer (LF), Ctrl+C clears, Ctrl+C on an empty composer quits", async () => {
  await withApp(async ({ app, type }) => {
    type("one");
    type("\n"); // Ctrl+J / Shift+Enter in Zed / Ctrl+Enter in Windows Terminal
    type("two");
    assert.equal(app.state.composer, "one\ntwo");
    type("\x7f");
    assert.equal(app.state.composer, "one\ntw");
    type("\x03");
    assert.equal(app.state.composer, "");
    let quit = false;
    app.done.then(() => (quit = true));
    type("\x03");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(quit, true);
  });
});

test("preview app: a paste is inserted as text, sanitized, and never submits", async () => {
  await withApp(async ({ app, type }) => {
    type("\x1b[200~line 1\r\nline 2\x1b[31m red\x1b[201~");
    assert.equal(app.state.composer, "line 1\nline 2 red");
    assert.equal(app.state.busy, false);
  });
});

test("preview app: submitting while a turn runs is refused with a notice", async () => {
  await withApp(async ({ app, type, until }) => {
    type("hang\r");
    await until(() => app.state.busy, "busy");
    type("more\r");
    assert.match(app.state.notice ?? "", /Esc interrupts/);
    assert.equal(app.state.composer, "more", "the text is kept");
    await new Promise((r) => setTimeout(r, 100));
    type("\x1b");
    await until(() => !app.state.busy, "the turn to stop");
  });
});

/* ------------------------------------------------------------------ */
/* Review 2: approval safety, stuck turns, long lines                  */
/* ------------------------------------------------------------------ */

test("header box: folder and model names can't inject controls, and long ones keep the box closed", () => {
  const rows = boxed([`directory: /tmp/evil\x1b]52;c;ZXZpbA==\x07\u{202e}dir`, `model: ${"m".repeat(200)}`], 60);
  const text = rows.map((r) => r.map((s) => s.text).join(""));
  for (const t of text) assert.ok(!/[\x1b\x07\u{202e}]/u.test(t), JSON.stringify(t));
  assert.ok(text[1].startsWith("\u{2502} directory: /tmp/evildir"));
  const widths = text.slice(0, -1).map((t) => [...t].length);
  assert.ok(widths.every((w) => w === widths[0]), `every box row has the same width: ${widths}`);
});

test("approvalKey: padded or multi-character text is never an answer", () => {
  assert.equal(approvalKey({ type: "text", text: " a " }), null);
  assert.equal(approvalKey({ type: "text", text: "yy" }), null);
  assert.equal(approvalKey({ type: "text", text: "y\n" }), null);
});

test("preview app: a key typed before the prompt was visible doesn't answer it", async () => {
  await withApp(async ({ app, type, until }) => {
    type("hello\r");
    await until(() => app.state.approval, "the approval prompt");
    type("a"); // type-ahead: the user was still typing "say..."
    assert.ok(app.state.approval, "not answered yet");
    await new Promise((r) => setTimeout(r, 80));
    type("n");
    await until(() => !app.state.busy, "the turn to finish");
  }, { armMs: 60 });
});

test("preview app: a double tap answers only the first of two back-to-back prompts", async () => {
  await withApp(async ({ app, scr, type, until }) => {
    type("two-approvals\r");
    await until(() => app.state.approval, "the first prompt");
    await new Promise((r) => setTimeout(r, 80));
    type("y");
    type("y"); // the bounce, before the second prompt was visible
    await until(() => app.state.approval, "the second prompt");
    assert.ok(app.state.approval, "the second prompt is still waiting");
    type("n");
    await until(() => !app.state.busy, "the turn to finish");
    assert.ok(scr.lines().some((l) => l.includes("two[accept,decline]")), JSON.stringify(scr.lines()));
  }, { armMs: 60 });
});

test("preview app: history records the whole approved request", async () => {
  await withApp(async ({ app, scr, type, until }) => {
    type("hello\r");
    await until(() => app.state.approval, "the approval prompt");
    type("n");
    await until(() => !app.state.busy, "the turn to finish");
    const lines = scr.lines();
    const i = lines.findIndex((l) => l.includes("declined: Run command?"));
    assert.match(lines[i + 1], /\$ rm -rf \//);
  });
});

test("preview app: if the engine stops during an approval, the prompt is declined and cleared", async () => {
  await withApp(async ({ app, scr, type, until, engine }) => {
    type("hello\r");
    await until(() => app.state.approval, "the approval prompt");
    engine.server.child.kill();
    await until(() => !app.state.busy, "the turn to end");
    assert.equal(app.state.approval, null);
    assert.ok(scr.lines().some((l) => l.includes("declined: Run command?")));
    type("x");
    assert.equal(app.state.composer, "x", "keys reach the composer again");
  });
});

test("preview app: a second Ctrl+C quits even when the turn won't stop", async () => {
  await withApp(async ({ app, type, until }) => {
    type("hang\r");
    await until(() => app.state.busy, "busy");
    app.session.interrupt = async () => true; // a wedged turn: interrupting does nothing
    let quit = false;
    app.done.then(() => (quit = true));
    type("\x03");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(quit, false, "the first Ctrl+C only interrupts");
    assert.match(app.state.notice ?? "", /Ctrl\+C again quits/);
    type("\x03");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(quit, true);
  });
});

test("transcript: showing an unfinished line costs the same at 10 KB and at 200 KB", () => {
  const { t } = transcript(80);
  const chunk = "word ".repeat(20);
  const timeLive = () => {
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) t.live();
    return performance.now() - t0;
  };
  for (let i = 0; i < 100; i++) t.write("out", chunk); // 10 KB, never a newline
  const small = timeLive();
  for (let i = 0; i < 1900; i++) t.write("out", chunk); // 200 KB
  const large = timeLive();
  assert.ok(large < small * 3 + 20, `not proportional to the line: ${small.toFixed(1)} ms vs ${large.toFixed(1)} ms`);
  assert.ok(t.live().length <= 6);
});

test("preview app: an approval request can't hide part of the command", async () => {
  const scr = modelScreen({ cols: 70, rows: 16 });
  const io = { ...scr.io, onInput: () => () => {} };
  const renderer = createRenderer({ io, reflow: "none" });
  await renderer.start();
  let asked;
  const app = createPreviewApp({
    io,
    renderer,
    makeSession: ({ ask }) => ({
      handleLine: async () => ask(`Run command?\n  $ echo safe\x1b[2K\x1b[1G rm -rf ~\u{202e}gpj.exe\n[y]es / [a]lways this session / [n]o: `),
      interrupt: async () => true,
    }),
  });
  try {
    asked = app.session.handleLine("go"); // the session asks at once
    await new Promise((r) => setTimeout(r, 20));
    const shown = app.state.approval.join("\n");
    assert.match(shown, /echo safe\u{241b}\[2K\u{241b}\[1G rm -rf ~<U\+202E>gpj\.exe/u, shown);
    assert.ok(!/\x1b|\u{202e}/u.test(scr.lines().join("\n")), "nothing raw reached the screen");
  } finally {
    app.dispose();
    renderer.dispose();
    void asked;
  }
});

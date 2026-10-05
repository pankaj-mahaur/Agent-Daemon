// The terminal app (tui/app.mjs, plan Part 6) on a test screen, driven by
// the session controller on the fake Codex app-server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine } from "../src/engine/index.mjs";
import { createSession } from "../src/harness/session.mjs";
import { createApp, reasoningHeadline } from "../src/tui/app.mjs";
import { createRenderer } from "../src/tui/terminal/renderer.mjs";
import { createInputDecoder } from "../src/tui/terminal/input.mjs";
import { modelScreen } from "../testkit/screen.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withApp(fn, { cols = 70, rows = 20, actions = {}, armMs = 60, sessionOpts = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ad-app-"));
  const engine = await createEngine({ home: join(root, "home"), command });
  const session = createSession({ engine, cwd: root, lockDir: join(root, "locks"), ...sessionOpts });
  const scr = modelScreen({ cols, rows });
  const listeners = new Set();
  const io = { ...scr.io, onInput: (f) => (listeners.add(f), () => listeners.delete(f)) };
  const decoder = createInputDecoder({ onEvent: (e) => listeners.forEach((f) => f(e)), escTimeoutMs: 5 });
  const type = (s) => decoder.feed(s);
  const renderer = createRenderer({ io, reflow: "none" });
  await renderer.start();
  const bells = [];
  const app = createApp({ io, renderer, session, cwd: root, header: [[{ text: "HEADER" }]], armMs, actions: { bell: (o) => bells.push(o), ...actions } });
  const text = () => scr.lines().join("\n");
  const until = async (pred, what, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred()) return;
      await sleep(20);
    }
    throw new Error(`timed out waiting for ${what}:\n${text()}`);
  };
  try {
    await fn({ app, scr, type, until, engine, session, text, bells, root });
  } finally {
    app.dispose();
    renderer.dispose();
    session.close();
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("a prompt runs: the answer and the command go to scrollback; the turn ends with a separator", async () => {
  await withApp(async ({ type, until, text, bells }) => {
    assert.match(text(), /HEADER/);
    type("fail-turn\r");
    await until(() => /Worked for/.test(text()), "the turn's end");
    const t = text();
    assert.match(t, /› fail-turn/);
    assert.match(t, /The turn failed/);
    assert.ok(bells.length >= 1, "a bell when the turn ends");
  });
});

test("an approval opens as a modal; arming holds early keys; y approves and the turn completes", async () => {
  await withApp(async ({ app, type, until, text, session }) => {
    type("hello\r");
    await until(() => app.state.modal === "approval-exec", "the approval modal");
    assert.match(text(), /Run command\?/);
    type("y"); // too soon: ignored
    assert.equal(session.state.requests.length, 1);
    await sleep(120);
    type("y");
    await until(() => /✔ approved/.test(text()), "the answer");
    await until(() => /Worked for/.test(text()), "the turn's end");
    assert.match(text(), /pong/);
  });
});

test("Esc in an approval declines; Ctrl+C twice quits", async () => {
  await withApp(async ({ app, type, until, text }) => {
    type("hello\r");
    await until(() => app.state.modal, "the modal");
    type("\x1b");
    await until(() => /✗ declined/.test(text()), "declined");
    let quit = false;
    app.done.then(() => (quit = true));
    type("\x03");
    type("\x03");
    await sleep(20);
    assert.equal(quit, true);
  });
});

test("Enter while a turn runs steers; Tab queues and Tab on an empty composer pulls it back", async () => {
  await withApp(async ({ type, until, text, session, engine }) => {
    type("hang\r");
    await until(() => session.state.activeTurnId, "the running turn");
    type("also this\r");
    await until(() => /steered: also this/.test(text()), "the steer");
    const st = await engine.server.request("debug/state", {});
    assert.ok(st.calls.includes("turn/steer"));
    await until(() => !session.state.activeTurnId, "the steered turn's end");
    type("hang\r");
    await until(() => session.state.activeTurnId, "another running turn");
    type("later please\t");
    await until(() => session.state.queue.length === 1, "the queue");
    await until(() => /queued: later please/.test(text()), "the queued line");
    type("\t");
    await until(() => session.state.queue.length === 0 && /› later please/.test(text()), "pulled back into the composer");
  });
});

test("Ctrl+C: clears the composer, then interrupts, then a second press quits", async () => {
  await withApp(async ({ app, type, until, session }) => {
    type("hang\r");
    await until(() => session.state.activeTurnId, "the running turn");
    type("draft");
    await until(() => app.state.composer === "draft", "typed");
    type("\x03");
    assert.equal(app.state.composer, "");
    await sleep(1600); // past the force-quit window
    type("\x03");
    await until(() => /Interrupting/.test(app.state.note ?? ""), "interrupting");
    await until(() => !session.state.activeTurnId, "the interrupt");
    let quit = false;
    app.done.then(() => (quit = true));
    type("\x03");
    await sleep(20);
    assert.equal(quit, true);
  });
});

test("slash commands: the popup completes, /status reports, /new resets, unknown ones warn", async () => {
  await withApp(async ({ app, type, until, text, session }) => {
    type("/sta");
    await until(() => app.state.popup === "command", "the command popup");
    assert.match(text(), /\/status/);
    type("\r");
    await until(() => /Status/.test(text()) && /sandbox/.test(text()), "the status report");
    type("fail-turn\r");
    await until(() => session.state.thread, "a thread");
    type("/new\r");
    await until(() => !session.state.thread && /New conversation/.test(text()), "a new conversation");
    type("/nope\r");
    await until(() => /Unknown command \/nope/.test(text()), "the warning");
    type("?");
    await until(() => app.state.overlay, "the shortcuts overlay");
    assert.match(text(), /Shortcuts/);
    type("\x1b");
    await until(() => !app.state.overlay, "closed");
  });
});

test("/permissions and /model set the next turn's overrides through pickers", async () => {
  await withApp(async ({ app, type, until, text, session, engine }) => {
    type("/permissions\r");
    await until(() => app.state.popup === "permissions", "the permissions picker");
    type("read\r");
    await until(() => /Permissions: Read only/.test(text()), "set");
    type("fail-turn\r");
    await until(() => /Worked for/.test(text()), "the turn");
    const st = await engine.server.request("debug/state", {});
    assert.deepEqual(st.lastParams["turn/start"].sandboxPolicy, { type: "readOnly" });
    assert.equal(session.state.config.sandbox, "read-only");
  });
});

test("! runs a shell command; its output is labelled unsandboxed", async () => {
  await withApp(async ({ type, until, text }) => {
    type("!echo hi\r");
    await until(() => /unsandboxed/.test(text()), "the shell cell");
  });
});

test("@ opens a file picker from actions.searchFiles; Tab inserts the path", async () => {
  await withApp(
    async ({ app, type, until }) => {
      type("look at @mai");
      await until(() => app.state.popup === "mention", "the mention popup");
      type("\t");
      await until(() => app.state.composer === "look at @src/main.mjs ", "the inserted path");
    },
    { actions: { searchFiles: async (q) => ["src/main.mjs", "src/maintain.mjs"].filter((f) => f.includes(q)) } },
  );
});

test("reasoningHeadline picks the first bold phrase", () => {
  assert.equal(reasoningHeadline("**Checking tests**\n\nmore"), "Checking tests");
  assert.equal(reasoningHeadline("no bold"), null);
  assert.equal(reasoningHeadline("**\x1b[31mred**"), "red");
});

test("a tiny screen still shows the composer; no footer under 10 rows", async () => {
  await withApp(
    async ({ type, until, text }) => {
      type("abc");
      await until(() => /› abc/.test(text()), "the composer");
      assert.ok(!/shortcuts/.test(text()));
    },
    { rows: 8, cols: 30 },
  );
});

test("/warnings lists kept notices and events from a newer Codex", async () => {
  await withApp(async ({ type, until, text }) => {
    type("/warnings\r");
    await until(() => /No warnings in this session/.test(text()), "the empty report");
    type("future\r");
    await until(() => /Worked for/.test(text()), "the future turn");
    assert.match(text(), /not shown: hologramProjection/);
    type("/warnings\r");
    await until(() => /thread\/hologram\/updated ×1/.test(text()), "the unknown event");
  });
});

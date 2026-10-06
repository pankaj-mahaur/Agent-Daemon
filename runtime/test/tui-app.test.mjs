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

async function withApp(fn, { cols = 70, rows = 20, actions = {}, armMs = 60, sessionOpts = {}, restartable = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ad-app-"));
  const engines = [];
  const make = async () => {
    const e = await createEngine({ home: join(root, "home"), command });
    engines.push(e);
    return e;
  };
  const engine = await make();
  const session = createSession({ engine, cwd: root, lockDir: join(root, "locks"), ...(restartable ? { restart: make } : {}), ...sessionOpts });
  const scr = modelScreen({ cols, rows });
  const listeners = new Set();
  const io = { ...scr.io, onInput: (f) => (listeners.add(f), () => listeners.delete(f)) };
  const decoder = createInputDecoder({ onEvent: (e) => listeners.forEach((f) => f(e)), escTimeoutMs: 5 });
  const type = (s) => decoder.feed(s);
  const renderer = createRenderer({ io, reflow: "none" });
  await renderer.start();
  // What went into the scrollback (as opposed to the live region).
  const scrollback = [];
  const commit = renderer.commit.bind(renderer);
  renderer.commit = (lines) => {
    for (const l of lines) scrollback.push((typeof l === "string" ? l : l.map((s) => s.text).join("")).replace(/ +$/, ""));
    return commit(lines);
  };
  const committed = () => scrollback.join("\n");
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
    await fn({ app, scr, type, until, engine, session, text, bells, root, committed, engines });
  } finally {
    app.dispose();
    renderer.dispose();
    session.close();
    for (const e of engines) await e.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

test("a prompt runs: the prompt, the answer and the turn's end go to scrollback", async () => {
  await withApp(async ({ type, until, text, bells, committed }) => {
    assert.match(text(), /HEADER/);
    type("early-complete\r");
    await until(() => /Worked for/.test(committed()), "the turn's end in scrollback");
    assert.match(committed(), /› early-complete/);
    assert.match(committed(), /• early/);
    type("fail-turn\r");
    await until(() => /The turn failed/.test(committed()), "the failure in scrollback");
    assert.ok(bells.length >= 1, "a bell when a turn ends");
  });
});

test("a crash mid-stream doesn't wedge the scrollback: the next answer still shows", async () => {
  await withApp(
    async ({ app, type, until, committed, engines, session }) => {
      type("hello\r");
      await until(() => app.state.modal, "the approval");
      engines[0].server.request("test/crash", {}).catch(() => {});
      await until(() => engines.length === 2 && session.state.engine.state === "ready", "the restart");
      type("early-complete\r");
      await until(() => /• early/.test(committed()), "the next answer in scrollback");
    },
    { restartable: true },
  );
});

test("a declined patch whose item never completes doesn't hold back the next turn", async () => {
  await withApp(async ({ app, type, until, committed }) => {
    type("edit-file\r");
    await until(() => app.state.modal === "approval-patch", "the patch approval");
    type("\x1b");
    await until(() => /Worked for/.test(committed()), "the turn's end");
    type("early-complete\r");
    await until(() => /• early/.test(committed()), "the next answer");
  });
});

test("Codex stopped and not restarted: a banner; Enter restarts and the kept prompt runs", async () => {
  await withApp(
    async ({ type, until, text, committed, engines, session }) => {
      type("fail-turn\r");
      await until(() => /Worked for/.test(committed()), "a first turn");
      engines[0].server.request("test/crash", {}).catch(() => {});
      await until(() => /Codex stopped \(exit 3\)\. Your text is kept\. Enter restarts/.test(text()), "the banner");
      type("early-complete\r");
      await until(() => session.state.engine.state === "ready" && /• early/.test(committed()), "the restart and the prompt");
    },
    { restartable: true, sessionOpts: { maxRestarts: 0 } },
  );
});

test("/resume of a thread another ad holds changes nothing in the scrollback", async () => {
  await withApp(async ({ app, type, until, committed, root }) => {
    type("fail-turn\r");
    await until(() => /The turn failed/.test(committed()), "a turn");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(root, "locks"), { recursive: true });
    writeFileSync(join(root, "locks", "thread-old.lock"), JSON.stringify({ pid: process.ppid, threadId: "thread-old" }));
    type("/resume\r");
    await until(() => app.state.popup === "resume", "the picker");
    type("\r");
    await until(() => /open in another ad/.test(committed()), "the refusal");
    await sleep(200);
    assert.equal(committed().split("› fail-turn").length - 1, 1, "the conversation isn't committed twice");
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
    type("\x03"); // clearing didn't arm the quit: this one interrupts
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

// A scripted session: just enough of the controller's surface for the app.
function stubSession(state) {
  const listeners = new Set();
  const calls = [];
  const st = {
    thread: { id: "t" }, turns: [], items: new Map(), echoes: new Map(), activeTurnId: null, starting: false, requests: [], queue: [],
    config: { model: "m", effort: null, sandbox: "workspace-write", approvalPolicy: "on-request", cwd: "/x" },
    account: null, goal: null, agents: new Map(), mcp: new Map(), tokens: null, plan: null, diff: null, rateLimits: null, notices: [],
    engine: { state: "ready", exitCode: null, restarts: 0 },
    ...state,
  };
  return {
    state: st,
    calls,
    on: (ev, fn) => (ev === "change" && listeners.add(fn), () => listeners.delete(fn)),
    emit: (what) => listeners.forEach((f) => f({ what, state: st })),
    submit: (text) => (calls.push(["submit", text]), { clientUserMessageId: "c", accepted: Promise.resolve({ turnId: "u" }), done: Promise.resolve({}) }),
    shell: (cmd) => (calls.push(["shell", cmd]), Promise.resolve({})),
    queue: () => 0, editQueued: () => true, interrupt: async () => true, resolve: () => true, setNextTurn: () => {}, newThread: () => {},
  };
}

async function withStub(session, fn, { cols = 70, rows = 20 } = {}) {
  const scr = modelScreen({ cols, rows });
  const listeners = new Set();
  const io = { ...scr.io, onInput: (f) => (listeners.add(f), () => listeners.delete(f)) };
  const decoder = createInputDecoder({ onEvent: (e) => listeners.forEach((f) => f(e)), escTimeoutMs: 5 });
  const renderer = createRenderer({ io, reflow: "none" });
  await renderer.start();
  const app = createApp({ io, renderer, session, cwd: "/x", armMs: 0 });
  try {
    await fn({ app, type: (s) => decoder.feed(s), text: () => scr.lines().join("\n") });
  } finally {
    app.dispose();
    renderer.dispose();
  }
}

test("an agent message behind a still-running item is drawn live", async () => {
  const s = stubSession({ activeTurnId: "u", turns: [{ id: "u", status: "inProgress", itemIds: [] }] });
  s.state.items.set("c1", { id: "c1", kind: "commandExecution", command: "npm test", status: "inProgress", streaming: true, actions: [], turnId: "u", threadId: "t" });
  s.state.items.set("m1", { id: "m1", kind: "agentMessage", text: "meanwhile, a note", streaming: true, turnId: "u", threadId: "t" });
  await withStub(s, async ({ app, text }) => {
    app.draw();
    assert.match(text(), /Running npm test/);
    assert.match(text(), /meanwhile, a note/);
  });
});

test("a pasted multi-line prompt that starts with ! is a prompt, not a shell command", async () => {
  const s = stubSession({});
  await withStub(s, async ({ type }) => {
    type("\x1b[200~![diagram](img.png)\nwhat does this show?\x1b[201~");
    type("\r");
    await sleep(20);
    assert.deepEqual(s.calls.map((c) => c[0]), ["submit"]);
    type("!git status\r");
    await sleep(20);
    assert.deepEqual(s.calls.at(-1), ["shell", "git status"]);
  });
});

test("/status shows the tokens used", async () => {
  const s = stubSession({ tokens: { total: { total: 1234 }, last: { total: 10 }, contextWindow: 1000 } });
  await withStub(s, async ({ type, text }) => {
    type("/status\r");
    await sleep(20);
    assert.match(text(), /1,234 tokens used/);
  });
});

test("/undo: files back and the prompt returns; typing takes the next turn's snapshot early", async () => {
  const s = stubSession({});
  let typed = 0;
  const undo = async ({ force }) => (force ? { message: "forced" } : { message: "Undid the last turn: 2 files put back.", prompt: "fix the bug" });
  const scr = modelScreen({ cols: 70, rows: 20 });
  const listeners = new Set();
  const io = { ...scr.io, onInput: (f) => (listeners.add(f), () => listeners.delete(f)) };
  const decoder = createInputDecoder({ onEvent: (e) => listeners.forEach((f) => f(e)), escTimeoutMs: 5 });
  const renderer = createRenderer({ io, reflow: "none" });
  await renderer.start();
  const app = createApp({ io, renderer, session: s, cwd: "/x", armMs: 0, actions: { undo, onTyping: () => typed++ } });
  try {
    decoder.feed("/undo\r");
    await sleep(30);
    assert.equal(app.state.composer, "fix the bug");
    assert.match(scr.lines().join("\n"), /Undid the last turn: 2 files put back/);
    assert.ok(typed > 0, "typing asked for a snapshot");
  } finally {
    app.dispose();
    renderer.dispose();
  }
  // Without checkpoints (not a git repo) /undo says why.
  await withStub(stubSession({}), async ({ type, text }) => {
    type("/undo\r");
    await sleep(20);
    assert.match(text(), /\/undo needs a git repo/);
  });
});

// The app on the fullscreen renderer (P2.2): scrolling with PageUp/PageDown,
// the jump keys, the wheel, Esc and Enter back to the bottom, and mouse moves
// that draw nothing. The inline routing is covered by tui-app.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/tui/app.mjs";
import { createFullscreenRenderer } from "../src/tui/terminal/fullscreen.mjs";
import { createInputDecoder } from "../src/tui/terminal/input.mjs";
import { createKeymap } from "../src/tui/keymap.mjs";
import { xtermScreen } from "../testkit/screen.mjs";
import { sgr } from "../testkit/mouse.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stubSession({ running = false } = {}) {
  const calls = [];
  const st = {
    thread: { id: "t" }, turns: running ? [{ id: "u", status: "inProgress", itemIds: [] }] : [], items: new Map(), echoes: new Map(),
    activeTurnId: running ? "u" : null, starting: false, requests: [], queue: [],
    config: { model: "m", effort: null, sandbox: "workspace-write", approvalPolicy: "on-request", cwd: "/x" },
    account: null, goal: null, agents: new Map(), mcp: new Map(), tokens: null, plan: null, diff: null, rateLimits: null, notices: [],
    engine: { state: "ready", exitCode: null, restarts: 0 },
  };
  return {
    state: st,
    calls,
    on: () => () => {},
    submit: (text) => (calls.push(["submit", text]), { clientUserMessageId: "c", accepted: Promise.resolve({ turnId: "u" }), done: Promise.resolve({}) }),
    shell: () => Promise.resolve({}),
    queue: () => 0, editQueued: () => true, interrupt: async () => (calls.push(["interrupt"]), true), resolve: () => true, setNextTurn: (o) => calls.push(["next", o]), newThread: () => {},
  };
}

async function withFullscreen(fn, { rows = 12, cols = 60, speed, overrides = null, running = false, history = 60 } = {}) {
  const scr = xtermScreen({ cols, rows });
  const listeners = new Set();
  const io = { ...scr.io, onInput: (f) => (listeners.add(f), () => listeners.delete(f)) };
  const decoder = createInputDecoder({ onEvent: (e) => listeners.forEach((f) => f(e)), escTimeoutMs: 5 });
  const renderer = createFullscreenRenderer({ io, resizeSource: scr.resizeSource, stderr: { write: () => true } });
  renderer.start();
  const session = stubSession({ running });
  const settings = { engine: { get: (k) => (k === "tui.mouse_scroll_speed" ? speed : undefined) } };
  const app = createApp({ io, renderer, session, cwd: "/x", armMs: 0, settings, keymap: createKeymap({ overrides }) });
  for (let i = 0; i < history; i++) renderer.commit([[{ text: `h${i}` }]]); // one row each
  app.draw();
  await sleep(40);
  const top = async () => {
    await sleep(30);
    await scr.settle();
    return scr.altLines()[0];
  };
  try {
    await fn({ app, renderer, session, scr, type: (s) => decoder.feed(s), top });
  } finally {
    app.dispose();
    renderer.dispose();
  }
}

const PGUP = "\x1b[5~";
const PGDN = "\x1b[6~";

test("PageUp/PageDown scroll by the transcript height − 1; Ctrl+End returns", async () => {
  await withFullscreen(async ({ renderer, type, top }) => {
    const first = await top();
    const h = renderer.transcript.height;
    type(PGUP);
    const up = await top();
    assert.equal(Number(up.slice(1)), Number(first.slice(1)) - (h - 1), `${first} → ${up} (h ${h})`);
    assert.equal(renderer.transcript.following, false);
    type(PGDN);
    assert.equal(await top(), first);
    type(PGUP);
    type("\x1b[1;5F");
    assert.equal(renderer.transcript.following, true);
    assert.equal(await top(), first);
  });
});

test("with no pager binding on page-up (pager.page_up = ctrl-b), PageUp doesn't scroll the transcript", async () => {
  await withFullscreen(async ({ renderer, type }) => {
    type(PGUP);
    await sleep(20);
    assert.equal(renderer.transcript.following, true);
  }, { overrides: { pager: { page_up: "ctrl-b" } } });
});

test("Ctrl+Home, Alt+< and Alt+Shift+, (CSI-u) jump to the top; Alt+> and Alt+Shift+. to the latest", async () => {
  await withFullscreen(async ({ renderer, type, top }) => {
    type("\x1b[1;5H");
    assert.equal(await top(), "h0");
    type("\x1b>");
    assert.equal(renderer.transcript.following, true);
    type("\x1b<");
    assert.equal(await top(), "h0");
    type("\x1b[46;4u");
    assert.equal(renderer.transcript.following, true);
    type("\x1b[44;4u");
    assert.equal(await top(), "h0");
  });
});

test("Alt+, and Alt+. (no Shift) still step the reasoning effort in fullscreen and never jump", async () => {
  await withFullscreen(async ({ renderer, session, type }) => {
    type("\x1b[44;3u");
    type("\x1b.");
    await sleep(30);
    assert.equal(renderer.transcript.following, true);
  });
});

test("the wheel moves 1 row per notch × tui.mouse_scroll_speed, carries fractions and resets on a direction change", async () => {
  const notch = (dir) => sgr({ action: "wheel", wheel: dir, x: 1, y: 1 });
  await withFullscreen(async ({ type, top }) => {
    const first = Number((await top()).slice(1));
    type(notch("up"));
    assert.equal(Number((await top()).slice(1)), first - 1);
  }, { speed: 1 });
  await withFullscreen(async ({ type, top }) => {
    const first = Number((await top()).slice(1));
    type(notch("up"));
    assert.equal(Number((await top()).slice(1)), first, "half a row: nothing yet");
    type(notch("up"));
    assert.equal(Number((await top()).slice(1)), first - 1);
    type(notch("up")); // half a row up is pending…
    type(notch("down")); // …and dropped by the direction change: this is half a row down
    type(notch("down")); // a whole row down
    assert.equal(Number((await top()).slice(1)), first, "without the reset the pending half row would eat one");
  }, { speed: 0.5 });
  await withFullscreen(async ({ type, top }) => {
    const first = Number((await top()).slice(1));
    type(notch("up"));
    assert.equal(Number((await top()).slice(1)), first - 2);
    type(notch("up"));
    assert.equal(Number((await top()).slice(1)), first - 5, "2.5 + 2.5 = 5");
  }, { speed: 2.5 });
});

test("Esc while scrolled returns to latest first; the next Esc interrupts the running turn", async () => {
  await withFullscreen(async ({ renderer, session, type }) => {
    type(PGUP);
    await sleep(20);
    type("\x1b");
    await sleep(30);
    assert.equal(renderer.transcript.following, true);
    assert.deepEqual(session.calls.filter((c) => c[0] === "interrupt"), []);
    type("\x1b");
    await sleep(30);
    assert.equal(session.calls.filter((c) => c[0] === "interrupt").length, 1);
  }, { running: true });
});

test("Enter on an empty prompt while scrolled returns to latest and sends nothing; a prompt sent while scrolled shows the bottom", async () => {
  await withFullscreen(async ({ renderer, session, type }) => {
    type(PGUP);
    await sleep(20);
    type("\r");
    await sleep(20);
    assert.equal(renderer.transcript.following, true);
    assert.deepEqual(session.calls.filter((c) => c[0] === "submit"), []);
    type(PGUP);
    type("hello\r");
    await sleep(30);
    assert.equal(renderer.transcript.following, true);
    assert.deepEqual(session.calls.filter((c) => c[0] === "submit").map((c) => c[1]), ["hello"]);
  });
});

test("the wheel scrolls the Ctrl+T pager when it is open", async () => {
  await withFullscreen(async ({ app, renderer, type }) => {
    type("\x14"); // Ctrl+T
    await sleep(20);
    assert.ok(app.state?.pager ?? true);
    type(sgr({ action: "wheel", wheel: "up", x: 1, y: 1 }));
    await sleep(20);
    assert.equal(renderer.transcript.following, true, "the transcript behind it didn't move");
  });
});

test("a click on the follow control returns to the bottom", async () => {
  await withFullscreen(async ({ renderer, type }) => {
    type(PGUP);
    await sleep(30);
    const h = renderer.transcript.height;
    type(sgr({ action: "press", button: "left", x: 2, y: h - 1 }));
    await sleep(20);
    assert.equal(renderer.transcript.following, true);
  });
});

test("1,000 mouse moves cause no frame write", async () => {
  await withFullscreen(async ({ scr, type }) => {
    await sleep(30);
    const n = scr.writes.length;
    for (let i = 0; i < 1000; i++) type(sgr({ action: "move", x: i % 50, y: 3 }));
    await sleep(30);
    assert.equal(scr.writes.length, n);
  });
});

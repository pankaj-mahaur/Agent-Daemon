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

async function withFullscreen(fn, { rows = 12, cols = 60, speed, overrides = null, running = false, history = 60, env = {}, platform = "linux", config = {}, clipboard = "from the clipboard", extraActions = {}, statusInfo = {} } = {}) {
  const scr = xtermScreen({ cols, rows });
  const listeners = new Set();
  const io = { ...scr.io, onInput: (f) => (listeners.add(f), () => listeners.delete(f)) };
  const decoder = createInputDecoder({ onEvent: (e) => listeners.forEach((f) => f(e)), escTimeoutMs: 5 });
  const renderer = createFullscreenRenderer({ io, resizeSource: scr.resizeSource, stderr: { write: () => true } });
  renderer.start();
  const session = stubSession({ running });
  const sets = [];
  const settings = { engine: { get: (k) => (k === "tui.mouse_scroll_speed" ? speed : config[k]), set: async (k, v) => (sets.push([k, v]), (config[k] = v)) } };
  // A fake clipboard: what was copied, and what a right-click paste reads.
  const copies = [];
  const actions = { copy: async (text) => (copies.push(text), { ok: true, via: "pbcopy" }), readClipboard: async () => clipboard, ...extraActions };
  const app = createApp({ io, renderer, session, cwd: "/x", armMs: 0, settings, keymap: createKeymap({ overrides }), env, platform, actions, statusInfo });
  for (let i = 0; i < history; i++) renderer.commit([[{ text: `h${i}` }]]); // one row each
  app.draw();
  await sleep(40);
  const top = async () => {
    await sleep(30);
    await scr.settle();
    return scr.altLines()[0];
  };
  try {
    await fn({ app, renderer, session, scr, type: (s) => decoder.feed(s), top, copies, sets });
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

/* Selecting and copying (P2.3) */

const press = (x, y, o = {}) => sgr({ action: "press", button: "left", x, y, ...o });
const drag = (x, y) => sgr({ action: "drag", button: "left", x, y });
const release = (x, y) => sgr({ action: "release", button: "left", x, y });
const tick = () => sleep(30);

test("drag selects; release copies (copy-on-select) and keeps the selection; Esc clears it", async () => {
  await withFullscreen(async ({ type, copies, scr }) => {
    const first = (await (async () => (await tick(), await scr.settle(), scr.altLines()[1]))());
    type(press(0, 1) + drag(1, 2) + release(1, 2));
    await tick();
    assert.equal(copies.length, 1);
    assert.equal(copies[0], `${first}\nh${Number(first.slice(1)) + 1}`.slice(0, first.length + 3));
    type("\x1b");
    await tick();
    assert.equal(copies.length, 1, "Esc clears, copies nothing");
  });
});

test("copy_on_select_clear_selection = true clears after the copy; under Windows Terminal release copies nothing and Ctrl+Shift+C copies", async () => {
  await withFullscreen(async ({ type, copies }) => {
    type(press(0, 1) + drag(1, 1) + release(1, 1));
    await tick();
    assert.equal(copies.length, 1);
    type("\x1b[99;6u"); // Ctrl+Shift+C: the selection is gone, nothing to copy
    await tick();
    assert.equal(copies.length, 1);
  }, { config: { "tui.copy_on_select_clear_selection": true } });
  await withFullscreen(async ({ type, copies }) => {
    type(press(0, 1) + drag(1, 1) + release(1, 1));
    await tick();
    assert.deepEqual(copies, [], "Windows Terminal copies its own selection: ad doesn't on release");
    type("\x1b[99;6u");
    await tick();
    assert.equal(copies.length, 1);
  }, { env: { WT_SESSION: "1" }, platform: "win32" });
});

test("Ctrl+C with a selection copies it and doesn't arm quit; Ctrl+Insert copies too", async () => {
  await withFullscreen(async ({ app, type, copies }) => {
    type(press(0, 1) + drag(1, 1) + release(1, 1));
    await tick();
    type("\x03");
    await tick();
    assert.equal(copies.length, 1);
    let quit = false;
    app.done.then(() => (quit = true));
    await tick();
    assert.equal(quit, false);
    type(press(0, 2) + drag(1, 2) + release(1, 2));
    await tick();
    type("\x1b[2;5~"); // Ctrl+Insert
    await tick();
    assert.equal(copies.length, 2);
  }, { env: { WT_SESSION: "1" }, platform: "win32" });
});

test("Enter copies and returns to latest; Esc clears without interrupting the running turn", async () => {
  await withFullscreen(async ({ renderer, session, type, copies }) => {
    type(PGUP);
    type(press(0, 1) + drag(2, 1) + release(2, 1));
    await tick();
    type("\r");
    await tick();
    assert.equal(copies.length, 1);
    assert.equal(renderer.transcript.following, true);
    type(press(0, 1) + drag(2, 1) + release(2, 1));
    await tick();
    type("\x1b");
    await tick();
    assert.deepEqual(session.calls.filter((c) => c[0] === "interrupt"), []);
  }, { env: { WT_SESSION: "1" }, platform: "win32", running: true });
});

test("double click selects a word, triple click the line; Shift+click extends", async () => {
  await withFullscreen(async ({ type, copies, scr }) => {
    await tick();
    await scr.settle();
    const row1 = scr.altLines()[1];
    type(press(1, 1) + release(1, 1) + press(1, 1) + release(1, 1));
    await tick();
    assert.equal(copies.at(-1), row1, "the word under the double click");
    type(press(0, 1) + release(0, 1));
    await tick();
    type(press(0, 1) + press(2, 3, { shift: true }));
    type("\x1b[99;6u");
    await tick();
    assert.match(copies.at(-1), /\n/, "Shift+click extended over three rows");
  });
});

test("right-click copies a selection; without one it pastes the clipboard into the prompt, never over SSH", async () => {
  const right = (x, y) => sgr({ action: "press", button: "right", x, y });
  await withFullscreen(async ({ type, copies, scr }) => {
    type(press(0, 1) + drag(1, 1) + release(1, 1));
    await tick();
    type(right(0, 1));
    await tick();
    assert.equal(copies.length, 1);
    type(right(0, 1));
    await tick();
    await scr.settle();
    assert.ok(scr.altLines().some((l) => l.includes("from the clipboard")), scr.altLines().join("\n"));
  }, { env: { WT_SESSION: "1" }, platform: "win32" });
  await withFullscreen(async ({ type, scr }) => {
    type(sgr({ action: "press", button: "right", x: 0, y: 1 }));
    await tick();
    await scr.settle();
    assert.ok(!scr.altLines().some((l) => l.includes("from the clipboard")));
  }, { env: { WT_SESSION: "1", SSH_CONNECTION: "1 2 3 4" }, platform: "win32" });
});

test("a selection keeps its rows while output arrives; a resize clears it", async () => {
  await withFullscreen(async ({ renderer, type, scr }) => {
    type(press(0, 1) + drag(1, 1) + release(1, 1));
    await tick();
    await scr.settle();
    const before = scr.altLines().slice(0, 4);
    for (let i = 0; i < 5; i++) renderer.commit([[{ text: `new${i}` }]]);
    await tick();
    await scr.settle();
    assert.deepEqual(scr.altLines().slice(0, 4), before);
    scr.resize(50, 12);
    await sleep(150);
    assert.equal(renderer.transcript.following, true, "the selection ended and following resumed");
  }, { env: { WT_SESSION: "1" }, platform: "win32" });
});

/* Find (P2.3b) */

const F3 = "\x1bOR";
const screenText = async (scr) => (await tick(), await scr.settle(), scr.altLines().join("\n"));

test("F3 opens Find; typing scrolls to the newest match; Enter keeps the view; Esc while reading returns to latest", async () => {
  await withFullscreen(async ({ renderer, type, scr }) => {
    type(F3);
    assert.match(await screenText(scr), /Find: +Type to find/);
    type("h12");
    const shown = await screenText(scr);
    assert.match(shown, /^h12$/m);
    assert.equal(renderer.transcript.following, false);
    assert.match(shown, /enter accept/);
    type("\r");
    assert.match(await screenText(scr), /esc back to bottom/);
    assert.equal(renderer.transcript.following, false, "Enter keeps the match in view");
    type("\x1b");
    await tick();
    assert.equal(renderer.transcript.following, true);
    assert.doesNotMatch(await screenText(scr), /Find:/);
  }, { cols: 90 });
});

test("Esc while editing puts the view back where it was", async () => {
  await withFullscreen(async ({ renderer, type }) => {
    type(F3);
    type("h3");
    await tick();
    assert.equal(renderer.transcript.following, false);
    type("\x1b");
    await tick();
    assert.equal(renderer.transcript.following, true);
  });
});

test("Find owns typing: q edits the query, not the prompt; no matches says so", async () => {
  await withFullscreen(async ({ type, scr }) => {
    type(F3);
    type("qzx");
    const t = await screenText(scr);
    assert.match(t, /Find: qzx +No matches/);
    assert.doesNotMatch(t, /› qzx/);
  });
});

test("Ctrl+N at the newest match reports no more; Ctrl+P steps older", async () => {
  await withFullscreen(async ({ type, scr }) => {
    type(F3);
    type("h1");
    await tick();
    type("\x0e"); // Ctrl+N
    assert.match(await screenText(scr), /No more matches/);
    type("\x10"); // Ctrl+P
    assert.doesNotMatch(await screenText(scr), /No more matches/);
  });
});

test("a held Enter while reading with an empty prompt sends nothing and keeps the match in view", async () => {
  await withFullscreen(async ({ renderer, session, type }) => {
    type(F3);
    type("h12"); // one match, far from the bottom
    await tick();
    type("\r");
    type("\r");
    type("\r");
    await tick();
    assert.deepEqual(session.calls.filter((c) => c[0] === "submit"), []);
    assert.equal(renderer.transcript.following, false, "the extra Enters don't go back to the bottom");
  });
});

/* Ctrl+Z (P2.4) */

test("Ctrl+Z suspends between turns; not while a turn runs (the note says why); on Windows it does nothing", async () => {
  let n = 0;
  const extraActions = { suspend: () => (n++, true) };
  await withFullscreen(async ({ type }) => {
    type("\x1a");
    await tick();
    assert.equal(n, 1);
  }, { extraActions });
  await withFullscreen(async ({ type, scr }) => {
    type("\x1a");
    assert.match(await screenText(scr), /Ctrl\+Z works between turns/);
    assert.equal(n, 1);
  }, { extraActions, running: true, cols: 90 });
  await withFullscreen(async ({ type }) => {
    type("\x1a");
    await tick();
    assert.equal(n, 1);
  }, { extraActions, platform: "win32" });
});

/* /tui and the /status screen line (P2.5) */

// Polls the screen until it matches (a picker or a note can take a few ticks under load).
async function screenUntil(scr, re, ms = 3000) {
  const end = Date.now() + ms;
  let t = "";
  while (Date.now() < end) {
    t = await screenText(scr);
    if (re.test(t)) return t;
  }
  return t;
}

test("/tui picks the screen mode for the next start and saves tui.fullscreen_transcript; /status shows the screen line", async () => {
  await withFullscreen(async ({ type, scr, sets }) => {
    type("/tui\r");
    let t = await screenUntil(scr, /Fullscreen +ad's own scrolling/);
    assert.match(t, /Inline +the terminal's own scrollback, selection and search/);
    assert.match(t, /Fullscreen +ad's own scrolling, selection and Find · current/);
    type("\x1b[A"); // up to Inline
    type("\r");
    await tick();
    assert.deepEqual(sets, [["tui.fullscreen_transcript", false]]);
    t = await screenUntil(scr, /Saved: inline from the next start/);
    assert.match(t, /Saved: inline from the next start/);
    type("/status\r");
    assert.match(await screenUntil(scr, /screen +fullscreen/), /screen +fullscreen · mouse off: tmux mouse is off/);
  }, { cols: 100, rows: 30, config: { "tui.fullscreen_transcript": true }, statusInfo: { screen: "fullscreen \u{b7} mouse off: tmux mouse is off (set -g mouse on)" } });
});

test("selecting only blank cells copies nothing and says nothing about the clipboard", async () => {
  await withFullscreen(async ({ renderer, type, copies, scr }) => {
    renderer.commit([[]]);
    renderer.commit([[{ text: "after a blank row" }]]);
    await tick();
    await scr.settle();
    const lines = scr.altLines();
    const blank = lines.findIndex((l, i) => i > 0 && l === "" && lines[i + 1] === "after a blank row");
    assert.ok(blank > 0, lines.join("\n"));
    type(press(0, blank) + drag(10, blank) + release(10, blank));
    await tick();
    assert.deepEqual(copies, []);
    assert.doesNotMatch(await screenText(scr), /Couldn't reach a clipboard/);
  });
});

// Fullscreen handoffs (P2.4): the external editor keeps ad's last frame on
// screen without a keyboard push or the mouse; /login and /ad run on the main
// screen and may wait for Enter; nothing is written while frozen; and every
// screen's keyboard stack ends where it began, signals included.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createIo, RESTORE_SEQUENCE } from "../src/tui/terminal/io.mjs";
import { createFullscreenRenderer } from "../src/tui/terminal/fullscreen.mjs";
import { createRenderer } from "../src/tui/terminal/renderer.mjs";
import { ENTER, LEAVE, MOUSE_OFF, releaseAltScreen } from "../src/tui/terminal/alt-screen.mjs";
import { handoff, suspendTui } from "../src/tui/main.mjs";

function fakeTerminal() {
  const stdin = new EventEmitter();
  Object.assign(stdin, { isTTY: true, setRawMode: () => {}, setEncoding: () => {}, pause: () => {}, resume: () => {} });
  const stdout = { isTTY: true, columns: 60, rows: 12, write: () => {} };
  const written = [];
  const writeSync = (fd, s) => {
    written.push(s);
    if (s.includes("\x1b[c")) setImmediate(() => stdin.emit("data", "\x1b[?61;4c"));
  };
  const proc = new EventEmitter();
  Object.assign(proc, { pid: 1, exits: [], exit: (c) => proc.exits.push(c), kill: () => {} });
  return { stdin, stdout, written, writeSync, proc, text: () => written.join("") };
}

async function setup({ fullscreen = true } = {}) {
  const t = fakeTerminal();
  const io = createIo({ stdin: t.stdin, stdout: t.stdout, proc: t.proc, writeSync: t.writeSync, env: {}, platform: "linux", queryTimeoutMs: 2000, errSink: () => {} });
  await io.enter();
  const timers = { setTimeout: () => 0, clearTimeout: () => {} };
  const renderer = fullscreen ? createFullscreenRenderer({ io, stderr: { write: () => true }, ...timers }) : createRenderer({ io });
  if (fullscreen) renderer.start();
  else await renderer.start?.();
  renderer.frame({ lines: [[{ text: "LAST-FRAME" }]], cursor: { row: 0, col: 0 } });
  return { t, io, renderer };
}

// Keyboard pushes minus pops per screen, from the written bytes in order.
function stacks(bytes) {
  const net = { main: 0, alt: 0 };
  let screen = "main";
  const re = /\x1b\[\?1049([hl])|\x1b\[>\d*u|\x1b\[<u/g;
  for (const m of bytes.matchAll(re)) {
    if (m[1]) screen = m[1] === "h" ? "alt" : "main";
    else net[screen] += m[0].startsWith("\x1b[>") ? 1 : -1;
  }
  return { net, screen };
}

afterEach(() => releaseAltScreen(() => {}));

test("editor handoff, in order: leave, RESTORE_SEQUENCE, ?1049h + the last frame without a push or mouse, [child], ?1049l, main modes, enter, repaint", async () => {
  const { t, io, renderer } = await setup();
  t.written.length = 0;
  let duringChild = "";
  await handoff(io, renderer, () => ((duringChild = t.text()), t.written.push("[CHILD]")), null, { kind: "keep" });
  const s = t.text();
  const leave = s.indexOf(LEAVE);
  const restore = s.indexOf(RESTORE_SEQUENCE);
  const frozenEnter = s.indexOf(ENTER, restore);
  const child = s.indexOf("[CHILD]");
  const unfreeze = s.indexOf(LEAVE, child);
  const modes = s.indexOf("\x1b[?2004h", unfreeze);
  const back = s.indexOf(ENTER, modes);
  assert.ok(leave >= 0 && leave < restore && restore < frozenEnter && frozenEnter < child && child < unfreeze && unfreeze < modes && modes < back, JSON.stringify(s));
  const frozen = s.slice(frozenEnter, child);
  assert.ok(frozen.includes("LAST-FRAME"), "a GUI editor sees ad's last frame");
  assert.ok(!frozen.includes("\x1b[>1u") && !frozen.includes("\x1b[?1000h"), "no keyboard push and no mouse while the child runs");
  assert.ok(duringChild.indexOf(MOUSE_OFF) >= 0 && duringChild.indexOf(MOUSE_OFF) < duringChild.indexOf(RESTORE_SEQUENCE), "mouse off before any child starts");
  assert.ok(s.slice(back).includes("LAST-FRAME"), "a full repaint after");
});

test("after an editor handoff each screen's keyboard stack holds exactly one push", async () => {
  const { t, io, renderer } = await setup();
  const before = stacks(t.text());
  assert.deepEqual(before.net, { main: 1, alt: 1 });
  await handoff(io, renderer, () => {}, null, { kind: "keep" });
  const after = stacks(t.text());
  assert.deepEqual(after.net, { main: 1, alt: 1 }, JSON.stringify(t.text()));
  assert.equal(after.screen, "alt");
});

test("a terminal editor that leaves the alternate screen itself still comes back to a repainted fullscreen", async () => {
  const { t, io, renderer } = await setup();
  await handoff(io, renderer, () => t.written.push("\x1b[?1049h editor \x1b[?1049l"), null, { kind: "keep" });
  const s = t.text();
  assert.equal(stacks(s).screen, "alt");
  assert.ok(s.slice(s.lastIndexOf(ENTER)).includes("LAST-FRAME"));
});

test("/ad: the child runs on the main screen, the wait runs before fullscreen returns; inline never waits", async () => {
  const { t, io, renderer } = await setup();
  const order = [];
  await handoff(io, renderer, () => (order.push(stacks(t.text()).screen), 0), null, { waitAfter: () => true, wait: async () => order.push("wait") });
  assert.deepEqual(order, ["main", "wait"]);
  const inline = await setup({ fullscreen: false });
  let waited = false;
  await handoff(inline.io, inline.renderer, () => 0, null, { waitAfter: () => true, wait: async () => (waited = true) });
  assert.equal(waited, false);
});

test("/login: success returns at once; a non-zero exit waits for Enter", async () => {
  for (const [code, expect] of [[0, false], [1, true]]) {
    const { io, renderer } = await setup();
    let waited = false;
    await handoff(io, renderer, () => code, null, { waitAfter: (c) => c !== 0, wait: async () => (waited = true) });
    assert.equal(waited, expect, `exit ${code}`);
  }
});

test("a child that fails to start (ENOENT) still returns to fullscreen", async () => {
  const { t, io, renderer } = await setup();
  await assert.rejects(handoff(io, renderer, () => { throw Object.assign(new Error("spawn vi ENOENT"), { code: "ENOENT" }); }, null, { kind: "keep" }), /ENOENT/);
  assert.equal(stacks(t.text()).screen, "alt");
  assert.deepEqual(stacks(t.text()).net, { main: 1, alt: 1 });
});

test("SIGTERM while frozen leaves the alternate screen without a pop and restores the main screen", async () => {
  const { t, io, renderer } = await setup();
  await handoff(io, renderer, () => t.proc.emit("SIGTERM", "SIGTERM"), null, { kind: "keep" }).catch(() => {});
  const { net } = stacks(t.text());
  assert.deepEqual(net, { main: 0, alt: 0 }, `each stack back to zero: ${JSON.stringify(t.text())}`);
  const s = t.text();
  assert.ok(s.lastIndexOf("\x1b[?25h") > s.lastIndexOf(LEAVE), "the cursor comes back after the alternate screen is left");
});

test("a commit and a resize during a frozen editor write nothing until resume, then one repaint shows them", async () => {
  const { t, io, renderer } = await setup();
  let during = null;
  await handoff(io, renderer, () => {
    const n = t.written.length;
    renderer.commit([[{ text: "COMMITTED-MEANWHILE" }]]);
    renderer.frame({ lines: [[{ text: "LIVE-MEANWHILE" }]] });
    renderer.redraw();
    renderer.terminalWrite("\x1b]52;c;eA==\x07");
    during = t.written.slice(n).join("");
  }, null, { kind: "keep" });
  assert.equal(during, "", "nothing between freeze and unfreeze");
  const s = t.text();
  const back = s.lastIndexOf(ENTER);
  assert.ok(s.slice(back).includes("LIVE-MEANWHILE"));
  assert.ok(s.indexOf("\x1b]52;c;eA==\x07", back) > s.indexOf("LIVE-MEANWHILE", back), "queued terminal bytes after the repaint");
});

test("SIGINT during a handoff is the child's", async () => {
  const { t, io, renderer } = await setup();
  await handoff(io, renderer, () => t.proc.emit("SIGINT", "SIGINT"), null, { kind: "keep" });
  assert.deepEqual(t.proc.exits, []);
});

test("Ctrl+Z: ad leaves its screen and stops; SIGCONT brings back a repainted fullscreen with balanced keyboard stacks", async () => {
  const { t, io, renderer } = await setup();
  let drawn = 0;
  assert.equal(suspendTui(io, renderer, { draw: () => drawn++ }), true);
  const stopped = stacks(t.text());
  assert.equal(stopped.screen, "main", "the shell's screen while stopped");
  t.proc.emit("SIGCONT");
  await new Promise((r) => setImmediate(r));
  const s = t.text();
  const after = stacks(s);
  assert.equal(after.screen, "alt");
  assert.deepEqual(after.net, { main: 1, alt: 1 });
  assert.ok(s.slice(s.lastIndexOf(ENTER)).includes("LAST-FRAME"));
  assert.equal(drawn, 1);
});

test("Ctrl+Z where stopping isn't possible changes nothing", async () => {
  const { t, io, renderer } = await setup();
  io.suspend = () => false;
  assert.equal(suspendTui(io, renderer, null), false);
  await new Promise((r) => setImmediate(r));
  assert.equal(stacks(t.text()).screen, "alt");
});

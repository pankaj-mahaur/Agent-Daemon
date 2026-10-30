// Every exit path leaves the alternate screen before restoring the terminal's
// modes (P2.1), and a signal during a handoff doesn't undo the main screen's
// modes twice (T2-M7). Byte level, against a fake terminal and process.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createIo, RESTORE_SEQUENCE } from "../src/tui/terminal/io.mjs";
import { LEAVE, enterAltScreen, isActive, leaveBytes, releaseAltScreen } from "../src/tui/terminal/alt-screen.mjs";

function fakeTerminal() {
  const stdin = new EventEmitter();
  Object.assign(stdin, { isTTY: true, setRawMode: () => {}, setEncoding: () => {}, pause: () => {}, resume: () => {} });
  const stdout = { isTTY: true, columns: 100, rows: 30, write: () => {} };
  const written = [];
  const writeSync = (fd, s) => {
    written.push(s);
    if (s.includes("\x1b[c")) setImmediate(() => stdin.emit("data", "\x1b[?61;4c"));
  };
  const proc = new EventEmitter();
  Object.assign(proc, { pid: 4242, exits: [], exit: (c) => proc.exits.push(c), kill: () => {} });
  return { stdin, stdout, written, writeSync, proc, text: () => written.join("") };
}

async function entered({ fullscreen = true } = {}) {
  const t = fakeTerminal();
  const io = createIo({ stdin: t.stdin, stdout: t.stdout, proc: t.proc, writeSync: t.writeSync, env: {}, platform: "linux", queryTimeoutMs: 2000, errSink: () => {} });
  await io.enter();
  if (fullscreen) enterAltScreen(io.writeSync, { mouse: true });
  t.written.length = 0;
  return { t, io };
}

const count = (s, sub) => s.split(sub).length - 1;

afterEach(() => releaseAltScreen(() => {}));

test("io.restore leaves the alternate screen first: exactly the leave bytes, then RESTORE_SEQUENCE", async () => {
  const { t, io } = await entered();
  io.restore();
  assert.equal(t.text(), leaveBytes({ keyboard: true }) + RESTORE_SEQUENCE);
  assert.equal(isActive(), false);
});

for (const [name, fire] of [
  ["exit", (p) => p.emit("exit", 0)],
  ["SIGTERM", (p) => p.emit("SIGTERM", "SIGTERM")],
  ["SIGHUP", (p) => p.emit("SIGHUP", "SIGHUP")],
  ["SIGBREAK", (p) => p.emit("SIGBREAK", "SIGBREAK")],
  ["SIGINT", (p) => p.emit("SIGINT", "SIGINT")],
  ["uncaughtException", (p) => p.emit("uncaughtException", new Error("boom"))],
  ["unhandledRejection", (p) => p.emit("unhandledRejection", new Error("boom"))],
]) {
  test(`${name}: the leave bytes come before RESTORE_SEQUENCE, mouse off and paste off follow`, async () => {
    const { t } = await entered();
    fire(t.proc);
    const s = t.text();
    const leave = s.indexOf(LEAVE);
    assert.ok(leave >= 0, `no ?1049l: ${JSON.stringify(s)}`);
    assert.ok(s.indexOf(RESTORE_SEQUENCE) > leave);
    assert.ok(s.indexOf("\x1b[?1000l") < leave, "mouse off before leaving");
    assert.ok(s.includes("\x1b[?2004l"));
  });
}

test("restore twice writes the leave bytes once", async () => {
  const { t, io } = await entered();
  io.restore();
  io.restore();
  t.proc.emit("exit", 0);
  assert.equal(count(t.text(), LEAVE), 1);
});

test("inline restore writes no alternate-screen bytes", async () => {
  const { t, io } = await entered({ fullscreen: false });
  io.restore();
  assert.equal(t.text(), RESTORE_SEQUENCE);
  assert.ok(!t.text().includes("?1049"));
});

for (const fullscreen of [false, true]) {
  test(`SIGTERM during a handoff pops the main keyboard stack once in total and still resets the cursor, autowrap, paste and focus (${fullscreen ? "fullscreen" : "inline"})`, async () => {
    const { t, io } = await entered({ fullscreen });
    let release;
    const child = io.handoff(() => new Promise((r) => (release = r)));
    await new Promise((r) => setImmediate(r));
    const atChild = t.written.length;
    t.proc.emit("SIGTERM", "SIGTERM");
    release();
    await child;
    const s = t.text();
    // The alternate screen's own stack is popped before ?1049l; the main one after.
    const main = fullscreen ? s.slice(s.indexOf(LEAVE) + LEAVE.length) : s;
    assert.equal(count(main, "\x1b[<u"), 1, JSON.stringify(s));
    assert.equal(count(main, "\x1b[>4;0m"), 1, "modifyOtherKeys reset once");
    const after = t.written.slice(atChild).join("");
    for (const seq of ["\x1b[?25h", "\x1b[?7h", "\x1b[?2004l", "\x1b[?1004l"]) assert.ok(after.includes(seq), `${JSON.stringify(seq)} after the child`);
    if (fullscreen) assert.equal(count(s, LEAVE), 1, "left once, at the handoff");
    assert.deepEqual(t.proc.exits, [143]);
  });
}

test("a handoff and a suspend leave the alternate screen before giving the terminal away", async () => {
  const { t, io } = await entered();
  await io.handoff(() => {});
  const s = t.text();
  assert.ok(s.indexOf(LEAVE) >= 0 && s.indexOf(LEAVE) < s.indexOf(RESTORE_SEQUENCE));
  const b = await entered();
  b.io.suspend();
  const u = b.t.text();
  assert.ok(u.indexOf(LEAVE) >= 0 && u.indexOf(LEAVE) < u.indexOf(RESTORE_SEQUENCE));
});

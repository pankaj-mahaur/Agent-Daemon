// Terminal I/O (tui/terminal/io.mjs) against a fake terminal: negotiation,
// late kitty upgrade, restore balance and idempotence, exit paths, handoff,
// suspend, CPR.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createIo, RESTORE_SEQUENCE } from "../src/tui/terminal/io.mjs";

// A fake terminal. `answers(query)` returns what the terminal replies.
function fakeTerminal({ kitty = false, sync = true, lateKitty = false, silent = false, cprAt = [5, 1] } = {}) {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.raw = [];
  stdin.setRawMode = (on) => stdin.raw.push(on);
  stdin.setEncoding = () => {};
  stdin.paused = true;
  stdin.pause = () => (stdin.paused = true);
  stdin.resume = () => (stdin.paused = false);
  const stdout = { isTTY: true, columns: 100, rows: 30, writes: [], write: (s) => stdout.writes.push(s) };
  const written = [];
  const reply = (s) => setImmediate(() => stdin.emit("data", s));
  const writeSync = (fd, s) => {
    written.push(s);
    if (silent) return;
    if (s.includes("\x1b[?u") && kitty && !lateKitty) reply("\x1b[?1u");
    if (s.includes("\x1b[?2026$p")) reply(`\x1b[?2026;${sync ? 2 : 0}$y`);
    if (s.includes("\x1b[c")) {
      reply("\x1b[?61;4c");
      if (kitty && lateKitty) setTimeout(() => stdin.emit("data", "\x1b[?1u"), 5);
    }
    if (s.includes("\x1b[6n")) reply(`\x1b[${cprAt[0]};${cprAt[1]}R`);
  };
  const proc = new EventEmitter();
  proc.pid = 4242;
  proc.exits = [];
  proc.exit = (code) => proc.exits.push(code);
  proc.kills = [];
  proc.kill = (pid, sig) => proc.kills.push([pid, sig]);
  return { stdin, stdout, written, writeSync, proc };
}

function make(t, opts = {}) {
  const errors = [];
  const io = createIo({
    stdin: t.stdin,
    stdout: t.stdout,
    proc: t.proc,
    writeSync: t.writeSync,
    env: {},
    platform: "linux",
    queryTimeoutMs: 50,
    errSink: (e) => errors.push(e),
    ...opts,
  });
  return { io, errors };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test("enter: raw mode, paste + kitty push + queries with DA1 last; no kitty → modifyOtherKeys", async () => {
  const t = fakeTerminal();
  const { io } = make(t);
  const caps = await io.enter();
  assert.deepEqual(t.stdin.raw, [true]);
  const first = t.written[0];
  assert.ok(first.startsWith("\x1b[?2004h\x1b[>1u\x1b[?u\x1b[?2026$p"), JSON.stringify(first));
  assert.ok(first.endsWith("\x1b[c"), "DA1 is the sentinel, sent last");
  assert.equal(caps.kitty, false);
  assert.equal(caps.modifyOtherKeys, true);
  assert.equal(caps.sync, true);
  assert.deepEqual(caps.da1, [61, 4]);
  assert.ok(t.written.includes("\x1b[>4;2m"));
  assert.equal(t.stdin.paused, false, "reading input");
  io.restore();
});

test("enter: a kitty reply before DA1 means no modifyOtherKeys", async () => {
  const t = fakeTerminal({ kitty: true });
  const { io } = make(t);
  const caps = await io.enter();
  assert.equal(caps.kitty, true);
  assert.equal(caps.modifyOtherKeys, false);
  assert.ok(!t.written.includes("\x1b[>4;2m"));
  io.restore();
});

test("a late kitty reply (after DA1, as under ConPTY) still upgrades and turns modifyOtherKeys off", async () => {
  const t = fakeTerminal({ kitty: true, lateKitty: true });
  const { io } = make(t);
  const caps = await io.enter();
  // Under a loaded test run the late reply can land before enter() resolves,
  // so only the end state is asserted: upgraded, and modifyOtherKeys turned off.
  for (let i = 0; i < 300 && !caps.kitty; i++) await tick(10);
  assert.equal(caps.kitty, true);
  assert.equal(caps.modifyOtherKeys, false);
  // Either modifyOtherKeys was never turned on (the reply came early) or it was turned off again.
  assert.ok(!t.written.includes("\x1b[>4;2m") || t.written.includes("\x1b[>4;0m"));
  io.restore();
});

test("enter gives up waiting after the query timeout on a silent terminal", async () => {
  const t = fakeTerminal({ silent: true });
  const { io } = make(t);
  const started = Date.now();
  const caps = await io.enter();
  assert.ok(Date.now() - started < 1000);
  assert.equal(caps.da1, null);
  assert.equal(caps.sync, false);
  io.restore();
});

test("enter refuses a non-TTY", async () => {
  const t = fakeTerminal();
  t.stdout.isTTY = false;
  const { io } = make(t);
  await assert.rejects(io.enter(), /interactive terminal/);
});

test("Windows: no focus reporting", async () => {
  const t = fakeTerminal();
  const { io } = make(t, { platform: "win32" });
  await io.enter();
  assert.ok(!t.written.join("").includes("\x1b[?1004h"));
  io.restore();
  const t2 = fakeTerminal();
  const { io: io2 } = make(t2, { platform: "linux" });
  await io2.enter();
  assert.ok(t2.written.join("").includes("\x1b[?1004h"));
  io2.restore();
});

test("restore undoes every mode enter can set, and more", () => {
  const pairs = [
    ["\x1b[?2004h", "\x1b[?2004l"],
    ["\x1b[>1u", "\x1b[<u"],
    ["\x1b[>4;2m", "\x1b[>4;0m"],
    ["\x1b[?1004h", "\x1b[?1004l"],
    ["\x1b[?2026h", "\x1b[?2026l"],
    ["\x1b[?7l", "\x1b[?7h"],
    ["\x1b[?25l", "\x1b[?25h"],
  ];
  for (const [, off] of pairs) assert.ok(RESTORE_SEQUENCE.includes(off), JSON.stringify(off));
  assert.ok(RESTORE_SEQUENCE.includes("\x1b[0 q"), "cursor shape reset");
  assert.ok(!/\x1b\[[23]J/.test(RESTORE_SEQUENCE), "never clears the screen");
});

test("restore is synchronous, idempotent, and leaves raw mode", async () => {
  const t = fakeTerminal();
  const { io } = make(t);
  await io.enter();
  const before = t.written.length;
  io.restore();
  io.restore();
  assert.equal(t.written.length, before + 1, "one restore write");
  assert.equal(t.written.at(-1), RESTORE_SEQUENCE);
  assert.deepEqual(t.stdin.raw, [true, false]);
  assert.equal(t.stdin.paused, true);
  assert.equal(t.stdin.listenerCount("data"), 0);
});

for (const [event, arg, code] of [
  ["exit", 0, null],
  ["SIGTERM", "SIGTERM", 143],
  ["SIGHUP", "SIGHUP", 129],
  ["SIGBREAK", "SIGBREAK", 149],
  ["uncaughtException", new Error("boom"), 1],
  ["unhandledRejection", new Error("nope"), 1],
]) {
  test(`exit path ${event} restores the terminal`, async () => {
    const t = fakeTerminal();
    const { io, errors } = make(t);
    await io.enter();
    t.proc.emit(event, arg);
    assert.equal(t.written.at(-1), RESTORE_SEQUENCE);
    assert.equal(io.entered, false);
    if (code !== null) assert.deepEqual(t.proc.exits, [code]);
    if (arg instanceof Error) assert.equal(errors[0], arg, "the error is reported");
    await io.close();
  });
}

test("process warnings go to the error sink", async () => {
  const t = fakeTerminal();
  const { io, errors } = make(t);
  await io.enter();
  const w = new Error("deprecated");
  t.proc.emit("warning", w);
  assert.equal(errors[0], w);
  await io.close();
});

test("close restores and unhooks the process listeners", async () => {
  const t = fakeTerminal();
  const { io } = make(t);
  await io.enter();
  assert.ok(t.proc.listenerCount("exit") >= 1);
  await io.close();
  for (const ev of ["exit", "SIGTERM", "uncaughtException", "warning"]) assert.equal(t.proc.listenerCount(ev), 0, ev);
  assert.equal(t.written.at(-1), RESTORE_SEQUENCE);
});

test("input events reach listeners; replies don't", async () => {
  const t = fakeTerminal();
  const { io } = make(t);
  const got = [];
  const off = io.onInput((e) => got.push(e.type === "key" ? e.name : e.type));
  await io.enter();
  t.stdin.emit("data", "a\x1b[?2026;2$y\r");
  off();
  t.stdin.emit("data", "b");
  assert.deepEqual(got, ["text", "enter"]);
  io.restore();
});

test("cpr returns the cursor position, or null on timeout or before enter", async () => {
  const t = fakeTerminal({ cprAt: [7, 3] });
  const { io } = make(t);
  assert.equal(await io.cpr(), null);
  await io.enter();
  assert.deepEqual(await io.cpr(), { row: 7, col: 3 });
  io.restore();
});

// A terminal that only answers CPR when told to.
function manualCpr(t) {
  const answers = [];
  const writeSync = t.writeSync;
  t.writeSync = (fd, s) => {
    if (s.includes("\x1b[6n")) answers.push(s);
    else writeSync(fd, s);
  };
  return (row, col) => t.stdin.emit("data", `\x1b[${row};${col}R`);
}

test("a CPR that timed out: its late answer (even 1;2R) is dropped, not a key and not the next answer", async () => {
  const t = fakeTerminal();
  const answer = manualCpr(t);
  const { io } = make(t);
  await io.enter();
  const keys = [];
  io.onInput((e) => keys.push(e));
  assert.equal(await io.cpr(20), null, "first query times out");
  const second = io.cpr(200);
  answer(1, 2); // late answer to the first query: looks like Shift+F3
  answer(9, 1); // the real answer to the second
  assert.deepEqual(await second, { row: 9, col: 1 });
  assert.deepEqual(keys, [], "nothing reached input listeners");
  io.restore();
});

test("an unanswered CPR stops swallowing Shift+F3 after the grace period", async () => {
  const t = fakeTerminal();
  manualCpr(t);
  const { io } = make(t, { staleCprGraceMs: 30 });
  await io.enter();
  const keys = [];
  io.onInput((e) => keys.push(e.type === "key" ? `${e.shift ? "S-" : ""}${e.name}` : e.type));
  assert.equal(await io.cpr(10), null);
  await tick(60);
  t.stdin.emit("data", "\x1b[1;2R");
  assert.deepEqual(keys, ["S-f3"]);
  io.restore();
});

test("concurrent enter() calls share one negotiation", async () => {
  const t = fakeTerminal();
  const { io } = make(t);
  // Snapshot at resolution time: a second call that returns early sees no result yet.
  const [a, b] = await Promise.all([io.enter(), io.enter()].map((p) => p.then((c) => ({ ...c }))));
  assert.deepEqual(a, b);
  assert.equal(b.modifyOtherKeys, true, "the second call waited for negotiation");
  assert.equal(t.written.filter((s) => s.includes("\x1b[c")).length, 1, "queries sent once");
  io.restore();
});

test("restore during negotiation ends enter() without turning modes back on", async () => {
  const t = fakeTerminal({ silent: true });
  const { io } = make(t, { queryTimeoutMs: 200 });
  const p = io.enter();
  await tick(5);
  io.restore();
  await p;
  assert.equal(t.written.at(-1), RESTORE_SEQUENCE);
  assert.ok(!t.written.includes("\x1b[>4;2m"));
});

test("re-entry after restoring mid-paste: the next session's input is not swallowed", async () => {
  const t = fakeTerminal();
  const { io } = make(t);
  await io.enter();
  t.stdin.emit("data", "\x1b[200~half a paste");
  io.restore();
  const got = [];
  io.onInput((e) => got.push(e.type === "key" ? e.name : e.type));
  const caps = await io.enter();
  assert.deepEqual(caps.da1, [61, 4], "negotiation worked");
  t.stdin.emit("data", "\r\x03");
  assert.deepEqual(got, ["enter", "c"]);
  io.restore();
});

test("after restore, a pending paste timer emits nothing", async () => {
  const t = fakeTerminal();
  const { io } = make(t, { decoderOptions: { pasteIdleMs: 15 } });
  await io.enter();
  const got = [];
  io.onInput((e) => got.push(e.type));
  t.stdin.emit("data", "\x1b[200~half a paste");
  io.restore();
  await tick(40);
  assert.deepEqual(got, []);
});

test("restore alone unhooks process listeners (no leak across sessions)", async () => {
  const t = fakeTerminal();
  for (let i = 0; i < 12; i++) {
    const { io } = make(t);
    await io.enter();
    io.restore();
  }
  for (const ev of ["exit", "SIGINT", "SIGTERM", "uncaughtException", "warning"]) assert.equal(t.proc.listenerCount(ev), 0, ev);
});

test("Ctrl+C / Ctrl+Break during a handoff belong to the child; SIGTERM still restores", async () => {
  const t = fakeTerminal();
  let clock = 1000;
  const { io } = make(t, { now: () => clock });
  await io.enter();
  await io.handoff(async () => {
    t.proc.emit("SIGINT", "SIGINT");
    t.proc.emit("SIGBREAK", "SIGBREAK");
  });
  assert.deepEqual(t.proc.exits, [], "ad keeps running");
  assert.equal(io.entered, true);
  // One Ctrl+C more than the child needed, landing as it exits: still the child's.
  clock += 1000;
  t.proc.emit("SIGINT", "SIGINT");
  assert.deepEqual(t.proc.exits, [], "a Ctrl+C right after the handoff doesn't quit ad");
  clock += 1000;
  t.proc.emit("SIGINT", "SIGINT");
  assert.deepEqual(t.proc.exits, [130], "outside a handoff SIGINT still quits cleanly");

  const t2 = fakeTerminal();
  const { io: io2 } = make(t2);
  await io2.enter();
  await io2.handoff(async () => t2.proc.emit("SIGTERM", "SIGTERM"));
  assert.deepEqual(t2.proc.exits, [143]);
  assert.equal(t2.written.at(-1), RESTORE_SEQUENCE, "not re-entered after the restore");
});

test("restore + enter inside a handoff: still one input listener, keys arrive once", async () => {
  const t = fakeTerminal();
  const { io } = make(t);
  await io.enter();
  const got = [];
  io.onInput((e) => got.push(e.type));
  await io.handoff(async () => {
    io.restore();
    await io.enter();
  });
  assert.equal(t.stdin.listenerCount("data"), 1);
  t.stdin.emit("data", "a");
  assert.deepEqual(got, ["text"]);
  io.restore();
});

test("a handoff started during negotiation: modifyOtherKeys is not written to the child's terminal", async () => {
  const t = fakeTerminal({ silent: true });
  const { io } = make(t, { queryTimeoutMs: 30 });
  const entering = io.enter();
  let duringChild = null;
  await io.handoff(async () => {
    const before = t.written.length;
    await entering; // negotiation finishes while the child owns the terminal
    duringChild = t.written.slice(before);
  });
  assert.ok(!duringChild.some((s) => s.includes("\x1b[>4;2m")), JSON.stringify(duringChild));
  assert.ok(t.written.at(-1).includes("\x1b[>4;2m"), "added when the terminal comes back");
  io.restore();
});

test("suspend that cannot stop the process takes the terminal back", async () => {
  const t = fakeTerminal();
  t.proc.kill = () => {
    throw new Error("EPERM");
  };
  const { io, errors } = make(t);
  await io.enter();
  assert.equal(io.suspend(), false);
  assert.equal(errors[0].message, "EPERM");
  assert.equal(t.stdin.raw.at(-1), true);
  assert.equal(t.stdin.listenerCount("data"), 1);
  assert.equal(t.proc.listenerCount("SIGCONT"), 0);
  assert.equal(io.suspend(), false, "not stuck 'away': a retry runs (and fails the same way) again");
  assert.equal(errors.length, 2);
  io.restore();
});

test("close() during a handoff stays closed", async () => {
  const t = fakeTerminal();
  const { io } = make(t);
  await io.enter();
  await io.handoff(() => io.close());
  assert.equal(t.stdin.raw.at(-1), false);
  assert.equal(t.written.at(-1), RESTORE_SEQUENCE);
  assert.equal(t.stdin.listenerCount("data"), 0);
  assert.equal(t.proc.listenerCount("exit"), 0);
});

test("handoff: input detached and modes restored during fn, raw cycled off→on after", async () => {
  const t = fakeTerminal();
  const { io } = make(t);
  await io.enter();
  const resumed = [];
  io.onResume((r) => resumed.push(r.reason));
  const seen = [];
  io.onInput((e) => seen.push(e.type));
  let rawCallsDuringFn = 0;
  const result = await io.handoff(async () => {
    assert.equal(t.stdin.listenerCount("data"), 0, "the child owns the input");
    assert.equal(t.stdin.paused, true);
    assert.equal(t.written.at(-1), RESTORE_SEQUENCE);
    assert.equal(t.stdin.raw.at(-1), false);
    rawCallsDuringFn = t.stdin.raw.length;
    return 42;
  });
  assert.equal(result, 42);
  // The child may have left the console in any state: off, then on again (libuv#5156).
  assert.deepEqual(t.stdin.raw.slice(rawCallsDuringFn), [false, true], "off→on cycle after the child");
  assert.ok(t.written.at(-1).includes("\x1b[?2004h"), "modes back on");
  assert.deepEqual(resumed, ["handoff"]);
  t.stdin.emit("data", "x");
  assert.deepEqual(seen, ["text"]);
  io.restore();
});

test("handoff re-enters even when fn throws", async () => {
  const t = fakeTerminal();
  const { io } = make(t);
  await io.enter();
  await assert.rejects(io.handoff(async () => {
    throw new Error("child failed");
  }), /child failed/);
  assert.equal(t.stdin.raw.at(-1), true);
  assert.equal(t.stdin.listenerCount("data"), 1);
  io.restore();
});

test("suspend: POSIX restores, SIGSTOPs, and re-enters on SIGCONT; Windows does nothing", async () => {
  const t = fakeTerminal();
  const { io } = make(t);
  await io.enter();
  const resumed = [];
  io.onResume((r) => resumed.push(r.reason));
  assert.equal(io.suspend(), true);
  assert.equal(t.written.at(-1), RESTORE_SEQUENCE);
  assert.deepEqual(t.proc.kills, [[4242, "SIGSTOP"]]);
  t.proc.emit("SIGCONT");
  assert.equal(t.stdin.raw.at(-1), true);
  assert.deepEqual(resumed, ["sigcont"]);
  io.restore();

  const w = fakeTerminal();
  const { io: wio } = make(w, { platform: "win32" });
  await wio.enter();
  const writes = w.written.length;
  assert.equal(wio.suspend(), false);
  assert.equal(w.written.length, writes);
  assert.deepEqual(w.proc.kills, []);
  wio.restore();
});

test("size falls back to 80x24", () => {
  const t = fakeTerminal();
  t.stdout.columns = 0;
  t.stdout.rows = undefined;
  const { io } = make(t);
  assert.deepEqual(io.size(), { cols: 80, rows: 24 });
});

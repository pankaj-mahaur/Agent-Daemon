// The alternate-screen guard (P2.1): one module-level state per process, so a
// crash path can leave the alternate screen with no renderer object at hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ENTER, LEAVE, MOUSE_ON, MOUSE_OFF, enterAltScreen, enterBytes, isActive, leaveBytes, onRelease, releaseAltScreen } from "../src/tui/terminal/alt-screen.mjs";

const sink = () => {
  const out = [];
  const w = (s) => out.push(s);
  w.text = () => out.join("");
  w.count = () => out.length;
  return w;
};

test("enter bytes: alt screen, the keyboard push, mouse capture, home and clear", () => {
  assert.equal(enterBytes({ mouse: true }), "\x1b[?1049h\x1b[>1u\x1b[?1007l\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[H\x1b[2J");
  assert.equal(enterBytes({ mouse: false }), "\x1b[?1049h\x1b[>1u\x1b[?1007l\x1b[H\x1b[2J");
  assert.equal(enterBytes({ mouse: false, keyboard: false }), "\x1b[?1049h\x1b[?1007l\x1b[H\x1b[2J");
  assert.ok(!enterBytes({ mouse: true }).includes("?1003h"), "no any-motion tracking");
});

test("leave bytes: synchronized output off, mouse off always, the pop only after a push, then the main screen", () => {
  assert.equal(leaveBytes({ keyboard: true }), `\x1b[?2026l${MOUSE_OFF}\x1b[<u\x1b[?1007l${LEAVE}`);
  assert.equal(leaveBytes({ keyboard: false }), `\x1b[?2026l${MOUSE_OFF}\x1b[?1007l${LEAVE}`);
  assert.ok(leaveBytes({ keyboard: true }).endsWith(LEAVE));
  assert.equal(MOUSE_OFF, "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l");
  assert.equal(ENTER, "\x1b[?1049h");
  assert.ok(MOUSE_ON.startsWith("\x1b[?1007l"));
});

test("the state is marked active before the enter bytes are written", () => {
  const seen = [];
  enterAltScreen((s) => seen.push([s, isActive()]), { mouse: true });
  try {
    assert.deepEqual(seen, [[enterBytes({ mouse: true }), true]]);
  } finally {
    releaseAltScreen(() => {});
  }
  assert.equal(isActive(), false);
});

test("a release fired from inside the enter write still leaves (a signal during enter)", () => {
  const w = sink();
  let fired = false;
  enterAltScreen((s) => {
    w(s);
    if (!fired) {
      fired = true;
      releaseAltScreen(w);
    }
  }, { mouse: false });
  assert.equal(isActive(), false);
  assert.ok(w.text().endsWith(LEAVE), "the leave bytes follow the enter bytes");
});

test("release is idempotent: once true with the leave bytes, then false and nothing", () => {
  const w = sink();
  enterAltScreen(w, { mouse: true });
  assert.equal(releaseAltScreen(w), true);
  assert.equal(w.text(), enterBytes({ mouse: true }) + leaveBytes({ keyboard: true }));
  const n = w.count();
  assert.equal(releaseAltScreen(w), false);
  assert.equal(w.count(), n, "nothing written the second time");
});

test("release when never entered writes nothing (inline sessions)", () => {
  const w = sink();
  assert.equal(releaseAltScreen(w), false);
  assert.equal(w.count(), 0);
});

test("entered without a keyboard push, leaving doesn't pop", () => {
  const w = sink();
  enterAltScreen(w, { mouse: false, keyboard: false });
  releaseAltScreen(w);
  assert.ok(!w.text().includes("\x1b[<u"));
  assert.ok(!w.text().includes("\x1b[>1u"));
});

test("release never throws, even when the write fails, and still clears the state", () => {
  enterAltScreen(() => {}, { mouse: true });
  assert.equal(releaseAltScreen(() => { throw new Error("EPIPE"); }), true);
  assert.equal(isActive(), false);
});

test("release listeners run once per release, after the state is cleared; a throwing listener doesn't stop the others", () => {
  const calls = [];
  const offA = onRelease(() => calls.push(["a", isActive()]));
  const offB = onRelease(() => { throw new Error("boom"); });
  const offC = onRelease(() => calls.push(["c", isActive()]));
  try {
    enterAltScreen(() => {}, { mouse: false });
    releaseAltScreen(() => {});
    releaseAltScreen(() => {});
    assert.deepEqual(calls, [["a", false], ["c", false]]);
    offA();
    enterAltScreen(() => {}, { mouse: false });
    releaseAltScreen(() => {});
    assert.deepEqual(calls, [["a", false], ["c", false], ["c", false]]);
  } finally {
    offA(); offB(); offC();
  }
});

// Input decoder (tui/terminal/input.mjs): byte fixtures, split chunks,
// interleaved replies, bracketed paste, CSI-u and modifyOtherKeys encodings.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createInputDecoder, isNewline } from "../src/tui/terminal/input.mjs";

const FIXTURE = JSON.parse(fs.readFileSync(new URL("./fixtures/tui/s1-keys.json", import.meta.url), "utf8"));
const fromHex = (hex) => Buffer.from(hex, "hex").toString("latin1");

// A decoder with manual timers: tick(ms) fires what is due.
function harness(opts = {}) {
  const events = [];
  let now = 0;
  let timers = [];
  const d = createInputDecoder({
    onEvent: (e) => events.push(e),
    escTimeoutMs: 30,
    sequenceCapMs: 500,
    pasteIdleMs: 1000,
    setTimeout: (fn, ms) => {
      const t = { fn, at: now + ms };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      timers = timers.filter((x) => x !== t);
    },
    ...opts,
  });
  const tick = (ms) => {
    now += ms;
    for (const t of timers.filter((x) => x.at <= now).sort((x, y) => x.at - y.at)) {
      if (!timers.includes(t)) continue; // cleared by an earlier timer in this tick
      timers = timers.filter((x) => x !== t);
      t.fn();
    }
  };
  return { d, events, tick, timers: () => timers.length };
}

const summary = (e) =>
  e.type === "key"
    ? `${e.ctrl ? "C-" : ""}${e.alt ? "A-" : ""}${e.shift ? "S-" : ""}${e.name}`
    : e.type === "text" || e.type === "paste"
      ? `${e.type}:${e.text}`
      : e.type;

/* ------------------------------------------------------------------ */
/* Recorded bytes (S1)                                                 */
/* ------------------------------------------------------------------ */

for (const k of FIXTURE.keys) {
  test(`S1 ${k.terminal}: ${k.label} (${k.hex})`, () => {
    const { d, events, tick } = harness();
    d.feed(fromHex(k.hex));
    tick(30); // a lone ESC resolves after the timeout
    assert.equal(events.length, 1, JSON.stringify(events));
    const e = events[0];
    assert.equal(e.type, "key");
    assert.equal(e.name, k.expect.name);
    assert.equal(e.ctrl, !!k.expect.ctrl, "ctrl");
    assert.equal(e.alt, !!k.expect.alt, "alt");
    assert.equal(e.shift, !!k.expect.shift, "shift");
    assert.equal(e.raw, fromHex(k.hex), "raw bytes preserved");
  });
}

for (const r of FIXTURE.replies) {
  test(`S1 ${r.terminal}: reply ${r.label}`, () => {
    const { d, events } = harness();
    d.feed(fromHex(r.hex));
    assert.equal(events.length, 1);
    for (const [k, v] of Object.entries(r.expect)) assert.equal(events[0][k], v, k);
  });
}

test("S1: the whole recorded session replays unchanged in one chunk and byte by byte", () => {
  const all = FIXTURE.keys.filter((k) => k.hex !== "1b").map((k) => fromHex(k.hex)).join("");
  const want = FIXTURE.keys.filter((k) => k.hex !== "1b").map((k) => k.expect.name);
  for (const mode of ["chunk", "bytes"]) {
    const { d, events, tick } = harness();
    if (mode === "chunk") d.feed(all);
    else for (const ch of all) d.feed(ch);
    tick(30);
    assert.deepEqual(events.map((e) => e.name), want, mode);
  }
});

/* ------------------------------------------------------------------ */
/* Text, controls, ESC                                                 */
/* ------------------------------------------------------------------ */

test("printable runs are joined into one text event; controls split them", () => {
  const { d, events } = harness();
  d.feed("hello\rwo");
  d.feed("rld");
  assert.deepEqual(events.map(summary), ["text:hello", "enter", "text:wo", "text:rld"]);
});

test("non-ASCII text and emoji pass through as text", () => {
  const { d, events } = harness();
  d.feed("\u{65e5}\u{672c} \u{1f44d}\u{1f3fd}");
  assert.deepEqual(events.map(summary), ["text:\u{65e5}\u{672c} \u{1f44d}\u{1f3fd}"]);
});

test("a lone ESC waits for the timeout; ESC then a key within it is Alt+key", () => {
  const h1 = harness();
  h1.d.feed("\x1b");
  assert.equal(h1.events.length, 0, "not yet");
  h1.tick(29);
  assert.equal(h1.events.length, 0, "still waiting");
  h1.tick(1);
  assert.deepEqual(h1.events.map(summary), ["escape"]);

  const h2 = harness();
  h2.d.feed("\x1b");
  h2.tick(10);
  h2.d.feed("b");
  h2.tick(100);
  assert.deepEqual(h2.events.map(summary), ["A-b"]);
});

test("ESC timeout is 100 ms over SSH by default", async () => {
  const prev = process.env.SSH_CONNECTION;
  process.env.SSH_CONNECTION = "1.2.3.4 22 5.6.7.8 22";
  try {
    const { createInputDecoder: fresh } = await import(`../src/tui/terminal/input.mjs?ssh=${Date.now()}`);
    let at = null;
    const d = fresh({ onEvent: () => {}, setTimeout: (fn, ms) => ((at = ms), 0), clearTimeout: () => {} });
    d.feed("\x1b");
    assert.equal(at, 100);
  } finally {
    if (prev === undefined) delete process.env.SSH_CONNECTION;
    else process.env.SSH_CONNECTION = prev;
  }
});

test("a started sequence split across chunks waits for its final byte", () => {
  const { d, events, tick } = harness();
  d.feed("\x1b[1;");
  tick(100); // longer than the ESC timeout: must not resolve as Esc
  assert.equal(events.length, 0);
  d.feed("5A");
  assert.deepEqual(events.map(summary), ["C-up"]);
});

test("a started sequence that never finishes is dropped after the cap, not typed", () => {
  const { d, events, tick } = harness();
  d.feed("\x1b[1;5");
  tick(499);
  assert.equal(events.length, 0);
  tick(1);
  assert.deepEqual(events.map((e) => [e.type, e.name]), [["key", "unknown"]]);
  d.feed("x");
  assert.deepEqual(events.slice(1).map(summary), ["text:x"]);
});

test("Alt with special keys sent as ESC ESC [ ...", () => {
  const { d, events, tick } = harness();
  d.feed("\x1b\x1b[A");
  d.feed("\x1b\x1b");
  tick(30);
  assert.deepEqual(events.map(summary), ["A-up", "A-escape"]);
});

test("Alt+Shift+letter keeps shift", () => {
  const { d, events } = harness();
  d.feed("\x1bB");
  assert.deepEqual(events.map(summary), ["A-S-b"]);
});

test("SS3 arrows and F1-F4 (application cursor mode)", () => {
  const { d, events } = harness();
  d.feed("\x1bOA\x1bOD\x1bOP\x1bOS");
  assert.deepEqual(events.map(summary), ["up", "left", "f1", "f4"]);
});

test("tilde keys with and without modifiers", () => {
  const { d, events } = harness();
  d.feed("\x1b[3~\x1b[5;5~\x1b[15~\x1b[24;2~\x1b[2~\x1b[99~");
  assert.deepEqual(events.map(summary), ["delete", "C-pageup", "f5", "S-f12", "insert", "unknown"]);
});

/* ------------------------------------------------------------------ */
/* CSI-u (kitty flag 1) and modifyOtherKeys                            */
/* ------------------------------------------------------------------ */

test("CSI-u encodings under flag 1", () => {
  const { d, events } = harness();
  d.feed("\x1b[99;5u"); // Ctrl+C
  d.feed("\x1b[27u"); // Esc, unambiguous
  d.feed("\x1b[13;2u"); // Shift+Enter
  d.feed("\x1b[13;5u"); // Ctrl+Enter
  d.feed("\x1b[97;3u"); // Alt+a
  d.feed("\x1b[97;6u"); // Ctrl+Shift+a
  d.feed("\x1b[9;2u"); // Shift+Tab
  d.feed("\x1b[127;5u"); // Ctrl+Backspace
  d.feed("\x1b[99;69u"); // Ctrl+C with caps lock (bit 64): lock bits ignored
  d.feed("\x1b[99;133u"); // Ctrl+C with num lock (bit 128)
  d.feed("\x1b[97:65;2u"); // shifted-key alternate field
  assert.deepEqual(events.map(summary), [
    "C-c", "escape", "S-enter", "C-enter", "A-a", "C-S-a", "S-tab", "C-backspace", "C-c", "C-c", "S-a",
  ]);
});

test("CSI-u key release events are ignored", () => {
  const { d, events } = harness();
  d.feed("\x1b[97;1:3u\x1b[97;1:1u");
  assert.deepEqual(events.map(summary), ["a"]);
});

test("modifyOtherKeys: CSI 27;m;c ~", () => {
  const { d, events } = harness();
  d.feed("\x1b[27;2;13~\x1b[27;5;13~\x1b[27;5;105~\x1b[27;6;65~");
  assert.deepEqual(events.map(summary), ["S-enter", "C-enter", "C-i", "C-S-a"]);
});

test("isNewline: LF, Shift+Enter and Ctrl+Enter, but not Enter or Alt+Enter", () => {
  const { d, events } = harness();
  d.feed("\n\x1b[13;2u\x1b[13;5u\r\x1b\r\x1b[27;2;13~");
  assert.deepEqual(events.map(isNewline), [true, true, true, false, false, true]);
  assert.equal(isNewline({ type: "text", text: "\n" }), false);
});

test("isNewline: Ctrl+J encoded by CSI-u or modifyOtherKeys is still a newline", () => {
  const { d, events } = harness();
  d.feed("\x1b[106;5u\x1b[27;5;106~\x1b[106;7u\x1b[106;6u\x1bj");
  assert.deepEqual(events.map(isNewline), [true, true, false, false, false], "Ctrl+J yes; Ctrl+Alt+J, Ctrl+Shift+J, Alt+J no");
});

/* ------------------------------------------------------------------ */
/* Replies                                                             */
/* ------------------------------------------------------------------ */

test("CSI 1;2R is a cursor report only while one is outstanding, else Shift+F3", () => {
  const { d, events } = harness();
  d.feed("\x1b[1;2R");
  d.expect("cpr");
  d.feed("\x1b[1;2R");
  d.feed("\x1b[1;2R");
  assert.deepEqual(events.map((e) => (e.type === "reply" ? `cpr ${e.row},${e.col}` : summary(e))), ["S-f3", "cpr 1,2", "S-f3"]);
});

test("replies interleaved with typing and split across chunks", () => {
  const { d, events } = harness();
  d.expect("cpr");
  d.feed("ab\x1b[?2026;2");
  d.feed("$y\x1b[12;4");
  d.feed("0Rcd\x1b[?1u\x1b[?62;4c");
  assert.deepEqual(
    events.map((e) => (e.type === "reply" ? e.kind : summary(e))),
    ["text:ab", "decrqm", "cpr", "text:cd", "kitty", "da1"],
  );
  assert.deepEqual(events[2], { type: "reply", kind: "cpr", row: 12, col: 40 });
  assert.deepEqual(events[5].params, [62, 4]);
});

test("focus in and out", () => {
  const { d, events } = harness();
  d.feed("\x1b[I\x1b[O");
  assert.deepEqual(events, [{ type: "focus", focused: true }, { type: "focus", focused: false }]);
});

test("expect rejects unknown reply kinds", () => {
  const { d } = harness();
  assert.throws(() => d.expect("da1"), /unknown reply kind/);
});

/* ------------------------------------------------------------------ */
/* Paste                                                               */
/* ------------------------------------------------------------------ */

test("bracketed paste is one event; keys inside it are never decoded", () => {
  const { d, events } = harness();
  d.feed("x\x1b[200~line1\r\nline2\x03\x1b[A\x1b\x1b[201~y");
  assert.deepEqual(events.map(summary), ["text:x", "paste:line1\nline2\x03\x1b[A\x1b", "text:y"]);
});

test("paste content spanning chunks, with the end marker split", () => {
  const { d, events } = harness();
  d.feed("\x1b[200~par");
  d.feed("t one\rpart two\x1b[2");
  d.feed("01");
  assert.equal(events.length, 0, "nothing until the end marker");
  d.feed("~\r");
  assert.deepEqual(events.map(summary), ["paste:part one\npart two", "enter"]);
});

test("a paste whose content looks like a partial end marker", () => {
  const { d, events } = harness();
  d.feed("\x1b[200~a\x1b[20");
  d.feed("0~b\x1b[201~");
  assert.deepEqual(events.map(summary), ["paste:a\x1b[200~b"]);
});

test("empty paste (an image on the Windows Terminal clipboard) is paste-empty", () => {
  const { d, events } = harness();
  d.feed("\x1b[200~\x1b[201~");
  assert.deepEqual(events, [{ type: "paste-empty" }]);
});

test("a stalled paste is shown after ~1 s idle but stays a paste until its end marker", () => {
  const { d, events, tick } = harness();
  d.feed("\x1b[200~abc");
  tick(999);
  assert.equal(events.length, 0);
  d.feed("def");
  tick(999);
  assert.equal(events.length, 0, "idle timer restarts on more content");
  tick(1);
  assert.deepEqual(events.map(summary), ["paste:abcdef"]);
  // The rest of the paste, with line breaks: still paste, never Enter.
  d.feed("rm -rf build\rline3\x1b[201~");
  d.feed("\r");
  assert.deepEqual(events.slice(1).map(summary), ["paste:rm -rf build\nline3", "enter"]);
});

test("a stalled paste whose end marker arrives with nothing after the flush emits no paste-empty", () => {
  const { d, events, tick } = harness();
  d.feed("\x1b[200~abc");
  tick(1000);
  d.feed("\x1b[201~x");
  assert.deepEqual(events.map(summary), ["paste:abc", "text:x"]);
});

test("a paste with no end marker at all is abandoned after 10 s of quiet", () => {
  const { d, events, tick } = harness();
  d.feed("\x1b[200~abc");
  tick(1000);
  d.feed("\rdef");
  tick(1000);
  tick(9999);
  assert.deepEqual(events.map(summary), ["paste:abc", "paste:\ndef"]);
  tick(10_000);
  d.feed("q\r");
  assert.deepEqual(events.slice(2).map(summary), ["text:q", "enter"], "back to normal input");
});

test("a paste that lost its end marker: the 10 s limit is not extended by typing, and Ctrl+C gets out", () => {
  const a = harness();
  a.d.feed("\x1b[200~partial");
  a.tick(1000); // shown; abandon counts from here
  for (let i = 0; i < 18; i++) {
    a.tick(500);
    a.d.feed("x");
  }
  a.tick(1000); // 11 s after the stall was shown
  a.d.feed("\r");
  assert.equal(a.events.at(-1).name, "enter", "back to keys within ~10 s despite typing");

  const b = harness();
  b.d.feed("\x1b[200~partial");
  b.tick(1000);
  b.d.feed("more");
  b.d.feed("\x03");
  assert.deepEqual(b.events.map(summary), ["paste:partial", "paste:more", "C-c"]);
});

test("a CRLF split by a stall stays one line break", () => {
  const { d, events, tick } = harness();
  d.feed("\x1b[200~a\r");
  tick(1000);
  d.feed("\nb\x1b[201~");
  assert.deepEqual(events.map(summary), ["paste:a", "paste:\nb"]);
});

test("the sequence cap counts from the start of the sequence, not the last byte", () => {
  const { d, events, tick } = harness();
  d.feed("\x1b[");
  for (let i = 0; i < 4; i++) {
    tick(100);
    d.feed("1;"); // a trickle that would keep re-arming an idle timer
  }
  assert.equal(events.length, 0, "400 ms in");
  tick(100); // 500 ms after the start
  assert.deepEqual(events.map((e) => e.name), ["unknown"]);
  d.feed("x");
  assert.deepEqual(events.slice(1).map(summary), ["text:x"]);
});

test("a sequence longer than 256 bytes is dropped at once and memory stays bounded", () => {
  const { d, events } = harness();
  d.feed("\x1b[");
  for (let i = 0; i < 1000; i++) d.feed("1;".repeat(50));
  assert.ok(d.pending.buffered <= 300, `buffered ${d.pending.buffered}`);
  assert.ok(events.length >= 1 && events.every((e) => e.name === "unknown" || e.type === "text"));
  d.reset();
  d.feed("ok");
  assert.deepEqual(events.slice(-1).map(summary), ["text:ok"]);
});

test("ESC O followed by a non-final byte is Alt+Shift+O, and the byte is kept", () => {
  const { d, events } = harness();
  d.feed("\x1bO\r\x1bO\x1b[A");
  assert.deepEqual(events.map(summary), ["A-S-o", "enter", "A-S-o", "up"]);
});

test("kitty keypad keys (flag 1) decode", () => {
  const { d, events } = harness();
  d.feed("\x1b[57421u\x1b[57424;5u\x1b[57400u\x1b[57413u\x1b[57414u\x1b[57426u");
  assert.deepEqual(events.map(summary), ["pageup", "C-end", "1", "+", "enter", "delete"]);
});

test("reset drops buffered state without emitting", () => {
  const { d, events } = harness();
  d.feed("\x1b[200~half");
  d.expect("cpr");
  d.reset();
  assert.deepEqual(d.pending, { buffered: 0, inPaste: false, cprOutstanding: 0 });
  d.feed("\r\x1b[1;2R");
  assert.deepEqual(events.map(summary), ["enter", "S-f3"]);
});

test("cancel gives up an outstanding CPR", () => {
  const { d, events } = harness();
  d.expect("cpr");
  d.cancel("cpr");
  d.feed("\x1b[1;2R");
  assert.deepEqual(events.map(summary), ["S-f3"]);
  assert.throws(() => d.cancel("da1"), /unknown reply kind/);
});

test("split invariance: every two-way split of a mixed corpus decodes like one chunk", () => {
  const corpus =
    "ab\x1b[1;5A\x1b\x1b[B\x1bOP\x1b[200~p\x1b[A\r\nq\x1b[201~\x1b[13;2u\x1b[27;5;13~\x1bb\x7f\x08\x03\u{1f44d}\x1b[?2026;2$y\r\n";
  const run = (chunks) => {
    const h = harness();
    for (const c of chunks) h.d.feed(c);
    h.tick(1000);
    // Text may arrive in pieces when a chunk boundary falls inside it; join them.
    const merged = [];
    for (const e of h.events.map(summary)) {
      if (e.startsWith("text:") && merged.at(-1)?.startsWith("text:")) merged[merged.length - 1] += e.slice(5);
      else merged.push(e);
    }
    return JSON.stringify(merged);
  };
  const whole = run([corpus]);
  for (let i = 1; i < corpus.length; i++) {
    // Never split inside a surrogate pair: io decodes UTF-8 to whole code points.
    if (corpus.charCodeAt(i) >= 0xdc00 && corpus.charCodeAt(i) <= 0xdfff) continue;
    assert.equal(run([corpus.slice(0, i), corpus.slice(i)]), whole, `split at ${i}`);
  }
});

test("paste-burst heuristic only when enabled", () => {
  const off = harness();
  off.d.feed("one\r\ntwo");
  assert.deepEqual(off.events.map(summary), ["text:one", "enter", "newline", "text:two"]);

  const on = harness({ pasteBurst: true });
  on.d.feed("one\r\ntwo");
  on.d.feed("typed\r");
  assert.deepEqual(on.events.map(summary), ["paste:one\ntwo", "text:typed", "enter"]);
});

test("flush emits a pending ESC, half paste or partial sequence", () => {
  const a = harness();
  a.d.feed("\x1b");
  a.d.flush();
  const b = harness();
  b.d.feed("\x1b[200~half");
  b.d.flush();
  const c = harness();
  c.d.feed("\x1b[1;");
  c.d.flush();
  assert.deepEqual([...a.events, ...b.events, ...c.events].map(summary), ["escape", "paste:half", "unknown"]);
  assert.equal(c.timers(), 0);
});

/* ------------------------------------------------------------------ */
/* Terminal strings: OSC / DCS / APC replies are never keys            */
/* ------------------------------------------------------------------ */

const rep = (e) => (e.type === "reply" ? `${e.kind}${e.code !== undefined ? e.code : ""}:${e.data}` : summary(e));

test("an OSC reply (BEL or ST, whole or split) is a reply, not Alt+], text and Ctrl+G", () => {
  const a = harness();
  a.d.feed("\x1b]11;rgb:1e1e/1e1e/1e1e\x07");
  assert.deepEqual(a.events.map(rep), ["osc11:rgb:1e1e/1e1e/1e1e"]);
  const b = harness();
  b.d.feed("\x1b]11;rgb:1");
  b.d.feed("e1e/1e1e/1e1e\x1b");
  b.d.feed("\u{5c}x");
  assert.deepEqual(b.events.map(rep), ["osc11:rgb:1e1e/1e1e/1e1e", "text:x"]);
  assert.equal(b.timers(), 0);
});

test("a late or unasked reply in the middle of typing is swallowed; the typing survives", () => {
  const h = harness();
  const ST = "\x1b\u{5c}";
  h.d.feed(`ab\x1b]10;rgb:ffff/ffff/ffff\x07cd\x1bP>|WezTerm 2026${ST}e\x1b_Gi=1;OK${ST}f`);
  assert.deepEqual(h.events.map(rep), ["text:ab", "osc10:rgb:ffff/ffff/ffff", "text:cd", "dcs:>|WezTerm 2026", "text:e", "apc:Gi=1;OK", "text:f"]);
});

test("Alt+], Alt+Shift+P and Alt+_ still type: a lone introducer times out like a lone ESC", () => {
  const h = harness();
  h.d.feed("\x1b]");
  h.tick(29);
  assert.equal(h.events.length, 0);
  h.tick(1);
  h.d.feed("\x1b]x\x1bPx\x1b_x");
  h.d.feed("\x1bP");
  h.tick(30);
  h.d.feed("\x1b_");
  h.tick(30);
  assert.deepEqual(h.events.map(rep), ["A-]", "A-]", "text:x", "A-S-p", "text:x", "A-_", "text:x", "A-S-p", "A-_"]);
  assert.equal(h.timers(), 0);
});

test("ESC ] with digits waits for the ';', then gives up into keys; an unfinished string is dropped", () => {
  const h = harness();
  h.d.feed("\x1b]1");
  h.tick(499);
  assert.equal(h.events.length, 0);
  h.tick(1);
  assert.deepEqual(h.events.map(rep), ["A-]", "text:1"]);
  const s = harness();
  s.d.feed("\x1b]11;rgb:1e1e");
  s.tick(500);
  assert.deepEqual(s.events.map(rep), ["unknown"], "never typed into the prompt");
  const big = harness();
  big.d.feed(`\x1b]52;c;${"A".repeat(9000)}`);
  assert.deepEqual(big.events.map(rep), ["unknown"]);
  assert.equal(big.timers(), 0);
});

test("a malformed string ends at the next escape sequence, which still decodes; Ctrl+G alone is a key", () => {
  const h = harness();
  h.d.feed("\x1b]11;rgb\x1b[A\x07");
  assert.deepEqual(h.events.map(rep), ["unknown", "up", "C-g"]);
});

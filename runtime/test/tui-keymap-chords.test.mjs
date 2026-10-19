// Key chords and the leader key (P1.2), as the engine's 0.163 keymap has them
// (codex-rs/tui/src/keymap/chords.rs and leader.rs at rust-v0.163.0): two
// strokes at most; `leader <key>` uses global.leader (default ctrl-x); an
// ordinary chord expires 1 s after its first stroke, a leader chord never;
// Esc or the leader again cancels; a second key that completes nothing is
// passed through; a pending chord is dropped when the contexts change.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeymap, parseBinding } from "../src/tui/keymap.mjs";

const key = (name, mods = {}) => ({ type: "key", name, ctrl: false, alt: false, shift: false, ...mods });
const text = (t) => ({ type: "text", text: t });
const MAIN = ["global", "chat", "composer"];
const PAGER = ["global", "pager"];
const ctrlX = key("x", { ctrl: true });

test("parseBinding: one stroke, two strokes, leader + key; three strokes, bare leader and esc in a chord are refused", () => {
  assert.deepEqual(parseBinding("ctrl-t"), { leader: false, strokes: [{ key: "t", ctrl: true, alt: false, shift: false }] });
  assert.equal(parseBinding("ctrl-x ctrl-s").strokes.length, 2);
  assert.deepEqual(parseBinding("leader c"), { leader: true, strokes: [{ key: "c", ctrl: false, alt: false, shift: false }] });
  assert.throws(() => parseBinding("ctrl-x a b"), /at most 2 strokes/);
  assert.throws(() => parseBinding("leader"), /leader/);
  assert.throws(() => parseBinding("leader a b"), /at most 2 strokes|leader/);
  assert.throws(() => parseBinding("ctrl-x esc"), /esc/);
});

test("the default leader is ctrl-x, yields when ctrl-x is configured, and refuses printable keys, ctrl-z (non-Windows) and reserved keys", () => {
  assert.equal(createKeymap({ overrides: { global: { copy: "leader c" } } }).leader(), "ctrl-x");
  const yielded = createKeymap({ overrides: { global: { copy: "leader c", open_transcript: "ctrl-x" } } });
  assert.equal(yielded.leader(), null, "ctrl-x configured elsewhere: no default leader");
  assert.ok(yielded.warnings.some((w) => /leader/.test(w)), "a leader binding with no leader says so");
  const printable = createKeymap({ overrides: { global: { leader: "a", copy: "leader c" } } });
  assert.equal(printable.leader(), null);
  assert.ok(printable.warnings.some((w) => /global\.leader/.test(w)));
  assert.equal(createKeymap({ overrides: { global: { leader: "f9", copy: "leader c" } } }).leader(), "f9", "a non-character key needs no modifier");
  assert.equal(createKeymap({ overrides: { global: { leader: "ctrl-x ctrl-y", copy: "leader c" } } }).leader(), null, "a leader is one key");
  const z = createKeymap({ overrides: { global: { leader: "ctrl-z", copy: "leader c" } }, platform: "linux" });
  assert.equal(z.leader(), null);
  assert.equal(createKeymap({ overrides: { global: { leader: "ctrl-z", copy: "leader c" } }, platform: "win32" }).leader(), "ctrl-z");
  assert.equal(createKeymap({ overrides: { global: { leader: "ctrl-c", copy: "leader c" } } }).leader(), null, "ctrl-c is reserved");
  assert.equal(createKeymap({ overrides: { global: { leader: "alt-space", copy: "leader c" } } }).leader(), "alt-space");
});

test("a leader binding completes: ctrl-x then c → {type: 'chord', ctx: 'global', action: 'copy'}, and keymap.is('global', 'copy', ev) is true", () => {
  const km = createKeymap({ overrides: { global: { copy: "leader c" } } });
  assert.deepEqual(km.warnings, []);
  const ch = km.chords();
  const first = ch.feed(ctrlX, MAIN, 0);
  assert.equal(first.kind, "pending");
  assert.deepEqual(first.hint.at(-1), { keys: "esc", label: "cancel" });
  assert.ok(first.hint.some((h) => h.keys === "c" && h.label === "copy"), JSON.stringify(first.hint));
  const r = ch.feed(text("c"), MAIN, 50);
  assert.equal(r.kind, "done");
  assert.deepEqual(r.ev, { type: "chord", ctx: "global", action: "copy" });
  assert.ok(km.is("global", "copy", r.ev));
  assert.ok(!km.is("global", "open_transcript", r.ev));
  assert.ok(!km.is("global", "copy", key("o", { ctrl: true })), "the override replaced ctrl-o");
  assert.equal(ch.pending(), null);
});

test("an ordinary chord expires after 1000 ms (injected clock: 999 completes, 1000 passes the second key through)", () => {
  const km = createKeymap({ overrides: { global: { copy: "alt-k alt-c" } } });
  assert.deepEqual(km.warnings, []);
  const ch = km.chords();
  assert.equal(ch.feed(key("k", { alt: true }), MAIN, 1000).kind, "pending");
  assert.equal(ch.feed(key("c", { alt: true }), MAIN, 1999).kind, "done");
  assert.equal(ch.feed(key("k", { alt: true }), MAIN, 5000).kind, "pending");
  assert.equal(ch.feed(key("c", { alt: true }), MAIN, 6000).kind, "pass", "expired: the second key is an ordinary key again");
});

test("a leader chord doesn't expire; Esc and the leader again cancel it", () => {
  const km = createKeymap({ overrides: { global: { copy: "leader c" } } });
  const ch = km.chords();
  ch.feed(ctrlX, MAIN, 0);
  assert.equal(ch.feed(text("c"), MAIN, 60_000).kind, "done", "still pending a minute later");
  ch.feed(ctrlX, MAIN, 0);
  assert.equal(ch.feed(key("escape"), MAIN, 10).kind, "cancelled");
  assert.equal(ch.pending(), null);
  ch.feed(ctrlX, MAIN, 0);
  assert.equal(ch.feed(ctrlX, MAIN, 10).kind, "cancelled");
  assert.equal(ch.feed(text("c"), MAIN, 20).kind, "pass", "nothing pending after the cancel");
});

test("an unmatched second key is passed through, not swallowed", () => {
  const km = createKeymap({ overrides: { global: { copy: "leader c" } } });
  const ch = km.chords();
  ch.feed(ctrlX, MAIN, 0);
  const r = ch.feed(text("z"), MAIN, 10);
  assert.equal(r.kind, "pass");
  assert.equal(ch.pending(), null);
  // …and a second key that starts another chord starts it.
  ch.feed(ctrlX, MAIN, 0);
  assert.equal(ch.feed(ctrlX, MAIN, 5).kind, "cancelled", "the leader again cancels (the engine's rule)");
});

test("a pending chord is dropped when the contexts change", () => {
  const km = createKeymap({ overrides: { global: { copy: "leader c" } } });
  const ch = km.chords();
  ch.feed(ctrlX, MAIN, 0);
  assert.equal(ch.feed(text("c"), PAGER, 10).kind, "pass", "the pager opened between the strokes");
});

test("no leader bindings: ctrl-x passes through", () => {
  const ch = createKeymap().chords();
  assert.equal(ch.feed(ctrlX, MAIN, 0).kind, "pass");
  assert.equal(ch.pending(), null);
  assert.equal(createKeymap().leader(), "ctrl-x", "the leader exists, it just has nothing to start");
});

test("a chord whose prefix is ad's single-stroke binding in a live-together context gives way with one warning", () => {
  const km = createKeymap({ overrides: { chat: { interrupt_turn: "ctrl-t x" } } });
  assert.equal(km.warnings.length, 1, km.warnings.join("\n"));
  assert.match(km.warnings[0], /chat\.interrupt_turn/);
  assert.match(km.warnings[0], /global\.open_transcript/);
  assert.ok(km.is("chat", "interrupt_turn", key("escape")), "the default stays");
  assert.equal(km.chords().feed(key("t", { ctrl: true }), MAIN, 0).kind, "pass");
});

test("chord shapes the engine refuses: a plain-character prefix, a reserved key, the leader repeated, the same chord twice", () => {
  const plain = createKeymap({ overrides: { global: { copy: "g g" } } });
  assert.equal(plain.warnings.length, 1);
  assert.match(plain.warnings[0], /ctrl, alt/);
  assert.equal(createKeymap({ overrides: { global: { copy: "ctrl-x ctrl-c" } } }).warnings.length, 1, "ctrl-c is reserved");
  assert.equal(createKeymap({ overrides: { global: { copy: "leader ctrl-x" } } }).warnings.length, 1, "repeating the leader is reserved for cancelling");
  const twice = createKeymap({ overrides: { global: { copy: "leader c", toggle_raw_output: "leader c" } } });
  assert.equal(twice.warnings.length, 1, twice.warnings.join("\n"));
  assert.match(twice.warnings[0], /same chord/);
});

test("a list mixing a key and a chord keeps both; /keymap's spelling stays the engine's", () => {
  const km = createKeymap({ overrides: { global: { copy: ["ctrl-o", "leader y"] } } });
  assert.deepEqual(km.warnings, []);
  assert.ok(km.is("global", "copy", key("o", { ctrl: true })));
  const ch = km.chords();
  ch.feed(ctrlX, MAIN, 0);
  assert.deepEqual(ch.feed(text("y"), MAIN, 1).ev, { type: "chord", ctx: "global", action: "copy" });
  assert.deepEqual(km.keys("global", "copy"), ["ctrl-o", "leader y"]);
  assert.equal(km.label("global", "copy", { all: true }), "ctrl+o / ctrl+x y");
});

test("a chord that starts with the leader written out waits like a leader chord; expire() drops only an ordinary one", () => {
  const km = createKeymap({ overrides: { global: { leader: "ctrl-x", copy: "ctrl-x c" } } });
  assert.deepEqual(km.warnings, []);
  const ch = km.chords();
  ch.feed(ctrlX, MAIN, 0);
  assert.equal(ch.pending().expiresAt, null, "the leader key waits");
  assert.equal(ch.expire(60_000), false);
  assert.equal(ch.feed(text("c"), MAIN, 60_000).kind, "done");
  const ordinary = createKeymap({ overrides: { global: { copy: "alt-k alt-c" } } }).chords();
  ordinary.feed(key("k", { alt: true }), MAIN, 100);
  assert.equal(ordinary.pending().expiresAt, 1100);
  assert.equal(ordinary.expire(1099), false);
  assert.equal(ordinary.expire(1100), true);
  assert.equal(ordinary.pending(), null);
});

// Composer (tui/view/composer.mjs) and prompt history (tui/history.mjs), plan Part 5a.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComposer, layout } from "../src/tui/view/composer.mjs";
import { createHistory } from "../src/tui/history.mjs";
import { stringWidth } from "../src/tui/terminal/width.mjs";

const key = (name, mods = {}) => ({ type: "key", name, ctrl: false, alt: false, shift: false, ...mods });
const ctrl = (name) => key(name, { ctrl: true });
const type = (c, s) => {
  for (const ch of s) c.handle({ type: "text", text: ch });
};
const memHistory = (items = []) => {
  const list = [...items];
  return { entries: () => list, add: (t) => list.push(t) };
};
const rowTexts = (r) => r.lines.map((l) => l.map((s) => s.text).join(""));

test("typing, grapheme cursor moves and backspace treat a cluster as one unit", () => {
  const c = createComposer();
  type(c, "a");
  c.handle({ type: "text", text: "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}" }); // family: one grapheme
  c.handle({ type: "text", text: "e\u{301}" }); // e + combining acute
  assert.equal(c.cursor, c.text.length);
  c.handle(key("left"));
  assert.equal(c.text.slice(c.cursor), "e\u{301}");
  c.handle(key("left"));
  c.handle(key("backspace"));
  assert.equal(c.text, "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}e\u{301}");
  c.handle(key("delete"));
  assert.equal(c.text, "e\u{301}");
  c.handle(key("right"));
  assert.equal(c.cursor, 2);
});

test("word moves and kills: Ctrl+←/→, Alt+B/F, Ctrl+W, Ctrl+K/U, Ctrl+Y", () => {
  const c = createComposer();
  type(c, "foo bar.baz  qux");
  c.handle(key("left", { ctrl: true }));
  assert.equal(c.text.slice(c.cursor), "qux");
  c.handle(key("b", { alt: true }));
  assert.equal(c.text.slice(c.cursor), "baz  qux");
  c.handle(key("right", { ctrl: true }));
  assert.equal(c.text.slice(0, c.cursor), "foo bar.baz");
  c.handle(key("f", { alt: true }));
  assert.equal(c.cursor, c.text.length);
  c.handle(ctrl("w"));
  assert.equal(c.text, "foo bar.baz  ");
  c.handle(ctrl("y"));
  assert.equal(c.text, "foo bar.baz  qux");
  c.handle(ctrl("a"));
  assert.equal(c.cursor, 0);
  c.handle(key("right", { ctrl: true }));
  c.handle(ctrl("k"));
  assert.equal(c.text, "foo");
  c.handle(ctrl("u"));
  assert.equal(c.text, "");
  c.handle(ctrl("y"));
  assert.equal(c.text, "foo");
  c.handle(key("backspace", { ctrl: true }));
  assert.equal(c.text, "");
});

test("Ctrl+K at a line's end joins the next line; Ctrl+U at a line's start the previous", () => {
  const c = createComposer();
  c.set("ab\ncd");
  c.handle(key("up"));
  c.handle(ctrl("e"));
  c.handle(ctrl("k"));
  assert.equal(c.text, "abcd");
  c.set("ab\ncd");
  c.handle(ctrl("a"));
  c.handle(ctrl("u"));
  assert.equal(c.text, "abcd");
});

test("newline keys insert a newline; Enter submits; \\ + Enter is a newline", () => {
  const c = createComposer();
  type(c, "a");
  c.handle(key("enter", { shift: true }));
  type(c, "b");
  c.handle(key("newline"));
  type(c, "c");
  c.handle(ctrl("j"));
  type(c, "d\\");
  assert.deepEqual(c.handle(key("enter")), { changed: true });
  type(c, "e");
  assert.equal(c.text, "a\nb\nc\nd\ne");
  assert.deepEqual(c.handle(key("enter")), { submit: "a\nb\nc\nd\ne" });
  assert.equal(c.text, "");
  assert.deepEqual(c.handle(key("enter")), { changed: false }, "an empty prompt isn't sent");
  type(c, "   ");
  assert.deepEqual(c.handle(key("enter")), { changed: false });
});

test("typed text is sanitized; keys it doesn't own return null", () => {
  const c = createComposer();
  c.handle({ type: "text", text: "a\x1b[31mb\x07\u{202e}c" });
  assert.equal(c.text, "abc");
  assert.equal(c.handle(key("f5")), null);
  assert.equal(c.handle({ type: "focus" }), null);
  c.clear();
  assert.equal(c.handle(key("escape")), null, "Esc on an empty composer isn't ours");
  type(c, "x");
  assert.deepEqual(c.handle(key("escape")), { cancel: true });
});

test("history: Up/Down only at the edges, the draft comes back, Enter adds", () => {
  const h = memHistory(["first", "second\nline"]);
  const c = createComposer({ history: h });
  type(c, "draft");
  c.handle(key("up"));
  assert.equal(c.text, "second\nline");
  // Inside a multi-line entry, Up moves a row before it walks the history.
  c.handle(key("up"));
  assert.equal(c.text, "second\nline");
  assert.equal(c.cursor, 4, "the column is kept");
  c.handle(key("up"));
  assert.equal(c.text, "first");
  assert.deepEqual(c.handle(key("up")), { changed: true }, "the oldest entry stays");
  assert.equal(c.text, "first");
  c.handle(key("down"));
  c.handle(key("down"));
  c.handle(key("down"));
  assert.equal(c.text, "draft");
  assert.deepEqual(c.handle(key("down")), { changed: false });
  c.handle(key("enter"));
  assert.deepEqual(h.entries(), ["first", "second\nline", "draft"]);
});

test("Ctrl+R searches history backwards; Enter takes the match, Esc keeps the prompt", () => {
  const c = createComposer({ history: memHistory(["git status", "npm test", "git push", "ls"]) });
  type(c, "keep");
  c.handle(ctrl("r"));
  assert.equal(c.searching, true);
  type(c, "git");
  assert.match(rowTexts(c.render({ width: 80 }))[0], /git push/);
  c.handle(ctrl("r"));
  assert.match(rowTexts(c.render({ width: 80 }))[0], /git status/);
  c.handle(ctrl("r"));
  assert.match(rowTexts(c.render({ width: 80 }))[0], /git status/, "no older match: stays");
  c.handle(key("enter"));
  assert.equal(c.searching, false);
  assert.equal(c.text, "git status");
  c.handle(ctrl("r"));
  type(c, "zzz");
  assert.match(rowTexts(c.render({ width: 80 }))[0], /no match/);
  c.handle(key("escape"));
  assert.equal(c.text, "git status");
});

test("big pastes become a token and expand on submit; small ones go inline", () => {
  const c = createComposer({ pasteLines: 3 });
  c.handle({ type: "paste", text: "one\ntwo" });
  assert.equal(c.text, "one\ntwo");
  c.clear();
  const big = "l1\nl2\nl3\nl4";
  c.handle({ type: "paste", text: big });
  assert.equal(c.text, "[Pasted 4 lines]");
  type(c, " and ");
  c.handle({ type: "paste", text: big });
  assert.equal(c.text, "[Pasted 4 lines] and [Pasted 4 lines #2]");
  assert.deepEqual(c.handle(key("enter")), { submit: `${big} and ${big}` });
  // A long single line counts too.
  const d = createComposer({ pasteChars: 10 });
  d.handle({ type: "paste", text: "x".repeat(11) });
  assert.equal(d.text, "[Pasted 1 lines]");
  // Pasted escapes are stripped.
  d.clear();
  d.handle({ type: "paste", text: "a\x1b]0;evil\x07b" });
  assert.equal(d.text, "ab");
});

test("mask: dots on screen, never in history, no newlines, no search", () => {
  const h = memHistory(["old"]);
  const c = createComposer({ history: h, mask: true });
  type(c, "s3cret");
  c.handle({ type: "paste", text: "x\ny" });
  assert.deepEqual(rowTexts(c.render({ width: 40, prompt: "> " })), ["> \u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}"]);
  assert.equal(c.handle(key("up")).changed, false);
  c.handle(key("enter", { shift: true }));
  c.handle(ctrl("r"));
  assert.equal(c.searching, false);
  assert.deepEqual(c.handle(key("enter")), { submit: "s3cretxy" });
  assert.deepEqual(h.entries(), ["old"]);
});

test("render wraps at the width with the cursor mapped; one cell stays free", () => {
  const c = createComposer();
  type(c, "hello wonderful world");
  const r = c.render({ width: 12, prompt: "> " }); // room 9
  // The space that overflows "wonderful" hides at that row's end.
  assert.deepEqual(rowTexts(r), ["> hello ", "  wonderful", "  world"]);
  assert.deepEqual(r.cursor, { row: 2, col: 7 });
  c.handle(ctrl("a"));
  assert.deepEqual(c.render({ width: 12, prompt: "> " }).cursor, { row: 2, col: 2 });
  c.handle(key("up"));
  assert.deepEqual(c.render({ width: 12, prompt: "> " }).cursor, { row: 1, col: 2 });
  c.handle(ctrl("e"));
  // A soft-wrapped row's end stops before its last grapheme.
  assert.equal(c.text.slice(c.cursor), " world"); // before the hidden space
  // Wide characters and tabs.
  const w = createComposer();
  w.set("\u{4f60}\u{597d}\tx");
  const wr = w.render({ width: 40, prompt: "> " });
  assert.deepEqual(rowTexts(wr), ["> \u{4f60}\u{597d}    x"]);
  assert.deepEqual(wr.cursor, { row: 0, col: 11 });
  // Placeholder only when empty.
  assert.deepEqual(rowTexts(createComposer().render({ width: 40, prompt: "> ", placeholder: "Ask" })), ["> Ask"]);
});

test("property: layout keeps every grapheme, fits the room, and the cursor stays inside", () => {
  const alphabet = ["a", "b", " ", " ", "\n", "\u{4f60}", "\u{1f600}", "e\u{301}", "\t", "-"];
  let seed = 7;
  const rand = (n) => {
    // mulberry32: a float multiply past 2^53 would lose the low bits.
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
  for (let i = 0; i < 300; i++) {
    let text = "";
    for (let k = rand(60); k > 0; k--) text += alphabet[rand(alphabet.length)];
    const width = 6 + rand(30);
    const c = createComposer();
    c.set(text);
    for (let k = rand(10); k > 0; k--) c.handle(key(["left", "right", "up", "down", "home", "end"][rand(6)]));
    const r = c.render({ width, prompt: "> " });
    const room = width - 3;
    const rows = layout(text, room);
    assert.equal(rows.map((x) => x.segs.map((s) => s.g).join("")).join(""), text.replace(/\n/g, ""), `kept: ${JSON.stringify(text)}`);
    for (const row of rows) assert.ok(row.segs.reduce((n, s) => n + s.w, 0) <= room, `fits: ${JSON.stringify(text)} @${width}`);
    for (const line of rowTexts(r)) assert.ok(stringWidth(line) <= width - 1, `line fits: ${JSON.stringify(line)}`);
    assert.ok(r.cursor.row >= 0 && r.cursor.row < r.lines.length);
    assert.ok(r.cursor.col >= 2 && r.cursor.col <= width - 1);
  }
});

test("token(): @mentions anywhere, /commands only at the start; replace() fills it", () => {
  const c = createComposer();
  type(c, "look at @src/ma");
  assert.deepEqual(c.token(), { kind: "mention", text: "@src/ma", start: 8, end: 15 });
  c.replace(8, 15, "@src/main.mjs ");
  assert.equal(c.text, "look at @src/main.mjs ");
  assert.equal(c.token(), null);
  c.clear();
  type(c, "/mod");
  assert.equal(c.token().kind, "command");
  c.clear();
  type(c, "a /mod");
  assert.equal(c.token(), null);
});

/* ------------------------------------------------------------------ */
/* history.mjs                                                         */
/* ------------------------------------------------------------------ */

test("history persists, skips consecutive duplicates and torn lines, and compacts", () => {
  const dir = mkdtempSync(join(tmpdir(), "ad-hist-"));
  const file = join(dir, "tui", "history.jsonl");
  try {
    const h = createHistory({ file, max: 3 });
    h.add("a");
    h.add("a");
    h.add("b");
    h.add("  ");
    assert.deepEqual(createHistory({ file, max: 3 }).entries(), ["a", "b"]);
    writeFileSync(file, readFileSync(file, "utf8") + '{"text":"tor');
    const h2 = createHistory({ file, max: 3 });
    assert.deepEqual(h2.entries(), ["a", "b"]);
    for (const t of ["c", "d", "e", "f", "g"]) h2.add(t);
    assert.deepEqual(h2.entries(), ["e", "f", "g"]);
    assert.ok(readFileSync(file, "utf8").trim().split("\n").length <= 6, "compacted");
    assert.deepEqual(createHistory({ file, max: 3 }).entries(), ["e", "f", "g"]);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    // An unwritable path: history stays in memory, nothing throws.
    const bad = createHistory({ file: join(file, "nested", "x.jsonl") });
    bad.add("still works");
    assert.deepEqual(bad.entries(), ["still works"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("text from outside (set, replace, history file) is sanitized like typed text", () => {
  const ST = "\x1b" + String.fromCharCode(92); // ESC \ ends an OSC
  const evil = `ok\x1b]8;;https://evil.example${ST}click\x1b]8;;${ST}\x1b[2K\x1b[1A`;
  const c = createComposer();
  c.set(evil);
  assert.equal(c.text, "okclick");
  c.clear();
  type(c, "@x");
  c.replace(0, 2, `@a\x1b[31mb `);
  assert.equal(c.text, "@ab ");
  const dir = mkdtempSync(join(tmpdir(), "ad-hist-evil-"));
  try {
    const file = join(dir, "h.jsonl");
    writeFileSync(file, JSON.stringify({ text: evil }) + "\n");
    const h = createHistory({ file });
    assert.deepEqual(h.entries(), ["okclick"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

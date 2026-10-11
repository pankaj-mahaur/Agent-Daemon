// Codex's Vim mode in the composer (tui/view/vim.mjs, codex-parity-2 Part 8):
// a binding table after Codex 0.160's textarea/vim*.rs and its tests. Cases
// are "text with | at the cursor", keys in a small notation (<esc> <cr> <bs>
// <c-r> <c-k> <a-b> <up> <down> <left> <right>), and the expected draft.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createComposer } from "../src/tui/view/composer.mjs";

const KEYS = {
  esc: { name: "escape" },
  cr: { name: "enter" },
  bs: { name: "backspace" },
  up: { name: "up" },
  down: { name: "down" },
  left: { name: "left" },
  right: { name: "right" },
  "c-r": { name: "r", ctrl: true },
  "c-k": { name: "k", ctrl: true },
  "c-y": { name: "y", ctrl: true },
  "c-t": { name: "t", ctrl: true },
  "a-b": { name: "b", alt: true },
};

function events(keys) {
  const out = [];
  for (let i = 0; i < keys.length; ) {
    const m = /^<([a-z-]+)>/.exec(keys.slice(i));
    if (m && KEYS[m[1]]) {
      out.push({ type: "key", ctrl: false, alt: false, shift: false, ...KEYS[m[1]] });
      i += m[0].length;
    } else {
      const ch = [...keys.slice(i)][0];
      out.push({ type: "text", text: ch });
      i += ch.length;
    }
  }
  return out;
}

const at = (s) => ({ text: s.replace("|", ""), cursor: s.indexOf("|") });
const shown = (c) => `${c.text.slice(0, c.cursor)}|${c.text.slice(c.cursor)}`;

/** A composer with Vim on, the draft and cursor set, in `mode`. */
function vim(start, { mode = "normal", ...opts } = {}) {
  const c = createComposer(opts);
  c.setVim(true, { mode });
  const s = at(start);
  c.set(s.text, s.cursor);
  return c;
}
function run(start, keys, opts) {
  const c = vim(start, opts);
  const results = events(keys).map((ev) => c.handle(ev));
  return { c, results };
}

// [start, keys, expected, mode after (default normal)]
const TABLE = [
  // motions: h/l cross lines through the end-of-line slot
  ["hel|lo", "h", "he|llo"],
  ["ab\n|cd", "h", "ab|\ncd"],
  ["a|b", "ll", "ab|"],
  ["ab|\ncd", "l", "ab\n|cd"],
  // w b e: Codex's words (separators apart, a run of them is one piece, CJK per character)
  ["|foo bar", "w", "foo |bar"],
  ["foo |bar", "w", "foo bar|"],
  ["fo|o\nbar", "w", "foo\n|bar"],
  ["|foo.bar", "w", "foo|.bar"],
  ["foo|.bar", "w", "foo.|bar"],
  ["|a...b", "w", "a|...b"],
  ["|日本語 abc", "w", "日|本語 abc"],
  ["foo ba|r", "b", "foo |bar"],
  ["foo |bar", "b", "|foo bar"],
  ["foo\n|bar", "b", "|foo\nbar"],
  ["|foo bar", "e", "fo|o bar"],
  ["fo|o bar", "e", "foo ba|r"],
  ["alph|a   ", "e", "alpha  | "],
  // 0 $ gg G f F t T
  ["foo b|ar", "0", "|foo bar"],
  ["|foo bar", "$", "foo ba|r"],
  ["  x\n  y\n|z", "gg", "  |x\n  y\nz"],
  ["|a\n  b", "G", "a\n  |b"],
  ["|abcabc", "fc", "ab|cabc"],
  ["ab|cabc", "fc", "abcab|c"],
  ["abcab|c", "Fa", "abc|abc"],
  ["|abcabc", "tc", "a|bcabc"],
  ["abcab|c", "Ta", "abca|bc"],
  ["|abc", "fz", "|abc"],
  // j k: visual rows, sticky column; past the first/last row to the buffer's ends
  ["ab|c\nde", "j", "abc\nde|"],
  ["ab|c\nde", "k", "|abc\nde"],
  ["abc\nd|e", "j", "abc\nde|"],
  // x s D C r R
  ["a|bc", "x", "a|c"],
  ["ab|\ncd", "x", "ab|\ncd"],
  ["a|bc", "xp", "acb|"],
  ["a|bc\nd", "D", "a|\nd"],
  ["a|bc\nd", "Cx<esc>", "a|x\nd"],
  ["a|bc", "sZ<esc>", "a|Zc"],
  ["a|bc", "rZ", "a|Zc"],
  ["a|bc", "r<cr>", "a\n|c"],
  ["a|bcd", "Rxy<esc>", "ax|yd"],
  // i a A I o O, Esc steps back unless at the line's start
  ["a|b", "ix<esc>", "a|xb"],
  ["a|b", "ax<esc>", "ab|x"],
  ["|ab\ncd", "Ax<esc>", "ab|x\ncd"],
  ["  a|b", "Ix<esc>", "  |xab"],
  ["a|b\ncd", "ox<esc>", "ab\n|x\ncd"],
  ["ab\nc|d", "Ox<esc>", "ab\n|x\ncd"],
  ["|ab", "i<esc>", "|ab"],
  // operators with motions
  ["|foo bar", "dw", "|bar"],
  ["foo |bar\nbaz", "dw", "foo |baz"],
  ["|foo bar", "de", "| bar"],
  ["foo b|ar", "db", "foo |ar"],
  ["foo b|ar", "d$", "foo b|"],
  ["foo b|ar", "d0", "|ar"],
  ["a|bc", "dl", "a|c"],
  ["ab|c", "dh", "a|c"],
  ["|a\nb\nc", "dj", "|c"],
  ["a\nb\n|c", "dk", "a\n|"],
  ["a\n|b", "dj", "a\n|"],
  ["a\n|b\nc", "dG", "a\n|"],
  ["a\nb|\nc", "dgg", "|c"],
  ["|abcabc", "dfc", "|abc"],
  ["|abcabc", "dtc", "|cabc"],
  ["|foo bar", "cwx<esc>", "|x bar"],
  ["foo| bar", "cwx<esc>", "foo|xbar"],
  ["|foo bar", "yw", "|foo bar"],
  ["|foo bar", "ywP", "|foo bar"], // no P in Codex: ignored
  // linewise: dd yy cc Y p
  ["a\n|b\nc", "dd", "a\n|c"],
  ["a\n|b", "dd", "a\n|"],
  ["a|b\ncd", "Yp", "ab\n|ab\ncd"],
  ["a|b\ncd", "yyjp", "ab\ncd\n|ab"],
  ["a\n  |b\nc", "ccx<esc>", "a\n|x\nc"],
  ["|a\nb", "ddp", "b\n|a"],
  // text objects
  ["foo b|ar baz", "diw", "foo | baz"],
  ["foo b|ar baz", "daw", "foo |baz"],
  ["foo |bar", "daw", "foo|"],
  ["foo bar|", "diw", "foo |"],
  ["a.b| c", "diW", "| c"],
  ["f(a, |b)", "di(", "f(|)"],
  ["f(a, |b)", "da(", "f|"],
  ["f(a, |b)", "dib", "f(|)"],
  ["(|)", "ci(x<esc>", "(|x)"],
  ["if (a && (|b)) x", "di)", "if (a && (|)) x"],
  ["x[1, |2]", "di[", "x[|]"],
  ["{a: |1}", "da{", "|"],
  ['a "b|c" d', 'di"', 'a "|" d'],
  ['a "b|c" d', 'da"', "a | d"],
  ["say 'h|i' ok", "ci'yo<esc>", "say 'y|o' ok"],
  // search
  ["|one two three two", "/tw<cr>", "one |two three two"],
  ["|one two three two", "/tw<cr>n", "one two three |two"],
  ["|one two three two", "/tw<cr>nn", "one |two three two"],
  ["|one two three two", "/tw<cr>nN", "one |two three two"],
  ["one two three tw|o", "?thr<cr>", "one two |three two"],
  ["|one two three two", "/tw<cr>/<cr>", "one two three |two"],
  ["|one two three", "d/three<cr>", "|three"],
  ["|one two", "/zz<cr>", "|one two"],
  ["|one two", "/tw<esc>", "|one two"],
  // undo, redo, repeat
  ["|foo bar", "dwu", "|foo bar"],
  ["|foo bar", "dwu<c-r>", "|bar"],
  ["|ab", "ixy<esc>u", "|ab"],
  ["|a b c", "dw.", "|c"],
  ["hello world fo|o", "bcwbar<esc>0.", "ba|r world bar"],
  ["|abc", "x..", "|"],
  ["|ab", "yw.", "|ab"],
  // the register is the composer's kill: Ctrl+K in Insert, p in Normal
  ["a|bc", "i<c-k><esc>p", "abc|"],
  // a burst of keys in one event, and Codex's "!" on an empty draft
  ["", "!ls<esc>", "!l|s"],
];

test("vim binding table (Codex 0.160's semantics)", () => {
  const failures = [];
  for (const [start, keys, expected, mode = "normal"] of TABLE) {
    const { c } = run(start, keys);
    const got = shown(c);
    if (got !== expected || c.vim.mode !== mode) failures.push(`${JSON.stringify(start)} + ${keys}: ${JSON.stringify(got)} (${c.vim.mode}), expected ${JSON.stringify(expected)} (${mode})`);
  }
  assert.deepEqual(failures, []);
});

test("vim: a burst of keys in one text event is the same as the keys one by one", () => {
  const one = vim("|foo bar baz");
  one.handle({ type: "text", text: "dwcwx" });
  one.handle({ type: "key", name: "escape" });
  assert.equal(shown(one), "|x baz");
  const typed = vim("|foo");
  typed.handle({ type: "text", text: "ihello " }); // "i" then the rest is typed in Insert
  assert.equal(typed.text, "hello foo");
  assert.equal(typed.vim.mode, "insert");
});

test("vim: wide characters and emoji are one character each", () => {
  assert.equal(shown(run("|👍🏽x", "l").c), "👍🏽|x");
  assert.equal(shown(run("|👍🏽x", "x").c), "|x");
  assert.equal(shown(run("a|日b", "x").c), "a|b");
});

test("vim: Enter submits in Normal with nothing pending (then Insert); with something pending it only cancels", () => {
  const c = vim("|hi there");
  assert.deepEqual(c.handle({ type: "key", name: "enter" }), { submit: "hi there" });
  assert.equal(c.text, "");
  assert.equal(c.vim.mode, "insert", "after a submit the new draft starts in Insert (Codex)");
  const p = vim("a|b");
  p.handle({ type: "text", text: "d" });
  const r = p.handle({ type: "key", name: "enter" });
  assert.equal(r.submit, undefined);
  assert.equal(shown(p), "a|b");
  assert.equal(p.vim.pending, false);
});

test("vim: Esc in Normal with nothing pending is the app's (interrupt, rewind); otherwise Vim's", () => {
  const c = vim("|ab");
  assert.equal(c.vim.wantsEscape(), false);
  assert.equal(c.handle({ type: "key", name: "escape" }), null);
  c.handle({ type: "text", text: "d" });
  assert.equal(c.vim.wantsEscape(), true);
  c.handle({ type: "key", name: "escape" });
  assert.equal(c.vim.pending, false);
  assert.equal(shown(c), "|ab");
  const i = vim("ab|", { mode: "insert" });
  assert.equal(i.vim.wantsEscape(), true, "Insert's Esc goes to Normal, never interrupts");
});

test("vim: Ctrl keys stay the app's in Normal (Ctrl+T, Ctrl+G…), except Ctrl+R (redo)", () => {
  const c = vim("|ab");
  assert.equal(c.handle({ type: "key", name: "t", ctrl: true }), null);
  assert.equal(c.handle({ type: "key", name: "g", ctrl: true }), null);
});

test("vim: Insert is the composer's own editing; Ctrl+R there is the history search", () => {
  const c = vim("|", { mode: "insert", history: { entries: () => ["earlier prompt"], add() {} } });
  c.handle({ type: "text", text: "ab" });
  assert.equal(c.text, "ab");
  c.handle({ type: "key", name: "backspace" });
  assert.equal(c.text, "a");
  c.handle({ type: "key", name: "r", ctrl: true });
  assert.equal(c.searching, true);
});

test("vim: Alt+x in Insert (a fast Esc then x on legacy terminals) is Esc, then x in Normal", () => {
  const c = vim("foo bar|", { mode: "insert" });
  c.handle({ type: "key", name: "b", alt: true });
  assert.equal(c.vim.mode, "normal");
  assert.equal(shown(c), "foo |bar");
});

test("vim: gg waits a second for its second g (Codex's chord), with Codex's hint", () => {
  let t = 0;
  const c = createComposer({ now: () => t });
  c.setVim(true);
  c.set("a\nb\nc", 4);
  c.handle({ type: "text", text: "g" });
  assert.equal(c.vim.hint, "g then \u{b7} g jump top \u{b7} esc cancel");
  t = 1500; // too late: the first g is dropped, the second starts a new chord
  c.handle({ type: "text", text: "g" });
  assert.equal(c.cursor, 4);
  t = 1600;
  c.handle({ type: "text", text: "g" });
  assert.equal(c.cursor, 0);
});

test("vim: j and k recall prompt history from an empty draft", () => {
  const c = vim("|", { history: { entries: () => ["first", "second"], add() {} } });
  c.handle({ type: "text", text: "k" });
  assert.equal(c.text, "second");
  c.handle({ type: "text", text: "k" });
  assert.equal(c.text, "first");
  c.handle({ type: "key", name: "down" });
  assert.equal(c.text, "second");
});

test("vim: the search query shows under the draft, with the cursor in it", () => {
  const c = vim("|one two");
  c.handle({ type: "text", text: "/" });
  c.handle({ type: "text", text: "tw" });
  const r = c.render({ width: 40 });
  assert.equal(r.lines.at(-1).map((s) => s.text).join(""), "/tw");
  assert.deepEqual(r.cursor, { row: r.lines.length - 1, col: 3 });
  assert.deepEqual(c.vim.search, { dir: "/", query: "tw" });
});

test("vim: no / or @ popup outside Insert; masked composers never get Vim", () => {
  const c = vim("/mo|del");
  assert.equal(c.token(), null);
  c.handle({ type: "text", text: "A" });
  assert.equal(c.token()?.kind, "command");
  const secret = createComposer({ mask: true });
  secret.setVim(true);
  assert.equal(secret.vim, null);
});

test("vim: undo history goes with a new draft; the register stays", () => {
  const c = vim("|foo bar");
  c.handle({ type: "text", text: "dw" });
  c.clear();
  c.setVim(true);
  c.set("x", 0);
  c.handle({ type: "text", text: "u" });
  assert.equal(c.text, "x", "nothing to undo in a new draft");
  c.handle({ type: "text", text: "p" });
  assert.equal(c.text, "xfoo ", "the register survives");
});

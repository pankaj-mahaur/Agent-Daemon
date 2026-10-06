// Styled spans, colour depth, SGR, wrap and truncate (tui/terminal/text.mjs).
// Invisible characters are written as \u{...} escapes, never raw.

import { test } from "node:test";
import assert from "node:assert/strict";
import { colorDepth, sgr, to256, renderLine, normalize, lineWidth, toLines, wrap, truncate, RESET } from "../src/tui/terminal/text.mjs";
import { graphemes, graphemeWidth, setWidthProfile } from "../src/tui/terminal/width.mjs";
import { assertGolden } from "../testkit/golden.mjs";

const FAMILY = "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}";
const THUMB_TONE = "\u{1f44d}\u{1f3fd}";
const FLAG_IN = "\u{1f1ee}\u{1f1f3}";
const plain = (lines) => lines.map((l) => l.map((s) => s.text).join(""));

/* ------------------------------------------------------------------ */
/* Colour depth                                                        */
/* ------------------------------------------------------------------ */

test("colorDepth: environment matrix", () => {
  const cases = [
    [{}, false, "linux", 0, "not a TTY"],
    [{}, true, "linux", 4, "plain TTY"],
    [{ TERM: "xterm-256color" }, true, "linux", 8, "256 from TERM"],
    [{ COLORTERM: "truecolor" }, true, "linux", 24, "COLORTERM truecolor"],
    [{ COLORTERM: "24bit" }, true, "darwin", 24, "COLORTERM 24bit"],
    [{ WT_SESSION: "x" }, true, "linux", 24, "Windows Terminal (e.g. WSL)"],
    [{}, true, "win32", 24, "Windows console"],
    [{ TERM: "dumb", COLORTERM: "truecolor" }, true, "linux", 0, "dumb terminal"],
    [{ NO_COLOR: "1", COLORTERM: "truecolor" }, true, "linux", 0, "NO_COLOR"],
    [{ NO_COLOR: "" }, true, "linux", 4, "empty NO_COLOR is ignored"],
    [{ NO_COLOR: "1", FORCE_COLOR: "3" }, false, "linux", 24, "FORCE_COLOR beats NO_COLOR and non-TTY"],
    [{ FORCE_COLOR: "" }, false, "linux", 4, "empty FORCE_COLOR"],
    [{ FORCE_COLOR: "2" }, false, "linux", 8, "FORCE_COLOR=2"],
    [{ FORCE_COLOR: "1", COLORTERM: "truecolor" }, true, "linux", 24, "FORCE_COLOR is a floor on a capable TTY"],
    [{ FORCE_COLOR: "1", COLORTERM: "truecolor" }, false, "linux", 4, "but exact when not a TTY"],
    [{ FORCE_COLOR: "0", COLORTERM: "truecolor" }, true, "linux", 0, "FORCE_COLOR=0"],
    [{ FORCE_COLOR: "false" }, true, "linux", 0, "FORCE_COLOR=false"],
  ];
  for (const [env, isTTY, platform, want, why] of cases) {
    assert.equal(colorDepth({ env, isTTY, platform }), want, why);
  }
});

/* ------------------------------------------------------------------ */
/* SGR                                                                 */
/* ------------------------------------------------------------------ */

test("sgr: named colours per depth", () => {
  assert.equal(sgr({ fg: "red" }, 4), "\x1b[31m");
  assert.equal(sgr({ bg: "blue" }, 4), "\x1b[44m");
  assert.equal(sgr({ fg: "brightRed" }, 4), "\x1b[91m");
  assert.equal(sgr({ fg: "brightRed" }, 8), "\x1b[38;5;9m");
  assert.equal(sgr({ fg: "red" }, 0), "", "no colour at depth 0");
});

test("sgr: hex colours downsample", () => {
  assert.equal(sgr({ fg: "#ff8000" }, 24), "\x1b[38;2;255;128;0m");
  assert.equal(sgr({ fg: "#ff8000" }, 8), "\x1b[38;5;208m");
  assert.equal(sgr({ fg: "#ff0000" }, 4), "\x1b[91m");
  assert.equal(sgr({ bg: "#000000" }, 8), "\x1b[48;5;16m");
  assert.equal(sgr({ bg: "#808080" }, 8), "\x1b[48;5;244m");
  assert.equal(sgr({ fg: "not-a-colour" }, 24), "");
});

const XTERM_CUBE = [0, 95, 135, 175, 215, 255];
function xterm256(i) {
  if (i >= 232) {
    const v = 8 + 10 * (i - 232);
    return [v, v, v];
  }
  const n = i - 16;
  return [XTERM_CUBE[Math.floor(n / 36)], XTERM_CUBE[Math.floor(n / 6) % 6], XTERM_CUBE[n % 6]];
}

test("to256 hits exact palette entries and picks the nearest otherwise", () => {
  for (let i = 16; i < 256; i++) assert.equal(to256(xterm256(i)), i, `palette entry ${i}`);
  // Nearest of all 240 cube/grey entries, on a coarse grid.
  const d = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  for (let r = 0; r < 256; r += 17) {
    for (let g = 0; g < 256; g += 17) {
      for (let b = 0; b < 256; b += 17) {
        let best = Infinity;
        for (let i = 16; i < 256; i++) best = Math.min(best, d([r, g, b], xterm256(i)));
        // The cube is separable and the nearest grey is the rounded mean, so this is exact.
        assert.ok(d([r, g, b], xterm256(to256([r, g, b]))) <= best, `${r},${g},${b}`);
      }
    }
  }
});

// Very dark tints such as #1f3a1f and #3a1f1f are both nearest to grey 235, so
// nearest-colour mapping can't keep them apart: theme tokens (Part 5) carry
// explicit 256- and 16-colour fallbacks for diff backgrounds.
test("to256 maps near-white and near-black to the right greys", () => {
  assert.equal(sgr({ bg: "#eeeeee" }, 8), "\x1b[48;5;255m");
  assert.equal(sgr({ bg: "#ffffff" }, 8), "\x1b[48;5;231m");
  assert.equal(sgr({ bg: "#080808" }, 8), "\x1b[48;5;232m");
});

test("sgr: attributes survive NO_COLOR, colours don't", () => {
  assert.equal(sgr({ bold: true, fg: "red" }, 0), "\x1b[1m");
  assert.equal(sgr({ bold: true, dim: true, italic: true, underline: true, inverse: true, strike: true }, 0), "\x1b[1;2;3;4;7;9m");
  assert.equal(sgr(undefined, 24), "");
  assert.equal(sgr({}, 24), "");
});

test("renderLine resets after every styled run and at the end", () => {
  const line = [{ text: "a" }, { text: "b", style: { fg: "red" } }, { text: "c", style: { bold: true } }, { text: "d" }];
  assert.equal(renderLine(line, 4), `a\x1b[31mb${RESET}\x1b[1mc${RESET}d`);
  assert.equal(renderLine([{ text: "x", style: { fg: "red" } }], 4), `\x1b[31mx${RESET}`);
  assert.equal(renderLine([{ text: "x", style: { fg: "red" } }], 0), "x", "nothing to reset");
  assert.equal(renderLine([], 24), "");
});

test("normalize joins equal styles and drops empty spans", () => {
  const out = normalize([{ text: "a" }, { text: "" }, { text: "b" }, { text: "c", style: { bold: true } }, { text: "d", style: { bold: true } }]);
  assert.deepEqual(out, [{ text: "ab" }, { text: "cd", style: { bold: true } }]);
});

/* ------------------------------------------------------------------ */
/* Lines and tabs                                                      */
/* ------------------------------------------------------------------ */

test("toLines splits newlines across spans and expands tabs to 8-column stops", () => {
  const lines = toLines([{ text: "ab\tc\n" }, { text: "\u{65e5}\tx", style: { bold: true } }]);
  assert.deepEqual(plain(lines), ["ab      c", "\u{65e5}      x"]);
  assert.equal(lineWidth(lines[1]), 9);
  assert.deepEqual(lines[1], [{ text: "\u{65e5}      x", style: { bold: true } }]);
});

test("lineWidth measures a cluster split across spans once", () => {
  const S = { bold: true };
  // Different styles, so the spans are not simply merged before measuring.
  const line = [{ text: THUMB_TONE, style: S }, { text: "\u{301}", style: { italic: true } }];
  for (const name of ["codepoint", "grapheme"]) {
    const prev = setWidthProfile(name);
    try {
      // In the grapheme profile the joined cluster is no longer RGI, so it is 4
      // wide; measuring each span alone would say 2 and let wrap overflow.
      assert.equal(lineWidth(line), 4, name);
      for (const out of wrap(line, 3)) assert.ok(lineWidth(out) <= 4, name);
      assert.equal(wrap([{ text: "ab" }, ...line], 4).length, 2, `${name}: the cluster moves to its own line`);
    } finally {
      setWidthProfile(prev);
    }
  }
});

/* ------------------------------------------------------------------ */
/* Wrap                                                                */
/* ------------------------------------------------------------------ */

test("wrap breaks at word boundaries and drops the spaces at the break", () => {
  assert.deepEqual(plain(wrap([{ text: "the quick brown fox jumps" }], 10)), ["the quick", "brown fox", "jumps"]);
});

test("wrap keeps leading indentation but not trailing spaces", () => {
  assert.deepEqual(plain(wrap([{ text: "    indented words here   " }], 12)), ["    indented", "words here"]);
});

test("wrap keeps the indent when the first word doesn't fit beside it", () => {
  assert.deepEqual(plain(wrap([{ text: "    abcdefgh" }], 10)), ["    abcdef", "gh"]);
});

test("wrap never emits a blank line for indentation as wide as the line", () => {
  assert.deepEqual(plain(wrap([{ text: "    abcdefgh" }], 4)), ["abcd", "efgh"]);
  assert.deepEqual(plain(wrap([{ text: "\t\t   xyzzyplugh" }], 5)), ["xyzzy", "plugh"]);
});

test("wrap hard-breaks a word longer than the line", () => {
  assert.deepEqual(plain(wrap([{ text: "abcdefghij xy" }], 4)), ["abcd", "efgh", "ij", "xy"]);
});

test("wrap never splits a wide grapheme across the edge", () => {
  const cjk = "\u{65e5}\u{672c}\u{8a9e}\u{306e}\u{30c6}\u{30ad}";
  assert.deepEqual(plain(wrap([{ text: cjk }], 5)), [cjk.slice(0, 2), cjk.slice(2, 4), cjk.slice(4)]);
  const prev = setWidthProfile("grapheme");
  try {
    assert.deepEqual(plain(wrap([{ text: `a${FAMILY}b` }], 2)), ["a", FAMILY, "b"]);
  } finally {
    setWidthProfile(prev);
  }
});

test("wrap keeps blank lines and styles across breaks", () => {
  const out = wrap([{ text: "one\n\n" }, { text: "two three", style: { fg: "red" } }], 5);
  assert.deepEqual(plain(out), ["one", "", "two", "three"]);
  assert.deepEqual(out[3], [{ text: "three", style: { fg: "red" } }]);
});

test("wrap survives a huge run of zero-width characters", () => {
  const out = wrap([{ text: "\u{200b}".repeat(300_000) + " x" }], 80);
  assert.deepEqual(plain(out).map((s) => s.length), [300_000 + 2]);
});

test("wrap rejects a width below 1", () => {
  assert.throws(() => wrap([{ text: "x" }], 0), RangeError);
});

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test("wrap property: lines fit, nothing but break spaces is lost, no stray blank lines", () => {
  const alphabet = ["a", "b", "z", " ", " ", "  ", "\t", "\u{65e5}", "\u{e9}", THUMB_TONE, "x\u{301}", "-", "ab", "\n"];
  const maxGrapheme = Math.max(...alphabet.map((g) => graphemes(g).reduce((w, x) => Math.max(w, graphemeWidth(x)), 0)));
  const random = rng(7);
  for (let round = 0; round < 800; round++) {
    let text = "";
    const n = Math.floor(random() * 40);
    for (let k = 0; k < n; k++) text += alphabet[Math.floor(random() * alphabet.length)];
    const width = maxGrapheme + Math.floor(random() * 14);
    const ctx = `width ${width}, ${JSON.stringify(text)}`;
    const out = wrap([{ text }], width);
    for (const line of out) {
      const s = line.map((sp) => sp.text).join("");
      assert.ok(lineWidth(line) <= width, `${ctx}: ${JSON.stringify(s)} too wide`);
      assert.ok(!/ $/.test(s), `${ctx}: trailing space in ${JSON.stringify(s)}`);
    }
    const squash = (s) => graphemes(s).filter((g) => g !== " " && g !== "\n" && g !== "\t").join("");
    assert.equal(squash(plain(out).join("")), squash(text), ctx);
    // A source line with any visible content wraps to lines that are all non-blank.
    for (const source of text.split("\n")) {
      if (!/[^ \t]/.test(source)) continue;
      for (const s of plain(wrap([{ text: source }], width))) assert.ok(s.trim() !== "", `${ctx}: blank line from ${JSON.stringify(source)}`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* Truncate                                                            */
/* ------------------------------------------------------------------ */

test("truncate adds an ellipsis only when it cuts", () => {
  assert.deepEqual(truncate([{ text: "hello" }], 5), [{ text: "hello" }]);
  assert.deepEqual(truncate([{ text: "hello world" }], 8), [{ text: "hello w\u{2026}" }]);
  assert.deepEqual(truncate([{ text: "\u{65e5}\u{672c}\u{8a9e}" }], 4), [{ text: "\u{65e5}\u{2026}" }], "a wide char that doesn't fit is dropped");
  assert.deepEqual(truncate([{ text: "abc" }], 0), []);
  assert.deepEqual(truncate([{ text: "abc" }, { text: "def", style: { bold: true } }], 5), [
    { text: "abc" },
    { text: "d\u{2026}", style: { bold: true } },
  ]);
  assert.ok(lineWidth(truncate([{ text: THUMB_TONE.repeat(3) }], 5)) <= 5);
});

/* ------------------------------------------------------------------ */
/* Goldens                                                             */
/* ------------------------------------------------------------------ */

const PARAGRAPH = [
  { text: "Codex-style answers wrap at word boundaries, like " },
  { text: "this bold phrase", style: { bold: true } },
  { text: `, and keep CJK text (\u{65e5}\u{672c}\u{8a9e}\u{306e}\u{30c6}\u{30ad}\u{30b9}\u{30c8}) and emoji ${FAMILY} ${FLAG_IN} whole.\n` },
  { text: "    Indented code stays indented;\tthen a tab.\n\n" },
  { text: "A_very_long_identifier_that_has_no_spaces_at_all_and_must_be_hard_broken_somewhere", style: { fg: "cyan" } },
];

for (const width of [20, 40, 79]) {
  test(`wrap golden at width ${width}`, () => {
    const lines = wrap(PARAGRAPH, width);
    for (const line of lines) assert.ok(lineWidth(line) <= width);
    const body = lines.map((l) => `|${l.map((s) => s.text).join("")}|`).join("\n");
    const styled = lines.map((l) => JSON.stringify(renderLine(l, 4))).join("\n");
    assertGolden(`tui/wrap-${width}.txt`, `${body}\n--- ansi (depth 4)\n${styled}`);
  });
}

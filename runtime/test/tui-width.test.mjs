// Terminal cell widths (tui/terminal/width.mjs). Only cases whose width has
// been stable across Unicode versions, so a Node upgrade can't flip them.
// Invisible characters are written as \u{...} escapes, never raw.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stringWidth,
  graphemeWidth,
  graphemes,
  codePointWidth,
  setWidthProfile,
  widthProfile,
} from "../src/tui/terminal/width.mjs";
import { WIDE, UNICODE_VERSION } from "../src/tui/terminal/width-table.mjs";
import { parseEastAsianWidth, renderTable } from "../scripts/gen-width-tables.mjs";

const FAMILY = "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}";
const THUMB_TONE = "\u{1f44d}\u{1f3fd}";
const FLAG_IN = "\u{1f1ee}\u{1f1f3}";
const KEYCAP_1 = "1\u{fe0f}\u{20e3}";
const HEART_VS16 = "\u{2764}\u{fe0f}";

// [text, width in the default "codepoint" profile, width in "grapheme", why]
const CASES = [
  ["", 0, 0, "empty"],
  ["hello, world", 12, 12, "printable ASCII"],
  ["\u{65e5}\u{672c}\u{8a9e}", 6, 6, "CJK ideographs are wide"],
  ["\u{d55c}\u{ad6d}\u{c5b4}", 6, 6, "precomposed Hangul is wide"],
  ["\u{1100}\u{1161}\u{11a8}", 2, 2, "conjoining Hangul jamo: medial and final are zero"],
  ["\u{ff21}\u{ff22}\u{ff23}", 6, 6, "fullwidth Latin"],
  ["\u{ff71}\u{ff72}\u{ff73}", 3, 3, "halfwidth katakana"],
  ["e\u{301}", 1, 1, "combining acute"],
  ["\u{301}", 0, 0, "lone combining mark"],
  ["\u{3b1}\u{3b2}\u{3b3}", 3, 3, "Greek is ambiguous, counted as 1"],
  ["\u{2192} \u{2190} \u{b7}", 5, 5, "ambiguous arrows and dot stay 1"],
  ["\u{200b}", 0, 0, "zero-width space"],
  ["\u{ad}", 0, 0, "soft hyphen (Cf)"],
  ["\u{feff}", 0, 0, "BOM / zero-width no-break space"],
  ["\x07\x08\x1b", 0, 0, "C0 controls"],
  ["\x85\x9b", 0, 0, "C1 controls"],
  ["\t", 0, 0, "tab is expanded by text.mjs, not measured here"],
  ["\u{1f600}", 2, 2, "emoji presentation"],
  [THUMB_TONE, 4, 2, "emoji + skin tone modifier"],
  [FAMILY, 6, 2, "ZWJ family sequence"],
  [FLAG_IN, 2, 2, "flag (regional indicator pair)"],
  [KEYCAP_1, 2, 2, "keycap sequence"],
  [HEART_VS16, 2, 2, "text-default emoji with VS16"],
  ["\u{2764}", 1, 1, "text-default emoji without VS16"],
  ["\u{928}\u{92e}\u{938}\u{94d}\u{924}\u{947}", 4, 4, "Devanagari: sum of code points like wcwidth"],
  ["a\u{65e5}b", 4, 4, "mixed"],
];

function withProfile(name, fn) {
  const prev = setWidthProfile(name);
  try {
    fn();
  } finally {
    setWidthProfile(prev);
  }
}

test("default profile is codepoint", () => {
  assert.equal(widthProfile(), "codepoint");
});

for (const [text, cpWidth, gWidth, why] of CASES) {
  test(`stringWidth ${JSON.stringify(text)} = ${cpWidth} / ${gWidth} (${why})`, () => {
    assert.equal(stringWidth(text), cpWidth, "codepoint profile");
    withProfile("grapheme", () => assert.equal(stringWidth(text), gWidth, "grapheme profile"));
  });
}

test("codepoint profile never counts an emoji narrower than the grapheme profile", () => {
  for (const [text, cpWidth, gWidth] of CASES) assert.ok(cpWidth >= gWidth, JSON.stringify(text));
});

test("setWidthProfile rejects unknown names and returns the previous one", () => {
  assert.throws(() => setWidthProfile("auto"), /unknown/);
  assert.equal(setWidthProfile("grapheme"), "codepoint");
  assert.equal(setWidthProfile("codepoint"), "grapheme");
});

test("stringWidth equals the sum of grapheme widths", () => {
  for (const [text] of CASES) {
    const sum = graphemes(text).reduce((w, g) => w + graphemeWidth(g), 0);
    assert.equal(stringWidth(text), sum, JSON.stringify(text));
  }
});

test("emoji sequences are one grapheme each", () => {
  assert.deepEqual(graphemes(`a${FAMILY}${FLAG_IN}b`), ["a", FAMILY, FLAG_IN, "b"]);
});

test("codePointWidth at block edges", () => {
  assert.equal(codePointWidth(0x10ff), 1);
  assert.equal(codePointWidth(0x1100), 2, "first Hangul initial");
  assert.equal(codePointWidth(0x115f), 2, "Hangul choseong filler");
  assert.equal(codePointWidth(0x1160), 0, "Hangul jungseong filler");
  assert.equal(codePointWidth(0x11ff), 0, "last conjoining final");
  assert.equal(codePointWidth(0xd7b0), 1, "extended jamo: drawn 1 by xterm.js, so not 0");
  assert.equal(codePointWidth(0xffa0), 1, "halfwidth filler is drawn, not zero");
  assert.equal(codePointWidth(0x3164), 2, "Hangul filler: default-ignorable but wide");
  assert.equal(codePointWidth(0x3099), 0, "combining kana mark inside a wide block");
  assert.equal(codePointWidth(0x200b), 0, "zero-width space");
  assert.equal(codePointWidth(0x1f93b), 2, "legacy-wide emoji (xterm.js)");
  assert.equal(codePointWidth(0x1f946), 2, "legacy-wide emoji (xterm.js)");
  assert.equal(codePointWidth(0x4e00), 2);
  assert.equal(codePointWidth(0x3000), 2, "ideographic space");
  assert.equal(codePointWidth(0x7e), 1);
  assert.equal(codePointWidth(0x7f), 0);
  assert.equal(codePointWidth(0xa0), 1);
});

test("vendored table is sorted, merged and non-overlapping", () => {
  assert.ok(WIDE.length % 2 === 0 && WIDE.length > 100);
  assert.match(UNICODE_VERSION, /^\d+\.\d+\.\d+$/);
  for (let i = 0; i < WIDE.length; i += 2) {
    assert.ok(WIDE[i] <= WIDE[i + 1], `range ${i / 2} reversed`);
    if (i > 0) assert.ok(WIDE[i] > WIDE[i - 1] + 1, `range ${i / 2} overlaps or touches the previous one`);
  }
});

test("generator parses UCD lines, keeps only W and F, merges neighbours", () => {
  const ucd = [
    "# EastAsianWidth-1.2.3.txt",
    "# comment",
    "0020..007E;Na   # ASCII",
    "1100..115F;W    # Hangul",
    "3000;F          # ideographic space",
    "3001..3003;W",
    "00A1;A",
    "",
  ].join("\n");
  const ranges = parseEastAsianWidth(ucd, "1.2.3");
  assert.deepEqual(ranges, [[0x1100, 0x115f], [0x3000, 0x3003]]);
  const js = renderTable(ranges, "1.2.3");
  assert.match(js, /UNICODE_VERSION = "1\.2\.3"/);
  assert.match(js, /0x1100,0x115F, 0x3000,0x3003,/);
});

test("generator rejects a file for another version and malformed ranges", () => {
  assert.throws(() => parseEastAsianWidth("# EastAsianWidth-15.1.0.txt\n1100;W\n", "16.0.0"), /15\.1\.0/);
  assert.throws(() => parseEastAsianWidth("# EastAsianWidth-16.0.0.txt\nZZZZ;W\n", "16.0.0"), /malformed/);
});

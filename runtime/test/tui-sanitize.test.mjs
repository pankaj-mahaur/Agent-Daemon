// Hostile strings through sanitize() (tui/terminal/sanitize.mjs): nothing in
// "transcript" mode may reach the terminal as a control, and nothing in
// "approval" mode may be hidden from the user.
// Invisible characters are written as \u{...} escapes, never raw.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitize } from "../src/tui/terminal/sanitize.mjs";

const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u{061c}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/u;
const FAMILY = "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}";

const HOSTILE = [
  ["\x1b[31mred\x1b[0m", "red", "SGR colour"],
  ["a\x1b[2J\x1b[3Jb", "ab", "clear screen and scrollback"],
  ["a\x1b[10;5Hb\x1b[Ac", "abc", "cursor moves"],
  ["x\x1b[?1049hy\x1b[?25l", "xy", "private modes (alt screen, hide cursor)"],
  ["\x1b]0;pwned title\x07ok", "ok", "OSC title, BEL-terminated"],
  ["\x1b]52;c;ZXZpbA==\x1b\\ok", "ok", "OSC 52 clipboard write, ST-terminated"],
  ["\x1b]8;;https://evil.example\x1b\\click\x1b]8;;\x1b\\", "click", "OSC 8 hyperlink"],
  ["a\x1bPq#0;2;0;0;0\x1b\\b", "ab", "DCS (sixel)"],
  ["a\x1b_payload\x1b\\b", "ab", "APC"],
  ["a\x1b]0;never terminated", "a", "unterminated OSC at the end"],
  ["before \x1bX after\nmore\nlines", "before \nmore\nlines", "unterminated SOS stops at the newline"],
  ["x\x1b^pm\nnext", "x\nnext", "unterminated PM stops at the newline"],
  ["a\x1b]0;t\x1b[31mred\x1b[0m b", "ared b", "unterminated OSC stops at the next ESC"],
  ["a\x1b]0;t\x18b\x1b]0;u\x1ac", "abc", "CAN and SUB abort an OSC"],
  ["a\x9b31mb", "ab", "8-bit CSI"],
  ["a\x9d0;t\x9cb", "ab", "8-bit OSC with 8-bit ST"],
  ["a\x1b7b\x1b8c\x1bcd", "abcd", "two-byte escapes (save, restore, reset)"],
  ["a\x1b(0b", "ab", "charset designation"],
  ["trailing\x1b", "trailing", "lone trailing ESC"],
  ["bell\x07 back\x08space", "bell backspace", "C0 controls"],
  ["safe\rrm -rf /", "saferm -rf /", "lone CR can't overwrite the line"],
  ["line\r\nnext", "line\nnext", "CRLF becomes LF"],
  ["tab\tand\nnewline", "tab\tand\nnewline", "tab and newline kept"],
  ["del\x7fete", "delete", "DEL"],
  ["admin\u{202e}\u{2066} // evil\u{2069}\u{2066}", "admin // evil", "Trojan Source bidi controls"],
  ["a\u{200e}b\u{200f}c\u{061c}d", "abcd", "bidi marks"],
  [`fam ${FAMILY} ok`, `fam ${FAMILY} ok`, "ZWJ emoji untouched"],
  ["lone \u{d800} surrogate", "lone \u{fffd} surrogate", "lone surrogate made well-formed"],
];

for (const [input, want, why] of HOSTILE) {
  test(`transcript: ${why}`, () => {
    const out = sanitize(input, "transcript");
    assert.equal(out, want);
    assert.ok(!CONTROL.test(out.replace(/[\t\n]/g, "")), "a control survived");
  });
}

test("transcript is the default mode and tolerates non-strings", () => {
  assert.equal(sanitize("\x1b[1mx"), "x");
  assert.equal(sanitize(null), "");
  assert.equal(sanitize(42), "42");
});

test("transcript property: random bytes never leave a control behind", () => {
  let s = 12345;
  const next = () => ((s = (s * 1103515245 + 12345) >>> 0) % 0xa0);
  for (let round = 0; round < 300; round++) {
    let text = "";
    for (let k = 0; k < 60; k++) text += String.fromCharCode(next());
    const out = sanitize(text, "transcript").replace(/[\t\n]/g, "");
    assert.ok(!CONTROL.test(out), JSON.stringify(text));
  }
});

test("transcript is linear on large hostile input", () => {
  const big = "\x1b]".repeat(200_000) + "\x1b[".repeat(200_000) + "\x1bX\n".repeat(100_000);
  const t0 = performance.now();
  sanitize(big, "transcript");
  assert.ok(performance.now() - t0 < 2000, "took too long");
});

test("approval: escape sequences become visible, not removed", () => {
  assert.equal(sanitize("echo hi\x1b[2K\x1b[1Gecho bye", "approval"), "echo hi\u{241b}[2K\u{241b}[1Gecho bye");
});

test("approval: CR, BEL, NUL and DEL are shown as control pictures", () => {
  assert.equal(sanitize("safe\rrm -rf /", "approval"), "safe\u{240d}rm -rf /");
  assert.equal(sanitize("a\x07b\x00c\x7fd", "approval"), "a\u{2407}b\u{2400}c\u{2421}d");
});

const SPELLED = [
  [0x9b, "C1 CSI"],
  [0x85, "C1 next line"],
  [0x202e, "right-to-left override"],
  [0x2066, "left-to-right isolate"],
  [0x061c, "Arabic letter mark"],
  [0x200b, "zero-width space"],
  [0x200d, "zero-width joiner"],
  [0x2060, "word joiner"],
  [0xfeff, "BOM"],
  [0x00ad, "soft hyphen"],
  [0x180e, "Mongolian vowel separator"],
  [0xfff9, "interlinear annotation anchor"],
  [0xfffb, "interlinear annotation terminator"],
  [0x2028, "line separator"],
  [0x2029, "paragraph separator"],
  [0x206a, "inhibit symmetric swapping"],
  [0x034f, "combining grapheme joiner"],
  [0x3164, "Hangul filler"],
  [0x115f, "Hangul choseong filler"],
  [0xffa0, "halfwidth Hangul filler"],
  [0xfe0f, "variation selector 16"],
  [0xe0100, "variation selector supplement"],
  [0xe0041, "tag character (ASCII smuggling)"],
  [0x1bca0, "shorthand format letter overlap"],
  [0x00a0, "no-break space"],
  [0x2000, "en quad"],
  [0x202f, "narrow no-break space"],
  [0x3000, "ideographic space"],
  [0x2800, "braille blank"],
  [0x16fe4, "Khitan filler"],
  [0xe000, "private use"],
  [0xf0000, "supplementary private use"],
  [0xffff, "noncharacter (never assigned)"],
];

for (const [cp, why] of SPELLED) {
  test(`approval spells out U+${cp.toString(16).toUpperCase().padStart(4, "0")} (${why})`, () => {
    const hex = cp.toString(16).toUpperCase().padStart(4, "0");
    assert.equal(sanitize(`rm${String.fromCodePoint(cp)} -rf`, "approval"), `rm<U+${hex}> -rf`);
  });
}

test("approval keeps tab, newline and ordinary text", () => {
  assert.equal(sanitize("cat <<EOF\n\tx\nEOF", "approval"), "cat <<EOF\n\tx\nEOF");
  assert.equal(sanitize("echo \u{65e5}\u{672c} caf\u{e9} ok", "approval"), "echo \u{65e5}\u{672c} caf\u{e9} ok");
});

test("approval output has no raw controls left", () => {
  let all = "";
  for (let cp = 0; cp < 0xa0; cp++) all += String.fromCharCode(cp);
  const out = sanitize(all + "\u{202a}\u{202e}\u{2066}\u{2069}\u{200b}\u{200d}\u{feff}", "approval");
  assert.ok(!CONTROL.test(out.replace(/[\t\n]/g, "")));
  assert.ok(!/[\u{200b}-\u{200d}\u{feff}]/u.test(out));
});

test("unknown mode throws", () => {
  assert.throws(() => sanitize("x", "raw"), /unknown mode/);
});

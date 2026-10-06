// Terminal cell width of strings, per grapheme cluster.
//
// Code points: East Asian Wide and Fullwidth are 2, ambiguous is 1, combining
// marks (Mn, Me), format characters (Cf) and Hangul medial/final jamo are 0,
// C0/C1 controls are 0 (sanitize first), everything else is 1.
//
// Clusters: terminals disagree. Windows Terminal draws an RGI emoji sequence
// as 2 cells; xterm.js (VS Code) and wcwidth-style terminals add up its code
// points (a ZWJ family is 6). So there are two profiles:
//   "codepoint" (default): RGI emoji = max(2, sum); safe everywhere, because
//                over-counting only leaves blank cells.
//   "grapheme":  RGI emoji = 2; the renderer selects it once it knows the
//                terminal clusters graphemes (Windows Terminal, or measured).
// Any other cluster is the sum of its code points in both profiles.

import { WIDE } from "./width-table.mjs";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const RGI_EMOJI = /^\p{RGI_Emoji}$/v;
const ZERO = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
// Emoji that xterm.js and older wcwidth tables still draw 2 cells wide.
const LEGACY_WIDE = new Set([0x1f93b, 0x1f946]);

let profile = "codepoint";

/** Selects the cluster profile; returns the previous one. */
export function setWidthProfile(next) {
  if (next !== "codepoint" && next !== "grapheme") throw new Error(`width profile: unknown ${next}`);
  const prev = profile;
  profile = next;
  return prev;
}

export function widthProfile() {
  return profile;
}

function isWide(cp) {
  let lo = 0;
  let hi = WIDE.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < WIDE[mid * 2]) hi = mid - 1;
    else if (cp > WIDE[mid * 2 + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

export function codePointWidth(cp) {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x7f) return 1;
  if (cp >= 0x1160 && cp <= 0x11ff) return 0;
  // Zero before wide: combining marks inside wide blocks (U+3099) are 0, while
  // wide fillers (U+115F, U+3164) are letters and stay 2.
  const ch = String.fromCodePoint(cp);
  if (ZERO.test(ch)) return 0;
  return isWide(cp) || LEGACY_WIDE.has(cp) ? 2 : 1;
}

/** Grapheme clusters with their UTF-16 offsets. */
export function* graphemeSegments(text) {
  for (const { segment, index } of segmenter.segment(text)) yield { segment, index };
}

export function graphemes(text) {
  const out = [];
  for (const { segment } of segmenter.segment(text)) out.push(segment);
  return out;
}

export function graphemeWidth(g) {
  const first = g.codePointAt(0);
  if (first === undefined) return 0;
  if (g.length === 1 || (g.length === 2 && first > 0xffff)) return codePointWidth(first);
  let sum = 0;
  for (const ch of g) sum += codePointWidth(ch.codePointAt(0));
  if (RGI_EMOJI.test(g)) return profile === "grapheme" ? 2 : Math.max(2, sum);
  return sum;
}

export function stringWidth(text) {
  if (PRINTABLE_ASCII.test(text)) return text.length;
  let w = 0;
  for (const { segment } of segmenter.segment(text)) w += graphemeWidth(segment);
  return w;
}

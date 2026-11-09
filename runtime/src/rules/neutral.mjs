// Text that reaches a model must never carry a command that runs ad, above all one that
// lowers enforcement (MCP launch plan L7, S4). A rule's reason is the user's own words and
// lands in the hook's deny reason, so it is neutralised when the rule is made (the review
// service) and again when the hook renders it (a snapshot written by an older writer).
// Pure, no dependencies: the hook path imports it.

import { PRODUCT, LEGACY_NAMES } from "../product.mjs";

const ENTRY_NAMES = [...new Set(["ad", "agent-daemon", "teachonce", PRODUCT.bin, PRODUCT.package, ...LEGACY_NAMES])];
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, (c) => "\\" + c);

// Each token has one way to match (no nested alternatives over the same text), so hostile
// text can't make it backtrack for long.
const ENTRY_COMMAND = new RegExp(
  String.raw`(?:\b(?:npx|pnpm\s+dlx|pnpm\s+exec|yarn\s+dlx|yarn\s+exec|npm\s+exec|npm\s+x|bunx)\s+(?:-[\w-]*\s+)*)?(?<![\w-])(?:${ENTRY_NAMES.map(esc).join("|")})(?:\.(?:cmd|exe|ps1))?(?:@[\w.-]+)?(?:\s+[\w-]+)+`,
  "gi"
);
// Lowering phrases, whatever comes before them (`ad.cmd rules pause`, `node …/cli.mjs rules rm 7`).
const LOWERING = /\b(?:rules\s+(?:rm|remove|pause|resume|allow-once|add)\b(?:\s+[\w-]+)*|config\s+review\s+auto\b|review\s+--accept-all\b(?:\s+--?[\w-]+)*)/gi;

/** One line of the user's words, safe for a model's text: no control or bidi characters, no ad commands, ≤ max characters. */
export function neutralText(text, { max = 120 } = {}) {
  const one = String(text ?? "")
    .slice(0, 1000) // never scan more than this; the result keeps `max`
    .replace(/[\u{0}-\u{1f}\u{7f}-\u{9f}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu, " ")
    .replace(ENTRY_COMMAND, "…")
    .replace(LOWERING, "…")
    .replace(/\s+/g, " ")
    .trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

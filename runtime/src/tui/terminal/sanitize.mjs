// Untrusted text (model output, command output, file names, MCP results) must
// never reach the terminal as control sequences.
//
//   sanitize(text, "transcript")  for display: removes escape sequences, C0
//     (except tab and newline), DEL, C1 and bidi controls. A lone CR goes too,
//     so "\r\n" becomes "\n". An unterminated OSC/DCS/APC/PM/SOS string ends
//     before the next newline, ESC, CAN or SUB, so one stray introducer can't
//     hide the text after it.
//   sanitize(text, "approval")    for what the user is asked to approve: nothing
//     is removed. Every control, format, default-ignorable, variation-selector,
//     non-ASCII space, private-use, unassigned and blank-glyph character is
//     shown (ESC as "␛", other C0 as control pictures, the rest as
//     "<U+XXXX>"), so a command can't hide part of itself. Tab and newline stay.
//
// Sanitize the accumulated text, not each streamed delta: a sequence split
// across deltas is only recognised whole.
//
// Source note: write invisible characters as \u{...} escapes here, never raw.

const ESCAPE_SEQUENCE = new RegExp(
  [
    // CSI (7-bit and 8-bit introducer): parameters, intermediates, final byte.
    String.raw`(?:\x1b\[|\x9b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]?`,
    // OSC, DCS, SOS, PM, APC: up to BEL or ST. Unterminated, it ends before the
    // next newline, ESC, CAN or SUB, as terminals abort a string on ESC/CAN/SUB.
    String.raw`(?:\x1b[\]PX^_]|[\x9d\x90\x98\x9e\x9f])[^\n]*?(?:\x07|\x1b\\|\x9c|(?=[\n\x1b\x18\x1a])|$)`,
    // Any other escape: intermediates and one final byte (ESC 7, ESC ( B, ESC c).
    String.raw`\x1b[\x20-\x2f]*[\x30-\x7e]?`,
  ].join("|"),
  "g",
);

const TRANSCRIPT_STRIP = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u{061c}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu;

const APPROVAL_VISIBLE =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}\p{Variation_Selector}\u{2800}\u{16fe4}]|[\p{Zs}--[ ]]/gv;

function visible(ch) {
  const cp = ch.codePointAt(0);
  if (cp === 0x09 || cp === 0x0a) return ch;
  if (cp === 0x1b) return "\u{241b}";
  if (cp < 0x20) return String.fromCodePoint(0x2400 + cp);
  if (cp === 0x7f) return "\u{2421}";
  return `<U+${cp.toString(16).toUpperCase().padStart(4, "0")}>`;
}

export function sanitize(text, mode = "transcript") {
  const s = String(text ?? "").toWellFormed();
  if (mode === "transcript") return s.replace(ESCAPE_SEQUENCE, "").replace(TRANSCRIPT_STRIP, "");
  if (mode === "approval") return s.replace(APPROVAL_VISIBLE, visible);
  throw new Error(`sanitize: unknown mode ${mode}`);
}

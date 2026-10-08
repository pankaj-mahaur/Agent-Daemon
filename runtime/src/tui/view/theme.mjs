// The terminal UI's styles in one place (codex-parity-2 P8): modules name a
// style by what it means (accent, code, success…) instead of keeping their
// own colour tables, so a colour has one name and one home. The UI's colours
// follow Codex's and aren't themeable; syntax highlighting gets its own
// themes. Transcript (committed) lines use foreground colours only: the
// terminal's scrollback can't be restyled after a light/dark change.
//
// Text formatting that isn't a colour choice (markdown emphasis, links) stays
// where it is written.

// Frozen all the way down: modules share these objects, so none may change one.
export const T = deepFreeze({
  dim: { dim: true },
  bold: { bold: true },
  italicDim: { dim: true, italic: true },
  boldDim: { dim: true, bold: true },
  done: { dim: true, strike: true }, // a finished plan step
  heading: { bold: true, underline: true }, // markdown # heading
  // What stands out: selection, keys, prompts, the user's own message, a step in progress.
  accent: { fg: "cyan", bold: true },
  // Commands, inline code and code blocks, command names in lists.
  code: { fg: "cyan" },
  success: { fg: "green" },
  successStrong: { fg: "green", bold: true },
  error: { fg: "red" },
  errorStrong: { fg: "red", bold: true },
  warning: { fg: "yellow" },
  diffAdd: { fg: "green" },
  diffDel: { fg: "red" },
  diffHunk: { fg: "cyan", dim: true },
});

function deepFreeze(o) {
  for (const v of Object.values(o)) Object.freeze(v);
  return Object.freeze(o);
}

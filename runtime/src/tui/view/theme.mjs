// The terminal UI's styles in one place (parity P8): modules name a
// style by what it means (accent, code, success…) instead of keeping their
// own colour tables, so a colour has one name and one home. The UI's colours
// follow upstream's and aren't themeable; syntax highlighting gets its own
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
  // The plan mode: the footer's mode chip and the prompt.
  planMode: { fg: "magenta" },
  // The command a cell answers, as the engine heads them ("/debug-config").
  commandEcho: { fg: "magenta" },
  // The Vim mode indicator.
  vimNormal: { fg: "magenta" },
  vimInsert: { fg: "green" },
  vimReplace: { fg: "cyan" },
  diffAdd: { fg: "green" },
  diffDel: { fg: "red" },
  diffHunk: { fg: "cyan", dim: true },
  // Fullscreen (P2.3): selected cells, Find's matches and its current match.
  selection: { inverse: true },
  findMatch: { underline: true, bold: true },
  findCurrent: { inverse: true, bold: true },
});

// Syntax highlighting (parity Part 9): token class → style, per theme
// (upstream's names). Used by view/highlight.mjs; /theme picks one.
// "ansi" uses the terminal's own 16 colours (it follows its palette, light or
// dark); the other two are upstream's adaptive defaults, in truecolor (the
// renderer downsamples them to 256 or 16 colours; NO_COLOR keeps none).
export const SYNTAX = {
  ansi: {
    keyword: { fg: "magenta" },
    string: { fg: "green" },
    number: { fg: "yellow" },
    comment: { fg: "gray" },
    function: { fg: "blue" },
    type: { fg: "cyan" },
    constant: { fg: "yellow" },
    operator: null,
    punctuation: null,
    property: { fg: "cyan" },
    tag: { fg: "red" },
    attribute: { fg: "yellow" },
    variable: { fg: "red" },
    builtin: { fg: "cyan" },
    inserted: { fg: "green" },
    deleted: { fg: "red" },
    meta: { fg: "cyan" },
  },
  "catppuccin-mocha": {
    keyword: { fg: "#cba6f7" },
    string: { fg: "#a6e3a1" },
    number: { fg: "#fab387" },
    comment: { fg: "#7f849c", italic: true },
    function: { fg: "#89b4fa" },
    type: { fg: "#f9e2af" },
    constant: { fg: "#fab387" },
    operator: { fg: "#89dceb" },
    punctuation: { fg: "#9399b2" },
    property: { fg: "#b4befe" },
    tag: { fg: "#89b4fa" },
    attribute: { fg: "#f9e2af" },
    variable: { fg: "#f38ba8" },
    builtin: { fg: "#f38ba8" },
    inserted: { fg: "#a6e3a1" },
    deleted: { fg: "#f38ba8" },
    meta: { fg: "#89dceb" },
  },
  "catppuccin-latte": {
    keyword: { fg: "#8839ef" },
    string: { fg: "#40a02b" },
    number: { fg: "#fe640b" },
    comment: { fg: "#8c8fa1", italic: true },
    function: { fg: "#1e66f5" },
    type: { fg: "#df8e1d" },
    constant: { fg: "#fe640b" },
    operator: { fg: "#04a5e5" },
    punctuation: { fg: "#7c7f93" },
    property: { fg: "#7287fd" },
    tag: { fg: "#1e66f5" },
    attribute: { fg: "#df8e1d" },
    variable: { fg: "#d20f39" },
    builtin: { fg: "#d20f39" },
    inserted: { fg: "#40a02b" },
    deleted: { fg: "#d20f39" },
    meta: { fg: "#04a5e5" },
  },
};

function deepFreeze(o) {
  for (const v of Object.values(o)) Object.freeze(v);
  return Object.freeze(o);
}

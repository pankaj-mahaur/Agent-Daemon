// What the renderer needs to know about the terminal that the capability
// queries can't tell it (plan Part 0 S1/S1b, Part 1c, v4.1).

const FAMILY = "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}";

/** Which terminal this is, from the environment. */
export function terminalName(env = process.env) {
  // TERM_PROGRAM first: WT_SESSION is inherited by an editor started from
  // Windows Terminal, whose own terminal is then not Windows Terminal.
  const program = (env.TERM_PROGRAM ?? "").toLowerCase();
  if (program === "zed") return "zed";
  if (program === "vscode") return "vscode";
  if (program === "iterm.app") return "iterm2";
  if (program === "wezterm") return "wezterm";
  if (env.KITTY_WINDOW_ID) return "kitty";
  if (env.ALACRITTY_WINDOW_ID || env.ALACRITTY_SOCKET) return "alacritty";
  if (program) return "unknown";
  if (env.WT_SESSION) return "windows-terminal";
  return "unknown";
}

/**
 * Reflow model on resize. Windows Terminal (S1b), Zed and Alacritty, VS Code
 * (xterm.js, checked in the renderer tests), iTerm2, WezTerm and kitty re-wrap
 * rows when the window narrows. Unknown terminals get "unknown": the renderer
 * then never assumes extra rows, which may leave ghost rows but never erases
 * history.
 */
export function reflowModel(env = process.env) {
  return terminalName(env) === "unknown" ? "unknown" : "reflow";
}

/**
 * Width profile for emoji sequences: "grapheme" if the terminal draws a ZWJ
 * family as one 2-cell cluster, else "codepoint". Windows Terminal is known to
 * cluster. Otherwise, when `io` can answer CPR, a probe writes the family at
 * column 1 of an empty row (moving to a fresh row first if the cursor's row
 * has text), reads the cursor column, and erases only its own probe.
 */
export async function probeWidthProfile({ io, env = process.env } = {}) {
  if (terminalName(env) === "windows-terminal") return "grapheme";
  if (!io?.cpr) return "codepoint";
  const at = await io.cpr();
  if (!at) return "codepoint";
  if (at.col !== 1) io.write("\x1b[0m\r\n"); // never overwrite text on the cursor's row
  io.write("\r" + FAMILY);
  const pos = await io.cpr();
  io.write("\r\x1b[0m\x1b[K");
  if (!pos) return "codepoint";
  return pos.col === 3 ? "grapheme" : "codepoint";
}

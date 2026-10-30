// Which screen mode `ad tui` starts in, and whether it captures the mouse
// (plan P2.1). Pure: the inputs come from the engine's settings, ad's prefs,
// the command line and the terminal.
//
// The mode mirrors the engine's settings: `tui.alternate_screen`
// ("auto" | "always" | "never") and `tui.fullscreen_transcript`. Only a value
// the user set (explicitIn) switches ad to fullscreen while ad's own default
// is inline.

import { terminalName } from "./terminal/detect.mjs";

export const FULLSCREEN_DEFAULT = false;

// P0.1's probe (research S-FULLSCREEN, 30 Oct 2026): SGR mouse reports reach
// Node in these terminals on Windows. Terminals not listed use the rules in
// mouseDefault().
export const MOUSE_RECORD = Object.freeze({ "windows-terminal": true, zed: true });

const EXPLICIT_LAYERS = new Set(["user", "sessionFlags"]);

/** True when an enabled user or session-flags layer sets `key` (dotted), to any value. */
export function explicitIn(layers, key) {
  const path = key.split(".");
  return (layers ?? []).some((l) => {
    if (!EXPLICIT_LAYERS.has(l?.name?.type) || l.disabledReason) return false;
    let v = l.config;
    for (const k of path) v = v?.[k];
    return v !== undefined;
  });
}

/**
 * Whether to capture the mouse in this terminal by default. On Windows the
 * legacy console host (no WT_SESSION, no TERM_PROGRAM) is off: Node can't turn
 * its QuickEdit off, so a click would select text instead of reaching ad.
 */
export function mouseDefault({ env = process.env, platform = process.platform, record = MOUSE_RECORD } = {}) {
  const name = terminalName(env);
  if (typeof record[name] === "boolean") return record[name];
  if (platform === "win32" && !env.WT_SESSION && !env.TERM_PROGRAM) return false;
  return true;
}

export function resolveScreenMode({
  noAltScreen = false,
  altScreen = "auto",
  fullscreenTranscript,
  fullscreenExplicit = false,
  appleTerminalOverSsh = false,
  tmuxMouse = null,
  mousePref = null,
  mouseDefault: byTerminal = true,
} = {}) {
  const inline = (reason) => ({ mode: "inline", mouse: false, reason, mouseReason: "inline mode" });
  let picked;
  if (noAltScreen) picked = inline("--no-alt-screen");
  else if (altScreen === "never") picked = inline('tui.alternate_screen = "never"');
  else if (fullscreenTranscript === false) picked = inline("tui.fullscreen_transcript = false");
  else if (!(fullscreenExplicit && fullscreenTranscript === true) && !FULLSCREEN_DEFAULT) picked = inline("ad's default");
  else if (altScreen !== "always" && appleTerminalOverSsh) picked = inline("Apple Terminal over SSH");
  if (picked) return picked;
  if (typeof mousePref === "boolean") return { mode: "fullscreen", mouse: mousePref, reason: "tui.fullscreen_transcript = true", mouseReason: "screen.mouse in ad's prefs" };
  if (tmuxMouse === "off") return { mode: "fullscreen", mouse: false, reason: "tui.fullscreen_transcript = true", mouseReason: "tmux's mouse is off" };
  return { mode: "fullscreen", mouse: byTerminal, reason: "tui.fullscreen_transcript = true", mouseReason: "this terminal's default" };
}

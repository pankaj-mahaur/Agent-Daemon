// Which screen mode `ad tui` starts in, and whether it captures the mouse
// (plan P2.1). Pure: the inputs come from the engine's settings, ad's prefs,
// the command line and the terminal.
//
// The mode mirrors the engine's settings: `tui.alternate_screen`
// ("auto" | "always" | "never") and `tui.fullscreen_transcript`. Only a value
// the user set (explicitIn) switches ad to fullscreen while ad's own default
// is inline.

import { terminalName } from "./terminal/detect.mjs";
import { resolveCommand } from "../safe-spawn.mjs";

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
  // `reason` and `mouseReason` are ids; screenStatus() turns them into /status text.
  const inline = (reason) => ({ mode: "inline", mouse: false, reason, mouseReason: null });
  if (noAltScreen) return inline("flag");
  if (altScreen === "never") return inline("never");
  if (fullscreenTranscript === false) return inline("choice");
  if (!(fullscreenExplicit && fullscreenTranscript === true) && !FULLSCREEN_DEFAULT) return inline("default");
  if (altScreen !== "always" && appleTerminalOverSsh) return inline("appleSsh");
  const reason = altScreen === "always" ? "always" : "auto";
  if (typeof mousePref === "boolean") return { mode: "fullscreen", mouse: mousePref, reason, mouseReason: mousePref ? null : "pref" };
  if (tmuxMouse === "off") return { mode: "fullscreen", mouse: false, reason, mouseReason: "tmux" };
  return { mode: "fullscreen", mouse: byTerminal, reason, mouseReason: byTerminal ? null : "terminal" };
}

const SCREEN_TEXT = {
  auto: "fullscreen",
  always: "fullscreen (always, from your settings)",
  flag: "inline (started with --no-alt-screen)",
  never: "inline (fullscreen turned off in your settings)",
  choice: "inline (you picked inline with /tui)",
  default: "inline (ad's default: /tui to change)",
  appleSsh: "inline (Apple Terminal over SSH)",
};
const MOUSE_TEXT = {
  tmux: "mouse off: tmux mouse is off (set -g mouse on)",
  pref: "mouse off: screen.mouse is false in prefs.json",
  terminal: "mouse off: this terminal doesn't send mouse reports to ad",
};

/** The /status "screen" value: one vocabulary, fullscreen · inline. */
export function screenStatus({ reason, mouseReason } = {}) {
  const text = SCREEN_TEXT[reason] ?? "inline";
  return mouseReason ? `${text} \u{b7} ${MOUSE_TEXT[mouseReason]}` : text;
}

/** Apple Terminal answers DA1 1;2 and DA2 1;95;0: both are needed (either alone is common). */
export function appleTerminalOverSsh(caps) {
  const eq = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
  return eq(caps?.da1, [1, 2]) && eq(caps?.da2, [1, 95, 0]);
}

/**
 * Inside tmux: is its mouse on? One `tmux display-message`, bounded to 1 s.
 * → "on" | "off" | null (no tmux, an error or a timeout: capture stays on).
 */
export function probeTmuxMouse({ env = process.env, execFile = null, timeoutMs = 1000, resolve = (n) => resolveCommand(n, { env }) } = {}) {
  if (!env.TMUX || !execFile) return Promise.resolve(null);
  // From PATH only, never the working folder (runtime/src/safe-spawn.mjs).
  const tmux = resolve("tmux");
  if (!tmux?.cmd) return Promise.resolve(null);
  const args = ["display-message", "-p", ...(env.TMUX_PANE ? ["-t", env.TMUX_PANE] : []), "#{mouse}"];
  return new Promise((resolve) => {
    try {
      execFile(tmux.cmd, [...tmux.prefix, ...args], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        const v = String(stdout).trim();
        resolve(v === "0" || v === "off" ? "off" : v === "1" || v === "on" ? "on" : null);
      });
    } catch {
      resolve(null);
    }
  });
}

// When bare `ad` opens the terminal UI (plan D7): by default where the
// terminal can show it (flipped 2026-10-06, after FC3); AD_TUI=0 opts out.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { preflight } from "./preflight.mjs";

/** Bare `ad` opens the TUI (FC3 passed: the live script, automated in test/tui-live.test.mjs). */
export const TUI_IS_DEFAULT = true;

/**
 * {tui: true} when bare `ad` should open the TUI here, else {tui: false,
 * reason?}: the one-line reason and a working alternative when the TUI was
 * wanted but can't run in this terminal.
 */
export function bareAdChoice({ env = process.env, isDefault = TUI_IS_DEFAULT, stdin = process.stdin, stdout = process.stdout, platform = process.platform, version = process.versions.node } = {}) {
  const wanted = env.AD_TUI === "1" || (isDefault && env.AD_TUI !== "0");
  if (!wanted) return { tui: false };
  const why = preflight({ stdin, stdout, platform, version, env });
  return why ? { tui: false, reason: why } : { tui: true };
}

/**
 * `ad chat`, once bare `ad` opens the TUI: a one-time hint that it does, and
 * that chat stays the plain line mode. Returns the hint or null.
 */
export function chatHintOnce({ isDefault = TUI_IS_DEFAULT, file = path.join(homedir(), ".agent-daemon", "tui", "chat-hint-shown") } = {}) {
  if (!isDefault || existsSync(file)) return null;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, new Date().toISOString());
  } catch {
    // shown again next time: harmless
  }
  return "Tip: `ad` alone now opens the terminal UI (AD_TUI=0 turns that off). `ad chat` stays the plain line mode.";
}

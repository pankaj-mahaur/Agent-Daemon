// TUI settings (codex-parity-2 1c, P3), in two homes:
//
//   - Codex's own TUI settings stay in Codex's config.toml, in ad's Codex
//     home (never ~/.codex), under Codex's keys and value types, so the stock
//     UI (/codex) shows the same status line, title, theme and Vim default.
//     Read with config/read (at start and after every /codex), written with
//     config/batchWrite. `tui.keymap` is read but never written: the stock UI
//     refuses to start on a keymap conflict, and ad doesn't know all of
//     Codex's actions to check for one.
//   - ad's own preferences (what Codex has no setting for) in
//     ~/.agent-daemon/tui/prefs.json: owner-only, written atomically.
//
//   createCodexSettings({engine: () => engine}) → {load(), get(keyPath), set(keyPath, value)}
//   createPrefs({file}) → {get(key, fallback), set(key, value), all()}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_PREFS_FILE = path.join(homedir(), ".agent-daemon", "tui", "prefs.json");

/** The value at a dotted key path ("tui.status_line") of a config object. */
function at(obj, keyPath) {
  let v = obj;
  for (const k of keyPath.split(".")) v = v && typeof v === "object" ? v[k] : undefined;
  return v;
}

/**
 * Codex's settings as ad's Codex reads them. `engine` is a getter: the
 * engine is replaced when it restarts.
 */
export function createCodexSettings({ engine }) {
  let config = {};
  return {
    /** Re-reads them; a failure keeps the last known values. */
    async load() {
      try {
        config = (await engine().readConfig()) ?? {};
      } catch {
        // Keep what we had: settings are never a reason to stop.
      }
      return config;
    },
    /** A setting by Codex's key path, e.g. "tui.status_line"; undefined when unset. */
    get(keyPath) {
      return at(config, keyPath);
    },
    /** Writes one of Codex's settings (null removes it, back to the default). */
    async set(keyPath, value) {
      if (keyPath === "tui.keymap" || keyPath.startsWith("tui.keymap.")) throw new Error("ad doesn't write tui.keymap: change keys in /codex (ad reads them from there)");
      await engine().writeConfig([[keyPath, value]]);
      // What Codex now has; ours is a copy until the next load().
      const keys = keyPath.split(".");
      let o = config;
      for (const k of keys.slice(0, -1)) o = o[k] && typeof o[k] === "object" ? o[k] : (o[k] = {});
      if (value === null) delete o[keys.at(-1)];
      else o[keys.at(-1)] = value;
    },
  };
}

/** ad's own preferences: a flat {key: value} JSON file, owner-only. */
export function createPrefs({ file = DEFAULT_PREFS_FILE } = {}) {
  let prefs = {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) prefs = raw;
  } catch {
    // Missing or unreadable: the defaults.
  }
  return {
    get(key, fallback = undefined) {
      return Object.hasOwn(prefs, key) ? prefs[key] : fallback;
    },
    /** Saves at once (a temp file renamed over the old one, so a crash never leaves half a file). */
    set(key, value) {
      const next = { ...prefs };
      if (value === undefined || value === null) delete next[key];
      else next[key] = value;
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, file);
      prefs = next;
    },
    all() {
      return { ...prefs };
    },
  };
}

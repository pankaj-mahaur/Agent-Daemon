// Daemon config — reads ~/.agent-daemon/watch.json (creates a default if absent).
//
// Schema:
//   {
//     "watch": [
//       { "path": "~/.claude/projects", "pattern": "**/*.jsonl", "adapter": "claude-code" }
//     ],
//     "debounceMs": 30000,             // wait this long after last write before firing
//     "stableCheckIntervalMs": 5000,   // size-stability poll interval
//     "skipDigested": true             // don't re-digest sessions already marked digested in SQLite
//   }
//
// Tilde expansion: paths starting with ~ are expanded relative to $HOME / $USERPROFILE.

import fs from "node:fs/promises";
import path from "node:path";

/** @typedef {{path: string, pattern: string, adapter?: string}} WatchEntry */
/** @typedef {{watch: WatchEntry[], debounceMs: number, stableCheckIntervalMs: number, skipDigested: boolean}} WatchConfig */

const DEFAULT_CONFIG = {
  watch: [
    { path: "~/.claude/projects",   pattern: "**/*.jsonl", adapter: "claude-code" },
    { path: "~/.cursor/sessions",   pattern: "**/*.jsonl", adapter: "cursor" },
    { path: "~/.codex/sessions",    pattern: "**/*.jsonl", adapter: "codex" }
  ],
  debounceMs: 30000,
  stableCheckIntervalMs: 5000,
  skipDigested: true
};

export function configPath() {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return path.join(home, ".agent-daemon", "watch.json");
}

/**
 * Load the watch config; create the default if absent.
 *
 * @returns {Promise<WatchConfig>}
 */
export async function loadConfig() {
  const p = configPath();
  let raw;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      // Create default
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf8");
      return { ...DEFAULT_CONFIG, watch: DEFAULT_CONFIG.watch.map(expandEntry) };
    }
    throw err;
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) {
    throw new Error(`watch.json is not valid JSON (${p}): ${err.message}`);
  }
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    watch: (parsed.watch || []).map(expandEntry)
  };
}

/**
 * Expand ~ in a watch entry's path.
 *
 * @param {WatchEntry} entry
 * @returns {WatchEntry}
 */
function expandEntry(entry) {
  return { ...entry, path: expandTilde(entry.path) };
}

export function expandTilde(p) {
  if (typeof p !== "string") return p;
  if (p.startsWith("~/") || p === "~") {
    const home = process.env.HOME || process.env.USERPROFILE || ".";
    return path.join(home, p.slice(2) || "");
  }
  return p;
}

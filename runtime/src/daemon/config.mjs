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
import { engineHome } from "../engine/index.mjs";

/** @typedef {{path: string, pattern: string, adapter?: string}} WatchEntry */
/** @typedef {{watch: WatchEntry[], debounceMs: number, stableCheckIntervalMs: number, skipDigested: boolean}} WatchConfig */

const DEFAULT_CONFIG = {
  watch: [
    { path: "~/.claude/projects",   pattern: "**/*.jsonl", adapter: "claude-code" },
    { path: "~/.cursor/sessions",   pattern: "**/*.jsonl", adapter: "cursor" },
    { path: "~/.codex/sessions",    pattern: "**/*.jsonl", adapter: "codex" }
  ],
  harnessSessions: true,
  debounceMs: 30000,
  stableCheckIntervalMs: 5000,
  skipDigested: true,
  logDir: "~/.agent-daemon/logs"
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
      return withHarnessSessions({ ...DEFAULT_CONFIG, watch: DEFAULT_CONFIG.watch.map(expandEntry) });
    }
    throw err;
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) {
    throw new Error(`watch.json is not valid JSON (${p}): ${err.message}`);
  }
  return withHarnessSessions({
    ...DEFAULT_CONFIG,
    ...parsed,
    watch: (parsed.watch || []).map(expandEntry)
  });
}

// ad's engine writes its conversations into its own folder (engine/, or
// codex-home on an older install, or the user's AD_ENGINE_DIR). Derived at
// every start, never written to watch.json. Opt out with "harnessSessions": false.
export function harnessSessionsEntry({ state = () => engineHome.state() } = {}) {
  const s = state();
  if (s.state === "two-folders") return { skip: "HOME_TWO_FOLDERS" };
  return { entry: { path: path.join(s.path, "sessions"), pattern: "**/*.jsonl", adapter: "ad" } };
}

export function withHarnessSessions(config, opts = {}) {
  if (config.harnessSessions === false) return config;
  let found;
  try {
    found = harnessSessionsEntry(opts);
  } catch (err) {
    return { ...config, harnessSessionsSkipped: err.code ?? "ERROR" };
  }
  if (found.skip) return { ...config, harnessSessionsSkipped: found.skip };
  const same = (a, b) => engineHome.canonical(a) === engineHome.canonical(b);
  if (config.watch.some((w) => same(w.path, found.entry.path))) return config;
  return { ...config, watch: [...config.watch, found.entry] };
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

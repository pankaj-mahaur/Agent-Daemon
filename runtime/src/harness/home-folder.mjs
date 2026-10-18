// Working in the home folder (P0.2a). When a folder would load the user's own
// engine home as a project layer (engineHome.homeLayerRisk), ad doesn't work there
// by default. Three overrides: --allow-home-folder, AD_ALLOW_HOME_FOLDER=1, and
// the lasting pref allowHomeFolder: true in ~/.agent-daemon/tui/prefs.json.

import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_PREFS_FILE } from "../tui/prefs.mjs";
import { engineHome } from "../engine/index.mjs";
import { DEFAULT_NOTES_FILE } from "./notes.mjs";

/** The lasting pref, read without creating anything. */
export function allowHomePref(file = DEFAULT_PREFS_FILE) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))?.allowHomeFolder === true;
  } catch {
    return false;
  }
}

/** → {allowed, source: "flag" | "env" | "pref" | null}. */
export function homeFolderAllowed({ flag = false, env = process.env, prefsFile } = {}) {
  if (flag === true) return { allowed: true, source: "flag" };
  if (env.AD_ALLOW_HOME_FOLDER === "1") return { allowed: true, source: "env" };
  if (allowHomePref(prefsFile)) return { allowed: true, source: "pref" };
  return { allowed: false, source: null };
}

/** Folders where ad run/chat/loop ran under the 3.0.x grace (their one-time notes; ad doctor). */
export function homeGraceFolders(file = DEFAULT_NOTES_FILE) {
  try {
    return Object.keys(JSON.parse(readFileSync(file, "utf8")) ?? {}).filter((k) => k.startsWith("home.cli.")).map((k) => k.slice("home.cli.".length));
  } catch {
    return [];
  }
}

/** What would load from a user engine home in `cwd` (null: nothing; see engineHome.homeLayerRisk). */
export function homeRisk(cwd, opts) {
  return engineHome.homeLayerRisk(cwd, opts);
}

/**
 * Recent project folders from the TUI's state.json ({<canonical>: {lastSeen, path?}}),
 * newest first: ones that exist and aren't refused themselves.
 */
export function recentProjects(state, { limit = 8, exclude = [] } = {}) {
  const skip = new Set(exclude.map((d) => engineHome.canonical(d)));
  return Object.entries(state ?? {})
    .filter(([, v]) => v && typeof v === "object" && Number.isFinite(v.lastSeen))
    .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
    .map(([key, v]) => (typeof v.path === "string" ? v.path : key))
    .filter((dir) => !skip.has(engineHome.canonical(dir)) && existsSync(dir) && !homeRisk(dir))
    .slice(0, limit);
}

// Where the engine's home folder is, in the three disk states of an install
// (own-harness design D7). New installs use ~/.agent-daemon/engine plus a link
// named codex-home pointing at it, so a rolled-back 2.x finds its folder;
// installs from before 3.0 keep their codex-home folder until `ad migrate`.
// lstat-based: a link is never mistaken for a folder, a dangling link is seen.

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { legacyHomeName, twoHomesRefusal } from "../attribution.mjs";
import { engineError } from "./errors.mjs";

export const NEW_HOME_NAME = "engine";
export const OLD_HOME_NAME = legacyHomeName; // "codex-home"
export const defaultRoot = () => join(homedir(), ".agent-daemon");

/** "missing" | "dir" | "link" (to an existing folder) | "dangling" (a link to nothing) | "file". */
export function entryKind(p) {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return "missing";
  }
  if (st.isSymbolicLink()) {
    try {
      return statSync(p).isDirectory() ? "link" : "dangling";
    } catch {
      return "dangling";
    }
  }
  return st.isDirectory() ? "dir" : "file";
}

/** Removes a link and never what it points to. The only way ad deletes a link: never rmSync on one. */
export function removeLink(p) {
  try {
    unlinkSync(p);
  } catch (err) {
    if (process.platform === "win32" && (err.code === "EPERM" || err.code === "EISDIR")) rmdirSync(p);
    else throw err;
  }
}

/** Makes `link` point at `target`: a junction on Windows (no admin rights needed), a directory symlink elsewhere. */
export function createLegacyLink(target, link, { hide = true } = {}) {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  // Hidden on the link itself (/L), never on its target. Best effort: a visible link works the same.
  if (hide && process.platform === "win32") spawnSync("attrib", ["+h", "/L", link], { windowsHide: true, stdio: "ignore" });
}

const ROLLOUT = /^rollout-.*\.jsonl$/i;

function rolloutFiles(dir, depth = 0, out = []) {
  if (depth > 6) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // no such folder: no conversations
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) rolloutFiles(p, depth + 1, out);
    else if (e.isFile() && ROLLOUT.test(e.name)) out.push(p);
  }
  return out;
}

/** What a home folder holds: {path, conversations, lastUsed (ISO or null), signedIn}. Reads only. */
export function homeFacts(dir) {
  const files = [...rolloutFiles(join(dir, "sessions")), ...rolloutFiles(join(dir, "archived_sessions"))];
  let newest = null;
  for (const f of files) {
    try {
      const m = statSync(f).mtimeMs;
      if (newest === null || m > newest) newest = m;
    } catch {
      // removed while we looked: not counted for the date
    }
  }
  let config = "";
  try {
    config = readFileSync(join(dir, "config.toml"), "utf8");
  } catch {
    config = ""; // no settings file yet
  }
  const openrouter = /^\s*model_provider\s*=\s*"openrouter"/m.test(config);
  return { path: dir, conversations: files.length, lastUsed: newest === null ? null : new Date(newest).toISOString(), signedIn: existsSync(join(dir, "auth.json")) || openrouter };
}

/** Empty = nothing a user would miss: no sign-in, no OpenRouter setting, no conversation. */
export function isEmptyHome(dir) {
  const f = homeFacts(dir);
  return f.conversations === 0 && !f.signedIn;
}

function freeName(base) {
  let name = base;
  for (let i = 2; existsSync(name) || entryKind(name) !== "missing"; i++) name = `${base}-${i}`;
  return name;
}

/**
 * The engine's home under `root` (~/.agent-daemon). Read-only unless `write`:
 * then a dangling link is replaced or removed, and with `autoPickEmpty`
 * (interactive starts only) an empty duplicate folder is set aside.
 * → {path, state: "fresh" | "old" | "new" | "two-folders", oldKind, newKind, setAside?}
 * Throws HOME_BROKEN, and HOME_TWO_FOLDERS in write mode when it can't pick.
 */
export function resolveHomeState({ root = defaultRoot(), write = false, autoPickEmpty = false, today = new Date() } = {}) {
  const oldP = join(root, OLD_HOME_NAME);
  const newP = join(root, NEW_HOME_NAME);
  let o = entryKind(oldP);
  const n = entryKind(newP);
  if (n === "file" || n === "dangling" || o === "file") {
    const bad = n === "file" || n === "dangling" ? newP : oldP;
    throw engineError("HOME_BROKEN", `the engine's folder ${bad} is not a folder; move it away and start ad again`, { path: bad });
  }
  if (n === "dir" || n === "link") {
    if (o === "dir") {
      if (!write) return { path: newP, state: "two-folders", oldKind: o, newKind: n };
      const emptyOld = isEmptyHome(oldP);
      const emptyNew = isEmptyHome(newP);
      if (autoPickEmpty && (emptyOld || emptyNew)) {
        const stamp = today.toISOString().slice(0, 10);
        if (emptyOld) {
          // Both empty: keep engine/. The old name becomes the link a 2.x needs.
          const aside = freeName(`${oldP}.empty-${stamp}`);
          renameSync(oldP, aside);
          createLegacyLink(newP, oldP);
          return { path: newP, state: "new", oldKind: "link", newKind: n, setAside: aside };
        }
        const aside = freeName(`${newP}.empty-${stamp}`);
        renameSync(newP, aside);
        return { path: oldP, state: "old", oldKind: o, newKind: "missing", setAside: aside };
      }
      throw engineError("HOME_TWO_FOLDERS", twoHomesRefusal({ oldPath: oldP, newPath: newP }), { oldPath: oldP, newPath: newP });
    }
    if (o === "dangling" && write) {
      removeLink(oldP);
      createLegacyLink(newP, oldP);
      o = "link";
    }
    return { path: newP, state: "new", oldKind: o, newKind: n };
  }
  if (o === "dir" || o === "link") return { path: oldP, state: "old", oldKind: o, newKind: n };
  if (o === "dangling" && write) {
    removeLink(oldP);
    o = "missing";
  }
  return { path: newP, state: "fresh", oldKind: o, newKind: n };
}

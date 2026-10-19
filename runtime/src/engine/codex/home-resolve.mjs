// Where the engine's home folder is, in the three disk states of an install
// (own-harness design D7). New installs use ~/.agent-daemon/engine plus a link
// named codex-home pointing at it, so a rolled-back 2.x finds its folder;
// installs from before 3.0 keep their codex-home folder until `ad migrate`.
// lstat-based: a link is never mistaken for a folder, a dangling link is seen.

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { adRoot } from "../../ad-root.mjs";
import { systemTool } from "../../safe-spawn.mjs";
import { legacyHomeName, twoHomesRefusal } from "../attribution.mjs";
import { engineError } from "./errors.mjs";

export const NEW_HOME_NAME = "engine";
export const OLD_HOME_NAME = legacyHomeName; // "codex-home"
export const defaultRoot = () => adRoot();

/**
 * "missing" | "dir" | "link" (to an existing folder) | "dangling" (a link whose
 * target does not exist) | "unreachable" (a link whose target can't be read
 * right now: a locked or slow drive, a permission error) | "file".
 */
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
    } catch (err) {
      // Only "it isn't there" is dangling. Anything else may come back by itself.
      return err.code === "ENOENT" || err.code === "ENOTDIR" ? "dangling" : "unreachable";
    }
  }
  return st.isDirectory() ? "dir" : "file";
}

const normPath = (p) => {
  const out = resolve(String(p).replace(/^\\\\\?\\/, "")).replace(/[\\/]+$/, "");
  return process.platform === "win32" || process.platform === "darwin" ? out.toLowerCase() : out;
};

/** Where a link points, as an absolute path; "?" when it can't be read. */
export function linkTarget(p) {
  try {
    return resolve(dirname(p), readlinkSync(p).replace(/^\\\\\?\\/, ""));
  } catch {
    return "?"; // not a link, or unreadable: the caller only shows it
  }
}

/** True when both paths are the same existing folder (junctions and symlinks followed). */
export function sameFolder(a, b) {
  try {
    return normPath(realpathSync.native(a)) === normPath(realpathSync.native(b));
  } catch {
    return false; // one of them doesn't resolve: not provably the same folder
  }
}

/** True when the link at `link` is the one ad makes: pointing at `target` (ad's own engine/ folder). */
const isOwnLink = (link, target) => normPath(linkTarget(link)) === normPath(target);

const REMOVE_ONLY_LINK = `remove that link (only the link: ${process.platform === "win32" ? "rmdir" : "rm"} on it, never a recursive delete)`;

/** Why following `p` fails ("EACCES", "ELOOP", …), for messages. */
function statCode(p) {
  try {
    statSync(p);
    return "readable now";
  } catch (err) {
    return err.code ?? err.message;
  }
}

/** Removes a link and never what it points to. The only way ad deletes a link: never rmSync on one. A real folder is refused, empty or not. */
export function removeLink(p) {
  if (!lstatSync(p).isSymbolicLink()) throw engineError("NOT_A_LINK", `refusing to remove ${p}: it is a folder, not a link`, { path: p });
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
  const attrib = hide && process.platform === "win32" ? systemTool("attrib.exe") : null;
  if (attrib) spawnSync(attrib, ["+h", "/L", link], { windowsHide: true, stdio: "ignore" });
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
  const openrouter = /^\s*model_provider\s*=\s*["']openrouter["']/m.test(config);
  return { path: dir, conversations: files.length, lastUsed: newest === null ? null : new Date(newest).toISOString(), signedIn: existsSync(join(dir, "auth.json")) || openrouter };
}

// The one setting ad's bootstrap writes (3.0 and 2.x alike); comments and blank lines aside.
const bootstrapOnly = (text) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .every((l) => /^cli_auth_credentials_store\s*=\s*["']file["']$/.test(l));

/**
 * Empty = a folder ad bootstrapped and nothing else ever touched: only the
 * bootstrap config.toml, ad's marker, and empty log/ or tmp/ folders. Any other
 * file or setting (a provider, a keyring sign-in, skills, history, AGENTS.md)
 * is the user's, so the folder is not empty and is never set aside.
 */
export function isEmptyHome(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false; // unreadable: never treat as empty
  }
  for (const e of entries) {
    if (e.name === ".agent-daemon-managed" && e.isFile()) continue; // home.mjs MANAGED_MARKER
    if (e.name === "config.toml" && e.isFile()) {
      let text;
      try {
        text = readFileSync(join(dir, e.name), "utf8");
      } catch {
        return false;
      }
      if (bootstrapOnly(text)) continue;
      return false;
    }
    if ((e.name === "log" || e.name === "tmp") && e.isDirectory()) {
      let inner;
      try {
        inner = readdirSync(join(dir, e.name));
      } catch {
        return false;
      }
      if (inner.length === 0) continue;
      return false;
    }
    return false;
  }
  return true;
}

function freeName(base) {
  let name = base;
  for (let i = 2; existsSync(name) || entryKind(name) !== "missing"; i++) name = `${base}-${i}`;
  return name;
}

/**
 * The engine's home under `root` (~/.agent-daemon). Read-only unless `write`:
 * then ad's own dangling link (to a removed engine/) is removed, and with
 * `autoPickEmpty` (interactive starts only) an empty duplicate folder is set
 * aside. A link the user made is never removed or replaced.
 * → {path, state: "fresh" | "old" | "new" | "two-folders", oldKind, newKind, setAside?, sameFolder?}
 * Throws HOME_BROKEN, HOME_UNREACHABLE, and HOME_TWO_FOLDERS in write mode when it can't pick.
 */
export function resolveHomeState({ root = defaultRoot(), write = false, autoPickEmpty = false, today = new Date() } = {}) {
  const oldP = join(root, OLD_HOME_NAME);
  const newP = join(root, NEW_HOME_NAME);
  let o = entryKind(oldP);
  const n = entryKind(newP);
  if (n === "file" || o === "file") {
    const bad = n === "file" ? newP : oldP;
    throw engineError("HOME_BROKEN", `the engine's folder ${bad} is not a folder; move it away and start ad again`, { path: bad });
  }
  // A link that can't be read (a locked drive, a permission, a loop) may come back: refuse, never replace it.
  for (const [kind, p] of [[n, newP], [o, oldP]]) {
    if (kind === "unreachable") throw engineError("HOME_UNREACHABLE", `${p} points to ${linkTarget(p)}, which can't be read (${statCode(p)}). If it is on a drive that isn't connected or unlocked, reconnect it; otherwise fix or ${REMOVE_ONLY_LINK}, and start ad again.`, { path: p });
  }
  // A dangling engine/, or a dangling codex-home ad didn't make (it points somewhere other than
  // engine/), is the user's: a drive that isn't connected, say. Refuse rather than start over in
  // an empty folder. ad's own link from before ~/.agent-daemon moved lands here too: removing it is safe.
  for (const [dangling, p] of [[n === "dangling", newP], [o === "dangling" && !isOwnLink(oldP, newP), oldP]]) {
    if (dangling) throw engineError("HOME_BROKEN", `${p} points to ${linkTarget(p)}, which doesn't exist. Reconnect it, or ${REMOVE_ONLY_LINK}, and start ad again.`, { path: p });
  }
  // Two names for one folder (engine/ a link to codex-home, or the other way round) are one folder.
  if (n === "link" && o === "dir" && sameFolder(newP, oldP)) return { path: oldP, state: "old", oldKind: o, newKind: n, sameFolder: true };
  if (n === "dir" || n === "link") {
    if (o === "dir" || (o === "link" && !sameFolder(oldP, newP))) {
      if (!write) return { path: newP, state: "two-folders", oldKind: o, newKind: n };
      const emptyOld = o === "dir" && isEmptyHome(oldP);
      const emptyNew = n === "dir" && isEmptyHome(newP);
      // Never auto-pick when either name is a link: renaming one could leave the other pointing nowhere.
      if (autoPickEmpty && o === "dir" && n === "dir" && (emptyOld || emptyNew)) {
        const stamp = today.toISOString().slice(0, 10);
        if (emptyOld) {
          // Both empty: keep engine/. The old name becomes the link a 2.x needs.
          const aside = freeName(`${oldP}.empty-${stamp}`);
          renameSync(oldP, aside);
          try {
            createLegacyLink(newP, oldP);
          } catch (err) {
            // Set aside either way: the caller reports both, and the next start tries the link again.
            return { path: newP, state: "new", oldKind: "missing", newKind: n, setAside: aside, linkError: err.message };
          }
          return { path: newP, state: "new", oldKind: "link", newKind: n, setAside: aside };
        }
        const aside = freeName(`${newP}.empty-${stamp}`);
        renameSync(newP, aside);
        return { path: oldP, state: "old", oldKind: o, newKind: "missing", setAside: aside };
      }
      throw engineError("HOME_TWO_FOLDERS", twoHomesRefusal({ oldPath: oldP, newPath: newP }), { oldPath: oldP, newPath: newP });
    }
    return { path: newP, state: "new", oldKind: o, newKind: n };
  }
  if (o === "dir" || o === "link") return { path: oldP, state: "old", oldKind: o, newKind: n };
  // Only ad's own link reaches here dangling (engine/ itself is gone): remove it, start fresh.
  if (o === "dangling" && write) {
    removeLink(oldP);
    o = "missing";
  }
  return { path: newP, state: "fresh", oldKind: o, newKind: n };
}

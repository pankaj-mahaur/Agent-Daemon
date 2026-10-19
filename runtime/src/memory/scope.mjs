// Which project a memory reader is bound to: the single resolver of the
// memory scope contract (plan §M). One server process, one scope; no tool
// argument changes it, so a prompt-injected agent can't pick another
// project's memory.
//
// Order:
//   1. an explicit project: --project (the host config), AD_MEMORY_PROJECT
//      (ad's façade, per thread), CLAUDE_PROJECT_DIR (Claude Code only: a host
//      started from a Claude Code shell inherits it, so it doesn't count there)
//   2. else the working folder, if it looks like a project: inside a git repo
//      (a .git folder or file, found walking up, stopping before home and the
//      root) or holding a .agent-daemon folder
//   3. else unbound: serve nothing, not even global rows.
//
// Never valid: home and filesystem roots (the folder itself), OS system
// folders, ad's root (current and HOME-based legacy) and the package folder
// (the folder or anything inside it).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adPackageRoot, adRoot, legacyAdRoots } from "../ad-root.mjs";
import { projectSlug } from "./episodic.mjs";
import { withProjectId } from "./projects.mjs";
import { syncProjectKeys } from "./project-db.mjs";

const norm = (p, platform) => {
  const r = path.resolve(p).replace(/[\\/]+$/, "") || path.resolve(p);
  return platform === "win32" ? r.toLowerCase() : r;
};
const isRoot = (p) => {
  const r = path.resolve(p);
  return path.dirname(r) === r;
};
const within = (child, parent, platform) => {
  const c = norm(child, platform);
  const pr = norm(parent, platform);
  return c === pr || c.startsWith(pr + path.sep);
};

function envGet(env, name) {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function systemFolders(env, platform) {
  if (platform === "win32") {
    const out = ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"].map((k) => envGet(env, k)).filter(Boolean);
    const local = envGet(env, "LOCALAPPDATA");
    if (local) out.push(path.join(local, "Programs"));
    return out.filter((p) => path.isAbsolute(p));
  }
  // macOS: /etc and /var are links into /private; /tmp too, and the per-user
  // temp folder lives in /private/var/folders (exempt below), so not all of /private.
  if (platform === "darwin") return ["/System", "/Library", "/Applications", "/usr", "/bin", "/sbin", "/etc", "/var", "/private/etc", "/private/var", "/opt/homebrew"];
  return ["/usr", "/bin", "/sbin", "/etc", "/opt", "/var", "/proc", "/sys", "/snap"];
}

// Temp folders inside a system folder are where people (and tests) make scratch
// projects: the OS temp folder and macOS's per-user ones are never "system".
function tempFolders(platform) {
  if (platform === "win32") return [];
  const out = [os.tmpdir(), "/var/tmp", "/private/var/tmp"];
  if (platform === "darwin") out.push("/var/folders", "/private/var/folders");
  return out;
}

// A path and, when it exists, its real path (a junction, a short 8.3 name or
// a \\?\ prefix lead to the same folder).
function spellings(p) {
  const out = [path.resolve(p)];
  try {
    const real = fs.realpathSync.native(p);
    if (real && !out.includes(real)) out.push(real);
  } catch {
    // not there (yet): the given spelling only
  }
  return out;
}

/** @returns {string|null} why `dir` can never be a memory project, or null */
export function neverValid(dir, opts = {}) {
  if (!dir || !path.isAbsolute(dir)) return "not an absolute path";
  for (const d of spellings(dir)) {
    const why = neverValidOne(d, opts);
    if (why) return why;
  }
  return null;
}

function neverValidOne(dir, { env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  if (isRoot(dir)) return "a filesystem root";
  if (home && spellings(home).some((h) => norm(dir, platform) === norm(h, platform))) return "the home folder";
  const inside = (ref) => spellings(ref).some((r) => within(dir, r, platform));
  if (!tempFolders(platform).some((t) => inside(t))) for (const sys of systemFolders(env, platform)) if (inside(sys)) return "a system folder";
  for (const r of [adRoot({ env, homedir: () => home }), ...legacyAdRoots({ env, homedir: () => home, platform })]) {
    if (inside(r)) return "ad's own folder";
  }
  if (inside(adPackageRoot())) return "ad's install folder";
  return null;
}

/** A .git (folder or file) or .agent-daemon folder at dir or above, below home and the root. */
function looksLikeProject(dir, { home, platform }) {
  let d = path.resolve(dir);
  for (;;) {
    if (isRoot(d) || (home && norm(d, platform) === norm(home, platform))) return false;
    if (fs.existsSync(path.join(d, ".git"))) return true;
    try {
      if (fs.statSync(path.join(d, ".agent-daemon")).isDirectory()) return true;
    } catch { /* not there */ }
    const up = path.dirname(d);
    if (up === d) return false;
    d = up;
  }
}

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The project keys a hook (SessionStart, query-retrieve) may read for the
 * folder the host gave it: [] when that folder is never valid (home, a root,
 * a system folder, ad's own folders). With the project's id (P7.1a): a folder
 * that shares its slug with another reads by id only (projects.mjs withProjectId).
 *
 * @param {string|undefined} cwd
 * @returns {Promise<string[]>}
 */
export async function hookProjectKeys(cwd, { env = process.env } = {}) {
  if (!cwd) return [];
  const { db } = await import("./episodic.mjs");
  const { slugCollides } = await import("./safety.mjs");
  const handle = await db().catch(() => null);
  const s = resolveMemoryScope({ project: cwd, env: { ...env, AD_MEMORY_PROJECT: undefined }, cwd, collides: handle ? (k, d) => slugCollides(handle, k, d) : undefined, note: () => {} });
  const bound = withProjectId(s, { env });
  // A project the registry just learned of: the database's mirror follows, so rows
  // written in this process get its id.
  if (handle?.raw && bound !== s) {
    try {
      syncProjectKeys(handle.raw, { env });
    } catch {
      // a busy store: the next open mirrors it
    }
  }
  return bound.keys;
}

/**
 * @param {{project?:string, env?:object, cwd?:string, host?:string, home?:string, platform?:string,
 *          collides?:(key:string, dir:string)=>boolean, note?:(text:string)=>void}} opts
 * @returns {{ kind: "project"|"unbound"|"collision", dir: string|null, keys: string[], source: string }}
 */
export function resolveMemoryScope({ project, env = process.env, cwd, host, home = os.homedir(), platform = process.platform, collides, note = (t) => process.stderr.write(`[agent-daemon memory] ${t}\n`) } = {}) {
  const o = { env, home, platform };
  const explicit = [
    ["arg", project],
    ["env:AD_MEMORY_PROJECT", env.AD_MEMORY_PROJECT],
    ...(host === "claude-code" ? [["env:CLAUDE_PROJECT_DIR", env.CLAUDE_PROJECT_DIR]] : []),
  ];
  let picked = null;
  for (const [source, value] of explicit) {
    if (!value) continue;
    const why = !path.isAbsolute(value) ? "not an absolute path" : neverValid(value, o) ?? (isDir(value) ? null : "not a folder");
    if (why) {
      note(`ignoring ${source === "arg" ? "--project" : source.slice(4)} (${why})`);
      continue;
    }
    picked = { dir: path.resolve(value), source };
    break;
  }
  // Agent Plugins hosts start servers in the plugin's own folder, which may sit in a
  // git clone of a marketplace: the working folder is never the user's project there.
  if (!picked && host !== "agent-plugins" && cwd && path.isAbsolute(cwd) && !neverValid(cwd, o) && looksLikeProject(cwd, o)) {
    picked = { dir: path.resolve(cwd), source: "cwd" };
  }
  if (!picked) return { kind: "unbound", dir: null, keys: [], source: "none" };
  const key = projectSlug(picked.dir);
  if (collides && collides(key, picked.dir)) return { kind: "collision", dir: picked.dir, keys: [], source: picked.source };
  return { kind: "project", dir: picked.dir, keys: [key], source: picked.source };
}

/**
 * The scope plus alias keys: the same folder's key under the other drive-letter
 * case (Windows) and under its real path, when no other folder owns that key.
 */
export function withAliasKeys(scope, { platform = process.platform, collides = () => false, realpath = (p) => fs.realpathSync.native(p) } = {}) {
  if (scope.kind !== "project" || !scope.dir) return scope;
  const spellings = new Set([scope.dir]);
  try {
    spellings.add(realpath(scope.dir));
  } catch {
    // gone or unreadable: no real-path alias
  }
  if (platform === "win32") for (const d of [...spellings]) if (/^[a-z]:/i.test(d)) spellings.add((d[0] === d[0].toUpperCase() ? d[0].toLowerCase() : d[0].toUpperCase()) + d.slice(1));
  const keys = [...scope.keys];
  for (const d of spellings) {
    const k = projectSlug(d);
    if (!keys.includes(k) && !collides(k, d)) keys.push(k);
  }
  return { ...scope, keys };
}

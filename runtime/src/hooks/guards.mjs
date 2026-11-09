// The rules snapshot `tool.before` reads (plan L2, 02 §3): adRoot()/guards.json.
// The hook that guards every tool call must be fast and must never open the
// memory store, so the review service writes what the hook needs here:
//
//   { version: 1, generation: 7, updatedAt: "…",
//     projects: { "<project id>": { roots: ["D:\\work\\app"], paused: false,
//                                   rules: [ { id, kind: "command"|"write", decision: "ask"|"deny",
//                                              reason, rule: {…neutral schema…} } ] } } }
//
// Reading: guards.json; if it is corrupt, guards.last-good.json; if both are
// missing or corrupt, no rules and a visible warning (memory never blocks a
// tool because its own file broke). The project is found read-only, by the
// longest root that contains the session's folder; nothing is ever created.
// Writing (the review service): a temp file renamed into place, the previous
// good file kept as last-good, the generation bumped. The writer holds its own
// lock; readers never lock.

import fs from "node:fs";
import path from "node:path";
import { adRoot } from "../ad-root.mjs";

export const GUARDS_FILE = "guards.json";
export const LAST_GOOD_FILE = "guards.last-good.json";
/** Exists while the store has rules (L7 D3): both snapshot files unreadable then means "can't check", not "no rules". */
export const ACTIVE_FILE = "guards.active";
/** Allow-once consumed markers (L7 D9): the only files the hook creates in the guard state. */
export const CONSUMED_DIR = "guards-consumed";

export const guardsPath = (root = adRoot()) => path.join(root, GUARDS_FILE);
export const lastGoodPath = (root = adRoot()) => path.join(root, LAST_GOOD_FILE);
export const activePath = (root = adRoot()) => path.join(root, ACTIVE_FILE);
export const consumedDir = (root = adRoot()) => path.join(root, CONSUMED_DIR);

const isObj = (v) => Boolean(v && typeof v === "object" && !Array.isArray(v));
const countRules = (s) => Object.values(s.projects).reduce((n, p) => n + (Array.isArray(p?.rules) ? p.rules.length : 0), 0) + (Array.isArray(s.global?.rules) ? s.global.rules.length : 0);

// L2 wrote paused: true|false; L7 writes false or {at, until}.
const isPause = (p) => typeof p === "boolean" || p === null || p === undefined || (isObj(p) && typeof p.at === "string" && (p.until === null || typeof p.until === "string"));
const isToken = (t) => isObj(t) && typeof t.nonce === "string" && /^[0-9a-f]{32}$/.test(t.nonce) && typeof t.expires === "string";

/**
 * Is this a snapshot we can use? L7's fields are optional for an older writer's file, but
 * when present they must be well formed, and a snapshot that holds rules must say how many
 * (a count that disagrees, or an L7 file without one, would read as "no rules" on the
 * failure paths: fail-open).
 */
export function validSnapshot(s) {
  if (!(isObj(s) && s.version === 1 && Number.isInteger(s.generation) && isObj(s.projects))) return false;
  if ("global" in s && !(isObj(s.global) && (s.global.rules === undefined || Array.isArray(s.global.rules)))) return false;
  if ("allowOnce" in s && !(Array.isArray(s.allowOnce) && s.allowOnce.every(isToken))) return false;
  if ("ruleCount" in s && !(Number.isInteger(s.ruleCount) && s.ruleCount >= 0)) return false;
  if ("pausedAll" in s && !isPause(s.pausedAll)) return false;
  if ("store_id" in s && !(s.store_id === null || typeof s.store_id === "string")) return false;
  for (const p of Object.values(s.projects)) {
    if (!isObj(p) || ("rules" in p && !Array.isArray(p.rules)) || ("roots" in p && !Array.isArray(p.roots)) || !isPause(p.paused)) return false;
  }
  const n = countRules(s);
  if ("ruleCount" in s && s.ruleCount !== n) return false; // the count must match
  if (n > 0 && "global" in s && !("ruleCount" in s)) return false; // an L7 writer's file must say
  return true;
}

/** guards.active (L7 D3), parsed: {ruleCount, store_id} or {} for an older plain count; null when absent. */
export function readActive({ root = adRoot() } = {}) {
  let text;
  try {
    text = fs.readFileSync(activePath(root), "utf8");
  } catch (err) {
    return err?.code === "ENOENT" ? null : {}; // unreadable: present, store unknown
  }
  try {
    const j = JSON.parse(text);
    return isObj(j) ? j : {};
  } catch {
    return {};
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return err?.code === "ENOENT" ? undefined : null; // missing vs corrupt
  }
}

/**
 * Load the snapshot.
 * @returns {{snapshot:object|null, source:"current"|"last-good"|"none", warning:string|null}}
 */
export function loadGuards({ root = adRoot() } = {}) {
  const current = readJson(guardsPath(root));
  if (validSnapshot(current)) return { snapshot: current, source: "current", warning: null };
  const lastGood = readJson(lastGoodPath(root));
  if (validSnapshot(lastGood)) {
    return { snapshot: lastGood, source: "last-good", warning: current === undefined ? null : "ad: the rules file was unreadable; using the last good copy." };
  }
  if (current === undefined && lastGood === undefined) return { snapshot: null, source: "none", warning: null }; // no rules yet
  return { snapshot: null, source: "none", warning: "ad: the rules file is unreadable, so no rules apply right now. Run `ad doctor`." };
}

const pathFor = (os) => (os === "win32" ? path.win32 : path.posix);
const caseFold = (os) => os === "win32" || os === "darwin";
const norm = (p, os) => {
  const r = pathFor(os).resolve(String(p)).replace(/[\\/]+$/, "");
  return caseFold(os) ? r.toLowerCase() : r;
};

/**
 * The project a folder belongs to: the snapshot project whose root is the longest prefix
 * of `dir` (compared as the folder's own OS compares paths). Read-only.
 * @returns {{id:string, project:object, root:string}|null}
 */
export function projectFor(snapshot, dir, { platform = process.platform } = {}) {
  if (!validSnapshot(snapshot) || !dir) return null;
  const sep = pathFor(platform).sep;
  const d = norm(dir, platform);
  let best = null;
  let bestLen = -1;
  for (const [id, project] of Object.entries(snapshot.projects)) {
    for (const root of project?.roots ?? []) {
      const r = norm(root, platform);
      if ((d === r || d.startsWith(r + sep)) && r.length > bestLen) {
        best = { id, project, root };
        bestLen = r.length;
      }
    }
  }
  return best;
}

/** Is this pause in force at `now`? L2 wrote `true` (until resumed); L7 writes {at, until}. */
export function pauseLive(p, now = Date.now()) {
  if (p === true) return true;
  if (!isObj(p)) return false;
  return p.until === null || p.until === undefined || Date.parse(p.until) > now;
}

/** Rules that would apply somewhere right now (pauses decided at read time, L7 D3). */
export function activeRuleCount(snapshot, now = Date.now()) {
  if (!validSnapshot(snapshot) || pauseLive(snapshot.pausedAll, now)) return 0;
  let n = Array.isArray(snapshot.global?.rules) ? snapshot.global.rules.length : 0;
  for (const p of Object.values(snapshot.projects)) if (!pauseLive(p?.paused, now)) n += Array.isArray(p?.rules) ? p.rules.length : 0;
  return n;
}

/**
 * Write a new snapshot (the review service, under its own lock). The previous
 * snapshot, if it was good, becomes the last-good copy.
 * @returns {number} the new generation
 */
export function writeGuards(snapshot, { root = adRoot(), now = Date.now() } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const previous = readJson(guardsPath(root));
  const lastGood = readJson(lastGoodPath(root));
  // A corrupt current file must not restart the count (a reader compares generations).
  const generation = Math.max(validSnapshot(previous) ? previous.generation : 0, validSnapshot(lastGood) ? lastGood.generation : 0) + 1;
  // Every field the writer gave is kept (L7: global, pausedAll, allowOnce, ruleCount, rules_rev, cmd).
  const next = { ...snapshot, version: 1, generation, updatedAt: new Date(now).toISOString(), projects: snapshot.projects ?? {} };
  if (!validSnapshot(next)) throw new Error("writeGuards: not a valid snapshot");
  if (validSnapshot(previous)) fs.copyFileSync(guardsPath(root), lastGoodPath(root));
  const tmp = `${guardsPath(root)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  fs.renameSync(tmp, guardsPath(root));
  return generation;
}

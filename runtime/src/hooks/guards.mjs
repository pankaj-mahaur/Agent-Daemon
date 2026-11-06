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

export const guardsPath = (root = adRoot()) => path.join(root, GUARDS_FILE);
export const lastGoodPath = (root = adRoot()) => path.join(root, LAST_GOOD_FILE);

/** Is this a snapshot we can use? */
export function validSnapshot(s) {
  return Boolean(s && typeof s === "object" && s.version === 1 && Number.isInteger(s.generation) && s.projects && typeof s.projects === "object" && !Array.isArray(s.projects));
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

const caseFold = (os) => os === "win32" || os === "darwin";
const norm = (p, os) => {
  const r = path.resolve(String(p)).replace(/[\\/]+$/, "");
  return caseFold(os) ? r.toLowerCase() : r;
};

/**
 * The project a folder belongs to: the snapshot project whose root is the
 * longest prefix of `dir`. Read-only.
 * @returns {{id:string, project:object}|null}
 */
export function projectFor(snapshot, dir, { platform = process.platform } = {}) {
  if (!validSnapshot(snapshot) || !dir) return null;
  const d = norm(dir, platform);
  let best = null;
  let bestLen = -1;
  for (const [id, project] of Object.entries(snapshot.projects)) {
    for (const root of project?.roots ?? []) {
      const r = norm(root, platform);
      if ((d === r || d.startsWith(r + path.sep)) && r.length > bestLen) {
        best = { id, project };
        bestLen = r.length;
      }
    }
  }
  return best;
}

/**
 * Write a new snapshot (the review service, under its own lock). The previous
 * snapshot, if it was good, becomes the last-good copy.
 * @returns {number} the new generation
 */
export function writeGuards(snapshot, { root = adRoot(), now = Date.now() } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const previous = readJson(guardsPath(root));
  const generation = (validSnapshot(previous) ? previous.generation : 0) + 1;
  const next = { version: 1, generation, updatedAt: new Date(now).toISOString(), projects: snapshot.projects ?? {} };
  if (!validSnapshot(next)) throw new Error("writeGuards: not a valid snapshot");
  if (validSnapshot(previous)) fs.copyFileSync(guardsPath(root), lastGoodPath(root));
  const tmp = `${guardsPath(root)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  fs.renameSync(tmp, guardsPath(root));
  return generation;
}

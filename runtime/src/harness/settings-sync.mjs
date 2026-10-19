// Settings that must not split across engine homes (P3.4, T2-M5). The default home is
// the home of record for the user's [tui] table and folder trust ([projects]); the api
// home and account homes hold mirrored copies only.
//
//   adRoot()/accounts/settings-record.json  { revision, tui, projects, pending: [[keyPath, value]] }
//
// - snapshotRecord(engine): an engine on the default home → its [tui] and [projects], read
//   through the engine (config/read), become the record. Owner decision: no TOML parser,
//   so a hand edit reaches the record when an engine next starts on the default home.
// - recordSettings(edits, { engine }): ad's own writes (/tui, /theme, trust answers) go to
//   the window's engine and to the record; an edit made in another home waits in
//   `pending` and is applied to the default home at its next start.
// - syncSettings(engine): at every engine start. Default home: apply pending, then
//   snapshot. Any other home: mirror the record's [tui] and [projects] into it.
// - folderTrusted(dir, record): the record's trust for a folder (the project target
//   selector is read only in a trusted folder).

import fs from "node:fs";
import path from "node:path";
import { adRoot } from "../ad-root.mjs";
import { writeJsonAtomicSync } from "../atomic-json.mjs";
import { engineHome } from "../engine/index.mjs";

const EMPTY = () => ({ revision: 0, tui: {}, projects: {}, pending: [] });
export const recordFile = (root = adRoot()) => path.join(root, "accounts", "settings-record.json");
const isDefault = (engine) => Boolean(engine?.home) && engineHome.canonical(engine.home) === engineHome.canonical(engineHome.defaultPath());
const canonicalDir = (d) => engineHome.canonical(d);
/** ad's api home and its account homes: <root>/api, <root>/a/<id>. */
export const apiHomePath = (root = adRoot()) => path.join(root, "api");
export const accountHomePath = (homeId, root = adRoot()) => path.join(root, "a", homeId);
function isAccountHome(engine, root = adRoot()) {
  if (!engine?.home) return false;
  const h = engineHome.canonical(engine.home);
  const a = engineHome.canonical(path.join(root, "a"));
  return h === engineHome.canonical(apiHomePath(root)) || h.startsWith(a + path.sep);
}

export function readRecord({ root = adRoot() } = {}) {
  try {
    const r = JSON.parse(fs.readFileSync(recordFile(root), "utf8"));
    return { ...EMPTY(), ...r, pending: Array.isArray(r.pending) ? r.pending : [] };
  } catch {
    return EMPTY();
  }
}

function writeRecord(next, { root = adRoot() } = {}) {
  const before = readRecord({ root });
  const same = JSON.stringify({ tui: before.tui, projects: before.projects, pending: before.pending }) === JSON.stringify({ tui: next.tui, projects: next.projects, pending: next.pending });
  if (same) return before;
  const out = { revision: before.revision + 1, tui: next.tui, projects: next.projects, pending: next.pending };
  fs.mkdirSync(path.dirname(recordFile(root)), { recursive: true });
  writeJsonAtomicSync(recordFile(root), out);
  return out;
}

const plain = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

/** An engine on the default home → the record (anything else: nothing happens). */
export async function snapshotRecord(engine, { root } = {}) {
  if (!isDefault(engine)) return null;
  const cfg = await engine.readConfig();
  const cur = readRecord({ root });
  return writeRecord({ ...cur, tui: structuredClone(plain(cfg.tui)), projects: structuredClone(plain(cfg.projects)) }, { root });
}

// keyPath "tui.theme" / `projects."<dir>".trust_level` → the record, in place.
function applyToRecord(rec, keyPath, value) {
  const m = /^tui\.(.+)$/.exec(keyPath);
  if (m) {
    if (value === null) delete rec.tui[m[1]];
    else rec.tui[m[1]] = value;
    return true;
  }
  const p = /^projects\.("(?:[^"\\]|\\.)*")\.(.+)$/.exec(keyPath);
  if (p) {
    const dir = JSON.parse(p[1]);
    rec.projects[dir] = { ...plain(rec.projects[dir]) };
    if (value === null) delete rec.projects[dir][p[2]];
    else rec.projects[dir][p[2]] = value;
    return true;
  }
  return false;
}

/**
 * ad's own settings writes: to the window's engine, and to the record (others are ignored
 * here). written: the caller already wrote them to that engine in its own form.
 */
export async function recordSettings(edits, { engine, written = false, root } = {}) {
  if (engine && !written) await engine.writeConfig(edits);
  const rec = readRecord({ root });
  const mine = edits.filter(([k, v]) => applyToRecord(rec, k, v));
  if (!mine.length) return rec;
  // Written in another home: the default home gets them at its next start.
  if (!isDefault(engine)) rec.pending = [...rec.pending.filter(([k]) => !mine.some(([m]) => m === k)), ...mine.map(([k, v]) => [k, v])];
  return writeRecord(rec, { root });
}

/**
 * The record as config edits for a mirrored home: each table replaced whole, so a key
 * or a trust answer removed in the default home is removed in the copies too (these
 * homes hold copies only).
 */
export function mirrorEdits(rec) {
  return [
    ["tui", structuredClone(plain(rec.tui))],
    ["projects", structuredClone(plain(rec.projects))],
  ];
}

/** At every engine start. Never fails a start: a problem is returned as a warning. */
export async function syncSettings(engine, { root } = {}) {
  try {
    if (isDefault(engine)) {
      const rec = readRecord({ root });
      if (rec.pending.length) {
        await engine.writeConfig(rec.pending);
        writeRecord({ ...rec, pending: [] }, { root });
      }
      await snapshotRecord(engine, { root });
      return null;
    }
    // Only ad's own account homes (api/, a/<id>) mirror the record: a home a command or a
    // test chose is left alone.
    if (!isAccountHome(engine, root)) return null;
    const edits = mirrorEdits(readRecord({ root }));
    if (edits.length) await engine.writeConfig(edits);
    return null;
  } catch (e) {
    return `settings sync: ${e.message.split("\n")[0]}`;
  }
}

/** Whether the record trusts a folder (or the folder it is in). */
export function folderTrusted(dir, rec = readRecord()) {
  if (!dir) return false;
  const want = canonicalDir(dir);
  for (const [d, t] of Object.entries(plain(rec.projects))) {
    if (plain(t).trust_level !== "trusted") continue;
    const c = canonicalDir(d);
    if (want === c || want.startsWith(c.endsWith(path.sep) ? c : c + path.sep)) return true;
  }
  return false;
}

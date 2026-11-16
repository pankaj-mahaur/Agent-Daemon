// The order of the review screen (MCP launch plan 02 §2.4, PV8; L4b). Read-only:
// accepting goes through acceptQueued below, which calls the review service.
// L5's checklist renders `firstScreen`, then the rest.
//
// Rows, in this order:
//   1. "note"     what the user saved in the last 7 days (pending or provisional, from no
//                 import), newest first, at most 5 (01 §7: saved → review → accept);
//   2. "repeat" / "note"  every other pending note, by repeat count, then the latest
//                 repeat, then id: the history import's proposals ("repeat") and older
//                 notes alike, so legacy pending notes never push the top repeats off
//                 the first screen; with nothing saved lately it is the top 10;
//   3. "file"     one row per instruction file (its latest import): its pending notes
//                 (`units`, a `sample`), how many lines were held back; a note two files
//                 hold belongs to the first file in the import order; files that hold the
//                 same notes are one row;
//   4. "note"     imported notes no current file holds;
//   5. "removed"  accepted notes whose line left their file: the user decides;
//   6. "flagged"  held-back notes (`flagged: true`): never bulk-selected, released only
//                 through the review service.
// Each pending note is in exactly one row.

import { pendingSql, statusSql } from "./trust.mjs";
import { projectClause } from "./projects.mjs";
import { acceptLearning } from "./review-service.mjs";
import { hasProposalTables } from "./proposal-tables.mjs";
import { fileRank, latestImports } from "./instruction-import.mjs";

export const FIRST_SCREEN = 10;
export const SAMPLE = 3;
export const RECENT_DAYS = 7;
export const RECENT_MAX = 5;

const IMPORTED = new Set(["transcript", "instruction-file"]);

/**
 * @param {any} handle  an open store
 * @param {string[]} keys  this project's memory keys
 * @returns {{items: object[], firstScreen: object[], total: number}}
 */
export function reviewQueue(handle, keys, { first = FIRST_SCREEN, now = Date.now() } = {}) {
  const since = new Date(now - RECENT_DAYS * 86_400_000).toISOString();
  const lk = projectClause("l", keys);
  const open = handle.all(
    `SELECT l.id, l.text, l.observed_count, l.created_at, l.last_verified_at, l.provenance, ${statusSql("l")} AS status
       FROM learnings l WHERE (${pendingSql("l")} OR l.status = 'provisional') AND ${lk.sql}`,
    lk.params
  );
  const tables = hasProposalTables(handle);
  const history = new Map();
  let imports = [];
  const linksOf = new Map();
  if (tables) {
    const hk = projectClause("h", keys);
    for (const r of handle.all(`SELECT h.learning_id, h.count, h.hosts, h.last_ts FROM history_clusters h WHERE h.learning_id IS NOT NULL AND ${hk.sql}`, hk.params)) history.set(r.learning_id, r);
    imports = [...latestImports(handle, keys).values()].sort((a, b) => fileRank(a.file) - fileRank(b.file) || (a.file < b.file ? -1 : 1));
    for (const i of imports) linksOf.set(i.id, handle.all("SELECT learning_id FROM instruction_import_notes WHERE import_id = ?", [i.id]).map((r) => r.learning_id));
  }
  const inFile = new Set([...linksOf.values()].flat());

  const early = [];
  const late = [];
  const repeats = [];
  const forFiles = new Map();
  for (const l of open) {
    const h = history.get(l.id);
    const count = Math.max(l.observed_count ?? 1, h?.count ?? 0);
    const seen = sqlTime(l.last_verified_at ?? l.created_at);
    if (h && count >= 2 && l.status === "pending") {
      repeats.push({ kind: "repeat", ids: [l.id], text: l.text, count, hosts: json(h.hosts), lastSeen: h.last_ts ?? seen });
    } else if (inFile.has(l.id) && l.status === "pending") {
      forFiles.set(l.id, l);
    } else {
      const row = { kind: "note", ids: [l.id], text: l.text, count, status: l.status, lastSeen: seen };
      if (IMPORTED.has(l.provenance)) late.push(row);
      else if (sqlTime(l.created_at) >= since) early.push(row);
      else repeats.push(row);
    }
  }
  const newest = (a, b) => cmp(b.lastSeen, a.lastSeen) || a.ids[0] - b.ids[0];
  early.sort(newest);
  late.sort(newest);
  // Saved lately beyond the cap: ranked with the rest.
  repeats.push(...early.splice(RECENT_MAX));
  repeats.sort((a, b) => b.count - a.count || cmp(b.lastSeen, a.lastSeen) || a.ids[0] - b.ids[0]);

  const files = [];
  const bySet = new Map();
  const owned = new Set();
  for (const i of imports) {
    const links = linksOf.get(i.id);
    const ids = links.filter((id) => forFiles.has(id) && !owned.has(id));
    for (const id of ids) owned.add(id);
    const held = links.length ? handle.get(`SELECT COUNT(*) AS n FROM learnings WHERE status = 'quarantined' AND id IN (${links.map(() => "?").join(",")})`, links).n : 0;
    if (!ids.length) {
      // Every line of this file is already in an earlier file's row: name it there.
      const sig = links.filter((id) => forFiles.has(id)).join(",");
      const same = sig && bySet.get(sig);
      if (same) {
        same.files.push(i.file);
        same.text = fileText(same);
      }
      continue;
    }
    const units = ids.map((id) => ({ id, text: forFiles.get(id).text }));
    const row = { kind: "file", ids, files: [i.file], units, sample: units.slice(0, SAMPLE).map((u) => u.text), held, count: 0 };
    row.text = fileText(row);
    bySet.set(ids.join(","), row);
    files.push(row);
  }

  const removed = tables ? removedRows(handle, keys, linksOf) : [];
  const fk = projectClause("", keys);
  const flagged = handle
    .all(`SELECT id, text FROM learnings WHERE status = 'quarantined' AND ${fk.sql} ORDER BY id`, fk.params)
    .map((l) => ({ kind: "flagged", ids: [l.id], text: l.text, count: 0, flagged: true }));
  const items = [...early, ...repeats, ...files, ...late, ...removed, ...flagged];
  return { items, firstScreen: items.slice(0, first), total: items.length };
}

const fileText = (row) => `${row.files.join(" = ")}: ${row.ids.length} ${row.ids.length === 1 ? "instruction" : "instructions"}${row.held ? ` (${row.held} held back)` : ""}`;

// Accepted notes an earlier version of a file held that no file's latest version holds.
function removedRows(handle, keys, linksOf) {
  const current = new Set([...linksOf.values()].flat());
  const ik = projectClause("i", keys);
  const rows = handle.all(
    `SELECT DISTINCT n.learning_id AS id, i.file, l.text FROM instruction_import_notes n
       JOIN instruction_imports i ON i.id = n.import_id
       JOIN learnings l ON l.id = n.learning_id
      WHERE ${ik.sql} AND l.status IN ('active', 'forget-requested') AND l.accepted_by IS NOT NULL
      ORDER BY n.learning_id`,
    ik.params
  );
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    if (current.has(r.id) || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ kind: "removed", ids: [r.id], text: r.text, files: [r.file], count: 0 });
  }
  return out;
}

/**
 * Accept a row's notes through the review service: only those still pending or
 * provisional in this project (a stale row never accepts a rejected, hidden or held-back
 * note). → accepted ids
 */
export function acceptQueued(handle, token, ids, { keys, now } = {}) {
  const lk = projectClause("", keys);
  const done = [];
  for (const id of [...new Set(ids)]) {
    const still = handle.get(`SELECT id FROM learnings WHERE id = ? AND (${pendingSql()} OR status = 'provisional') AND ${lk.sql}`, [id, ...lk.params]);
    if (!still) continue;
    if (acceptLearning(handle, token, id, { now })) done.push(id);
  }
  return done;
}

// SQLite's CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS") and ISO strings, as comparable ISO.
const sqlTime = (t) => (t == null ? null : String(t).includes("T") ? String(t) : `${String(t).replace(" ", "T")}.000Z`);

const cmp = (a, b) => (a == null ? (b == null ? 0 : -1) : b == null ? 1 : a < b ? -1 : a > b ? 1 : 0);

function json(s) {
  try {
    return JSON.parse(s ?? "{}");
  } catch {
    return {};
  }
}

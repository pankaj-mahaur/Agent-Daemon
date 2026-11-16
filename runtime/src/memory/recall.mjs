// The recall core's store adapter (MCP launch plan L6, design decisions 2, 4, 5, 6):
// which rows recall may serve, as the pure ranker (recall-rank.mjs) sees them.
//
//   - this project's accepted, forget-requested and provisional notes (recallSql),
//     never a provisional one under strict mode or past its 30 days;
//   - prompt recall and the recall command add global accepted notes;
//   - a note's age comes from created_at, or accepted_at when later (only the review
//     service writes it) — never last_verified_at or last_retrieved_at, which
//     model-callable tools move, and never a repeat count, which re-writes bump;
//     supersession compares created_at alone (`written`);
//   - a note is sent every session when it is provisional, or from the user's own
//     words (`own`) and accepted in the last 14 days.
// Nothing here writes.

import { recallSql, pendingSql, statusSql, provisionalSql, ownWordsAnySql } from "./trust.mjs";
import { learningVisibility } from "./episodic.mjs";
import { isStrict } from "./review-mode.mjs";

export const PROVISIONAL_DAYS = 30;
export const RECENT_DAYS = 14;
export const PREFILTER_ABOVE = 1500;
export const PREFILTER_TOP = 300;
const DAY = 86_400_000;
const OWN_SQL = ownWordsAnySql("l");

const later = (a, b) => {
  const ta = Date.parse(iso(a) ?? "");
  const tb = Date.parse(iso(b) ?? "");
  if (!Number.isFinite(tb) || (Number.isFinite(ta) && ta >= tb)) return a ?? null;
  return b;
};
// SQLite's CURRENT_TIMESTAMP ("2026-11-08 10:00:00") is UTC without a zone.
const iso = (s) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(" ", "T")}Z` : s);

/**
 * The rows recall may serve, shaped for the ranker:
 *   {id, text, evidence, status, created, written, own, standing, provenance, global}
 * @param {object} handle  an open store
 * @param {string[]} keys  the reader's project keys (memory/scope.mjs)
 * @param {{now?: number, global?: boolean, ftsQuery?: string|null}} [opts]
 *   global: add global accepted notes (prompt recall, the recall command); ftsQuery: the
 *   FTS prefilter's terms, used only above PREFILTER_ABOVE rows (without one — no repo
 *   context — the newest PREFILTER_TOP)
 */
export function recallRows(handle, keys, { now = Date.now(), global = false, ftsQuery = null } = {}) {
  if (!handle || !Array.isArray(keys) || !keys.length) return [];
  const strict = isStrict(handle);
  const vis = learningVisibility("l", keys, "project");
  const cutoff = new Date(now - PROVISIONAL_DAYS * DAY).toISOString();
  // A provisional note past its 30 days is no longer in use, even before maintenance moves it back.
  const live = `(NOT ${provisionalSql("l")} OR (l.status_at IS NOT NULL AND l.status_at >= ?))`;
  const cols = `l.id, l.text, l.evidence, ${statusSql("l")} AS status, ${provisionalSql("l")} AS prov, l.created_at, l.status_at, l.provenance, l.accepted_at, ${OWN_SQL} AS own`;
  const params = [...vis.params, cutoff];
  const where = `${recallSql("l", { strict })} AND ${vis.sql} AND ${live}`;
  const total = handle.get(`SELECT COUNT(*) AS n FROM learnings l WHERE ${where}`, params)?.n ?? 0;
  let rows;
  if (total > PREFILTER_ABOVE) {
    // Bounded: the best FTS matches (or, with no context, the newest notes) plus every
    // note that could be sent every session (own words, provisional), newest first.
    const best = ftsQuery
      ? handle.all(`SELECT l.id FROM learnings_fts JOIN learnings l ON l.id = learnings_fts.rowid WHERE learnings_fts MATCH ? AND ${where} ORDER BY bm25(learnings_fts) LIMIT ${PREFILTER_TOP}`, [ftsQuery, ...params]).map((r) => r.id)
      : handle.all(`SELECT l.id FROM learnings l WHERE ${where} ORDER BY COALESCE(l.accepted_at, l.created_at) DESC LIMIT ${PREFILTER_TOP}`, params).map((r) => r.id);
    const stand = handle.all(`SELECT l.id FROM learnings l WHERE ${where} AND (${OWN_SQL} OR ${provisionalSql("l")}) ORDER BY COALESCE(l.accepted_at, l.created_at) DESC LIMIT 100`, params).map((r) => r.id);
    const ids = [...new Set([...best, ...stand])];
    rows = ids.length ? handle.all(`SELECT ${cols} FROM learnings l WHERE l.id IN (${ids.map(() => "?").join(",")}) AND ${where}`, [...ids, ...params]) : [];
  } else {
    rows = handle.all(`SELECT ${cols} FROM learnings l WHERE ${where}`, params);
  }
  if (global) {
    const g = learningVisibility("l", keys, "global");
    rows = rows.concat(handle.all(`SELECT ${cols} FROM learnings l WHERE ${recallSql("l", { strict: true })} AND ${g.sql} ORDER BY COALESCE(l.accepted_at, l.created_at) DESC LIMIT ${PREFILTER_TOP}`, g.params).map((r) => ({ ...r, global: true })));
  }
  const recentFrom = now - RECENT_DAYS * DAY;
  return rows.map((r) => {
    const accepted = Date.parse(iso(r.accepted_at) ?? "");
    const own = Boolean(r.own) && !r.global;
    const recent = !r.global && (Boolean(r.prov) || (own && Number.isFinite(accepted) && accepted >= recentFrom));
    return {
      id: r.id,
      text: r.text,
      evidence: r.evidence,
      status: r.status,
      created: iso(later(r.created_at, r.accepted_at)),
      written: iso(r.created_at),
      own,
      provenance: r.provenance ?? null,
      standing: recent,
      global: Boolean(r.global),
    };
  });
}

/** This project's pending notes (for the recall command's "saved, not in use" list), newest first. */
export function pendingRows(handle, keys, { limit = 200 } = {}) {
  if (!handle || !Array.isArray(keys) || !keys.length) return [];
  const vis = learningVisibility("l", keys, "project");
  return handle
    .all(`SELECT l.id, l.text, l.evidence, ${statusSql("l")} AS status, l.created_at FROM learnings l WHERE ${pendingSql("l")} AND l.accepted_by IS NULL AND ${vis.sql} ORDER BY l.created_at DESC LIMIT ${limit}`, vis.params)
    .map((r) => ({ id: r.id, text: r.text, evidence: r.evidence, status: "pending", created: iso(r.created_at) }));
}

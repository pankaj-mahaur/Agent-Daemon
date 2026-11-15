// The user's learnings, read (MCP launch plan L8, design decisions 4–5): the data behind
// `learnings list|show` and L8b's viewer. Pure reads, no writes; a missing table reads as
// empty. The CLI (learnings-cli.mjs) decides how text is shown (neutral in the agent's shell).
//
//   labelOf(row)                         accepted | forget-requested | provisional | pending |
//                                        flagged | hidden | archived | rejected | superseded
//   listLearnings(handle, {keys, …})     this project's notes plus accepted global ones
//   showLearning(handle, id, {keys})     one note with its counts and rule, or {other}/{none}

import { projectClause } from "./projects.mjs";
import { acceptedSql, pendingSql, provisionalSql, flaggedSql } from "./trust.mjs";

export const LABELS = Object.freeze(["accepted", "forget-requested", "provisional", "pending", "flagged", "hidden", "archived", "rejected", "superseded"]);
// What `list` shows without --status: what is in use or waits for the user.
export const DEFAULT_LABELS = Object.freeze(["accepted", "forget-requested", "provisional", "pending", "flagged"]);

/** One label per row, in the order the trust predicates decide it. */
export function labelOf(row) {
  const s = row?.status;
  const flagged = s === "quarantined" || String(row?.applied_to ?? "").startsWith("quarantined");
  if (s === "forget-requested" && row.accepted_by) return "forget-requested";
  if (s === "active" && row.accepted_by) return "accepted";
  if (s === "provisional" && !row.accepted_by) return "provisional";
  if (["hidden", "archived", "rejected", "superseded"].includes(s)) return s;
  if (flagged) return "flagged";
  if (s === "pending" || s === "active") return "pending";
  return s ?? "pending";
}

const SQL_OF = {
  accepted: (a) => `(${a}status = 'active' AND ${a}accepted_by IS NOT NULL)`,
  "forget-requested": (a) => `(${a}status = 'forget-requested' AND ${a}accepted_by IS NOT NULL)`,
  provisional: () => provisionalSql("l"),
  pending: () => `(${pendingSql("l")} AND NOT ${flaggedSql("l")})`,
  flagged: () => `(${flaggedSql("l")} AND l.accepted_by IS NULL AND l.status NOT IN ('hidden', 'archived', 'rejected', 'superseded'))`,
  hidden: (a) => `${a}status = 'hidden'`,
  archived: (a) => `${a}status = 'archived'`,
  rejected: (a) => `${a}status = 'rejected'`,
  superseded: (a) => `${a}status = 'superseded'`,
};

const COLS = `l.id, l.text, l.status, l.accepted_by, l.accepted_at, l.status_at, l.created_at, l.category, l.provenance, l.origin,
  l.project_slug, l.project_id, l.applied_to, l.superseded_by, l.global_accepted_at, l.quarantine_reason`;

function tryAll(handle, sql, params) {
  try {
    return handle.all(sql, params);
  } catch (e) {
    if (/no such (table|column)/i.test(String(e?.message))) return [];
    throw e;
  }
}
const tryGet = (handle, sql, params) => tryAll(handle, sql, params)[0] ?? null;

// Where a note is this project's: its rows, or an accepted global note (served everywhere).
function inScope(keys) {
  if (keys === null || keys === undefined) return { sql: "1", params: [] };
  const p = projectClause("l", keys);
  return { sql: `(${p.sql} OR (l.project_slug IS NULL AND ${acceptedSql("l")}))`, params: p.params };
}

/** Counts and the rule of each row (by id). */
function withCounts(handle, rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => "?").join(",");
  const by = (list) => new Map(list.map((x) => [x.id, x]));
  const recalled = by(tryAll(handle, `SELECT learning_id AS id, COUNT(*) AS n, MAX(ts) AS last FROM injections WHERE learning_id IN (${marks}) GROUP BY learning_id`, ids));
  const repeated = by(tryAll(handle, `SELECT learning_id AS id, COUNT(*) AS n FROM events WHERE kind = 'repeated' AND learning_id IN (${marks}) GROUP BY learning_id`, ids));
  const rules = new Map();
  for (const r of tryAll(handle, `SELECT id AS rule, learning_id AS id, kind, decision, pattern, scope FROM rules WHERE learning_id IN (${marks}) ORDER BY id`, ids)) {
    if (!rules.has(r.id)) rules.set(r.id, []);
    rules.get(r.id).push({ id: r.rule, kind: r.kind, decision: r.decision, pattern: r.pattern, scope: r.scope });
  }
  return rows.map((r) => ({
    ...r,
    label: labelOf(r),
    scope: r.project_slug === null || r.project_slug === undefined ? "all" : "project",
    recalled: recalled.get(r.id)?.n ?? 0,
    lastRecalled: recalled.get(r.id)?.last ?? null,
    repeated: repeated.get(r.id)?.n ?? 0,
    rules: rules.get(r.id) ?? [],
  }));
}

/**
 * @param {any} handle
 * @param {{keys: string[]|null, labels?: string[], limit?: number}} o keys null = every project
 */
export function listLearnings(handle, { keys, labels = DEFAULT_LABELS, limit = 200 } = {}) {
  const want = labels.filter((x) => SQL_OF[x]);
  if (!want.length) return [];
  const scope = inScope(keys);
  const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 5000) : 200;
  const rows = tryAll(
    handle,
    `SELECT ${COLS} FROM learnings l WHERE (${want.map((x) => SQL_OF[x]("l.")).join(" OR ")}) AND ${scope.sql} ORDER BY l.id DESC LIMIT ${lim}`,
    scope.params
  );
  return withCounts(handle, rows);
}

/** One note → {note} | {other: true} (another project's) | {none: true}. */
export function showLearning(handle, id, { keys } = {}) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return { none: true };
  const row = tryGet(handle, `SELECT ${COLS} FROM learnings l WHERE l.id = ?`, [n]);
  if (!row) return { none: true };
  const scope = inScope(keys);
  if (!tryGet(handle, `SELECT 1 AS x FROM learnings l WHERE l.id = ? AND ${scope.sql}`, [n, ...scope.params])) return { other: true };
  return { note: withCounts(handle, [row])[0] };
}

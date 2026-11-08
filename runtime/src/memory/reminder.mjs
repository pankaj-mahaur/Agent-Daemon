// The review reminder (L5 design decision 18) and the store-based review counts that
// session start, `ad status` and `report` print.
//
// session.start, per project, only when something is new since the last `reviewed` event:
//   "3 new learnings from your prompts wait for your OK (2 from Codex): <review>"
// plus "1 removed by a prompt" (a hide nobody has seen yet) and the agent's hides, and,
// once after an import, "also: 14 from your history, 3 from your instruction files". Daily, then
// weekly after 3 reminders with no review in between.

import { projectClause } from "./projects.mjs";
import { ownWordsSql, openSql } from "./trust.mjs";
import { getSetting, putSetting } from "./l5-tables.mjs";

const DAY = 86_400_000;
const EPOCH = "1970-01-01T00:00:00.000Z";

/**
 * When this project was last reviewed: its newest `reviewed` event, by project id, or by
 * the folder's slug in the event's detail (a folder reviewed before it had an id). → ISO.
 */
export function lastReviewedAt(handle, { projectId = null, slug = null } = {}) {
  try {
    return handle.get(
      "SELECT MAX(at) AS at FROM events WHERE kind = 'reviewed' AND ((? IS NOT NULL AND project_id = ?) OR (? IS NOT NULL AND json_valid(detail) AND json_extract(detail, '$.slug') = ?))",
      [projectId, projectId, slug, slug]
    )?.at ?? EPOCH;
  } catch {
    return EPOCH;
  }
}

/**
 * Review counts for one project, from the store (never from proposal files).
 * @returns {{ownNew:number, fromCodex:number, waiting:number, removedByPrompt:number, removedByAgent:number, history:number, files:number, since:string}}
 */
export function reviewCounts(handle, { keys, projectId = null } = {}) {
  const none = { ownNew: 0, fromCodex: 0, waiting: 0, removedByPrompt: 0, removedByAgent: 0, history: 0, files: 0, since: EPOCH };
  if (!Array.isArray(keys) || !keys.length) return none;
  const scope = projectClause("l", keys);
  const since = lastReviewedAt(handle, { projectId, slug: keys.find((k) => !String(k).startsWith("prj_")) ?? null });
  const notMarked = "NOT EXISTS (SELECT 1 FROM events m WHERE m.kind = 'marked' AND m.learning_id = l.id)";
  const one = (sql, params = []) => {
    try {
      return handle.get(sql, [...params, ...scope.params])?.n ?? 0;
    } catch {
      return 0; // an older store without the events table
    }
  };
  return {
    // The checklist's group 1: the user's own prompt words, new since the last review.
    ownNew: one(`SELECT COUNT(*) AS n FROM learnings l WHERE ${ownWordsSql("l")} AND ${openSql("l")} AND julianday(l.created_at) > julianday(?) AND ${notMarked} AND ${scope.sql}`, [since]),
    fromCodex: one(
      `SELECT COUNT(*) AS n FROM learnings l WHERE ${ownWordsSql("l")} AND ${openSql("l")} AND julianday(l.created_at) > julianday(?) AND ${notMarked}
         AND EXISTS (SELECT 1 FROM events c WHERE c.kind = 'captured' AND c.learning_id = l.id AND c.detail LIKE '%"host":"codex"%') AND ${scope.sql}`,
      [since]
    ),
    waiting: one(`SELECT COUNT(*) AS n FROM learnings l WHERE ${openSql("l")} AND ${scope.sql}`),
    // A prompt's hide of the user's own note, never shown yet (its clock hasn't started).
    removedByPrompt: one(`SELECT COUNT(*) AS n FROM learnings l WHERE l.status = 'hidden' AND l.accepted_by IS NULL AND l.status_at IS NULL AND ${scope.sql}`),
    removedByAgent: one(
      `SELECT COUNT(*) AS n FROM learnings l WHERE l.status = 'hidden' AND l.accepted_by IS NULL
         AND EXISTS (SELECT 1 FROM events h WHERE h.kind = 'hidden' AND h.actor = 'agent' AND h.learning_id = l.id AND julianday(h.at) > julianday(?)) AND ${scope.sql}`,
      [since]
    ),
    history: one(`SELECT COUNT(*) AS n FROM learnings l WHERE l.provenance = 'transcript' AND ${openSql("l")} AND ${scope.sql}`),
    files: one(`SELECT COUNT(*) AS n FROM learnings l WHERE l.provenance = 'instruction-file' AND ${openSql("l")} AND ${scope.sql}`),
    since,
  };
}

/**
 * The session-start reminder line, or null (nothing new, or not due). Records that it was
 * shown (memory_settings, per project), so it comes daily, then weekly.
 * @param {{keys:string[], projectId?:string|null, review:string, product?:string, now?:Date}} o
 */
export function reviewReminder(handle, { keys, projectId = null, review, product, now = new Date() }) {
  const c = reviewCounts(handle, { keys, projectId });
  if (!c.ownNew && !c.removedByPrompt && !c.removedByAgent) return null;
  // Keyed by the folder's slug: the project id appears once session start binds the folder.
  const key = `reminder:${keys[0]}`;
  let state = {};
  try {
    state = JSON.parse(getSetting(handle, key) ?? "{}") ?? {};
  } catch {
    state = {};
  }
  // A review since the last reminder starts the count again.
  const shown = state.since === c.since ? Number(state.n) || 0 : 0;
  const every = shown >= 3 ? 7 * DAY : DAY;
  if (state.since === c.since && state.at && now.getTime() - Date.parse(state.at) < every) return null;
  const parts = [];
  if (c.ownNew) parts.push(`${c.ownNew} new learning${c.ownNew === 1 ? "" : "s"} from your prompts wait${c.ownNew === 1 ? "s" : ""} for your OK${c.fromCodex ? ` (${c.fromCodex} from Codex)` : ""}`);
  if (c.removedByPrompt) parts.push(`${c.removedByPrompt} removed by a prompt`);
  if (c.removedByAgent) parts.push(`${c.removedByAgent} removed by the agent`);
  // History and instruction-file proposals are named once, at the first reminder after an import.
  const imported = `${c.history}:${c.files}`;
  const also = (c.history || c.files) && state.imported !== imported
    ? ` · also: ${[c.history ? `${c.history} from your history` : null, c.files ? `${c.files} from your instruction files` : null].filter(Boolean).join(", ")}`
    : "";
  try {
    putSetting(handle, key, JSON.stringify({ at: now.toISOString(), n: shown + 1, since: c.since, imported }), { now });
  } catch {
    // the reminder still shows; it may come again sooner
  }
  return `${product ? `${product}: ` : ""}${parts.join(" · ")}${also} · ${review}`;
}

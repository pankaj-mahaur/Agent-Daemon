// Hard deletes of notes (MCP launch plan 02 §6): the bytes go, not just the row.
//
// purgeLearnings is called by the review service (a forget the user confirmed) and by
// retainNotes (hidden notes nobody accepted, after 7 days); nothing else deletes a note.
// A purge turns on FTS5 secure-delete, so the search index drops the note's terms
// instead of marking them deleted, and PRAGMA secure_delete, so freed pages are
// zeroed; then it truncates the WAL. Rows that only point at the note (injections,
// feedback) go with it, and correction events keep their counts but lose its text.

const DAY = 86_400_000;
export const HIDDEN_DAYS = 7;
export const PROVISIONAL_DAYS = 30;

/** Delete learnings for good. → rows deleted. */
export function purgeLearnings(handle, ids) {
  const list = [...new Set(ids.map(Number).filter(Number.isInteger))];
  if (!list.length) return 0;
  const marks = list.map(() => "?").join(",");
  let rebuild = false;
  try {
    handle.run("INSERT INTO learnings_fts(learnings_fts, rank) VALUES('secure-delete', 1)");
  } catch {
    rebuild = true; // SQLite before 3.44: rebuild the index after the delete instead
  }
  handle.raw.exec("PRAGMA secure_delete = ON");
  const deleted = handle.transaction(() => {
    for (const [table, col] of [["injections", "learning_id"], ["feedback", "learning_id"]]) {
      try {
        handle.run(`DELETE FROM ${table} WHERE ${col} IN (${marks})`, list);
      } catch {
        // older store without the table
      }
    }
    try {
      handle.run(`UPDATE correction_events SET matched_learning_id = NULL, norm_key = NULL WHERE matched_learning_id IN (${marks})`, list);
    } catch {
      // older store without the table
    }
    handle.run(`UPDATE learnings SET supersedes = NULL WHERE supersedes IN (${marks})`, list);
    handle.run(`UPDATE learnings SET superseded_by = NULL WHERE superseded_by IN (${marks})`, list);
    return handle.run(`DELETE FROM learnings WHERE id IN (${marks})`, list).changes;
  });
  if (rebuild) handle.run("INSERT INTO learnings_fts(learnings_fts) VALUES('rebuild')");
  try {
    handle.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // another reader holds the WAL: the next checkpoint truncates it
  }
  return deleted;
}

/**
 * The retention pass (memory maintenance, every run): hidden notes nobody accepted are
 * purged after 7 days, and provisional notes go back to pending after 30. An accepted
 * note, including one the agent asked to forget, is never touched here.
 * → { purged, expired }
 */
export function retainNotes(handle, { now = Date.now() } = {}) {
  const before = (days) => new Date(now - days * DAY).toISOString();
  const stale = handle.all(
    "SELECT id FROM learnings WHERE status = 'hidden' AND accepted_by IS NULL AND status_at IS NOT NULL AND status_at < ?",
    [before(HIDDEN_DAYS)]
  ).map((r) => r.id);
  const purged = stale.length ? purgeLearnings(handle, stale) : 0;
  const expired = handle.run(
    "UPDATE learnings SET status = 'pending', status_at = ? WHERE status = 'provisional' AND accepted_by IS NULL AND status_at IS NOT NULL AND status_at < ?",
    [new Date(now).toISOString(), before(PROVISIONAL_DAYS)]
  ).changes;
  return { purged, expired };
}

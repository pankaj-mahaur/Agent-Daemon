// Erasing notes (MCP launch plan 02 §6): the bytes go, not just the row.
//
// purgeLearnings erases accepted notes for the review service (a forget the user
// confirmed) and hidden unaccepted notes for retainNotes (after 7 days). Other deletes are
// rollbacks of a row just written (capture.mjs) or old migrations (sqlite.mjs).
// Every connection runs with PRAGMA secure_delete (sqlite.mjs open), so pages freed from
// then on are zeroed; the index has FTS5 secure-delete, so a deleted row's terms leave its
// segments. Pages freed before that, by an older ad or an index merge, still hold old
// bytes: after erasing, compactStore() rewrites the file (VACUUM) and truncates the WAL.
// When another process holds the store, that waits, and the maintenance pass retries.
// Rows that only point at the note (injections, feedback) go with it; correction events
// keep their counts but lose its text.

const DAY = 86_400_000;
export const HIDDEN_DAYS = 7;
export const PROVISIONAL_DAYS = 30;
const COMPACT_STEP = "compact-after-purge";

/** Rewrite the store and truncate its WAL. → { vacuumed, walCleared } (false: another process held it; retried by maintenance). */
export function compactStore(handle) {
  let vacuumed = false;
  try {
    handle.raw.exec("VACUUM");
    vacuumed = true;
  } catch {
    // busy: another process has the store open in a transaction
  }
  let walCleared = false;
  try {
    const r = handle.get("PRAGMA wal_checkpoint(TRUNCATE)");
    walCleared = Number(r?.busy ?? Object.values(r ?? {})[0] ?? 1) === 0;
  } catch {
    // not in WAL mode, or busy
  }
  const pending = !(vacuumed && walCleared);
  try {
    if (pending) handle.run("INSERT OR REPLACE INTO memory_maintenance (name, done_at, result) VALUES (?, ?, 'pending')", [COMPACT_STEP, new Date().toISOString()]);
    else handle.run("DELETE FROM memory_maintenance WHERE name = ?", [COMPACT_STEP]);
  } catch {
    // older store without the table
  }
  return { vacuumed, walCleared };
}

/** Whether an earlier purge's compaction is still owed (memory maintenance retries it). */
export function compactionPending(handle) {
  try {
    return Boolean(handle.get("SELECT 1 AS owed FROM memory_maintenance WHERE name = ?", [COMPACT_STEP]));
  } catch {
    return false;
  }
}

/** Delete learnings for good. → rows deleted. */
export function purgeLearnings(handle, ids) {
  const list = [...new Set(ids.map(Number).filter(Number.isInteger))];
  if (!list.length) return 0;
  const marks = list.map(() => "?").join(",");
  // The index's secure-delete is set once, by the schema v5 migration. SQLite before 3.44
  // has none: rebuild the index after the delete instead.
  let rebuild = true;
  try {
    rebuild = Number(handle.get("SELECT v FROM learnings_fts_config WHERE k = 'secure-delete'")?.v) !== 1;
  } catch {
    // no config table: rebuild
  }
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
  if (deleted) compactStore(handle);
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

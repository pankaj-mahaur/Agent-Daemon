// L5 tables (design decisions 10 and 13), created idempotently on every open, with no
// schema version bump: older ad ignores them, and readers treat a missing table as empty.
//
//   events            what happened to a learning (captured, provisional, hidden, …):
//                     kinds, actors and hashes only, never a note's text
//   memory_settings   one row per setting; `review_mode` (strict | auto) and the sticky
//                     `review_mode_ever_strict`
//
// A later column change needs a version bump (hooks never migrate).

export const EVENT_KINDS = Object.freeze([
  "captured", "provisional", "hidden", "restored", "marked", "forget-requested", "expired",
  "repeated", "discarded", "strict-on", "strict-off", "reviewed",
]);
export const ACTORS = Object.freeze(["user", "agent", "review", "system"]);

export const L5_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  kind        TEXT NOT NULL,
  learning_id INTEGER,
  project_id  TEXT,
  actor       TEXT NOT NULL,
  detail      TEXT,
  notified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_learning ON events(learning_id, kind);
CREATE INDEX IF NOT EXISTS idx_events_kind_at ON events(kind, at);
CREATE TABLE IF NOT EXISTS memory_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  at    TEXT NOT NULL
);`;

/** Create the L5 tables on a raw connection (sqlite.mjs open()). */
export function ensureL5Tables(raw) {
  raw.exec(L5_TABLES_SQL);
  // An early dev build registered events as a project table, whose id triggers name a
  // project_slug column events doesn't have; drop them if a store kept them.
  raw.exec("DROP TRIGGER IF EXISTS events_project_id_insert; DROP TRIGGER IF EXISTS events_project_id_update;");
}

const iso = (now) => (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();

/**
 * Record one event. detail: a small object (counts, a hash, a status) — never note text.
 * → the event id, or null when the store has no events table (an older reader's store).
 */
export function recordEvent(handle, { kind, learningId = null, projectId = null, actor, detail = null, at } = {}) {
  if (!EVENT_KINDS.includes(kind)) throw new Error(`unknown event kind: ${kind}`);
  if (!ACTORS.includes(actor)) throw new Error(`unknown actor: ${actor}`);
  try {
    return Number(handle.run(
      "INSERT INTO events (at, kind, learning_id, project_id, actor, detail) VALUES (?, ?, ?, ?, ?, ?)",
      [iso(at), kind, learningId, projectId, actor, detail == null ? null : JSON.stringify(detail)]
    ).lastInsertRowid);
  } catch (e) {
    if (/no such table/i.test(String(e?.message))) return null;
    throw e;
  }
}

/** The newest event of this kind for a learning (or, with learningId null, any), or null. */
export function latestEvent(handle, kind, learningId = undefined, { projectId } = {}) {
  try {
    const where = ["kind = ?"];
    const params = [kind];
    if (learningId !== undefined) {
      where.push("learning_id IS ?");
      params.push(learningId);
    }
    if (projectId !== undefined) {
      where.push("project_id IS ?");
      params.push(projectId);
    }
    const row = handle.get(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT 1`, params);
    if (row?.detail) {
      try {
        row.detail = JSON.parse(row.detail);
      } catch {
        // a damaged detail reads as none
        row.detail = null;
      }
    }
    return row ?? null;
  } catch {
    return null;
  }
}

/** A setting's value, or null when unset or the table is missing. */
export function getSetting(handle, key) {
  try {
    return handle.get("SELECT value FROM memory_settings WHERE key = ?", [key])?.value ?? null;
  } catch {
    return null;
  }
}

/** Set a setting (call inside the caller's transaction when it pairs with an event). */
export function putSetting(handle, key, value, { now } = {}) {
  handle.run(
    "INSERT INTO memory_settings (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at",
    [key, String(value), iso(now)]
  );
}

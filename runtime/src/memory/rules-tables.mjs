// The rules store (MCP launch plan L7, design D1): one row per rule the user approved
// in review. Created idempotently on every open, like L5's events (no schema bump:
// readers treat a missing table as no rules). guards.json is derived from it
// (memory/guards-build.mjs); the hook never opens this store.
//
//   rules(id, learning_id, project_id, scope project|all, kind command|write,
//         decision ask|deny, pattern JSON, reason, approved_at, source learning|policy,
//         orphaned_at)
//
// Triggers:
//   - a learning deleted (forget for good, a rejection) ORPHANS its rules (learning_id
//     NULL, orphaned_at set, the reason replaced so none of the forgotten words stay):
//     they stay enforced until the user removes them with the typed code (design D1–D2),
//     so no rule ends silently;
//   - any change to rules, and a status or superseded_by change of a learning that has a
//     rule, bump
//     memory_settings.rules_rev, so a refresh can tell the store moved since the
//     snapshot was built.

export const RULES_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  learning_id INTEGER,
  project_id  TEXT,
  scope       TEXT NOT NULL CHECK (scope IN ('project', 'all')),
  kind        TEXT NOT NULL CHECK (kind IN ('command', 'write')),
  decision    TEXT NOT NULL CHECK (decision IN ('ask', 'deny')),
  pattern     TEXT NOT NULL,
  reason      TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'learning' CHECK (source IN ('learning', 'policy')),
  orphaned_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_rules_learning ON rules(learning_id);
CREATE INDEX IF NOT EXISTS idx_rules_project ON rules(project_id);
CREATE TRIGGER IF NOT EXISTS rules_orphan_on_learning_delete AFTER DELETE ON learnings
BEGIN
  UPDATE rules SET learning_id = NULL, orphaned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), reason = 'a rule whose learning you removed' WHERE learning_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS rules_rev_insert AFTER INSERT ON rules
BEGIN
  INSERT INTO memory_settings (key, value, at) VALUES ('rules_rev', '1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), at = excluded.at;
END;
CREATE TRIGGER IF NOT EXISTS rules_rev_update AFTER UPDATE ON rules
BEGIN
  INSERT INTO memory_settings (key, value, at) VALUES ('rules_rev', '1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), at = excluded.at;
END;
CREATE TRIGGER IF NOT EXISTS rules_rev_delete AFTER DELETE ON rules
BEGIN
  INSERT INTO memory_settings (key, value, at) VALUES ('rules_rev', '1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), at = excluded.at;
END;
CREATE TRIGGER IF NOT EXISTS rules_rev_learning AFTER UPDATE OF status, superseded_by ON learnings
WHEN (OLD.status IS NOT NEW.status OR OLD.superseded_by IS NOT NEW.superseded_by) AND EXISTS (SELECT 1 FROM rules WHERE learning_id = NEW.id)
BEGIN
  INSERT INTO memory_settings (key, value, at) VALUES ('rules_rev', '1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), at = excluded.at;
END;`;

/** Create the rules table and its triggers on a raw connection (sqlite.mjs open(), after the L5 tables). */
export function ensureRulesTables(raw) {
  raw.exec(RULES_TABLES_SQL);
  // The store's id, made once. Read first: a hook's open must not take the write lock for it.
  if (!raw.prepare("SELECT 1 AS x FROM memory_settings WHERE key = 'store_id'").get()) {
    raw.exec("INSERT OR IGNORE INTO memory_settings (key, value, at) VALUES ('store_id', lower(hex(randomblob(16))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))");
  }
}

/** True for the error an older store gives when it has no rules table yet (anything else is real). */
export const noRulesTable = (e) => /no such table: (?:main\.)?rules\b/i.test(String(e?.message ?? e));

/** This store's id (made with the rules table): the snapshot records it, so a rebuild from another store is refused. */
export function storeId(handle) {
  try {
    return handle.get("SELECT value FROM memory_settings WHERE key = 'store_id'")?.value ?? null;
  } catch {
    return null;
  }
}

/** The store's rules change counter (0 when nothing was ever recorded). */
export function rulesRev(handle) {
  try {
    return Number(handle.get("SELECT value FROM memory_settings WHERE key = 'rules_rev'")?.value ?? 0) || 0;
  } catch {
    return 0; // an older store with no settings table
  }
}

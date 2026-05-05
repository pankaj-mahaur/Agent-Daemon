// SQLite + FTS5 episodic memory store.
//
// Schema modeled after the Hermes Agent pattern:
//   - sessions: one row per session (id, project, agent type, timing, outcome)
//   - messages: turn-by-turn conversation events (user/assistant/tool_use/tool_result)
//   - tool_calls: tool invocations with input/output/duration
//   - learnings: distilled lessons from the digest pipeline (the actual "memory")
//   - skill_executions: per-session record of which skills triggered + outcome
//   - user_facts: cross-project user profile data (Honcho-style dialectic modeling)
//   - messages_fts: FTS5 virtual table over messages.text for full-text recall
//   - learnings_fts: FTS5 virtual table over learnings.text
//
// v0.1: schema definitions + connection helper. Read/write methods wired in
// the next pass when sqlite-vec / better-sqlite3 native binding is added.
// In v0.1 we generate the schema string and write it to a file for review;
// no native binding required to ship the design.

import fs from "node:fs/promises";
import path from "node:path";

/**
 * Full schema (idempotent — uses IF NOT EXISTS everywhere).
 * Apply once at runtime init; safe to apply again.
 *
 * Hermes-style memory model with our additions for skill self-improvement (GEPA traces).
 */
export const SCHEMA = `
-- ─────────────────────────────────────────────────────────────────
-- Pragmas
-- ─────────────────────────────────────────────────────────────────
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA cache_size = -32000;             -- 32 MB cache
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 134217728;           -- 128 MB mmap

-- ─────────────────────────────────────────────────────────────────
-- Schema versioning
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO schema_version (version) VALUES (1);

-- ─────────────────────────────────────────────────────────────────
-- sessions
-- One row per agent session that the digest pipeline saw.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,                            -- agent-provided session id
  project_path    TEXT NOT NULL,                               -- absolute cwd at session start
  project_slug    TEXT NOT NULL,                               -- normalized slug (encoded path)
  agent_type      TEXT NOT NULL DEFAULT 'claude-code',         -- 'claude-code' | 'cline' | 'cursor' | 'codex' | 'aider'
  started_at      TEXT NOT NULL,                               -- ISO 8601
  ended_at        TEXT,                                        -- ISO 8601, null if still in progress
  duration_ms     INTEGER,                                     -- denormalized; updated when ended_at set
  user_turns      INTEGER NOT NULL DEFAULT 0,
  assistant_turns INTEGER NOT NULL DEFAULT 0,
  tool_calls      INTEGER NOT NULL DEFAULT 0,
  edits           INTEGER NOT NULL DEFAULT 0,
  tokens_input    INTEGER NOT NULL DEFAULT 0,                  -- fresh input tokens
  tokens_output   INTEGER NOT NULL DEFAULT 0,
  tokens_cache_create INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  digest_status   TEXT NOT NULL DEFAULT 'pending',             -- 'pending' | 'skipped' | 'digested' | 'error'
  digest_reason   TEXT,                                        -- triage reason or error message
  digested_at     TEXT,                                        -- when digest pipeline ran
  transcript_path TEXT                                         -- absolute path to source JSONL
);
CREATE INDEX IF NOT EXISTS idx_sessions_project   ON sessions(project_slug, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_started   ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_digest    ON sessions(digest_status, started_at DESC);

-- ─────────────────────────────────────────────────────────────────
-- messages
-- Every user / assistant / tool_use / tool_result event.
-- FTS5-indexed for cross-session text recall.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  ord          INTEGER NOT NULL,                               -- order within session
  type         TEXT NOT NULL,                                  -- 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system'
  tool_name    TEXT,                                           -- only when type='tool_use'
  text         TEXT,                                           -- normalized text content
  timestamp    TEXT,
  raw_json     TEXT,                                           -- original JSONL line for debugging
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ord);
CREATE INDEX IF NOT EXISTS idx_messages_type    ON messages(type, timestamp DESC);

-- FTS5 virtual table over messages.text
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text,
  content='messages',
  content_rowid='id',
  tokenize='porter unicode61'
);
-- triggers keep FTS5 in sync
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.id, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;

-- ─────────────────────────────────────────────────────────────────
-- tool_calls
-- Denormalized view of tool invocations for analytics + GEPA trace sampling.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tool_calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  message_id   INTEGER NOT NULL,
  tool_name    TEXT NOT NULL,
  input_json   TEXT,                                           -- input arguments as JSON
  output_text  TEXT,                                           -- result content (truncated if huge)
  output_truncated INTEGER NOT NULL DEFAULT 0,                 -- 1 if output was truncated
  duration_ms  INTEGER,
  status       TEXT,                                           -- 'success' | 'error' | 'timeout' | 'denied'
  error_text   TEXT,
  timestamp    TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool    ON tool_calls(tool_name, status, timestamp DESC);

-- ─────────────────────────────────────────────────────────────────
-- learnings
-- The actual distilled memory entries. Output of the digest pipeline.
-- Each learning is one fact, correction, pattern, or gotcha.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS learnings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT,                                        -- session where this was extracted
  project_slug    TEXT,                                        -- project scope (null = global / cross-project)
  category        TEXT NOT NULL,                               -- 'correction' | 'pattern' | 'gotcha' | 'tool' | 'preference' | 'fact'
  text            TEXT NOT NULL,                               -- the lesson itself
  evidence        TEXT,                                        -- supporting quote or file ref
  confidence      REAL NOT NULL DEFAULT 0.5,                   -- 0.0–1.0
  status          TEXT NOT NULL DEFAULT 'active',              -- 'active' | 'superseded' | 'rejected' | 'archived'
  supersedes      INTEGER,                                     -- id of the learning this replaces
  superseded_by   INTEGER,                                     -- denormalized reverse pointer
  tags            TEXT,                                        -- JSON array of strings (file paths, tech names)
  applied_to      TEXT,                                        -- 'memory.md' | 'skill:debug-triage' | 'constitution' | etc.
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_verified_at TEXT,
  valid_until     TEXT,                                        -- when this learning expires / is invalidated
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (supersedes) REFERENCES learnings(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_learnings_project  ON learnings(project_slug, status, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_learnings_category ON learnings(category, status, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_learnings_session  ON learnings(session_id);

-- FTS5 virtual table over learnings.text
CREATE VIRTUAL TABLE IF NOT EXISTS learnings_fts USING fts5(
  text,
  evidence,
  tags,
  content='learnings',
  content_rowid='id',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS learnings_fts_insert AFTER INSERT ON learnings BEGIN
  INSERT INTO learnings_fts(rowid, text, evidence, tags) VALUES (new.id, new.text, new.evidence, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS learnings_fts_delete AFTER DELETE ON learnings BEGIN
  INSERT INTO learnings_fts(learnings_fts, rowid, text, evidence, tags) VALUES('delete', old.id, old.text, old.evidence, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS learnings_fts_update AFTER UPDATE ON learnings BEGIN
  INSERT INTO learnings_fts(learnings_fts, rowid, text, evidence, tags) VALUES('delete', old.id, old.text, old.evidence, old.tags);
  INSERT INTO learnings_fts(rowid, text, evidence, tags) VALUES (new.id, new.text, new.evidence, new.tags);
END;

-- ─────────────────────────────────────────────────────────────────
-- skill_executions
-- Records every time a skill triggered, plus the outcome.
-- This is the trace data GEPA samples from for skill self-evolution.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_executions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  skill_name      TEXT NOT NULL,
  skill_version   TEXT,                                        -- if the skill has metadata.version
  trigger_text    TEXT,                                        -- what user message caused trigger
  succeeded       INTEGER,                                     -- 0 = no, 1 = yes, NULL = unknown
  failure_reason  TEXT,                                        -- structured failure category if succeeded=0
  trace_path      TEXT,                                        -- pointer to detailed trace blob
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_skill_exec_skill  ON skill_executions(skill_name, succeeded, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_exec_session ON skill_executions(session_id);

-- ─────────────────────────────────────────────────────────────────
-- user_facts
-- Cross-project user profile data. Honcho-style — refined over time
-- by the digest pipeline and writes to ~/.agent-daemon/user.md.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_facts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  category        TEXT NOT NULL,                               -- 'identity' | 'preference' | 'tool' | 'anti-preference' | 'project'
  text            TEXT NOT NULL,
  evidence        TEXT,
  confidence      REAL NOT NULL DEFAULT 0.5,
  status          TEXT NOT NULL DEFAULT 'active',              -- 'active' | 'superseded' | 'rejected'
  supersedes      INTEGER,
  source_session  TEXT,
  observed_count  INTEGER NOT NULL DEFAULT 1,                  -- how many sessions confirmed this
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_observed_at TEXT,
  FOREIGN KEY (source_session) REFERENCES sessions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_user_facts_cat ON user_facts(category, status, confidence DESC);

-- ─────────────────────────────────────────────────────────────────
-- skill_variants  (for GEPA evolution)
-- Each row is a candidate variant produced during a skill-evolution run,
-- with its evaluation score(s). Best variant wins; losers retained for analysis.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_variants (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  evolution_run_id TEXT NOT NULL,                              -- groups all variants from one run
  skill_name      TEXT NOT NULL,
  parent_version  TEXT,                                        -- the skill version this is a variant of
  body            TEXT NOT NULL,                               -- the candidate skill content
  body_hash       TEXT NOT NULL,                               -- sha256 for dedupe
  generated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Evaluation scores (multi-objective Pareto inputs)
  score_quality   REAL,                                        -- task success rate over held-out traces
  score_size      INTEGER,                                     -- char count (smaller = better)
  score_compat    INTEGER,                                     -- caching / format compatibility (1 or 0)
  score_test_pass INTEGER,                                     -- syntactic / linting tests passed (1 or 0)
  is_winner       INTEGER NOT NULL DEFAULT 0,                  -- 1 if Pareto-frontier winner
  applied         INTEGER NOT NULL DEFAULT 0,                  -- 1 if PR'd / merged into the skill
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_skill_variants_run    ON skill_variants(evolution_run_id, is_winner DESC);
CREATE INDEX IF NOT EXISTS idx_skill_variants_skill  ON skill_variants(skill_name, generated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_variants_dedupe ON skill_variants(skill_name, body_hash);

-- ─────────────────────────────────────────────────────────────────
-- proposals  (queued user-review items)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proposals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,                               -- 'skill-edit' | 'constitution-add' | 'memory-add' | 'memory-supersede'
  title           TEXT NOT NULL,
  description     TEXT,
  diff            TEXT,                                        -- patch content
  source_session  TEXT,
  source_run_id   TEXT,                                        -- evolution_run_id if from GEPA
  status          TEXT NOT NULL DEFAULT 'queued',              -- 'queued' | 'accepted' | 'rejected' | 'expired'
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at     TEXT,
  resolution_note TEXT,
  FOREIGN KEY (source_session) REFERENCES sessions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_proposals_kind   ON proposals(kind, status);
`;

/**
 * Resolve the canonical SQLite path:
 *   ~/.agent-daemon/episodic.db
 *
 * @returns {string}
 */
export function defaultDbPath() {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return path.join(home, ".agent-daemon", "episodic.db");
}

/**
 * Write the schema to a file (handy for `sqlite3 < schema.sql` manual apply
 * or for review).
 *
 * @param {string} outPath
 */
export async function dumpSchema(outPath) {
  const dir = path.dirname(outPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(outPath, SCHEMA, "utf8");
}

/**
 * Lazy-load better-sqlite3. Returns null if the module isn't installed —
 * callers handle gracefully so the runtime keeps working without the
 * native binding (digest still writes markdown; only SQLite features fail).
 *
 * @returns {Promise<any | null>}
 */
async function loadDriver() {
  try {
    const mod = await import("better-sqlite3");
    return mod.default || mod;
  } catch (err) {
    return null;
  }
}

/**
 * @typedef {Object} Db
 * @property {any} raw                                  - the underlying better-sqlite3 Database
 * @property {string} path                              - the absolute file path
 * @property {(sql: string, params?: any[]) => any} run - exec a write
 * @property {(sql: string, params?: any[]) => any[]} all - exec a read returning rows
 * @property {(sql: string, params?: any[]) => any} get - exec a read returning the first row
 * @property {(fn: () => any) => any} transaction       - run fn inside a transaction
 * @property {() => void} close
 */

/**
 * Open (or create) the episodic SQLite database. Applies the schema idempotently.
 * Returns null if better-sqlite3 isn't installed; caller decides what to do.
 *
 * @param {{dbPath?: string}} [opts]
 * @returns {Promise<Db | null>}
 */
export async function open(opts = {}) {
  const Database = await loadDriver();
  if (!Database) return null;

  const dbPath = opts.dbPath || defaultDbPath();
  await fs.mkdir(path.dirname(dbPath), { recursive: true });

  const raw = new Database(dbPath);
  raw.exec(SCHEMA);

  return {
    raw,
    path: dbPath,
    run: (sql, params = []) => raw.prepare(sql).run(...params),
    all: (sql, params = []) => raw.prepare(sql).all(...params),
    get: (sql, params = []) => raw.prepare(sql).get(...params),
    transaction: (fn) => raw.transaction(fn)(),
    close: () => raw.close()
  };
}

/**
 * @returns {Promise<{installed: boolean, version?: string, error?: string}>}
 */
export async function checkDriver() {
  try {
    const Database = await loadDriver();
    if (!Database) {
      return { installed: false, error: "better-sqlite3 not installed (run: cd runtime && npm install)" };
    }
    // Probe by opening an in-memory db
    const db = new Database(":memory:");
    db.close();
    return { installed: true };
  } catch (err) {
    return { installed: false, error: err.message };
  }
}

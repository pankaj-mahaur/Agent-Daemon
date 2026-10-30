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
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { adRoot, legacyAdRoots } from "../ad-root.mjs";
import { availableDrivers, openDatabase } from "./driver.mjs";
import { migrateProjectIds, syncProjectKeys } from "./project-db.mjs";


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
  content_hash    TEXT,                                        -- 16-hex sha256 of trimmed text — dedup key
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_verified_at TEXT,
  valid_until     TEXT,                                        -- when this learning expires / is invalidated
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (supersedes) REFERENCES learnings(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_learnings_project  ON learnings(project_slug, status, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_learnings_category ON learnings(category, status, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_learnings_session  ON learnings(session_id);
-- NOTE: the unique partial index on content_hash is created by the migration
-- runner in open() (migrateLearningsContentHash), NOT here in SCHEMA. Doing
-- it here would fail on legacy DBs whose learnings table predates the
-- content_hash column — SCHEMA runs before the migration adds the column.

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
CREATE TRIGGER IF NOT EXISTS learnings_fts_update AFTER UPDATE OF text, evidence, tags ON learnings BEGIN
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
  invocation_source TEXT,                                      -- 'slash-command' | 'skill-tool'
  outcome_source TEXT,                                         -- how outcome was determined
  completed_at    TEXT,                                        -- when a known outcome was observed
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
-- skill_route_events
-- Separates routing telemetry from execution telemetry so GEPA
-- failure sampling is not polluted by "recommended but not invoked"
-- events. A recommendation here does NOT imply a failure.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_route_events (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id                  TEXT NOT NULL,
  project_slug                TEXT,
  task_size                   TEXT,                                -- 'simple' | 'substantial' | 'high-risk' | 'override'
  prompt_intent               TEXT,                                -- short label matched from routing map
  recommended_capability_type TEXT,                                -- 'skill' | 'mcp' | 'native-agent' | null
  recommended_capability      TEXT,                                -- e.g. 'review-slice', null if no match
  recommendation_source       TEXT NOT NULL DEFAULT 'capability-route-advice',
  explicit_agent_request      INTEGER NOT NULL DEFAULT 0,          -- 1 if prompt contained agent-delegation language
  explicit_capability_constraint INTEGER NOT NULL DEFAULT 0,       -- 1 if prompt said "do not use skills" etc.
  invoked_skill               TEXT,                                -- filled in later by skill-use telemetry correlation
  created_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_route_events_session ON skill_route_events(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_route_events_skill   ON skill_route_events(recommended_capability, created_at DESC);

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
// AD_MEMORY_DB (the memory server's --db) names the file. Else an existing DB, looked
// for first where every earlier ad put it (HOME, then USERPROFILE: Git Bash's HOME can
// differ), so an install keeps the DB it has; a new install gets one in ad's root (plan §M).
// Hooks and the memory server all resolve through here, so they share one file.
export function defaultDbPath() {
  if (process.env.AD_MEMORY_DB && path.isAbsolute(process.env.AD_MEMORY_DB)) return process.env.AD_MEMORY_DB;
  const earlier = process.env.HOME || process.env.USERPROFILE;
  const roots = [...new Set([...(earlier ? [path.join(earlier, ".agent-daemon")] : []), adRoot(), ...legacyAdRoots()])];
  const found = roots.map((r) => path.join(r, "episodic.db")).find((p) => existsSync(p));
  return found ?? path.join(adRoot(), "episodic.db");
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
// SQLITE_BUSY, SQLITE_LOCKED and SQLITE_IOERR (its extended codes keep the low byte 10).
const transientOpenError = (e) => e?.code === "SQLITE_BUSY" || /^SQLITE_IOERR/.test(String(e?.code ?? "")) || [5, 6, 10].includes(Number(e?.errcode) & 0xff);

export async function open(opts = {}) {
  const dbPath = opts.dbPath || defaultDbPath();
  await fs.mkdir(path.dirname(dbPath), { recursive: true });

  // better-sqlite3 or node:sqlite (memory/driver.mjs); null when neither loads.
  // A process that just closed or died can leave the WAL's shared memory busy for
  // a moment (Windows: "disk I/O error" under node:sqlite): retry those briefly.
  let raw;
  for (let attempt = 0; ; attempt++) {
    raw = await openDatabase(dbPath, { prefer: opts.prefer });
    if (!raw) return null;
    try {
      raw.exec(SCHEMA);
      // Run migrations AFTER SCHEMA exec. Each migration is idempotent + safe to
      // re-run on already-migrated DBs.
      migrateLearningsContentHash(raw);
      migrateLearningsEvolution(raw);
      migrateSkillExecutionTelemetry(raw);
      migrateSkillRouteEvents(raw);
      migrateRetrievalEvents(raw);
      migrateMemoryContract(raw);
      migrateLearningsCapture(raw);
      migrateLearningValue(raw);
      // P7.1a: project ids (additive), and the registry's slugs mirrored for the triggers.
      migrateProjectIds(raw);
      syncProjectKeys(raw);
      break;
    } catch (e) {
      try {
        raw.close();
      } catch {
        // already unusable
      }
      if (attempt >= 4 || !transientOpenError(e)) throw e;
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    }
  }

  return {
    raw,
    path: dbPath,
    driver: raw.driver,
    run: (sql, params = []) => raw.prepare(sql).run(...params),
    all: (sql, params = []) => raw.prepare(sql).all(...params),
    get: (sql, params = []) => raw.prepare(sql).get(...params),
    transaction: (fn) => raw.transaction(fn)(),
    close: () => raw.close()
  };
}

/**
 * Compute the 16-char hex SHA-256 fingerprint of a learning's text.
 * 64 bits of entropy — collision-resistant enough for dedup; cheap.
 *
 * Trims surrounding whitespace so cosmetic drift ("foo " vs "foo")
 * collapses to the same hash. Case-sensitive — "Use pnpm" and "use pnpm"
 * intentionally hash differently because they may carry different intent
 * (a quote vs a statement).
 *
 * @param {string} text
 * @returns {string}
 */
export function learningContentHash(text) {
  return createHash("sha256").update(String(text || "").trim()).digest("hex").slice(0, 16);
}

/**
 * Idempotent migration: ensures `learnings.content_hash` column exists,
 * backfills NULLs for legacy rows, dedupes by hash (keeping the oldest row
 * per duplicate cluster), and creates the unique partial index. Safe to run
 * on every `open()` — does nothing when already migrated.
 *
 * Originally introduced because `searchLearnings` was returning the same
 * text 3× ("`git status` shows 4 changed files") — three sessions each
 * extracted the same line, inserts went through unguarded, FTS returned
 * all three.
 *
 * @param {any} raw — the better-sqlite3 Database
 */
function migrateLearningsContentHash(raw) {
  // 1. Add column if missing
  const cols = raw.prepare("PRAGMA table_info(learnings)").all();
  const hasContentHash = cols.some(c => c.name === "content_hash");
  if (!hasContentHash) {
    raw.exec("ALTER TABLE learnings ADD COLUMN content_hash TEXT");
  }

  // 2. Backfill + dedupe in a single transaction.
  //    The order matters: if we set hashes first and then dedupe, the UPDATE
  //    can hit the unique index (already created on fresh DBs by SCHEMA).
  //    Instead: compute hashes in JS, group by hash, keep the oldest id per
  //    group, DELETE the rest, then UPDATE only the survivors. Avoids any
  //    UNIQUE collision during migration.
  const nullRows = raw.prepare(
    "SELECT id, text FROM learnings WHERE content_hash IS NULL ORDER BY id ASC"
  ).all();

  if (nullRows.length > 0) {
    const keepersByHash = new Map();  // hash → id of oldest row carrying this text
    const dropIds = [];
    for (const row of nullRows) {
      const h = learningContentHash(row.text);
      if (keepersByHash.has(h)) {
        dropIds.push(row.id);
      } else {
        keepersByHash.set(h, row.id);
      }
    }

    // Also check for collisions against ROWS THAT ALREADY HAVE A HASH (could
    // happen if a partial migration ran before — defensive).
    const existingHashes = raw.prepare(
      "SELECT content_hash FROM learnings WHERE content_hash IS NOT NULL"
    ).all().map(r => r.content_hash);
    const existingSet = new Set(existingHashes);

    raw.transaction(() => {
      // Delete legacy duplicates first
      if (dropIds.length > 0) {
        const placeholders = dropIds.map(() => "?").join(",");
        raw.prepare(`DELETE FROM learnings WHERE id IN (${placeholders})`).run(...dropIds);
      }

      // Update survivors. Skip any whose hash already exists (collision with
      // an already-migrated row); delete those instead.
      const update = raw.prepare("UPDATE learnings SET content_hash = ? WHERE id = ?");
      const del    = raw.prepare("DELETE FROM learnings WHERE id = ?");
      for (const [hash, id] of keepersByHash) {
        if (existingSet.has(hash)) {
          del.run(id);
        } else {
          update.run(hash, id);
        }
      }
    })();
  }

  // 3. Ensure the unique partial index exists. Idempotent — the SCHEMA block
  //    creates it on fresh DBs; this is the safety net for legacy DBs where
  //    the column didn't exist when SCHEMA first ran.
  raw.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_learnings_content_hash " +
    "ON learnings(content_hash) WHERE content_hash IS NOT NULL"
  );
}

/**
 * Idempotent migration for Claude skill telemetry audit metadata.
 *
 * @param {any} raw - the better-sqlite3 Database
 */
function migrateSkillExecutionTelemetry(raw) {
  const cols = new Set(raw.prepare("PRAGMA table_info(skill_executions)").all().map(c => c.name));
  const missing = [
    ["invocation_source", "TEXT"],
    ["outcome_source", "TEXT"],
    ["completed_at", "TEXT"]
  ];
  for (const [name, type] of missing) {
    if (!cols.has(name)) {
      raw.exec(`ALTER TABLE skill_executions ADD COLUMN ${name} ${type}`);
    }
  }
}

/**
 * Idempotent migration: memory-evolution columns on learnings. Powers
 * confidence reinforcement (observed_count), retrieval write-back
 * (retrieval_count / last_retrieved_at), usefulness feedback, and
 * contradiction links — the Hermes-style evolution loop.
 *
 * @param {any} raw - the better-sqlite3 Database
 */
function migrateLearningsEvolution(raw) {
  const cols = new Set(raw.prepare("PRAGMA table_info(learnings)").all().map(c => c.name));
  const missing = [
    ["observed_count", "INTEGER NOT NULL DEFAULT 1"],
    ["retrieval_count", "INTEGER NOT NULL DEFAULT 0"],
    ["last_retrieved_at", "TEXT"],
    ["usefulness", "REAL"],
    ["contradicted_by", "INTEGER"],
    // Honcho-inspired derivation tier (deterministic 2-way):
    //   'explicit'  — directly stated (correction/decision/tool/fact/gotcha/confirmation)
    //   'inferred'  — generalized from behavior (pattern)
    // We deliberately collapse Honcho's deductive/inductive split into 'inferred'
    // because distinguishing them reliably requires an LLM — see episodic.deriveTier().
    ["derivation", "TEXT"]
  ];
  for (const [name, type] of missing) {
    if (!cols.has(name)) {
      raw.exec(`ALTER TABLE learnings ADD COLUMN ${name} ${type}`);
    }
  }

  // Backfill derivation on legacy rows from their category (idempotent — only
  // touches NULLs). 'pattern' is the one generalized category → 'inferred'.
  raw.exec(
    `UPDATE learnings
        SET derivation = CASE WHEN category = 'pattern' THEN 'inferred' ELSE 'explicit' END
      WHERE derivation IS NULL`
  );

  // user_facts provenance: which projects observed this fact (JSON array of
  // slugs). ≥2 distinct projects is the promotion signal.
  const ufCols = new Set(raw.prepare("PRAGMA table_info(user_facts)").all().map(c => c.name));
  if (!ufCols.has("projects")) {
    raw.exec("ALTER TABLE user_facts ADD COLUMN projects TEXT");
  }
  if (!ufCols.has("content_hash")) {
    raw.exec("ALTER TABLE user_facts ADD COLUMN content_hash TEXT");
  }
}

/**
 * Idempotent migration: the memory scope and promotion contract (plan §M).
 * Columns only; no data is rewritten. Readers apply the visibility rule
 * (episodic.mjs learningVisibility / factVisibility):
 *   - status 'active' (accepted), 'pending' (waits for the user) or
 *     'quarantined' (held back); older ad serves only 'active', so it never
 *     shows pending or quarantined rows;
 *   - origin: who wrote it ('user' | 'agent' | 'unknown');
 *   - global_accepted_at: set only when the user accepts a row as global; a
 *     NULL-project row without it is "global pending", served only in the
 *     project its session came from;
 *   - promote_request 'global': the classifier thought it was global; it waits
 *     for the user's promotion instead of going global by itself.
 *
 * @param {any} raw
 */
export function migrateMemoryContract(raw) {
  for (const table of ["learnings", "user_facts"]) {
    const cols = new Set(raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    const want = [["quarantine_reason", "TEXT"], ["origin", "TEXT"], ["global_accepted_at", "TEXT"]];
    if (table === "learnings") want.push(["promote_request", "TEXT"]);
    for (const [col, type] of want) {
      if (!cols.has(col)) raw.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    }
  }
  raw.exec(`CREATE TABLE IF NOT EXISTS memory_maintenance (
    name    TEXT PRIMARY KEY,
    done_at TEXT NOT NULL,
    result  TEXT
  )`);
}

/**
 * Idempotent migration (P5.2): capture keys on learnings, and the hooks' heartbeats.
 *   norm_key      one note per project whoever records it: normKey(text)
 *   capture_ref   the host's session id, or proc:<pid>; deduplication only, so no
 *                 foreign key (a host's session id needn't be one of ad's sessions)
 *   project_path  the folder the note was recorded in
 *   capture_heartbeats  a host's hooks ran in a project; the record tools defer to them
 * Additive only: older ad ignores the columns and the table.
 *
 * @param {any} raw
 */
export function migrateLearningsCapture(raw) {
  const cols = new Set(raw.prepare("PRAGMA table_info(learnings)").all().map((c) => c.name));
  for (const [col, type] of [["norm_key", "TEXT"], ["capture_ref", "TEXT"], ["project_path", "TEXT"]]) {
    if (!cols.has(col)) raw.exec(`ALTER TABLE learnings ADD COLUMN ${col} ${type}`);
  }
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_learnings_norm ON learnings(project_slug, norm_key);
    CREATE TABLE IF NOT EXISTS capture_heartbeats (
      host         TEXT NOT NULL,
      project_slug TEXT NOT NULL,
      capture_ref  TEXT,
      last_seen    TEXT NOT NULL,
      PRIMARY KEY (host, project_slug)
    );
    INSERT OR IGNORE INTO schema_version (version) VALUES (2);`);
  // The search index only needs the indexed columns: an update of a counter or a
  // key (retrieval counts, the norm_key backfill) no longer rewrites its index row.
  const trig = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'learnings_fts_update'").get();
  if (trig && !/UPDATE OF text, evidence, tags/i.test(trig.sql)) {
    // One transaction, so two processes upgrading at once can't leave it missing or fail on it.
    raw.transaction(() => {
      raw.exec(`DROP TRIGGER IF EXISTS learnings_fts_update;
        CREATE TRIGGER learnings_fts_update AFTER UPDATE OF text, evidence, tags ON learnings BEGIN
          INSERT INTO learnings_fts(learnings_fts, rowid, text, evidence, tags) VALUES('delete', old.id, old.text, old.evidence, old.tags);
          INSERT INTO learnings_fts(rowid, text, evidence, tags) VALUES (new.id, new.text, new.evidence, new.tags);
        END;`);
    }).immediate();
  }
}

/**
 * Idempotent migration (P5.5): what memory showed, which corrections came back,
 * and feedback per project. Additive DDL only; nothing is backfilled.
 *   injections         a lesson shown to a session (capture_ref = the host session
 *                      id for hooks, proc:<pid>-<start> for one memory-server process)
 *   correction_events  every correction captured, and whether it repeated an
 *                      accepted lesson from an earlier session (match_kind exact |
 *                      similar | null; was_injected yes | no | unknown | null)
 *   feedback           memory_feedback verdicts, per calling project: a global lesson
 *                      ranks by its own project's verdicts only
 *
 * @param {any} raw
 */
export function migrateLearningValue(raw) {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS injections (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      capture_ref  TEXT,
      project_slug TEXT,
      learning_id  INTEGER NOT NULL,
      surface      TEXT NOT NULL,
      host         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_injections_ref ON injections(capture_ref, learning_id);
    CREATE INDEX IF NOT EXISTS idx_injections_project ON injections(project_slug, ts);
    CREATE TABLE IF NOT EXISTS correction_events (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      ts                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      capture_ref         TEXT,
      project_slug        TEXT,
      norm_key            TEXT,
      source              TEXT,
      matched_learning_id INTEGER,
      match_kind          TEXT,
      was_injected        TEXT,
      host                TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_correction_events_project ON correction_events(project_slug, ts);
    CREATE INDEX IF NOT EXISTS idx_correction_events_match ON correction_events(matched_learning_id, was_injected);
    CREATE TABLE IF NOT EXISTS feedback (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      project_slug TEXT,
      learning_id  INTEGER NOT NULL,
      verdict      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_learning ON feedback(learning_id, project_slug);
    INSERT OR IGNORE INTO schema_version (version) VALUES (3);
  `);
}

/**
 * One note per project: the text lowercased (Unicode NFKC), spacing collapsed and
 * end punctuation dropped, hashed. "Use pnpm." and "use  pnpm" are one note.
 */
export function normKey(text) {
  const n = String(text ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").replace(/[.,;:!?]+$/, "").trim();
  return createHash("sha256").update(n).digest("hex").slice(0, 16);
}

/** The content hash a new row gets: project rows are scoped to their project, global rows not. */
export function scopedContentHash(projectKey, text) {
  return projectKey ? learningContentHash(`${projectKey}\u{0}${String(text ?? "").trim()}`) : learningContentHash(text);
}

/**
 * Idempotent migration: retrieval_events table — measurement-first telemetry
 * for what SessionStart / query-retrieve considered, injected, and truncated
 * (scalable-memory-retrieval plan, Phase 1).
 *
 * @param {any} raw - the better-sqlite3 Database
 */
function migrateRetrievalEvents(raw) {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS retrieval_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      session_id      TEXT,
      project_slug    TEXT,
      source          TEXT NOT NULL,            -- 'session-start' | 'query-retrieve'
      considered_bytes INTEGER NOT NULL DEFAULT 0,
      injected_bytes  INTEGER NOT NULL DEFAULT 0,
      truncated       INTEGER NOT NULL DEFAULT 0,
      groups_json     TEXT                      -- per-group {label, bytesIn, bytesKept, truncated}
    );
    CREATE INDEX IF NOT EXISTS idx_retrieval_events_project ON retrieval_events(project_slug, ts DESC);
  `);
}

/**
 * Idempotent migration: create skill_route_events table on existing DBs that
 * predate its introduction. The SCHEMA block handles fresh DBs; this is the
 * safety net for live installs.
 *
 * @param {any} raw - the better-sqlite3 Database
 */
function migrateSkillRouteEvents(raw) {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS skill_route_events (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id                  TEXT NOT NULL,
      project_slug                TEXT,
      task_size                   TEXT,
      prompt_intent               TEXT,
      recommended_capability_type TEXT,
      recommended_capability      TEXT,
      recommendation_source       TEXT NOT NULL DEFAULT 'capability-route-advice',
      explicit_agent_request      INTEGER NOT NULL DEFAULT 0,
      explicit_capability_constraint INTEGER NOT NULL DEFAULT 0,
      invoked_skill               TEXT,
      invoked_at                  TEXT,
      created_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_route_events_session ON skill_route_events(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_route_events_skill   ON skill_route_events(recommended_capability, created_at DESC);
  `);
  // invoked_at landed after the table's introduction — patch existing DBs.
  const cols = new Set(raw.prepare("PRAGMA table_info(skill_route_events)").all().map(c => c.name));
  if (!cols.has("invoked_at")) {
    raw.exec("ALTER TABLE skill_route_events ADD COLUMN invoked_at TEXT");
  }
}

/**
 * @returns {Promise<{installed: boolean, driver?: string, drivers?: string[], error?: string}>}
 */
export async function checkDriver() {
  try {
    const drivers = await availableDrivers();
    if (!drivers.length) return { installed: false, drivers, error: "no SQLite driver: better-sqlite3 not installed (run: cd runtime && npm install) and node:sqlite needs Node 22.16+ (full-text search)" };
    // Probe the one open() will use.
    const db = await openDatabase(":memory:");
    const driver = db.driver;
    db.close();
    return { installed: true, driver, drivers };
  } catch (err) {
    return { installed: false, error: err.message };
  }
}

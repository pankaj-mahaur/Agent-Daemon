// Episodic memory CRUD over the SQLite schema.
//
// Higher-level layer over runtime/src/memory/sqlite.mjs. The digest pipeline
// writes here; session-start reads here for retrieval-augmented context loading.
//
// Two retrieval paths:
//   - searchLearnings(query, opts)  →  BM25 over learnings.text via FTS5
//   - listRecentLearnings(opts)     →  most-recent N by created_at
//
// All writes use prepared statements + transactions for safety.

import path from "node:path";
import { open, learningContentHash } from "./sqlite.mjs";
import { redactSecrets } from "../security/secret-patterns.mjs";

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

let _db = null;
let _dbPromise = null;

/**
 * Get-or-open the singleton database. Returns null if better-sqlite3 isn't
 * installed (callers handle gracefully — the markdown side of digest still works).
 *
 * Concurrency-safe: parallel callers (e.g. the MCP server handling several
 * tool calls at once) share the SAME in-flight open() promise. A previous
 * boolean-gate implementation returned null to the second caller while the
 * first open() was still awaiting — surfacing as spurious "(no learning)"
 * misses under concurrent load. A resolved null (driver missing) is cached so
 * we don't re-attempt every call; a rejected open() resets so a later call can
 * retry.
 *
 * @returns {Promise<import("./sqlite.mjs").Db | null>}
 */
export async function db() {
  if (_db) return _db;
  if (!_dbPromise) {
    _dbPromise = open()
      .then(handle => { _db = handle; return handle; })
      .catch(err => { _dbPromise = null; throw err; });
  }
  return _dbPromise;
}

/** Close the singleton (for tests). */
export function closeDb() {
  if (_db) { _db.close(); }
  _db = null;
  _dbPromise = null;
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

/**
 * Upsert a session row. Idempotent on `id`.
 *
 * @param {{
 *   id: string,
 *   projectPath: string,
 *   agentType?: string,
 *   startedAt: string,
 *   endedAt?: string,
 *   userTurns?: number,
 *   assistantTurns?: number,
 *   toolCalls?: number,
 *   edits?: number,
 *   transcriptPath?: string,
 *   digestStatus?: string,
 *   digestReason?: string
 * }} row
 */
export async function upsertSession(row) {
  const handle = await db();
  if (!handle) return;
  const slug = projectSlug(row.projectPath);
  const durationMs = (row.startedAt && row.endedAt)
    ? Math.max(0, new Date(row.endedAt) - new Date(row.startedAt))
    : null;

  handle.run(
    `INSERT INTO sessions
       (id, project_path, project_slug, agent_type, started_at, ended_at, duration_ms,
        user_turns, assistant_turns, tool_calls, edits, transcript_path, digest_status, digest_reason, digested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       ended_at        = COALESCE(excluded.ended_at, sessions.ended_at),
       duration_ms     = COALESCE(excluded.duration_ms, sessions.duration_ms),
       user_turns      = excluded.user_turns,
       assistant_turns = excluded.assistant_turns,
       tool_calls      = excluded.tool_calls,
       edits           = excluded.edits,
       digest_status   = excluded.digest_status,
       digest_reason   = excluded.digest_reason,
       digested_at     = excluded.digested_at`,
    [
      row.id, row.projectPath, slug, row.agentType || "claude-code",
      row.startedAt, row.endedAt || null, durationMs,
      row.userTurns ?? 0, row.assistantTurns ?? 0, row.toolCalls ?? 0, row.edits ?? 0,
      row.transcriptPath || null,
      row.digestStatus || "digested",
      row.digestReason || null,
      new Date().toISOString()
    ]
  );
}

/**
 * True when a session id is already recorded as digested. Used by the
 * digest-sweep command to skip transcripts that were already processed
 * (transcript filename stem = session UUID).
 *
 * @param {string} sessionId
 * @returns {Promise<boolean>}
 */
export const SETTLED_DIGEST_STATUSES = new Set(["digested", "triaged-skip", "no-block", "no-learnings"]);

export async function isSessionDigested(sessionId) {
  const info = await sessionDigestInfo(sessionId);
  return !!info && SETTLED_DIGEST_STATUSES.has(info.status);
}

/**
 * Digest bookkeeping for one session: { status, digestedAt } or null when
 * the session has never been seen. digest-sweep uses digestedAt to detect
 * transcripts that grew after their last digest (resumed sessions).
 *
 * @param {string} sessionId
 * @returns {Promise<{ status: string|null, digestedAt: string|null } | null>}
 */
export async function sessionDigestInfo(sessionId) {
  const handle = await db();
  if (!handle || !sessionId) return null;
  const row = handle.get(
    `SELECT digest_status AS status, digested_at AS digestedAt
       FROM sessions WHERE id = ? LIMIT 1`,
    [sessionId]
  );
  return row || null;
}

/**
 * ISO timestamp of the most recent digested session for a project slug,
 * or null. Feeds the doctor freshness check.
 *
 * @param {string} projectSlug
 * @returns {Promise<string | null>}
 */
export async function latestDigestedAt(projectSlug) {
  const handle = await db();
  if (!handle) return null;
  const row = handle.get(
    `SELECT MAX(digested_at) AS latest FROM sessions
      WHERE project_slug = ? AND digest_status = 'digested'`,
    [projectSlug]
  );
  return row?.latest || null;
}

/* ------------------------------------------------------------------ */
/* Learnings                                                           */
/* ------------------------------------------------------------------ */

/**
 * Honcho-inspired derivation tier, computed deterministically from category.
 * Honcho types observations as explicit / deductive / inductive via an LLM; we
 * collapse the two inferred kinds into 'inferred' because telling deductive
 * from inductive reliably needs an LLM (truth over a fake 3-way split). The one
 * generalized category we emit is 'pattern' ("we always X", conventions) →
 * 'inferred'; everything else is a directly-stated fact → 'explicit'.
 *
 * @param {string} category
 * @returns {'explicit'|'inferred'}
 */
export function deriveTier(category) {
  return category === "pattern" ? "inferred" : "explicit";
}

/**
 * Insert one learning row. Returns the new id, or null if the driver isn't loaded.
 *
 * @param {{
 *   sessionId?: string,
 *   projectSlug?: string,
 *   category: string,                 // 'correction' | 'pattern' | 'gotcha' | 'tool' | 'preference' | 'fact' | 'confirmation'
 *   text: string,
 *   evidence?: string,
 *   confidence?: number,
 *   tags?: string[],
 *   appliedTo?: string                // 'memory.md' | 'skill:debug-triage' | etc.
 * }} learning
 * @returns {Promise<number | null>}
 */
export async function insertLearning(learning) {
  const handle = await db();
  if (!handle) return null;
  const l = redactLearning(learning);
  const contentHash = learningContentHash(l.text);
  // INSERT OR IGNORE: same text from a different session collides on the
  // partial unique index `idx_learnings_content_hash` and is skipped.
  // (We use OR IGNORE instead of ON CONFLICT(col) because SQLite's
  // UPSERT requires a FULL unique constraint as the conflict target —
  // partial indexes don't qualify. OR IGNORE works with either.)
  const result = handle.run(INSERT_LEARNING_SQL, learningRow(l, contentHash));
  // Hash collision = the same lesson re-observed in a later session — the
  // strongest confirmation signal we get. Reinforce instead of discarding.
  if (!result.changes) {
    if (l.origin === "user") acceptPendingByUser(handle, contentHash, l.projectSlug);
    reinforceLearning(handle, contentHash);
    return null;  // null still signals "dedup" to callers counting inserts
  }
  return result.lastInsertRowid;
}

// Every learning write redacts secrets in text, evidence and tags first.
// status: 'active' (accepted), 'pending' (waits for the user: agent-written
// notes) or 'quarantined' (held back: injection screen, secrets).
const INSERT_LEARNING_SQL = `INSERT OR IGNORE INTO learnings
  (session_id, project_slug, category, text, evidence, confidence, tags, applied_to, content_hash, derivation, status, origin, quarantine_reason, promote_request)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const LEARNING_STATUSES = new Set(["active", "pending", "quarantined"]);

function redactLearning(l) {
  const r = (s) => (typeof s === "string" ? redactSecrets(s).text : s);
  return { ...l, text: r(l.text), evidence: r(l.evidence), tags: Array.isArray(l.tags) ? l.tags.map(r) : l.tags };
}

function learningRow(l, contentHash) {
  return [
    l.sessionId || null,
    l.projectSlug || null,
    l.category,
    l.text,
    l.evidence || null,
    l.confidence ?? 0.5,
    l.tags ? JSON.stringify(l.tags) : null,
    l.appliedTo || null,
    contentHash,
    deriveTier(l.category),
    LEARNING_STATUSES.has(l.status) ? l.status : "active",
    ["user", "agent", "unknown"].includes(l.origin) ? l.origin : null,
    l.quarantineReason || null,
    l.promoteRequest || null,
  ];
}

// The user typed what an agent noted (same text, same project): that is the
// user's acceptance, so the pending row becomes theirs and active.
function acceptPendingByUser(handle, contentHash, projectSlug) {
  try {
    handle.run(
      `UPDATE learnings SET status = 'active', origin = 'user', applied_to = NULL
        WHERE content_hash = ? AND status = 'pending' AND project_slug IS ?`,
      [contentHash, projectSlug || null]
    );
  } catch { /* pre-migration DB: no pending rows to accept */ }
}

/**
 * Bump confidence + observed_count on a re-observed learning (content-hash
 * collision). Confidence saturates at 0.95 — certainty stays earned, never
 * absolute.
 *
 * @param {import("./sqlite.mjs").Db} handle
 * @param {string} contentHash
 */
function reinforceLearning(handle, contentHash) {
  try {
    handle.run(
      `UPDATE learnings
          SET confidence = MIN(0.95, confidence + 0.1),
              observed_count = observed_count + 1,
              last_verified_at = ?
        WHERE content_hash = ? AND status = 'active'`,
      [new Date().toISOString(), contentHash]
    );
  } catch { /* evolution columns missing on a pre-migration DB — best-effort */ }
}

/**
 * Insert many learnings inside a single transaction.
 *
 * @param {Parameters<typeof insertLearning>[0][]} learnings
 * @returns {Promise<number[]>}
 */
export async function insertLearnings(learnings) {
  const handle = await db();
  if (!handle) return [];
  const ids = [];
  handle.transaction(() => {
    for (const raw of learnings) {
      const l = redactLearning(raw);
      const contentHash = learningContentHash(l.text);
      const r = handle.run(INSERT_LEARNING_SQL, learningRow(l, contentHash));
      // Dedup = re-observation → reinforce confidence instead of discarding.
      if (!r.changes && l.origin === "user") acceptPendingByUser(handle, contentHash, l.projectSlug);
      if (!r.changes) reinforceLearning(handle, contentHash);
      ids.push(r.changes ? r.lastInsertRowid : null);
    }
  });
  return ids;
}

/* ------------------------------------------------------------------ */
/* Visibility (the memory scope contract, plan §M)                     */
/* ------------------------------------------------------------------ */

// Rows held back from every reader: quarantined by status, or by the 3.0
// marker (applied_to 'quarantined…' on an 'active' row).
const NOT_QUARANTINED = (a) => `COALESCE(${a}applied_to, '') NOT LIKE 'quarantined%'`;

/** The project keys a reader is bound to: projectKeys, else [projectSlug], else null (internal listing). */
export function keysOf(opts = {}) {
  if (Array.isArray(opts.projectKeys)) return opts.projectKeys.filter((k) => typeof k === "string" && k);
  if (opts.projectSlug) return [opts.projectSlug];
  return null;
}

/**
 * SQL for "this learning may be served to a reader bound to `keys`".
 *   - a project row: project_slug IN keys
 *   - a row with no project (NULL slug): accepted as global (global_accepted_at
 *     set), or — 3.0's automatic globals, now "global pending" — its session
 *     belongs to one of keys
 *   scope 'project' → project rows; 'global' → accepted globals; 'any' → both.
 * Without keys (internal listings) only the quarantine rule applies.
 *
 * @returns {{sql: string, params: any[]}}
 */
export function learningVisibility(alias, keys, scope = "any") {
  const a = `${alias || "learnings"}.`;
  const notQ = NOT_QUARANTINED(a);
  if (keys === null) return { sql: notQ, params: [] };
  if (keys.length === 0) return { sql: "0", params: [] };
  const ph = keys.map(() => "?").join(",");
  const project = `${a}project_slug IN (${ph})`;
  const accepted = `(${a}project_slug IS NULL AND ${a}global_accepted_at IS NOT NULL)`;
  const pendingHere = `(${a}project_slug IS NULL AND ${a}global_accepted_at IS NULL AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = ${a}session_id AND s.project_slug IN (${ph})))`;
  if (scope === "project") return { sql: `${notQ} AND ${project}`, params: [...keys] };
  if (scope === "global") return { sql: `${notQ} AND ${accepted}`, params: [] };
  return { sql: `${notQ} AND (${project} OR ${accepted} OR ${pendingHere})`, params: [...keys, ...keys] };
}

/** SQL for "this user fact may be served to a reader bound to `keys`". */
export function factVisibility(alias, keys) {
  const a = `${alias || "user_facts"}.`;
  if (keys === null) return { sql: "1", params: [] };
  if (keys.length === 0) return { sql: "0", params: [] };
  const ph = keys.map(() => "?").join(",");
  return {
    sql: `(${a}global_accepted_at IS NOT NULL OR EXISTS (SELECT 1 FROM json_each(COALESCE(${a}projects, '[]')) WHERE value IN (${ph})))`,
    params: [...keys],
  };
}

/**
 * BM25 search over learnings via FTS5.
 *
 * @param {string} query                                     - free text
 * @param {{projectKeys?: string[], projectSlug?: string, scope?: 'project'|'global'|'any', limit?: number, status?: string}} [opts]
 * @returns {Promise<Array<{id: number, text: string, evidence: string|null, category: string, confidence: number, project_slug: string|null, created_at: string, score: number}>>}
 */
export async function searchLearnings(query, opts = {}) {
  const handle = await db();
  if (!handle) return [];

  const limit = opts.limit ?? 5;
  const keys = keysOf(opts);
  // A bound reader only ever sees active rows.
  const status = keys ? "active" : opts.status ?? "active";

  // FTS5 "MATCH" syntax — escape special chars by quoting tokens
  const safeQuery = sanitizeFtsQuery(query);
  if (!safeQuery) return [];

  const vis = learningVisibility("l", keys, opts.scope ?? "any");
  const where = `learnings_fts MATCH ? AND l.status = ? AND ${vis.sql}`;
  const params = [safeQuery, status, ...vis.params];

  // Freshness decay at rank time (non-destructive): bm25 score × a half-life
  // factor on the most recent of last_verified_at / last_retrieved_at /
  // created_at. 90-day half-life — stale rows lose rank but keep their data.
  // julianday() arithmetic keeps this deterministic SQL, no JS date math.
  // Ranking = BM25 relevance × 90-day freshness half-life × a small derivation
  // factor (directly-stated facts edge out inferred generalizations on ties).
  // Honcho-inspired, fully deterministic — no embeddings.
  const rows = handle.all(
    `SELECT l.id, l.text, l.evidence, l.category, l.confidence, l.project_slug, l.created_at, l.derivation,
            -bm25(learnings_fts) *
              pow(0.5, (julianday('now') - julianday(
                MAX(COALESCE(l.last_verified_at, l.created_at), COALESCE(l.last_retrieved_at, l.created_at))
              )) / 90.0) *
              (CASE WHEN l.derivation = 'inferred' THEN 0.9 ELSE 1.0 END)
              AS score
       FROM learnings_fts
       JOIN learnings l ON l.id = learnings_fts.rowid
      WHERE ${where}
      ORDER BY score DESC, l.confidence DESC
      LIMIT ?`,
    [...params, limit]
  );
  return rows;
}

/**
 * List the most-recent N learnings for a project.
 *
 * @param {{projectSlug?: string, limit?: number, category?: string}} [opts]
 */
export async function listRecentLearnings(opts = {}) {
  const handle = await db();
  if (!handle) return [];
  const limit = opts.limit ?? 10;
  const vis = learningVisibility("", keysOf(opts), opts.scope ?? "any");
  let where = `status = 'active' AND ${vis.sql}`;
  const params = [...vis.params];
  if (opts.category) {
    where += " AND category = ?";
    params.push(opts.category);
  }
  return handle.all(
    `SELECT id, category, text, evidence, confidence, project_slug, created_at
       FROM learnings
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ?`,
    [...params, limit]
  );
}

/**
 * Fetch full learnings by id — the "detail" layer of the progressive-disclosure
 * MCP flow (search returns compact IDs → memory_get fetches the full rows for
 * the few the agent kept). Returns un-clipped text + evidence + provenance
 * (session_id, created_at) + evolution counters. Order matches the input ids
 * is not guaranteed; rows come back id-ascending.
 *
 * A bound reader (projectKeys / projectSlug) gets only rows visible to it:
 * an id from another project returns nothing.
 *
 * @param {Array<number|string>} ids
 * @param {{limit?: number, projectKeys?: string[], projectSlug?: string}} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function getLearningsByIds(ids, opts = {}) {
  const handle = await db();
  if (!handle || !Array.isArray(ids)) return [];
  const cap = Math.min(20, Math.max(1, opts.limit ?? 20));
  const clean = [...new Set(ids.map(n => Number(n)).filter(Number.isInteger))].slice(0, cap);
  if (clean.length === 0) return [];
  const placeholders = clean.map(() => "?").join(",");
  const keys = keysOf(opts);
  const vis = keys ? learningVisibility("", keys) : { sql: "1", params: [] };
  return handle.all(
    `SELECT id, session_id, project_slug, category, text, evidence, confidence,
            observed_count, retrieval_count, usefulness, tags, applied_to, status,
            created_at, last_verified_at, derivation
       FROM learnings
      WHERE id IN (${placeholders})${keys ? ` AND status = 'active' AND ${vis.sql}` : ""}
      ORDER BY id ASC`,
    [...clean, ...vis.params]
  );
}

/**
 * Timeline around one learning — the "context" layer of progressive disclosure.
 * Resolves the learning's originating session, that session's metadata, and the
 * sibling learnings extracted from the same session (chronological). Lets the
 * agent see "what else was going on when this was learned" before deciding
 * whether to fetch full detail.
 *
 * @param {number|string} id
 * @param {{limit?: number}} [opts]
 * @returns {Promise<{learning: object, session: object|null, neighbors: object[]} | null>}
 */
export async function learningTimeline(id, opts = {}) {
  const handle = await db();
  if (!handle) return null;
  const lid = Number(id);
  if (!Number.isInteger(lid)) return null;
  const limit = Math.min(50, Math.max(1, opts.limit ?? 10));
  const keys = keysOf(opts);
  const vis = keys ? learningVisibility("", keys) : { sql: "1", params: [] };
  const nvis = learningVisibility("", keys);

  const learning = handle.get(
    `SELECT id, session_id, project_slug, category, text, confidence, created_at
       FROM learnings WHERE id = ?${keys ? ` AND status = 'active' AND ${vis.sql}` : ""} LIMIT 1`,
    [lid, ...vis.params]
  );
  if (!learning) return null;

  let session = null;
  let neighbors = [];
  if (learning.session_id) {
    session = handle.get(
      `SELECT id, project_slug, started_at, ended_at, digest_status, transcript_path
         FROM sessions WHERE id = ? LIMIT 1`,
      [learning.session_id]
    ) || null;
    neighbors = handle.all(
      `SELECT id, category, text, confidence, created_at
         FROM learnings
        WHERE session_id = ? AND id != ? AND status = 'active' AND ${nvis.sql}
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
      [learning.session_id, lid, ...nvis.params, limit]
    );
  }
  return { learning, session, neighbors };
}

/**
 * File-aware recall: find learnings whose `tags` reference a given file. The
 * digest pipeline tags each learning with the files in play that session
 * (normalized to forward slashes), so this matches either the full normalized
 * path or just the basename. Deterministic LIKE over the JSON-serialized tags
 * column — no FTS tokenizer surprises on paths with dots/slashes.
 *
 * @param {string} file                              - path or basename
 * @param {{projectSlug?: string, scope?: 'project'|'global'|'any', limit?: number, status?: string}} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function searchLearningsByFile(file, opts = {}) {
  const handle = await db();
  if (!handle || !file) return [];
  const limit = opts.limit ?? 5;
  const status = opts.status ?? "active";
  const norm = String(file).replace(/\\/g, "/").trim();
  if (!norm) return [];
  const base = norm.split("/").pop();

  const keys = keysOf(opts);
  const vis = learningVisibility("", keys, opts.scope ?? "any");
  // LIKE wildcards in the path are literal ("%" must not match every tagged row).
  const lit = (v) => v.replace(/[\\%_]/g, (c) => "\\" + c);
  const where = `tags IS NOT NULL AND (tags LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\') AND status = ? AND ${vis.sql}`;
  const params = [`%${lit(norm)}%`, `%"${lit(base)}"%`, keys ? "active" : status, ...vis.params];

  return handle.all(
    `SELECT id, category, text, evidence, confidence, project_slug, created_at, tags
       FROM learnings
      WHERE ${where}
      ORDER BY confidence DESC, created_at DESC
      LIMIT ?`,
    [...params, limit]
  );
}

/* ------------------------------------------------------------------ */
/* Skill executions (used by GEPA Stream B)                            */
/* ------------------------------------------------------------------ */

/**
 * Record a skill execution. The GEPA sampler reads from this table.
 *
 * @param {{
 *   sessionId: string,
 *   skillName: string,
 *   skillVersion?: string,
 *   triggerText?: string,
 *   succeeded?: boolean,
 *   failureReason?: string,
 *   tracePath?: string,
 *   invocationSource?: string,
 *   outcomeSource?: string,
 *   completedAt?: string
 * }} row
 */
export async function recordSkillExecution(row) {
  const handle = await db();
  if (!handle) return null;
  const succeeded = row.succeeded === undefined ? null : (row.succeeded ? 1 : 0);
  const r = handle.run(
    `INSERT INTO skill_executions
       (session_id, skill_name, skill_version, trigger_text, succeeded, failure_reason, trace_path, invocation_source, outcome_source, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.sessionId, row.skillName, row.skillVersion || null, row.triggerText ? redactSecrets(row.triggerText).text : null,
      succeeded, row.failureReason ? redactSecrets(row.failureReason).text : null, row.tracePath || null,
      row.invocationSource || null, row.outcomeSource || null, row.completedAt || null
    ]
  );
  return r.lastInsertRowid;
}

/**
 * Mark the latest unresolved skill invocation in a session as failed after a
 * high-confidence user correction. Unknown invocations remain NULL.
 */
export async function markRecentSkillFailure({ sessionId, failureReason, outcomeSource = "user-correction" }) {
  const handle = await db();
  if (!handle || !sessionId || !failureReason) return false;
  const r = handle.run(
    `UPDATE skill_executions
        SET succeeded = 0, failure_reason = ?, outcome_source = ?, completed_at = ?
      WHERE id = (
        SELECT id FROM skill_executions
         WHERE session_id = ? AND succeeded IS NULL
           AND created_at >= datetime('now', '-10 minutes')
         ORDER BY id DESC LIMIT 1
      )`,
    [redactSecrets(failureReason).text, outcomeSource, new Date().toISOString(), sessionId]
  );
  return r.changes > 0;
}

/**
 * Sample skill executions for GEPA — stratified by success/failure, recency-weighted.
 *
 * @param {{skillName: string, total: number}} opts
 * @returns {Promise<Array<{id: number, session_id: string, skill_name: string, succeeded: number|null, failure_reason: string|null, trigger_text: string|null, created_at: string}>>}
 */
export async function sampleSkillExecutions(opts) {
  const handle = await db();
  if (!handle) return [];
  return handle.all(
    `SELECT id, session_id, skill_name, succeeded, failure_reason, trigger_text,
            invocation_source, outcome_source, completed_at, created_at
       FROM skill_executions
      WHERE skill_name = ?
        AND created_at >= datetime('now', '-90 days')
      ORDER BY succeeded ASC, created_at DESC
      LIMIT ?`,
    [opts.skillName, opts.total]
  );
}

/* ------------------------------------------------------------------ */
/* Auto-evolve detection                                               */
/* ------------------------------------------------------------------ */

/**
 * Find skills with N+ recent failures that haven't been evolved yet.
 * Used by digest pipeline to auto-trigger GEPA evolution.
 *
 * @param {{ minFailures?: number, dayWindow?: number }} opts
 * @returns {Promise<Array<{skill_name: string, failure_count: number}>>}
 */
export async function findSkillsNeedingEvolution({ minFailures = 3, dayWindow = 30 } = {}) {
  const handle = await db();
  if (!handle) return [];
  return handle.all(
    `SELECT skill_name, COUNT(*) AS failure_count
       FROM skill_executions
      WHERE succeeded = 0
        AND created_at >= datetime('now', '-${dayWindow} days')
        AND skill_name NOT IN (
          SELECT DISTINCT skill_name FROM skill_variants
          WHERE created_at >= datetime('now', '-7 days')
        )
      GROUP BY skill_name
      HAVING COUNT(*) >= ?
      ORDER BY failure_count DESC`,
    [minFailures]
  );
}

/* ------------------------------------------------------------------ */
/* Stats (for doctor / analytics)                                      */
/* ------------------------------------------------------------------ */

export async function stats() {
  const handle = await db();
  if (!handle) return { driver: false };
  const counts = {};
  for (const t of ["sessions", "learnings", "skill_executions", "tool_calls", "user_facts", "skill_variants", "proposals"]) {
    counts[t] = handle.get(`SELECT COUNT(*) AS n FROM ${t}`).n;
  }

  // Retrieval telemetry aggregates (last 7 days) — best-effort on pre-migration DBs
  let retrieval = null;
  try {
    const r = handle.get(
      `SELECT COUNT(*) AS events,
              SUM(truncated) AS truncatedEvents,
              CAST(AVG(injected_bytes) AS INTEGER) AS avgInjectedBytes
         FROM retrieval_events
        WHERE ts >= datetime('now', '-7 days')`
    );
    if (r && r.events > 0) {
      retrieval = {
        events: r.events,
        truncatedEvents: r.truncatedEvents || 0,
        truncationRate: (r.truncatedEvents || 0) / r.events,
        avgInjectedBytes: r.avgInjectedBytes || 0
      };
    }
  } catch { /* table missing — fine */ }

  return { driver: true, dbPath: handle.path, counts, retrieval };
}

/* ------------------------------------------------------------------ */
/* user_facts — cross-project user profile                             */
/* ------------------------------------------------------------------ */

/**
 * Observe a user-profile fact. Upserts on content_hash: a re-observation
 * bumps observed_count + confidence and appends the project slug to the
 * provenance list. Facts observed in ≥2 distinct projects are surfaced by
 * `ad memory consolidate` as promotion candidates.
 *
 * @param {{
 *   category: string,        // 'identity' | 'preference' | 'tool' | 'anti-preference'
 *   text: string,
 *   evidence?: string,
 *   confidence?: number,
 *   sessionId?: string,
 *   projectSlug?: string
 * }} fact
 * @returns {Promise<{ id: number | null, observed: number, projects: string[] } | null>}
 */
export async function observeUserFact(input) {
  // Agent-written text never becomes a fact about the user.
  if (input.origin === "agent") return null;
  const handle = await db();
  if (!handle) return null;
  const fact = { ...input, text: redactSecrets(input.text).text, evidence: redactSecrets(input.evidence).text };
  const contentHash = learningContentHash(fact.text);
  const now = new Date().toISOString();

  const existing = handle.get(
    `SELECT id, observed_count, projects, confidence FROM user_facts
      WHERE content_hash = ? AND status = 'active' LIMIT 1`,
    [contentHash]
  );

  if (existing) {
    let projects = [];
    try { projects = JSON.parse(existing.projects || "[]"); } catch { /* reset */ }
    if (fact.projectSlug && !projects.includes(fact.projectSlug)) projects.push(fact.projectSlug);
    handle.run(
      `UPDATE user_facts
          SET observed_count = observed_count + 1,
              confidence = MIN(0.95, confidence + 0.05),
              last_observed_at = ?,
              projects = ?
        WHERE id = ?`,
      [now, JSON.stringify(projects), existing.id]
    );
    return { id: existing.id, observed: existing.observed_count + 1, projects };
  }

  const projects = fact.projectSlug ? [fact.projectSlug] : [];
  const r = handle.run(
    `INSERT INTO user_facts (category, text, evidence, confidence, source_session, observed_count, last_observed_at, projects, content_hash, origin)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      fact.category,
      fact.text,
      fact.evidence || null,
      fact.confidence ?? 0.5,
      fact.sessionId || null,
      now,
      JSON.stringify(projects),
      contentHash,
      fact.origin === "user" ? "user" : "unknown"
    ]
  );
  return { id: r.lastInsertRowid, observed: 1, projects };
}

/**
 * Top active user facts for SessionStart injection (tiny budget).
 *
 * @param {{ limit?: number }} [opts]
 */
export async function topUserFacts({ limit = 5, projectKeys, projectSlug } = {}) {
  const handle = await db();
  if (!handle) return [];
  const vis = factVisibility("", keysOf({ projectKeys, projectSlug }));
  return handle.all(
    `SELECT id, category, text, confidence, observed_count
       FROM user_facts WHERE status = 'active' AND ${vis.sql}
      ORDER BY confidence DESC, observed_count DESC
      LIMIT ?`,
    [...vis.params, limit]
  );
}

/** Learnings and user facts visible to a reader bound to projectKeys (memory_stats). */
export async function projectStats({ projectKeys }) {
  const handle = await db();
  if (!handle) return null;
  const keys = keysOf({ projectKeys }) ?? [];
  const lv = learningVisibility("", keys);
  const fv = factVisibility("", keys);
  return {
    learnings: handle.get(`SELECT COUNT(*) AS n FROM learnings WHERE status = 'active' AND ${lv.sql}`, lv.params).n,
    facts: handle.get(`SELECT COUNT(*) AS n FROM user_facts WHERE status = 'active' AND ${fv.sql}`, fv.params).n,
  };
}

/**
 * User facts visible to a reader bound to projectKeys (the MCP
 * `user_facts_list` tool): facts observed in one of those projects, or
 * accepted as global.
 */
export async function listUserFacts({ projectKeys, limit = 20 } = {}) {
  const handle = await db();
  if (!handle) return [];
  const vis = factVisibility("", keysOf({ projectKeys }) ?? []);
  return handle.all(
    `SELECT id, category, text, confidence, observed_count, last_observed_at
       FROM user_facts WHERE status = 'active' AND ${vis.sql}
      ORDER BY confidence DESC, observed_count DESC LIMIT ?`,
    [...vis.params, limit]
  );
}

/**
 * Record usefulness feedback on a learning the reader can see. An id from
 * another project (or a held-back row) changes nothing.
 *
 * usefulness is a running average in [-1, 1]: useful=+1, stale=-0.5, wrong=-1.
 *
 * @param {{id:number|string, verdict:"useful"|"stale"|"wrong", projectKeys:string[]}} opts
 * @returns {Promise<{changed:boolean}>}
 */
export async function recordFeedback({ id, verdict, projectKeys }) {
  const handle = await db();
  const lid = Number(id);
  if (!handle || !Number.isInteger(lid)) return { changed: false };
  const delta = verdict === "useful" ? 1 : verdict === "stale" ? -0.5 : verdict === "wrong" ? -1 : 0;
  if (!delta) return { changed: false };
  const vis = learningVisibility("", keysOf({ projectKeys }) ?? []);
  const r = handle.run(
    `UPDATE learnings
        SET usefulness = COALESCE((COALESCE(usefulness, 0) + ?) / 2.0, ?),
            last_verified_at = CASE WHEN ? > 0 THEN ? ELSE last_verified_at END
      WHERE id = ? AND status = 'active' AND ${vis.sql}`,
    [delta, delta, delta, new Date().toISOString(), lid, ...vis.params]
  );
  return { changed: r.changes > 0 };
}

/**
 * Build a deterministic "how this user works" representation — the no-LLM
 * analog of Honcho's dialectic/representation. Rolls up cross-project
 * `user_facts` plus high-confidence project learnings (preferring directly
 * stated 'explicit' facts) into a small structured profile. Pure data; callers
 * render + neutralize via representationToMarkdown.
 *
 * @param {{ projectSlug?: string, factLimit?: number, learningLimit?: number }} [opts]
 * @returns {Promise<{identity:string[],preferences:string[],tools:string[],conventions:string[],gotchas:string[],counts:object}|null>}
 */
export async function buildUserRepresentation({ projectSlug, projectKeys, factLimit = 8, learningLimit = 12 } = {}) {
  const handle = await db();
  if (!handle) return null;
  const keys = keysOf({ projectKeys, projectSlug });

  const fvis = factVisibility("", keys);
  const facts = handle.all(
    `SELECT category, text FROM user_facts WHERE status = 'active' AND ${fvis.sql}
      ORDER BY confidence DESC, observed_count DESC LIMIT ?`,
    [...fvis.params, factLimit]
  );

  const vis = learningVisibility("", keys);
  const where = `status = 'active' AND confidence >= 0.6 AND ${vis.sql}`;
  const params = [...vis.params];
  // Explicit (stated) facts first, then by confidence + reinforcement.
  const learnings = handle.all(
    `SELECT category, text FROM learnings
      WHERE ${where}
      ORDER BY (CASE WHEN derivation = 'explicit' THEN 1 ELSE 0 END) DESC,
               confidence DESC, observed_count DESC
      LIMIT ?`,
    [...params, learningLimit]
  );

  const profile = { identity: [], preferences: [], tools: [], conventions: [], gotchas: [], counts: {} };
  for (const f of facts) {
    if (f.category === "identity") profile.identity.push(f.text);
    else if (f.category === "tool") profile.tools.push(f.text);
    else if (f.category === "anti-preference") profile.preferences.push(`avoid: ${f.text}`);
    else profile.preferences.push(f.text);            // preference / project
  }
  for (const l of learnings) {
    if (l.category === "tool") profile.tools.push(l.text);
    else if (l.category === "gotcha") profile.gotchas.push(l.text);
    else if (l.category === "pattern" || l.category === "decision") profile.conventions.push(l.text);
    else profile.preferences.push(l.text);            // correction / fact / confirmation
  }
  for (const k of ["identity", "preferences", "tools", "conventions", "gotchas"]) {
    profile[k] = [...new Set(profile[k])].slice(0, 6);  // dedup + cap each bucket
  }
  profile.counts = { facts: facts.length, learnings: learnings.length };

  const total = profile.identity.length + profile.preferences.length +
                profile.tools.length + profile.conventions.length + profile.gotchas.length;
  return total > 0 ? profile : null;
}

/**
 * Render a representation profile to markdown. `compact` produces one line per
 * non-empty bucket (for the SessionStart budget); full produces a section per
 * bucket. Pass `neutralize` (e.g. sanitize.neutralizeText) so transcript-derived
 * text can't break out at the injection surface.
 *
 * @param {ReturnType<typeof buildUserRepresentation> extends Promise<infer T> ? T : never} profile
 * @param {{ compact?: boolean, neutralize?: (s: string) => string }} [opts]
 * @returns {string}
 */
export function representationToMarkdown(profile, { compact = false, neutralize = (s) => s } = {}) {
  if (!profile) return "";
  const clean = (t) => neutralize(String(t)).replace(/\s+/g, " ").trim();
  const sections = [
    ["Identity", profile.identity],
    ["Prefers", profile.preferences],
    ["Tools", profile.tools],
    ["Conventions", profile.conventions],
    ["Watch out", profile.gotchas]
  ];
  const lines = [];
  for (const [label, items] of sections) {
    if (!items || items.length === 0) continue;
    const shown = compact ? items.slice(0, 3) : items;
    if (compact) {
      lines.push(`- **${label}:** ${shown.map(clean).join("; ")}`);
    } else {
      lines.push(`### ${label}`);
      for (const t of shown) lines.push(`- ${clean(t)}`);
    }
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Retrieval telemetry (measurement-first — Phase 1)                   */
/* ------------------------------------------------------------------ */

/**
 * Record one retrieval decision (what was considered vs injected vs cut).
 *
 * @param {{
 *   sessionId?: string,
 *   cwd?: string,
 *   source: 'session-start' | 'query-retrieve',
 *   consideredBytes: number,
 *   injectedBytes: number,
 *   truncated: boolean,
 *   groups?: Array<{label: string, bytesIn: number, bytesKept: number, truncated: boolean}>
 * }} event
 */
export async function recordRetrievalEvent(event) {
  const handle = await db();
  if (!handle) return;
  handle.run(
    `INSERT INTO retrieval_events
       (session_id, project_slug, source, considered_bytes, injected_bytes, truncated, groups_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      event.sessionId || null,
      event.cwd ? projectSlug(event.cwd) : null,
      event.source,
      event.consideredBytes | 0,
      event.injectedBytes | 0,
      event.truncated ? 1 : 0,
      event.groups ? JSON.stringify(event.groups) : null
    ]
  );
}

/**
 * Retrieval write-back: bump retrieval_count + last_retrieved_at for learnings
 * that were actually injected. Feeds freshness-aware ranking.
 *
 * @param {number[]} ids
 */
export async function markRetrieved(ids) {
  const handle = await db();
  if (!handle || !ids || ids.length === 0) return;
  try {
    const now = new Date().toISOString();
    const stmt = `UPDATE learnings
                     SET retrieval_count = retrieval_count + 1,
                         last_retrieved_at = ?
                   WHERE id = ?`;
    handle.transaction(() => {
      for (const id of ids) handle.run(stmt, [now, id]);
    });
  } catch { /* evolution columns missing on a pre-migration DB — best-effort */ }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Normalize a project path into the slug we use as project_slug.
 * Same scheme Claude Code uses for ~/.claude/projects/<encoded>.
 */
export function projectSlug(absPath) {
  return path.normalize(absPath).replace(/[\\/:]/g, "-");
}

/**
 * FTS5 MATCH queries reject quotes/specials. Sanitize by extracting word-ish
 * tokens and OR-ing them. Returns null if nothing usable.
 *
 * @param {string} q
 */
function sanitizeFtsQuery(q) {
  if (!q) return null;
  const tokens = (q.match(/[\p{L}\p{N}_]{2,}/gu) || []).map(t => `"${t.replace(/"/g, '""')}"`);
  if (tokens.length === 0) return null;
  return tokens.join(" OR ");
}

/**
 * Record a capability route advice event. Kept separate from skill_executions
 * so GEPA failure sampling is not polluted by "recommended but not invoked" rows.
 *
 * @param {{
 *   sessionId: string,
 *   cwd: string,
 *   taskSize: string,
 *   recommendedCapability: string | null,
 *   explicit_agent?: boolean,
 *   explicit_constraint?: boolean,
 * }} event
 */
export async function recordRouteAdvice(event) {
  const handle = await db();
  if (!handle) return null;
  const slug = event.cwd ? projectSlug(event.cwd) : null;
  const capType = event.recommendedCapability ? "skill" : null;
  handle.run(
    `INSERT INTO skill_route_events
       (session_id, project_slug, task_size, prompt_intent, recommended_capability_type,
        recommended_capability, recommendation_source, explicit_agent_request, explicit_capability_constraint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.sessionId || "",
      slug,
      event.taskSize || null,
      event.promptIntent || null,
      capType,
      event.recommendedCapability || null,
      event.recommendationSource || "capability-route-advice",
      event.explicit_agent ? 1 : 0,
      event.explicit_constraint ? 1 : 0,
    ]
  );
}

/**
 * Correlate a skill invocation back to the route advice that recommended it.
 * Two passes: (1) exact match — the advice named this skill → "followed";
 * (2) any open advice in the window → "diverged" (a different skill ran).
 *
 * @param {{ sessionId: string, skillName: string, windowMinutes?: number }} opts
 * @returns {Promise<"followed" | "diverged" | null>}
 */
export async function correlateRouteInvocation({ sessionId, skillName, windowMinutes = 15 }) {
  const handle = await db();
  if (!handle || !sessionId || !skillName) return null;
  const now = new Date().toISOString();
  const window = `-${Math.max(1, windowMinutes | 0)} minutes`;

  const exact = handle.run(
    `UPDATE skill_route_events
        SET invoked_skill = ?, invoked_at = ?
      WHERE id = (
        SELECT id FROM skill_route_events
         WHERE session_id = ? AND invoked_skill IS NULL
           AND recommended_capability = ?
           AND created_at >= datetime('now', ?)
         ORDER BY id DESC LIMIT 1
      )`,
    [skillName, now, sessionId, skillName, window]
  );
  if (exact.changes > 0) return "followed";

  const diverged = handle.run(
    `UPDATE skill_route_events
        SET invoked_skill = ?, invoked_at = ?
      WHERE id = (
        SELECT id FROM skill_route_events
         WHERE session_id = ? AND invoked_skill IS NULL
           AND recommended_capability IS NOT NULL
           AND created_at >= datetime('now', ?)
         ORDER BY id DESC LIMIT 1
      )`,
    [skillName, now, sessionId, window]
  );
  return diverged.changes > 0 ? "diverged" : null;
}

/**
 * Advice effectiveness per skill: advised / followed / diverged / ignored.
 *
 * @param {{ days?: number }} [opts]
 * @returns {Promise<{ rows: Array<object>, totals: object, constraintOverrides: number }>}
 */
export async function routeAdviceStats({ days = 30 } = {}) {
  const handle = await db();
  if (!handle) return { rows: [], totals: { advised: 0, followed: 0, diverged: 0, ignored: 0 }, constraintOverrides: 0 };
  const since = `-${Math.max(1, days | 0)} days`;

  const rows = handle.all(
    `SELECT recommended_capability AS skill,
            COUNT(*) AS advised,
            SUM(CASE WHEN invoked_skill = recommended_capability THEN 1 ELSE 0 END) AS followed,
            SUM(CASE WHEN invoked_skill IS NOT NULL AND invoked_skill <> recommended_capability THEN 1 ELSE 0 END) AS diverged,
            SUM(CASE WHEN invoked_skill IS NULL THEN 1 ELSE 0 END) AS ignored
       FROM skill_route_events
      WHERE created_at >= datetime('now', ?) AND recommended_capability IS NOT NULL
      GROUP BY recommended_capability
      ORDER BY advised DESC`,
    [since]
  );

  const totals = rows.reduce(
    (a, r) => ({
      advised: a.advised + r.advised,
      followed: a.followed + r.followed,
      diverged: a.diverged + r.diverged,
      ignored: a.ignored + r.ignored
    }),
    { advised: 0, followed: 0, diverged: 0, ignored: 0 }
  );

  const constraintOverrides = handle.get(
    `SELECT COUNT(*) AS n FROM skill_route_events
      WHERE created_at >= datetime('now', ?) AND explicit_capability_constraint = 1`,
    [since]
  ).n;

  return { rows, totals, constraintOverrides };
}

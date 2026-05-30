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

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

let _db = null;
let _attempted = false;

/**
 * Get-or-open the singleton database. Returns null if better-sqlite3 isn't
 * installed (callers handle gracefully — the markdown side of digest still works).
 *
 * @returns {Promise<import("./sqlite.mjs").Db | null>}
 */
export async function db() {
  if (_db) return _db;
  if (_attempted) return null;
  _attempted = true;
  _db = await open();
  return _db;
}

/** Close the singleton (for tests). */
export function closeDb() {
  if (_db) { _db.close(); _db = null; _attempted = false; }
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

/* ------------------------------------------------------------------ */
/* Learnings                                                           */
/* ------------------------------------------------------------------ */

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
  const tagsJson = learning.tags ? JSON.stringify(learning.tags) : null;
  const contentHash = learningContentHash(learning.text);
  // INSERT OR IGNORE: same text from a different session collides on the
  // partial unique index `idx_learnings_content_hash` and is skipped
  // silently. (We use OR IGNORE instead of ON CONFLICT(col) because SQLite's
  // UPSERT requires a FULL unique constraint as the conflict target —
  // partial indexes don't qualify. OR IGNORE works with either.)
  const result = handle.run(
    `INSERT OR IGNORE INTO learnings (session_id, project_slug, category, text, evidence, confidence, tags, applied_to, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      learning.sessionId || null,
      learning.projectSlug || null,
      learning.category,
      learning.text,
      learning.evidence || null,
      learning.confidence ?? 0.5,
      tagsJson,
      learning.appliedTo || null,
      contentHash
    ]
  );
  // result.changes is 0 when ON CONFLICT skipped — return null to signal dedup.
  if (!result.changes) return null;
  return result.lastInsertRowid;
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
    for (const l of learnings) {
      const tagsJson = l.tags ? JSON.stringify(l.tags) : null;
      const contentHash = learningContentHash(l.text);
      const r = handle.run(
        `INSERT OR IGNORE INTO learnings (session_id, project_slug, category, text, evidence, confidence, tags, applied_to, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [l.sessionId || null, l.projectSlug || null, l.category, l.text, l.evidence || null, l.confidence ?? 0.5, tagsJson, l.appliedTo || null, contentHash]
      );
      // Push null for deduped (skipped) inserts so caller knows the count.
      ids.push(r.changes ? r.lastInsertRowid : null);
    }
  });
  return ids;
}

/**
 * BM25 search over learnings via FTS5.
 *
 * @param {string} query                                     - free text
 * @param {{projectSlug?: string, scope?: 'project'|'global'|'any', limit?: number, status?: string}} [opts]
 * @returns {Promise<Array<{id: number, text: string, evidence: string|null, category: string, confidence: number, project_slug: string|null, created_at: string, score: number}>>}
 */
export async function searchLearnings(query, opts = {}) {
  const handle = await db();
  if (!handle) return [];

  const limit = opts.limit ?? 5;
  const status = opts.status ?? "active";

  // FTS5 "MATCH" syntax — escape special chars by quoting tokens
  const safeQuery = sanitizeFtsQuery(query);
  if (!safeQuery) return [];

  let where = "learnings_fts MATCH ? AND l.status = ?";
  const params = [safeQuery, status];

  if (opts.projectSlug && opts.scope !== "global") {
    if (opts.scope === "project") {
      where += " AND l.project_slug = ?";
      params.push(opts.projectSlug);
    } else {
      // 'any' (default) — prefer project, fall back to global
      where += " AND (l.project_slug = ? OR l.project_slug IS NULL)";
      params.push(opts.projectSlug);
    }
  }

  const rows = handle.all(
    `SELECT l.id, l.text, l.evidence, l.category, l.confidence, l.project_slug, l.created_at,
            -bm25(learnings_fts) AS score
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
  let where = "status = 'active'";
  const params = [];
  if (opts.projectSlug) {
    where += " AND (project_slug = ? OR project_slug IS NULL)";
    params.push(opts.projectSlug);
  }
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
      row.sessionId, row.skillName, row.skillVersion || null, row.triggerText || null,
      succeeded, row.failureReason || null, row.tracePath || null,
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
    [failureReason, outcomeSource, new Date().toISOString(), sessionId]
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
  return { driver: true, dbPath: handle.path, counts };
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
       (session_id, project_slug, task_size, recommended_capability_type,
        recommended_capability, explicit_agent_request, explicit_capability_constraint)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      event.sessionId || "",
      slug,
      event.taskSize || null,
      capType,
      event.recommendedCapability || null,
      event.explicit_agent ? 1 : 0,
      event.explicit_constraint ? 1 : 0,
    ]
  );
}

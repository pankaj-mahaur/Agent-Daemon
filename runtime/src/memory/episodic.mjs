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
  // partial unique index `idx_learnings_content_hash` and is skipped.
  // (We use OR IGNORE instead of ON CONFLICT(col) because SQLite's
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
  // Hash collision = the same lesson re-observed in a later session — the
  // strongest confirmation signal we get. Reinforce instead of discarding.
  if (!result.changes) {
    reinforceLearning(handle, contentHash);
    return null;  // null still signals "dedup" to callers counting inserts
  }
  return result.lastInsertRowid;
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
    for (const l of learnings) {
      const tagsJson = l.tags ? JSON.stringify(l.tags) : null;
      const contentHash = learningContentHash(l.text);
      const r = handle.run(
        `INSERT OR IGNORE INTO learnings (session_id, project_slug, category, text, evidence, confidence, tags, applied_to, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [l.sessionId || null, l.projectSlug || null, l.category, l.text, l.evidence || null, l.confidence ?? 0.5, tagsJson, l.appliedTo || null, contentHash]
      );
      // Dedup = re-observation → reinforce confidence instead of discarding.
      if (!r.changes) reinforceLearning(handle, contentHash);
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

  // Freshness decay at rank time (non-destructive): bm25 score × a half-life
  // factor on the most recent of last_verified_at / last_retrieved_at /
  // created_at. 90-day half-life — stale rows lose rank but keep their data.
  // julianday() arithmetic keeps this deterministic SQL, no JS date math.
  const rows = handle.all(
    `SELECT l.id, l.text, l.evidence, l.category, l.confidence, l.project_slug, l.created_at,
            -bm25(learnings_fts) *
              pow(0.5, (julianday('now') - julianday(
                MAX(COALESCE(l.last_verified_at, l.created_at), COALESCE(l.last_retrieved_at, l.created_at))
              )) / 90.0)
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
export async function observeUserFact(fact) {
  const handle = await db();
  if (!handle) return null;
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
    `INSERT INTO user_facts (category, text, evidence, confidence, source_session, observed_count, last_observed_at, projects, content_hash)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    [
      fact.category,
      fact.text,
      fact.evidence || null,
      fact.confidence ?? 0.5,
      fact.sessionId || null,
      now,
      JSON.stringify(projects),
      contentHash
    ]
  );
  return { id: r.lastInsertRowid, observed: 1, projects };
}

/**
 * Top active user facts for SessionStart injection (tiny budget).
 *
 * @param {{ limit?: number }} [opts]
 */
export async function topUserFacts({ limit = 5 } = {}) {
  const handle = await db();
  if (!handle) return [];
  return handle.all(
    `SELECT id, category, text, confidence, observed_count
       FROM user_facts WHERE status = 'active'
      ORDER BY confidence DESC, observed_count DESC
      LIMIT ?`,
    [limit]
  );
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

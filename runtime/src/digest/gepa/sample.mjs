// GEPA Stage 1 — sample execution traces for a skill.
//
// Pulls past skill_executions rows from the episodic SQLite store, splits them
// into training (used by reflect+generate) and holdout (used by evaluate).
//
// Sampling strategy:
//   - Stratified by success/failure (~50/50 mix when both available).
//   - Recency-weighted: prefer the last ~30 days.
//   - Diversity: avoid duplicate trigger_text patterns.

/**
 * @typedef {Object} SkillTrace
 * @property {number} id
 * @property {string} sessionId
 * @property {string} skillName
 * @property {string} skillVersion
 * @property {string} triggerText
 * @property {boolean} succeeded
 * @property {string|null} failureReason
 * @property {Object[]} events             // ordered tool_calls + assistant turns from this skill's activation
 * @property {string} createdAt
 *
 * @typedef {Object} SampledTraces
 * @property {SkillTrace[]} training
 * @property {SkillTrace[]} holdout
 */

/**
 * @param {{skillName: string, sampleSize: number, holdoutSize: number, source: string}} opts
 * @returns {Promise<SampledTraces>}
 */
export async function sampleTraces(opts) {
  // v0.1 stub: returns empty arrays since SQLite read isn't wired.
  // v0.2 implementation:
  //
  //   const db = openDb();
  //   const total = opts.sampleSize + opts.holdoutSize;
  //   const rows = db.prepare(`
  //     SELECT * FROM skill_executions
  //     WHERE skill_name = ?
  //       AND created_at >= date('now', '-90 days')
  //     ORDER BY succeeded ASC, created_at DESC
  //     LIMIT ?
  //   `).all(opts.skillName, total);
  //
  //   // For each row, fetch the associated events from messages + tool_calls
  //   const traces = await Promise.all(rows.map(async row => ({
  //     ...row,
  //     events: await fetchSkillEvents(row.session_id, row.created_at)
  //   })));
  //
  //   // Stratified split — failures over-represented in training so we learn from them
  //   const failures = traces.filter(t => !t.succeeded);
  //   const successes = traces.filter(t => t.succeeded);
  //   const trainingTarget = Math.min(opts.sampleSize, traces.length);
  //   const training = stratifiedSample([failures, successes], trainingTarget, [0.6, 0.4]);
  //   const holdout = traces.filter(t => !training.includes(t)).slice(0, opts.holdoutSize);
  //
  //   return { training, holdout };

  if (opts.source === "synthetic") {
    // Future: synthesize traces from a description for cold-start.
    return { training: [], holdout: [] };
  }

  return { training: [], holdout: [] };
}

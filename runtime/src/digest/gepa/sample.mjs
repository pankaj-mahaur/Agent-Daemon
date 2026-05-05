// GEPA Stage 1 — sample execution traces for a skill.
//
// Pulls past skill_executions rows from the SQLite store and splits them
// into training (used by reflect+generate) and holdout (used by evaluate).

import { sampleSkillExecutions } from "../../memory/episodic.mjs";

/**
 * @typedef {Object} SkillTrace
 * @property {number} id
 * @property {string} sessionId
 * @property {string} skillName
 * @property {string|null} skillVersion
 * @property {string|null} triggerText
 * @property {boolean|null} succeeded
 * @property {string|null} failureReason
 * @property {string} createdAt
 *
 * @typedef {Object} SampledTraces
 * @property {SkillTrace[]} training
 * @property {SkillTrace[]} holdout
 * @property {Object} stats         - { total, successes, failures }
 */

/**
 * @param {{
 *   skillName: string,
 *   sampleSize?: number,        - target training size (default 20)
 *   holdoutSize?: number,       - target holdout size (default 10)
 *   source?: 'sessiondb' | 'synthetic'
 * }} opts
 * @returns {Promise<SampledTraces>}
 */
export async function sampleTraces(opts) {
  const sampleSize  = opts.sampleSize ?? 20;
  const holdoutSize = opts.holdoutSize ?? 10;

  if (opts.source === "synthetic") {
    return { training: [], holdout: [], stats: { total: 0, successes: 0, failures: 0 } };
  }

  const total = sampleSize + holdoutSize;
  const rows = await sampleSkillExecutions({ skillName: opts.skillName, total });

  // Normalize to SkillTrace shape
  const traces = rows.map(r => ({
    id: r.id,
    sessionId: r.session_id,
    skillName: r.skill_name,
    skillVersion: null,
    triggerText: r.trigger_text,
    succeeded: r.succeeded === null ? null : r.succeeded === 1,
    failureReason: r.failure_reason,
    createdAt: r.created_at
  }));

  const failures  = traces.filter(t => t.succeeded === false);
  const successes = traces.filter(t => t.succeeded === true);
  const unknowns  = traces.filter(t => t.succeeded === null);

  // Stratified split — failures over-represented in training (60%)
  // because we want the reflect step to focus on what went wrong.
  const trainFailureTarget = Math.ceil(sampleSize * 0.6);
  const trainSuccessTarget = sampleSize - trainFailureTarget;

  const trainFailures  = failures.slice(0, trainFailureTarget);
  const trainSuccesses = successes.slice(0, trainSuccessTarget);
  const training = [...trainFailures, ...trainSuccesses, ...unknowns].slice(0, sampleSize);

  // Holdout = remaining traces (those not in training)
  const trainingIds = new Set(training.map(t => t.id));
  const holdout = traces.filter(t => !trainingIds.has(t.id)).slice(0, holdoutSize);

  return {
    training,
    holdout,
    stats: { total: traces.length, successes: successes.length, failures: failures.length }
  };
}

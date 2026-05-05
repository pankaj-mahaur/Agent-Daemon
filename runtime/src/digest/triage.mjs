// Triage gate.
// Decides whether a session is worth running through the full digest pipeline.
// Cheap heuristics over a normalized transcript summary — no LLM call.

/**
 * @typedef {import("../adapters/claude-code.mjs").TranscriptSummary} TranscriptSummary
 *
 * @typedef {Object} TriageResult
 * @property {boolean} shouldDigest
 * @property {string} reason          - human-readable rationale ("edits + turns", "duration", "below threshold")
 * @property {Object} signals         - the raw signals consulted (for logging / tuning)
 */

const COMPLETION_REGEX = /\b(done|finished|complete|completed|shipped|merged|nice|perfect|thanks|thank you|great|works|works now)\b/i;

const FIVE_MINUTES_MS = 5 * 60 * 1000;

/**
 * Apply triage rules to a transcript summary.
 *
 * Trigger if any of:
 *   - (edits >= 1 AND user turns >= 2)
 *   - tool_calls >= 8
 *   - duration >= 5 minutes
 *   - last user message contains a "completion" word (done, finished, etc.)
 *
 * @param {TranscriptSummary} summary
 * @returns {TriageResult}
 */
export function triage(summary) {
  const signals = {
    userTurns:    summary.userTurns,
    edits:        summary.edits,
    toolCalls:    summary.toolCalls,
    durationMs:   summary.durationMs,
    durationMins: +(summary.durationMs / 60000).toFixed(1),
    lastUserMatch: COMPLETION_REGEX.test(summary.lastUserText || "")
  };

  // Rule 1: meaningful work — at least one edit AND a back-and-forth conversation
  if (summary.edits >= 1 && summary.userTurns >= 2) {
    return { shouldDigest: true, reason: `edits ≥ 1 AND user turns ≥ 2 (edits=${summary.edits}, turns=${summary.userTurns})`, signals };
  }

  // Rule 2: many tool calls = substantial work even if no edits (research session, debugging)
  if (summary.toolCalls >= 8) {
    return { shouldDigest: true, reason: `tool calls ≥ 8 (got ${summary.toolCalls})`, signals };
  }

  // Rule 3: long duration = real engagement
  if (summary.durationMs >= FIVE_MINUTES_MS) {
    return { shouldDigest: true, reason: `duration ≥ 5min (got ${signals.durationMins}min)`, signals };
  }

  // Rule 4: completion language — even short sessions may have a useful "thanks, that worked"
  if (signals.lastUserMatch && summary.userTurns >= 1) {
    return { shouldDigest: true, reason: `completion phrase in last user message ("${(summary.lastUserText || "").slice(0, 40)}…")`, signals };
  }

  return {
    shouldDigest: false,
    reason: `below threshold — turns=${summary.userTurns} edits=${summary.edits} tools=${summary.toolCalls} duration=${signals.durationMins}min`,
    signals
  };
}

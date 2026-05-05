// GEPA Stage 5 — Pareto frontier selection.
//
// Multi-objective optimization. A variant is on the Pareto frontier if no
// other variant dominates it across all objectives. We then break ties on
// quality (higher better) within the frontier.

/**
 * @typedef {import("./evaluate.mjs").ScoredVariant} ScoredVariant
 */

/**
 * Pick winners from a set of scored variants.
 *
 * Pareto rule: variant A dominates B if A is >= B on every objective AND
 * strictly > B on at least one. The frontier is the set of variants that
 * are not dominated by any other.
 *
 * Constraint: variants where compat=0 OR testPass=0 are excluded outright.
 *
 * Tie-break: within the frontier, sort by (quality DESC, size ASC).
 *
 * @param {ScoredVariant[]} scored
 * @param {string} parentBody
 * @returns {ScoredVariant[]}
 */
export function paretoSelect(scored, parentBody) {
  // Filter out invalid variants
  const valid = scored.filter(v => v.scores.compat === 1 && v.scores.testPass === 1);
  if (valid.length === 0) return [];

  // Variants must beat or tie the parent's baseline on quality.
  const parentBaseline = valid[0]?.parentBaseline ?? 0;
  const candidates = valid.filter(v => v.scores.quality >= parentBaseline);
  if (candidates.length === 0) return [];

  // Pareto frontier
  const frontier = candidates.filter(a =>
    !candidates.some(b => b !== a && dominates(b, a))
  );

  // Sort: quality desc, then size asc (smaller is better when quality is tied)
  frontier.sort((a, b) => {
    if (b.scores.quality !== a.scores.quality) {
      return b.scores.quality - a.scores.quality;
    }
    return a.scores.size - b.scores.size;
  });

  return frontier;
}

/**
 * Does variant a dominate variant b?
 *
 * a dominates b iff:
 *   - a.quality  >= b.quality
 *   - a.size     <= b.size  (smaller better)
 *   - a.compat   >= b.compat
 *   - a.testPass >= b.testPass
 * AND at least one of those is strict.
 *
 * @param {ScoredVariant} a
 * @param {ScoredVariant} b
 * @returns {boolean}
 */
function dominates(a, b) {
  const allWeakBetter =
    a.scores.quality  >= b.scores.quality  &&
    a.scores.size     <= b.scores.size     &&
    a.scores.compat   >= b.scores.compat   &&
    a.scores.testPass >= b.scores.testPass;
  if (!allWeakBetter) return false;
  return (
    a.scores.quality  >  b.scores.quality  ||
    a.scores.size     <  b.scores.size     ||
    a.scores.compat   >  b.scores.compat   ||
    a.scores.testPass >  b.scores.testPass
  );
}

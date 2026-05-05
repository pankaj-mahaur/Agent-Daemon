// GEPA Stage 4 — evaluate each variant against held-out traces.
//
// For each variant, we score against four objectives:
//   - quality: simulated task success rate when the held-out trigger replays
//   - size:    char count of the body (smaller is better, all else equal)
//   - compat:  syntactic + frontmatter validity (1 or 0)
//   - testPass: schema validation, no banned phrases, etc. (1 or 0)
//
// "Quality" requires actually running the skill on the held-out triggers. v0.2
// wires this to a headless `claude` simulator that role-plays the skill body
// against each holdout user message.

/**
 * @typedef {Object} VariantScores
 * @property {number} quality        - 0.0–1.0 task success on held-out
 * @property {number} size           - char count of body
 * @property {number} compat         - 1 = compatible, 0 = breaks (frontmatter / format)
 * @property {number} testPass       - 1 = passes lint/schema, 0 = fails
 *
 * @typedef {Object} ScoredVariant
 * @property {string} variantId
 * @property {string} body
 * @property {string[]} addresses
 * @property {VariantScores} scores
 * @property {number} parentBaseline - parent's quality score on same holdout (for delta display)
 */

/**
 * @param {{
 *   variants: import("./generate.mjs").Variant[],
 *   holdoutTraces: import("./sample.mjs").SkillTrace[],
 *   parentBody: string,
 *   verbose?: boolean
 * }} opts
 * @returns {Promise<ScoredVariant[]>}
 */
export async function evaluateVariants(opts) {
  // v0.1 stub: returns the variants with placeholder scores. v0.2 implements
  // the actual replay-against-holdout-and-grade loop.
  //
  // v0.2 implementation:
  //
  //   const parentBaseline = await scoreVariantOnHoldout(opts.parentBody, opts.holdoutTraces);
  //
  //   const scored = await Promise.all(opts.variants.map(async v => {
  //     const compat = checkFrontmatterCompat(v.body) ? 1 : 0;
  //     const testPass = runSkillTests(v.body) ? 1 : 0;
  //     // skip running quality eval if variant is broken
  //     const quality = (compat && testPass)
  //       ? await scoreVariantOnHoldout(v.body, opts.holdoutTraces)
  //       : 0;
  //     return {
  //       variantId: v.variantId,
  //       body: v.body,
  //       addresses: v.addresses,
  //       scores: { quality, size: v.body.length, compat, testPass },
  //       parentBaseline
  //     };
  //   }));
  //
  //   return scored;

  return opts.variants.map(v => ({
    variantId: v.variantId,
    body: v.body,
    addresses: v.addresses,
    scores: { quality: 0, size: v.body.length, compat: 1, testPass: 1 },
    parentBaseline: 0
  }));
}

/**
 * v0.2 — Replay each holdout trace against a candidate body via headless claude.
 * Compute success rate. Held private until v0.2 wiring lands.
 *
 * Algorithm sketch:
 *   for trace of holdout:
 *     simulate = await claudeHeadless({ systemPromptAddition: candidateBody, userMessage: trace.triggerText })
 *     score = grade(simulate, trace.expectedOutcome)  // requires "expected outcome" field on traces
 *   return mean(score)
 */

/**
 * v0.2 — Sanity checks on a candidate body before quality eval.
 * Catches: malformed frontmatter, missing required sections, banned phrases.
 */
export function checkFrontmatterCompat(body) {
  // v0.1: minimal — just verify it looks like markdown.
  return typeof body === "string" && body.length > 0;
}

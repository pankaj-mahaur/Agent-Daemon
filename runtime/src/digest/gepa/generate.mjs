// GEPA Stage 3 — generate candidate variants of the skill body.
//
// Each variant addresses one or more of the reflected failure modes. We
// generate K variants in a single multi-call to amortize the prompt overhead.

import crypto from "node:crypto";

/**
 * @typedef {Object} Variant
 * @property {string} variantId      - hash-derived id
 * @property {string} body           - candidate skill body
 * @property {string[]} addresses    - failure mode titles this variant targets
 * @property {string} rationale      - the model's stated reasoning for the change
 */

const GENERATE_PROMPT = `You are evolving the skill "{{skillName}}" based on a reflection report.

You will produce K candidate variants of the skill body. Each variant targets one or more of the failure modes listed in the reflection.

Constraints:
- Preserve the YAML frontmatter EXACTLY. Only the body (after the closing ---) may change.
- Stay under {{maxBodyChars}} chars per variant body.
- Don't introduce new external dependencies in the variant.
- Each variant should be RECOGNIZABLY the same skill — same purpose, same triggers, same general procedure. The variant is a sharpening, not a rewrite.

Output JSON of shape:
{
  "variants": [
    {
      "variantId": "auto",  // we'll compute the hash
      "body": "...",         // full body markdown (after the closing ---)
      "addresses": ["failure-mode-title-1", "failure-mode-title-2"],
      "rationale": "1-2 sentence reasoning"
    }
  ]
}

Diversity is valuable — the K variants should NOT all address the same failure mode. Spread coverage.`;

/**
 * @param {{
 *   skillName: string,
 *   parentBody: string,
 *   reflections: import("./reflect.mjs").Reflections,
 *   count: number,
 *   verbose?: boolean
 * }} opts
 * @returns {Promise<Variant[]>}
 */
export async function generateVariants(opts) {
  // v0.1 stub: returns an empty list. v0.2 wires headless `claude`.
  //
  // v0.2 implementation:
  //
  //   const maxBodyChars = Math.max(opts.parentBody.length * 1.2, 4000);
  //   const prompt = GENERATE_PROMPT
  //     .replace("{{skillName}}", opts.skillName)
  //     .replace("{{maxBodyChars}}", String(Math.floor(maxBodyChars)));
  //
  //   const userMessage = JSON.stringify({
  //     parent: opts.parentBody,
  //     reflections: opts.reflections,
  //     count: opts.count
  //   }, null, 2);
  //
  //   const json = await callClaudeHeadless({
  //     systemPromptAddition: prompt,
  //     userMessage,
  //     outputFormat: "json"
  //   });
  //
  //   const parsed = JSON.parse(json.result);
  //   return parsed.variants.map(v => ({
  //     ...v,
  //     variantId: hashOf(v.body)
  //   }));

  return [];
}

/**
 * sha256 hash of a body string, hex-encoded, first 12 chars (collision-safe enough
 * within a single evolution run).
 *
 * @param {string} body
 * @returns {string}
 */
export function hashOf(body) {
  return crypto.createHash("sha256").update(body, "utf8").digest("hex").slice(0, 12);
}

export { GENERATE_PROMPT };

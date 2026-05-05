// GEPA Stage 4 — evaluate candidate variants via LLM-as-judge.
//
// For each variant we get four scores:
//   - quality   — LLM-judge over (addresses_failures, preserves_purpose, clarity)
//   - size      — char count of body (smaller is better)
//   - compat    — frontmatter validity / format check (1 or 0)
//   - testPass  — schema validation, no banned phrases (1 or 0)
//
// v0.3: LLM-as-judge over a single call per variant. v0.4 will replace this
// with real trace-replay grading. K=4 variants × 1 call = 4 evaluator calls
// per evolution run; ~$0.02 at Haiku rates.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { callHeadlessClaude } from "../../claude.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const EVALUATE_PROMPT_PATH = path.join(__dirname, "prompts", "evaluate.md");

const EVALUATE_SCHEMA = {
  type: "object",
  properties: {
    addresses_failures: { type: "number", minimum: 0, maximum: 1 },
    preserves_purpose:  { type: "number", minimum: 0, maximum: 1 },
    clarity:            { type: "number", minimum: 0, maximum: 1 },
    overall:            { type: "number", minimum: 0, maximum: 1 },
    rationale:          { type: "string", maxLength: 500 }
  },
  required: ["addresses_failures", "preserves_purpose", "clarity", "overall"]
};

/**
 * @typedef {import("./generate.mjs").Variant} Variant
 * @typedef {import("./reflect.mjs").Reflections} Reflections
 *
 * @typedef {Object} VariantScores
 * @property {number} quality
 * @property {number} size
 * @property {number} compat
 * @property {number} testPass
 *
 * @typedef {Object} ScoredVariant
 * @property {string} variantId
 * @property {string} body
 * @property {string[]} addresses
 * @property {string} rationale
 * @property {VariantScores} scores
 * @property {number} parentBaseline
 * @property {string} [judgeRationale]
 */

/**
 * @param {{
 *   variants: Variant[],
 *   parentBody: string,
 *   skillName: string,
 *   reflections: Reflections,
 *   model?: string,
 *   maxBudgetUsd?: number,
 *   verbose?: boolean
 * }} opts
 * @returns {Promise<{ok: boolean, scored: ScoredVariant[], parentBaseline: number, totalCostUsd: number, error?: string}>}
 */
export async function evaluateVariants(opts) {
  // First, score the parent so we have a baseline
  const parentScore = await scoreOne({
    candidate: opts.parentBody,
    candidateLabel: "PARENT",
    parentBody: opts.parentBody,
    skillName: opts.skillName,
    reflections: opts.reflections,
    model: opts.model,
    maxBudgetUsd: opts.maxBudgetUsd,
    verbose: opts.verbose
  });
  const parentBaseline = parentScore.ok ? parentScore.overall : 0.5;
  let totalCost = parentScore.costUsd || 0;

  // Then score each candidate
  const scored = [];
  for (const v of opts.variants) {
    const compat   = checkCompat(v.body) ? 1 : 0;
    const testPass = checkTestPass(v.body) ? 1 : 0;

    let quality = 0;
    let judgeRationale = "skipped (compat or testPass = 0)";
    if (compat && testPass) {
      const s = await scoreOne({
        candidate: v.body,
        candidateLabel: `VARIANT ${v.variantId}`,
        parentBody: opts.parentBody,
        skillName: opts.skillName,
        reflections: opts.reflections,
        model: opts.model,
        maxBudgetUsd: opts.maxBudgetUsd,
        verbose: opts.verbose
      });
      if (s.ok) {
        quality = s.overall;
        judgeRationale = s.rationale;
        totalCost += s.costUsd || 0;
      } else {
        judgeRationale = `evaluator error: ${s.error}`;
      }
    }

    scored.push({
      variantId: v.variantId,
      body: v.body,
      addresses: v.addresses,
      rationale: v.rationale,
      scores: { quality, size: v.body.length, compat, testPass },
      parentBaseline,
      judgeRationale
    });
  }

  return { ok: true, scored, parentBaseline, totalCostUsd: totalCost };
}

async function scoreOne({ candidate, candidateLabel, parentBody, skillName, reflections, model, maxBudgetUsd, verbose }) {
  const userMessage = [
    `# Skill name`,
    skillName,
    "",
    `# Identifier`,
    candidateLabel,
    "",
    "# Parent body",
    "",
    "```markdown",
    parentBody,
    "```",
    "",
    "# Candidate body to score",
    "",
    "```markdown",
    candidate,
    "```",
    "",
    "# Reflection (failure modes the candidate should address)",
    "",
    JSON.stringify(reflections, null, 2)
  ].join("\n");

  const result = await callHeadlessClaude({
    systemPromptFile: EVALUATE_PROMPT_PATH,
    userMessage,
    model: model || "haiku",
    fallbackModel: "sonnet",
    jsonSchema: EVALUATE_SCHEMA,
    maxBudgetUsd: maxBudgetUsd ?? 0.05,
    timeoutMs: 60_000,
    verbose
  });

  if (!result.ok || !result.parsedJson) {
    return { ok: false, error: result.error || "no JSON" };
  }
  const j = result.parsedJson;
  const overall = typeof j.overall === "number"
    ? j.overall
    : (j.addresses_failures + j.preserves_purpose + j.clarity) / 3;
  return {
    ok: true,
    addresses_failures: j.addresses_failures,
    preserves_purpose: j.preserves_purpose,
    clarity: j.clarity,
    overall,
    rationale: j.rationale || "",
    costUsd: result.costUsd
  };
}

/**
 * Cheap structural check — does it look like a valid skill body?
 *
 * @param {string} body
 */
export function checkCompat(body) {
  if (typeof body !== "string" || body.length < 50) return false;
  // Banned: starts with frontmatter (variant should NOT include it — generate prompt forbids it)
  if (/^\s*---\s*\n/.test(body)) return false;
  return true;
}

/**
 * Cheap content checks — banned phrases, length sanity.
 *
 * @param {string} body
 */
export function checkTestPass(body) {
  // Reject common LLM-failure shapes
  if (/^I cannot|^I'm sorry/im.test(body)) return false;
  if (/As an AI language model/i.test(body)) return false;
  return true;
}

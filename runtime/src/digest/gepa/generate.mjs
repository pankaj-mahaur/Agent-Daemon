// GEPA Stage 3 — generate K candidate variants of the skill body via headless claude.

import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { callHeadlessClaude } from "../../claude.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const GENERATE_PROMPT_PATH = path.join(__dirname, "prompts", "generate.md");

/**
 * @typedef {Object} Variant
 * @property {string} variantId
 * @property {string} body
 * @property {string[]} addresses
 * @property {string} rationale
 */

function buildSchema(maxCount, maxBodyChars) {
  return {
    type: "object",
    properties: {
      variants: {
        type: "array",
        minItems: 1,
        maxItems: maxCount,
        items: {
          type: "object",
          properties: {
            body:      { type: "string", minLength: 100, maxLength: maxBodyChars },
            addresses: { type: "array", items: { type: "string" }, maxItems: 10 },
            rationale: { type: "string", maxLength: 400 }
          },
          required: ["body", "addresses", "rationale"]
        }
      }
    },
    required: ["variants"]
  };
}

/**
 * @param {{
 *   skillName: string,
 *   parentBody: string,
 *   reflections: import("./reflect.mjs").Reflections,
 *   count?: number,
 *   model?: string,
 *   maxBudgetUsd?: number,
 *   verbose?: boolean
 * }} opts
 * @returns {Promise<{ok: boolean, variants?: Variant[], error?: string, costUsd?: number}>}
 */
export async function generateVariants(opts) {
  const count = opts.count ?? 4;
  const maxBodyChars = Math.floor(Math.max(opts.parentBody.length * 1.2, 4000));

  const userMessage = renderUserMessage({
    skillName: opts.skillName,
    parentBody: opts.parentBody,
    reflections: opts.reflections,
    count,
    maxBodyChars
  });

  const result = await callHeadlessClaude({
    systemPromptFile: GENERATE_PROMPT_PATH,
    userMessage,
    model: opts.model || "haiku",
    fallbackModel: "sonnet",
    jsonSchema: buildSchema(count, maxBodyChars),
    maxBudgetUsd: opts.maxBudgetUsd ?? 0.20,
    timeoutMs: 120_000,
    verbose: opts.verbose
  });

  if (!result.ok || !result.parsedJson?.variants) {
    return { ok: false, error: result.error || "no variants parsed" };
  }

  const variants = result.parsedJson.variants.map(v => ({
    variantId: hashOf(v.body),
    body: v.body,
    addresses: Array.isArray(v.addresses) ? v.addresses : [],
    rationale: v.rationale || ""
  }));

  return { ok: true, variants, costUsd: result.costUsd };
}

function renderUserMessage({ skillName, parentBody, reflections, count, maxBodyChars }) {
  const failureModesBlock = reflections.failureModes.length === 0
    ? "_(no failure modes identified — your variants should focus on clarity / size reductions)_"
    : reflections.failureModes.map((fm, i) =>
        `### Failure mode ${i + 1}: ${fm.title}\n${fm.description}\n**Fix direction:** ${fm.fix_direction}`
      ).join("\n\n");

  const successBlock = reflections.successPatterns.length === 0
    ? ""
    : "## Success patterns to preserve\n\n" +
      reflections.successPatterns.map(p => `- ${p.pattern}`).join("\n") + "\n\n";

  return [
    `# Skill name`,
    skillName,
    "",
    `# Generation parameters`,
    `- Variants to produce (K): ${count}`,
    `- Max body chars per variant: ${maxBodyChars}`,
    "",
    "# Parent skill body",
    "",
    "```markdown",
    parentBody,
    "```",
    "",
    "# Reflection summary",
    "",
    reflections.summary,
    "",
    successBlock,
    "## Failure modes the variants should address",
    "",
    failureModesBlock,
    ""
  ].join("\n");
}

export function hashOf(body) {
  return crypto.createHash("sha256").update(body, "utf8").digest("hex").slice(0, 12);
}

// GEPA Stage 2 — reflect on success/failure traces via headless claude.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { callHeadlessClaude } from "../../claude.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REFLECT_PROMPT_PATH = path.join(__dirname, "prompts", "reflect.md");

/**
 * @typedef {Object} FailureMode
 * @property {string} title
 * @property {string} description
 * @property {string[]} evidence
 * @property {string} fix_direction
 *
 * @typedef {Object} SuccessPattern
 * @property {string} pattern
 * @property {string[]} evidence
 *
 * @typedef {Object} Reflections
 * @property {FailureMode[]} failureModes
 * @property {SuccessPattern[]} successPatterns
 * @property {string} summary
 */

const REFLECT_SCHEMA = {
  type: "object",
  properties: {
    failureModes: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          title:         { type: "string", maxLength: 80 },
          description:   { type: "string", maxLength: 500 },
          evidence:      { type: "array", items: { type: "string" }, maxItems: 20 },
          fix_direction: { type: "string", maxLength: 400 }
        },
        required: ["title", "description", "fix_direction"]
      }
    },
    successPatterns: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          pattern:  { type: "string", maxLength: 300 },
          evidence: { type: "array", items: { type: "string" }, maxItems: 20 }
        },
        required: ["pattern"]
      }
    },
    summary: { type: "string", maxLength: 500 }
  },
  required: ["failureModes", "successPatterns", "summary"]
};

/**
 * @param {{
 *   skillName: string,
 *   parentBody: string,
 *   traces: import("./sample.mjs").SkillTrace[],
 *   model?: string,
 *   maxBudgetUsd?: number,
 *   verbose?: boolean
 * }} opts
 * @returns {Promise<{ok: boolean, reflections?: Reflections, error?: string, costUsd?: number}>}
 */
export async function reflectOnTraces(opts) {
  if (!opts.traces || opts.traces.length === 0) {
    return { ok: true, reflections: { failureModes: [], successPatterns: [], summary: "No traces to reflect on." } };
  }

  const userMessage = renderUserMessage(opts.parentBody, opts.traces);

  const result = await callHeadlessClaude({
    systemPromptFile: REFLECT_PROMPT_PATH,
    userMessage,
    model: opts.model || "haiku",
    fallbackModel: "sonnet",
    jsonSchema: REFLECT_SCHEMA,
    maxBudgetUsd: opts.maxBudgetUsd ?? 0.10,
    timeoutMs: 60_000,
    verbose: opts.verbose
  });

  if (!result.ok || !result.parsedJson) {
    return { ok: false, error: result.error || "no parsed reflection JSON" };
  }

  // Replace {{SKILL_NAME}} substitution — we did it at userMessage level since
  // append-system-prompt doesn't get template-substituted.
  return { ok: true, reflections: result.parsedJson, costUsd: result.costUsd };
}

function renderUserMessage(parentBody, traces) {
  const lines = [
    "# Parent skill body",
    "",
    "```markdown",
    parentBody,
    "```",
    "",
    "# Trace set",
    ""
  ];
  for (const t of traces) {
    const status = t.succeeded === true ? "✓ succeeded" : t.succeeded === false ? "✗ failed" : "? unknown";
    lines.push(`## Trace ${t.id} (${status}) — ${t.createdAt}`);
    if (t.triggerText) lines.push(`Trigger: ${truncate(t.triggerText, 300)}`);
    if (t.failureReason) lines.push(`Failure reason: ${truncate(t.failureReason, 300)}`);
    lines.push("");
  }
  return lines.join("\n");
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

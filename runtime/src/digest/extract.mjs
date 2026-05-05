// Digest pipeline — Stage 2: extract candidate learnings from a transcript.
//
// Calls headless `claude` (--bare --print --output-format json) with:
//   - the extract.md prompt as appended system prompt
//   - a compact transcript rendering as the user message
//   - JSON Schema validation for structured output
//
// Returns the parsed `{ learnings: [...] }` object plus metadata (cost, duration).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { callHeadlessClaude } from "../claude.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTRACT_PROMPT_PATH = path.join(__dirname, "prompts", "extract.md");

/**
 * JSON schema the extractor must produce. Used to enforce structured output
 * via the `--json-schema` flag.
 */
const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    learnings: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          type:             { type: "string", enum: ["correction", "confirmation", "pattern", "tool"] },
          text:             { type: "string", minLength: 10, maxLength: 800 },
          evidence_quote:   { type: "string", maxLength: 240 },
          evidence_speaker: { type: "string", enum: ["user", "agent"] },
          scope:            { type: "string", enum: ["project", "global"] },
          confidence:       { type: "number", minimum: 0, maximum: 1 },
          tags:             { type: "array", items: { type: "string" }, maxItems: 8 }
        },
        required: ["type", "text", "evidence_quote", "evidence_speaker", "scope", "confidence"]
      }
    },
    session_summary: { type: "string", maxLength: 400 },
    skip_reason:     { type: ["string", "null"] }
  },
  required: ["learnings", "session_summary"]
};

/**
 * Render a transcript summary into the user message we feed the extractor.
 * Trims aggressively to fit the context budget — long transcripts get
 * truncated by keeping the structure but dropping mid-message bodies.
 *
 * @param {import("../adapters/claude-code.mjs").TranscriptSummary} summary
 * @param {{maxBytes?: number}} [opts]
 * @returns {string}
 */
export function renderTranscriptForExtraction(summary, opts = {}) {
  const maxBytes = opts.maxBytes ?? 200_000;  // ~50K tokens — well under any model's limit
  const lines = [];

  lines.push("# Session metadata");
  lines.push("");
  lines.push(`- Session id: ${summary.sessionId || "unknown"}`);
  lines.push(`- Started: ${summary.startTime?.toISOString() || "unknown"}`);
  lines.push(`- Duration: ${(summary.durationMs / 60000).toFixed(1)} minutes`);
  lines.push(`- User turns: ${summary.userTurns}`);
  lines.push(`- Assistant turns: ${summary.assistantTurns}`);
  lines.push(`- Tool calls: ${summary.toolCalls} (edits: ${summary.edits})`);
  lines.push("");
  lines.push("# Transcript");
  lines.push("");

  // Walk events in order, render compact entries
  let bytesUsed = lines.join("\n").length;
  for (const e of summary.events) {
    const block = renderEvent(e);
    if (!block) continue;
    if (bytesUsed + block.length > maxBytes) {
      lines.push("");
      lines.push(`(transcript truncated — ${summary.events.length - lines.filter(l => l.startsWith("##")).length} more events omitted)`);
      break;
    }
    lines.push(block);
    bytesUsed += block.length + 1;
  }

  return lines.join("\n");
}

function renderEvent(e) {
  const text = (e.text || "").trim();
  if (!text) return null;

  // Trim long bodies — keep structure visible without dumping huge tool outputs
  const trimmed = text.length > 1500 ? text.slice(0, 750) + " […trimmed…] " + text.slice(-300) : text;

  switch (e.type) {
    case "user":
      return `## USER\n\n${trimmed}\n`;
    case "assistant":
      return `## ASSISTANT\n\n${trimmed}\n`;
    case "tool_use":
      return `### TOOL_USE [${e.tool || "?"}]\n\n${trimmed.slice(0, 400)}\n`;
    case "tool_result":
      return `### TOOL_RESULT\n\n${trimmed.slice(0, 400)}\n`;
    default:
      return null;
  }
}

/**
 * @typedef {Object} Learning
 * @property {string} type           - 'correction' | 'confirmation' | 'pattern' | 'tool'
 * @property {string} text
 * @property {string} evidence_quote
 * @property {string} evidence_speaker
 * @property {string} scope
 * @property {number} confidence
 * @property {string[]} [tags]
 *
 * @typedef {Object} ExtractResult
 * @property {boolean} ok
 * @property {Learning[]} learnings
 * @property {string} sessionSummary
 * @property {string|null} skipReason
 * @property {number} [costUsd]
 * @property {number} [durationMs]
 * @property {string} [error]
 */

/**
 * Run the extraction step against a transcript summary.
 *
 * @param {{
 *   summary: import("../adapters/claude-code.mjs").TranscriptSummary,
 *   model?: string,
 *   maxBudgetUsd?: number,
 *   verbose?: boolean
 * }} opts
 * @returns {Promise<ExtractResult>}
 */
export async function extractLearnings(opts) {
  const userMessage = renderTranscriptForExtraction(opts.summary);

  const callResult = await callHeadlessClaude({
    systemPromptFile: EXTRACT_PROMPT_PATH,
    userMessage,
    model: opts.model || "haiku",  // cheap model is fine for this; can override
    fallbackModel: "sonnet",
    jsonSchema: EXTRACT_SCHEMA,
    maxBudgetUsd: opts.maxBudgetUsd ?? 0.20,
    timeoutMs: 90_000,
    verbose: opts.verbose
  });

  if (!callResult.ok) {
    return {
      ok: false,
      learnings: [],
      sessionSummary: "",
      skipReason: null,
      error: callResult.error
    };
  }

  const parsed = callResult.parsedJson;
  if (!parsed) {
    return {
      ok: false,
      learnings: [],
      sessionSummary: "",
      skipReason: null,
      error: callResult.error || "extractor produced no parsed JSON"
    };
  }

  return {
    ok: true,
    learnings: Array.isArray(parsed.learnings) ? parsed.learnings : [],
    sessionSummary: parsed.session_summary || "",
    skipReason: parsed.skip_reason || null,
    costUsd: callResult.costUsd,
    durationMs: callResult.durationMs
  };
}

export { EXTRACT_SCHEMA };

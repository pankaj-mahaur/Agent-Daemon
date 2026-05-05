// Digest pipeline — Stage 2: extract learnings from the agent's own digest block.
//
// v0.4 architecture: the AGENT itself emits a <agent-daemon-digest> JSON block
// near the end of its final assistant message. We parse that block directly
// from the transcript — no separate LLM call, no API key required.
//
// The agent learns the format from constitution/ending-protocol.md (loaded
// into every session by the SessionStart hook). The agent-self-improve skill
// reinforces it.
//
// Fallback: if no block is found AND ANTHROPIC_API_KEY is set AND
// AGENT_DAEMON_FALLBACK_LLM=1, we can call headless claude as before. By
// default we just return empty learnings and skip silently.

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
 * @property {string} [source]       - 'agent-emitted' | 'llm-fallback' | 'none'
 * @property {number} [costUsd]
 * @property {number} [durationMs]
 * @property {string} [error]
 */

/**
 * Tag pattern matches the agent-emitted digest block. Tolerant of whitespace
 * inside tags. Must contain valid JSON between the tags.
 */
const DIGEST_BLOCK_RE = /<agent-daemon-digest>\s*([\s\S]*?)\s*<\/agent-daemon-digest>/i;

const VALID_TYPES   = new Set(["correction", "confirmation", "pattern", "tool"]);
const VALID_SPEAKERS = new Set(["user", "agent"]);
const VALID_SCOPES   = new Set(["project", "global"]);

/**
 * Run the extraction step. New default: parse the agent's own digest block.
 *
 * @param {{
 *   summary: import("../adapters/claude-code.mjs").TranscriptSummary,
 *   verbose?: boolean,
 *   fallbackToLlm?: boolean
 * }} opts
 * @returns {Promise<ExtractResult>}
 */
export async function extractLearnings(opts) {
  const fromAgent = extractFromAgentBlock(opts.summary);
  if (fromAgent.found) {
    if (opts.verbose) console.error(`agent-daemon: extracted ${fromAgent.learnings.length} learning(s) from agent-emitted digest block`);
    return {
      ok: true,
      learnings: fromAgent.learnings,
      sessionSummary: fromAgent.sessionSummary,
      skipReason: null,
      source: "agent-emitted"
    };
  }

  if (opts.verbose) console.error(`agent-daemon: no <agent-daemon-digest> block found in transcript`);

  // Optional LLM fallback (off by default — preserves zero-API-key promise)
  if (opts.fallbackToLlm || process.env.AGENT_DAEMON_FALLBACK_LLM === "1") {
    if (opts.verbose) console.error(`agent-daemon: falling back to LLM extraction (AGENT_DAEMON_FALLBACK_LLM=1)`);
    return await extractWithLlm(opts);
  }

  return {
    ok: true,
    learnings: [],
    sessionSummary: "",
    skipReason: "no agent-emitted digest block found in transcript (agent did not follow ending-protocol)",
    source: "none"
  };
}

/**
 * Walk the transcript's assistant messages in reverse order; the most-recent
 * digest block wins. Search inside `text` content of each event.
 *
 * @param {import("../adapters/claude-code.mjs").TranscriptSummary} summary
 * @returns {{found: boolean, learnings: Learning[], sessionSummary: string, parseError?: string}}
 */
export function extractFromAgentBlock(summary) {
  const empty = { found: false, learnings: [], sessionSummary: "" };
  if (!summary?.events) return empty;

  // Walk assistant messages in reverse
  for (let i = summary.events.length - 1; i >= 0; i--) {
    const ev = summary.events[i];
    if (ev.type !== "assistant") continue;
    const text = ev.text || "";
    const m = text.match(DIGEST_BLOCK_RE);
    if (!m) continue;

    let parsed;
    try {
      parsed = JSON.parse(m[1]);
    } catch (err) {
      // malformed — log and continue searching for an earlier valid block
      return { ...empty, found: false, parseError: `last digest block failed to parse: ${err.message}` };
    }

    const learnings = sanitizeLearnings(parsed.learnings);
    return {
      found: true,
      learnings,
      sessionSummary: typeof parsed.session_summary === "string" ? parsed.session_summary : ""
    };
  }
  return empty;
}

/**
 * Validate + coerce raw learnings array. Drops invalid entries silently.
 *
 * @param {unknown} raw
 * @returns {Learning[]}
 */
function sanitizeLearnings(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 16)) {  // hard cap to avoid pathological blocks
    if (!item || typeof item !== "object") continue;
    const type = String(item.type || "").trim();
    if (!VALID_TYPES.has(type)) continue;
    const text = String(item.text || "").trim();
    if (text.length < 5 || text.length > 1500) continue;
    const evidence_quote = String(item.evidence_quote || "").slice(0, 400);
    const evidence_speaker = VALID_SPEAKERS.has(item.evidence_speaker) ? item.evidence_speaker : "user";
    const scope = VALID_SCOPES.has(item.scope) ? item.scope : "project";
    const confidence = clampNum(item.confidence, 0, 1, 0.5);
    const tags = Array.isArray(item.tags) ? item.tags.filter(t => typeof t === "string").slice(0, 12) : [];
    out.push({ type, text, evidence_quote, evidence_speaker, scope, confidence, tags });
  }
  return out;
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Optional LLM fallback path. Only fires if AGENT_DAEMON_FALLBACK_LLM=1
 * (or opts.fallbackToLlm=true). Requires ANTHROPIC_API_KEY.
 *
 * Loaded lazily so the module doesn't pull claude.mjs into every digest.
 *
 * @returns {Promise<ExtractResult>}
 */
async function extractWithLlm(opts) {
  try {
    const [{ callHeadlessClaude }, path, fileURLToPath] = await Promise.all([
      import("../claude.mjs"),
      import("node:path").then(m => m.default || m),
      import("node:url").then(m => m.fileURLToPath || m.default?.fileURLToPath)
    ]);
    const { dirname } = path;
    const __filename = fileURLToPath(import.meta.url);
    const promptPath = dirname(__filename) + "/prompts/extract.md";

    // Render compact transcript
    const userMessage = renderTranscriptForExtraction(opts.summary);
    const result = await callHeadlessClaude({
      systemPromptFile: promptPath,
      userMessage,
      model: "haiku",
      fallbackModel: "sonnet",
      maxBudgetUsd: 0.20,
      timeoutMs: 90_000,
      verbose: opts.verbose
    });
    if (!result.ok || !result.parsedJson) {
      return { ok: false, learnings: [], sessionSummary: "", skipReason: null, source: "llm-fallback", error: result.error };
    }
    return {
      ok: true,
      learnings: sanitizeLearnings(result.parsedJson.learnings),
      sessionSummary: result.parsedJson.session_summary || "",
      skipReason: result.parsedJson.skip_reason || null,
      source: "llm-fallback",
      costUsd: result.costUsd,
      durationMs: result.durationMs
    };
  } catch (err) {
    return { ok: false, learnings: [], sessionSummary: "", skipReason: null, source: "llm-fallback", error: err.message };
  }
}

function renderTranscriptForExtraction(summary, maxBytes = 200_000) {
  const lines = [
    "# Session", "",
    `- Turns: ${summary.userTurns}/${summary.assistantTurns}`,
    `- Tool calls: ${summary.toolCalls} (edits: ${summary.edits})`,
    `- Duration: ${(summary.durationMs / 60000).toFixed(1)}min`,
    "", "# Transcript", ""
  ];
  let bytes = lines.join("\n").length;
  for (const e of summary.events) {
    const block = renderEvent(e);
    if (!block) continue;
    if (bytes + block.length > maxBytes) {
      lines.push("(transcript truncated)");
      break;
    }
    lines.push(block);
    bytes += block.length + 1;
  }
  return lines.join("\n");
}

function renderEvent(e) {
  const text = (e.text || "").trim();
  if (!text) return null;
  const trimmed = text.length > 1500 ? text.slice(0, 750) + " […trimmed…] " + text.slice(-300) : text;
  switch (e.type) {
    case "user":         return `## USER\n\n${trimmed}\n`;
    case "assistant":    return `## ASSISTANT\n\n${trimmed}\n`;
    case "tool_use":     return `### TOOL_USE [${e.tool || "?"}]\n\n${trimmed.slice(0, 400)}\n`;
    case "tool_result":  return `### TOOL_RESULT\n\n${trimmed.slice(0, 400)}\n`;
    default:             return null;
  }
}

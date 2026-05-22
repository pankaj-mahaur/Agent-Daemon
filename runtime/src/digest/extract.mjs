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
 * Tag pattern matches the agent-emitted digest block. Tolerant of:
 *   - hyphen OR colon between "agent-daemon" and "digest" (Claude drifts)
 *   - whitespace inside the tags
 *   - JSON OR YAML payload inside the tags
 *
 * Real-world transcripts show ~50% of emitted blocks use the colon form
 * (<agent-daemon:digest>) and YAML payloads. The lenient parser recovers
 * both.
 */
const DIGEST_BLOCK_RE = /<agent-daemon[-:]digest>\s*([\s\S]*?)\s*<\/agent-daemon[-:]digest>/i;
const DIGEST_BLOCK_RE_GLOBAL = /<agent-daemon[-:]digest>\s*([\s\S]*?)\s*<\/agent-daemon[-:]digest>/gi;

const VALID_TYPES   = new Set(["correction", "confirmation", "pattern", "tool", "gotcha", "decision"]);
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
 * PARSEABLE digest block wins. If the most-recent block fails to parse
 * (common when the agent references the tag in dialogue afterward — e.g.
 * `<agent-daemon-digest>...</agent-daemon-digest>` with literal three dots
 * as a placeholder), keep walking earlier turns instead of giving up.
 *
 * Real-world transcripts contain this failure mode regularly: the agent
 * emits the real block in turn N, then in turn N+1 talks ABOUT the digest
 * and quotes the tag with a placeholder. The reverse walk hits the
 * placeholder first; before this change, that aborted extraction entirely.
 *
 * @param {import("../adapters/claude-code.mjs").TranscriptSummary} summary
 * @returns {{found: boolean, learnings: Learning[], sessionSummary: string, parseError?: string}}
 */
export function extractFromAgentBlock(summary) {
  const empty = { found: false, learnings: [], sessionSummary: "" };
  if (!summary?.events) return empty;

  // Walk assistant messages in reverse; within each turn, take the LAST block
  // (the agent may have iterated on the digest mid-message).
  let lastParseError = null;
  for (let i = summary.events.length - 1; i >= 0; i--) {
    const ev = summary.events[i];
    if (ev.type !== "assistant") continue;
    const text = ev.text || "";
    const allMatches = [...text.matchAll(DIGEST_BLOCK_RE_GLOBAL)];
    if (allMatches.length === 0) continue;
    const m = allMatches[allMatches.length - 1];

    const parsed = parseDigestPayload(m[1]);
    if (!parsed.ok) {
      // Malformed — remember the error for diagnostics, but keep walking
      // earlier turns. Yesterday's failure mode: turn N+1 contains the
      // tag in a placeholder/illustration; turn N has the real block.
      lastParseError = parsed.error;
      continue;
    }

    const learnings = sanitizeLearnings(parsed.value.learnings);
    return {
      found: true,
      learnings,
      sessionSummary: typeof parsed.value.session_summary === "string" ? parsed.value.session_summary : ""
    };
  }
  // No turn yielded a parseable block. Surface the last failure (if any)
  // so the caller can include it in verbose logs.
  if (lastParseError) {
    return { ...empty, found: false, parseError: `no parseable digest block found; last attempt: ${lastParseError}` };
  }
  return empty;
}

/**
 * Validate + coerce raw learnings array. Drops invalid entries silently.
 *
 * Schema drift handling (Claude doesn't always follow the ending-protocol):
 *
 *   1. `text` may be missing; accept `lessons` as a synonym. Seen in the
 *      wild as `{"lessons": "..."}` entries for prose-form takeaways with
 *      no other fields.
 *
 *   2. `type` may be missing or set to a categorical label (e.g.
 *      "projectbrief", "systemPatterns", "techContext"). When the schema
 *      uses `tag` (singular) instead of one of our canonical VALID_TYPES,
 *      treat it as a hint, default `type` to "pattern", and push the
 *      tag value into `tags[]` so the categorical signal is preserved
 *      for downstream search.
 *
 * Real-world failure that motivated this: mobiux-website session
 * 2026-05-21 emitted 8 entries with `tag`/`text` shape and 4 with just
 * `lessons` — all 12 got dropped silently before this change.
 *
 * @param {unknown} raw
 * @returns {Learning[]}
 */
function sanitizeLearnings(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 16)) {  // hard cap to avoid pathological blocks
    if (!item || typeof item !== "object") continue;

    // Accept text from `text` or `lessons` (Claude's prose-takeaway drift)
    const text = String(item.text || item.lessons || "").trim();
    if (text.length < 5 || text.length > 1500) continue;

    // Accept type as-is; fall back to "pattern" when the entry carries a
    // `tag`/`lessons` hint (clearly intentional, just off-schema). If the
    // entry has neither a valid type nor a tag/lessons hint, it's noise.
    let type = String(item.type || "").trim();
    if (!VALID_TYPES.has(type)) {
      if (item.tag || item.lessons) {
        type = "pattern";
      } else {
        continue;
      }
    }

    const evidence_quote = String(item.evidence_quote || "").slice(0, 400);
    const evidence_speaker = VALID_SPEAKERS.has(item.evidence_speaker) ? item.evidence_speaker : "user";
    const scope = VALID_SCOPES.has(item.scope) ? item.scope : "project";
    const confidence = clampNum(item.confidence, 0, 1, 0.5);

    // Merge the `tag` (singular string) and `tags` (array) drift forms into
    // one deduped array. Order: singular tag first (more specific), then tags array.
    const tagsFromArray  = Array.isArray(item.tags) ? item.tags.filter(t => typeof t === "string") : [];
    const tagsFromString = (typeof item.tag === "string" && item.tag.trim()) ? [item.tag.trim()] : [];
    const tags = [...new Set([...tagsFromString, ...tagsFromArray])].slice(0, 12);

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
 * Parse the inside of a digest block. Try JSON first, then a tolerant YAML
 * parse for the shape Claude commonly emits when it drifts from the spec.
 *
 * Public-ish — exported so tests can pin behavior on both forms.
 *
 * @param {string} raw
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function parseDigestPayload(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return { ok: false, error: "empty payload" };

  // Strip Markdown code fences if Claude wrapped the payload in ```json / ```yaml
  const unfenced = trimmed.replace(/^```(?:json|yaml|yml)?\s*\n([\s\S]*?)\n```\s*$/i, "$1").trim();

  // Looks like JSON?
  if (unfenced.startsWith("{") || unfenced.startsWith("[")) {
    try {
      const v = JSON.parse(unfenced);
      return { ok: true, value: v };
    } catch (err) {
      // Fall through to YAML — sometimes Claude emits unquoted keys / single quotes
    }
  }

  const yamlParsed = tryParseSimpleYaml(unfenced);
  if (yamlParsed.ok) return yamlParsed;

  // Last-resort: try JSON again on the raw payload (after fence strip)
  try {
    return { ok: true, value: JSON.parse(unfenced) };
  } catch (err) {
    return { ok: false, error: yamlParsed.error || err.message };
  }
}

/**
 * Minimal YAML parser for the digest block schema. Handles the predictable
 * shape Claude emits:
 *
 *   learnings:
 *     - type: pattern
 *       text: "..."
 *       evidence_quote: "..."
 *       evidence_speaker: user
 *       scope: project
 *       confidence: 0.7
 *       tags: [a, b]
 *   session_summary: "..."
 *
 * Not a general YAML parser — only enough to recover real-world digest blocks
 * without adding a dependency.
 *
 * @param {string} raw
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
function tryParseSimpleYaml(raw) {
  const lines = raw.split(/\r?\n/);

  /** @type {object} */
  const result = { learnings: [], session_summary: "" };
  let mode = "top"; // top | learnings | item
  /** @type {object|null} */
  let currentItem = null;

  const closeItem = () => {
    if (currentItem) {
      result.learnings.push(currentItem);
      currentItem = null;
    }
  };

  try {
    for (let raw of lines) {
      // Strip comments
      const commentIdx = indexOfYamlComment(raw);
      let line = commentIdx >= 0 ? raw.slice(0, commentIdx) : raw;
      if (!line.trim()) continue;

      const indent = line.length - line.trimStart().length;
      const stripped = line.trim();

      if (mode === "top" || mode === "learnings" || mode === "item") {
        // List-item start under learnings
        if (stripped.startsWith("- ")) {
          closeItem();
          currentItem = {};
          mode = "item";
          // The same line may carry the first key, e.g. "- type: pattern"
          const rest = stripped.slice(2).trim();
          if (rest.includes(":")) {
            assignKv(currentItem, rest);
          }
          continue;
        }
      }

      // `learnings:` start
      if (/^learnings\s*:\s*(?:\[\s*\])?\s*$/i.test(stripped)) {
        closeItem();
        mode = "learnings";
        continue;
      }

      // `session_summary: ...`
      const sumMatch = stripped.match(/^session_summary\s*:\s*(.*)$/i);
      if (sumMatch && indent === 0) {
        closeItem();
        result.session_summary = unquoteScalar(sumMatch[1]);
        mode = "top";
        continue;
      }

      // Generic `key: value` inside the current item
      if (mode === "item" && currentItem && /^[a-z_][a-z0-9_]*\s*:/i.test(stripped)) {
        assignKv(currentItem, stripped);
        continue;
      }

      // Top-level `key: value` (e.g. session_summary on its own line + indented body)
      if (mode === "top" && /^[a-z_][a-z0-9_]*\s*:/i.test(stripped)) {
        // ignore unrecognized top-level keys — be lenient
        continue;
      }
    }
    closeItem();

    if (!Array.isArray(result.learnings) || result.learnings.length === 0) {
      return { ok: false, error: "no learnings found in YAML payload" };
    }
    return { ok: true, value: result };
  } catch (err) {
    return { ok: false, error: `YAML parse failed: ${err.message}` };
  }
}

function indexOfYamlComment(line) {
  // Find a `#` that isn't inside quotes. Naive but adequate for digest blocks.
  let inSingle = false, inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return i;
    }
  }
  return -1;
}

function assignKv(obj, kvLine) {
  const m = kvLine.match(/^([a-z_][a-z0-9_]*)\s*:\s*(.*)$/i);
  if (!m) return;
  const key = m[1];
  const valRaw = m[2].trim();
  obj[key] = coerceScalar(valRaw);
}

function coerceScalar(raw) {
  if (raw === "" || raw === "~" || raw.toLowerCase() === "null") return null;
  // Inline list: [a, b, c]
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map(s => unquoteScalar(s.trim())).filter(s => s !== "");
  }
  // Numbers
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  // Booleans
  if (/^(true|false)$/i.test(raw)) return /^true$/i.test(raw);
  return unquoteScalar(raw);
}

function unquoteScalar(s) {
  if (!s) return "";
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
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

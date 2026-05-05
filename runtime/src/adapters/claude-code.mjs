// Claude Code transcript JSONL adapter.
// Parses session transcripts written by Claude Code at
// ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
//
// Each JSONL line is one event. We normalize to a small schema the digest
// pipeline can reason about regardless of which agent wrote the file.

import fs from "node:fs/promises";

/**
 * @typedef {Object} NormalizedEvent
 * @property {string} type         - "user" | "assistant" | "tool_use" | "tool_result" | "system" | "other"
 * @property {string} [tool]       - tool name (for tool_use)
 * @property {string} [text]       - human-readable text content
 * @property {string} [timestamp]  - ISO timestamp if available
 * @property {Object} [raw]        - original line for debugging
 */

/**
 * @typedef {Object} TranscriptSummary
 * @property {string|null} sessionId
 * @property {number} userTurns       - count of user messages
 * @property {number} assistantTurns  - count of assistant messages
 * @property {number} toolCalls       - total tool uses
 * @property {number} edits           - count of Edit + Write + NotebookEdit
 * @property {number} reads           - count of Read + Glob + Grep
 * @property {Date|null} startTime
 * @property {Date|null} endTime
 * @property {number} durationMs      - 0 if no timestamps
 * @property {string} lastUserText    - last user message text (for triage regex matches)
 * @property {NormalizedEvent[]} events
 */

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch"]);

/**
 * Parse one JSONL line and return a NormalizedEvent.
 * Returns null for lines that don't match a known shape (corrupted, future-format).
 *
 * @param {string} line
 * @returns {NormalizedEvent | null}
 */
export function parseLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }

  // Claude Code's JSONL has variable shapes across versions. Be permissive.
  // Common observed shapes:
  //   { type: "user", message: { content: "..." }, timestamp }
  //   { type: "assistant", message: { content: [...] }, timestamp }
  //   { type: "tool_use", name: "Bash", input: {...}, timestamp }
  //   { type: "tool_result", tool_use_id: "...", content: "...", timestamp }
  //   Plus variants where message.role is the discriminator.

  const timestamp = obj.timestamp || obj.created_at || obj.time || null;

  // User message
  if (obj.type === "user" || obj.role === "user" || obj.message?.role === "user") {
    return {
      type: "user",
      text: stringifyContent(obj.message?.content ?? obj.content),
      timestamp,
      raw: obj
    };
  }

  // Assistant message
  if (obj.type === "assistant" || obj.role === "assistant" || obj.message?.role === "assistant") {
    return {
      type: "assistant",
      text: stringifyContent(obj.message?.content ?? obj.content),
      timestamp,
      raw: obj
    };
  }

  // Tool use
  if (obj.type === "tool_use" || obj.tool_use || obj.message?.content?.some?.(c => c.type === "tool_use")) {
    const toolUse = obj.message?.content?.find?.(c => c.type === "tool_use") || obj;
    return {
      type: "tool_use",
      tool: toolUse.name || obj.name || obj.tool || "unknown",
      text: safeStringify(toolUse.input || obj.input),
      timestamp,
      raw: obj
    };
  }

  // Tool result
  if (obj.type === "tool_result" || obj.tool_result || obj.message?.content?.some?.(c => c.type === "tool_result")) {
    return {
      type: "tool_result",
      text: stringifyContent(obj.message?.content ?? obj.content),
      timestamp,
      raw: obj
    };
  }

  // System / meta
  if (obj.type === "system" || obj.type === "summary" || obj.type === "compact_summary") {
    return {
      type: "system",
      text: stringifyContent(obj.summary ?? obj.content ?? obj.message?.content),
      timestamp,
      raw: obj
    };
  }

  return { type: "other", text: null, timestamp, raw: obj };
}

/**
 * Coerce a content field that may be string, array of content blocks, or null
 * into a single string.
 *
 * @param {unknown} content
 * @returns {string}
 */
function stringifyContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === "string") return block;
        if (block?.type === "text") return block.text || "";
        if (block?.type === "tool_use") return `[tool_use:${block.name}]`;
        if (block?.type === "tool_result") return typeof block.content === "string" ? block.content : safeStringify(block.content);
        return safeStringify(block);
      })
      .join("\n");
  }
  return safeStringify(content);
}

function safeStringify(v) {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Read a JSONL transcript file and produce a normalized summary.
 *
 * @param {string} transcriptPath
 * @param {{sessionId?: string}} [opts]
 * @returns {Promise<TranscriptSummary>}
 */
export async function summarize(transcriptPath, opts = {}) {
  const raw = await fs.readFile(transcriptPath, "utf8");
  const lines = raw.split("\n").filter(l => l.trim().length > 0);

  /** @type {NormalizedEvent[]} */
  const events = [];
  for (const line of lines) {
    const e = parseLine(line);
    if (e) events.push(e);
  }

  const userEvents      = events.filter(e => e.type === "user");
  const assistantEvents = events.filter(e => e.type === "assistant");
  const toolEvents      = events.filter(e => e.type === "tool_use");
  const editEvents      = toolEvents.filter(e => EDIT_TOOLS.has(e.tool));
  const readEvents      = toolEvents.filter(e => READ_TOOLS.has(e.tool));

  const timestamped = events.map(e => e.timestamp ? new Date(e.timestamp) : null).filter(Boolean);
  const startTime = timestamped.length > 0 ? timestamped[0] : null;
  const endTime   = timestamped.length > 0 ? timestamped[timestamped.length - 1] : null;
  const durationMs = (startTime && endTime) ? (endTime.getTime() - startTime.getTime()) : 0;

  const lastUser = userEvents[userEvents.length - 1];

  return {
    sessionId: opts.sessionId || derivSessionIdFromPath(transcriptPath),
    userTurns: userEvents.length,
    assistantTurns: assistantEvents.length,
    toolCalls: toolEvents.length,
    edits: editEvents.length,
    reads: readEvents.length,
    startTime,
    endTime,
    durationMs,
    lastUserText: (lastUser?.text || "").trim(),
    events
  };
}

/**
 * Extract the session id from a Claude Code transcript path:
 *   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 *
 * @param {string} p
 * @returns {string | null}
 */
function derivSessionIdFromPath(p) {
  if (!p) return null;
  const fname = p.split(/[/\\]/).pop() || "";
  const m = fname.match(/^([a-z0-9-]+)\.jsonl$/i);
  return m ? m[1] : null;
}

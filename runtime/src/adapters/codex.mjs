// OpenAI Codex (https://developers.openai.com/codex) transcript adapter.
//
// Codex CLI writes session transcripts as JSONL with an OpenAI-conversation
// shape. Common location:
//   - ~/.codex/sessions/<session-id>.jsonl
//
// JSONL shape per line (per Codex hook docs):
//   { "type": "session.created" | "user.message" | "assistant.message" |
//             "tool.call" | "tool.result" | "session.ended",
//     "id": "...", "timestamp": "ISO8601",
//     "content": ... }

import fs from "node:fs/promises";

const EDIT_TOOLS = new Set(["str_replace_editor", "create_file", "edit_file"]);
const READ_TOOLS = new Set(["bash", "view_file", "find", "grep"]);

/**
 * @typedef {import("./claude-code.mjs").NormalizedEvent} NormalizedEvent
 * @typedef {import("./claude-code.mjs").TranscriptSummary} TranscriptSummary
 *
 * @param {string} transcriptPath
 * @param {{sessionId?: string}} [opts]
 * @returns {Promise<TranscriptSummary>}
 */
export async function summarize(transcriptPath, opts = {}) {
  const raw = await fs.readFile(transcriptPath, "utf8");
  const lines = raw.split("\n").filter(l => l.trim());

  /** @type {NormalizedEvent[]} */
  const events = [];
  let sessionIdFromTranscript = null;

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.type === "session.created" && obj.id) {
      sessionIdFromTranscript = obj.id;
    }
    const e = parseCodexEvent(obj);
    if (e) events.push(e);
  }

  const userEvents      = events.filter(e => e.type === "user");
  const assistantEvents = events.filter(e => e.type === "assistant");
  const toolEvents      = events.filter(e => e.type === "tool_use");
  const editEvents      = toolEvents.filter(e => EDIT_TOOLS.has(e.tool));
  const readEvents      = toolEvents.filter(e => READ_TOOLS.has(e.tool));

  const timestamps = events.map(e => e.timestamp ? new Date(e.timestamp) : null).filter(Boolean);
  const startTime = timestamps[0] || null;
  const endTime   = timestamps[timestamps.length - 1] || null;
  const durationMs = (startTime && endTime) ? (endTime - startTime) : 0;
  const lastUser = userEvents[userEvents.length - 1];

  const fname = transcriptPath.split(/[/\\]/).pop() || "";
  const sessionId = opts.sessionId || sessionIdFromTranscript || fname.replace(/\.[a-z]+$/, "");

  return {
    sessionId,
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

function parseCodexEvent(obj) {
  const timestamp = obj.timestamp || obj.created_at || null;
  const t = obj.type;

  if (t === "user.message" || obj.role === "user") {
    return { type: "user", text: extractText(obj), timestamp, raw: obj };
  }
  if (t === "assistant.message" || obj.role === "assistant") {
    return { type: "assistant", text: extractText(obj), timestamp, raw: obj };
  }
  if (t === "tool.call" || t === "function_call") {
    return {
      type: "tool_use",
      tool: obj.tool_name || obj.function?.name || obj.name || "unknown",
      text: safeStringify(obj.arguments || obj.input),
      timestamp,
      raw: obj
    };
  }
  if (t === "tool.result" || t === "function_result") {
    return { type: "tool_result", text: extractText(obj), timestamp, raw: obj };
  }
  if (t === "session.created" || t === "session.ended") {
    return { type: "system", text: t, timestamp, raw: obj };
  }
  return null;
}

function extractText(obj) {
  const c = obj.content || obj.text || obj.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map(b => typeof b === "string" ? b : (b?.text || safeStringify(b))).join("\n");
  }
  return safeStringify(c);
}

function safeStringify(v) {
  if (v == null) return "";
  try { return typeof v === "string" ? v : JSON.stringify(v); } catch { return String(v); }
}

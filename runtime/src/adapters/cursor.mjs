// Cursor (https://cursor.com) transcript adapter.
//
// Cursor 1.7+ has hooks but no first-class transcript-export API. The chat
// history is stored in IndexedDB inside the Electron app; programmatic export
// requires either:
//   1. Cursor's experimental session-export feature (writes JSONL to ~/.cursor/sessions/)
//   2. Hand-export via the chat UI
//   3. Reading Cursor's internal SQLite DB at:
//      - macOS: ~/Library/Application Support/Cursor/User/workspaceStorage/<hash>/state.vscdb
//      - Linux: ~/.config/Cursor/User/workspaceStorage/<hash>/state.vscdb
//      - Windows: %APPDATA%\Cursor\User\workspaceStorage\<hash>\state.vscdb
//
// This adapter parses path (1) — the JSONL export. For paths (2) and (3),
// users should pre-process to JSONL via Cursor's export tooling.
//
// JSONL shape (best-effort based on Cursor 1.7+ hook payloads):
//   { "type": "user_message" | "assistant_message" | "tool_use" | "tool_result",
//     "content": "...", "timestamp": "ISO8601" }

import fs from "node:fs/promises";

const EDIT_TOOLS = new Set(["edit_file", "create_file", "delete_file", "Edit", "Write"]);
const READ_TOOLS = new Set(["read_file", "list_dir", "grep_search", "codebase_search", "Read", "Glob", "Grep"]);

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

  // Cursor exports are JSONL (one event per line)
  const lines = raw.split("\n").filter(l => l.trim());
  /** @type {NormalizedEvent[]} */
  const events = [];
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const e = parseCursorEvent(obj);
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
  const sessionId = opts.sessionId || fname.replace(/\.[a-z]+$/, "");

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

function parseCursorEvent(obj) {
  const timestamp = obj.timestamp || obj.ts || obj.created_at || null;
  const t = obj.type || obj.event;

  // Cursor variants of the type field
  if (t === "user_message" || t === "user" || obj.role === "user") {
    return { type: "user", text: extractText(obj), timestamp, raw: obj };
  }
  if (t === "assistant_message" || t === "assistant" || obj.role === "assistant") {
    return { type: "assistant", text: extractText(obj), timestamp, raw: obj };
  }
  if (t === "tool_use" || t === "tool_call") {
    return {
      type: "tool_use",
      tool: obj.tool || obj.name || obj.function?.name || "unknown",
      text: safeStringify(obj.arguments || obj.input || obj.params),
      timestamp,
      raw: obj
    };
  }
  if (t === "tool_result" || t === "tool_response") {
    return { type: "tool_result", text: extractText(obj), timestamp, raw: obj };
  }
  if (t === "system" || t === "context") {
    return { type: "system", text: extractText(obj), timestamp, raw: obj };
  }
  return null;
}

function extractText(obj) {
  const c = obj.content || obj.text || obj.message;
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

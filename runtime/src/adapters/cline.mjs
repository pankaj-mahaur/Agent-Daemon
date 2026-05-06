// Cline transcript adapter.
//
// Cline (https://github.com/cline/cline) stores tasks in JSONL or in a
// directory tree per task. The exact path varies by Cline version and
// extension settings; common locations:
//   - ~/Library/Application Support/Cursor/User/globalStorage/saoudrizwan.claude-dev/tasks/<task-id>/
//   - %APPDATA%\Cursor\User\globalStorage\saoudrizwan.claude-dev\tasks\<task-id>\
//   - .cline/tasks/<task-id>/  (project-local)
//
// Each task directory typically contains:
//   - api_conversation_history.json  - the LLM-side messages array
//   - ui_messages.json               - the user-side chat events
//
// We parse api_conversation_history.json (closest to a transcript) into our
// normalized TranscriptSummary shape.

import fs from "node:fs/promises";
import path from "node:path";

const EDIT_TOOLS = new Set(["write_to_file", "replace_in_file", "edit_file", "Edit", "Write", "MultiEdit"]);
const READ_TOOLS = new Set(["read_file", "list_files", "search_files", "Read", "Glob", "Grep"]);

/**
 * @typedef {import("./claude-code.mjs").NormalizedEvent} NormalizedEvent
 * @typedef {import("./claude-code.mjs").TranscriptSummary} TranscriptSummary
 */

/**
 * Parse a Cline transcript path. The path can point at:
 *   - api_conversation_history.json directly
 *   - the task directory (we'll find the file)
 *   - a JSONL alternate format if Cline exports one
 *
 * @param {string} transcriptPath
 * @param {{sessionId?: string}} [opts]
 * @returns {Promise<TranscriptSummary>}
 */
export async function summarize(transcriptPath, opts = {}) {
  const filePath = await resolveFilePath(transcriptPath);
  const raw = await fs.readFile(filePath, "utf8");

  // Try JSON first (api_conversation_history.json is a JSON array)
  let messages;
  try {
    const parsed = JSON.parse(raw);
    messages = Array.isArray(parsed) ? parsed : (parsed.messages || []);
  } catch {
    // Fall back to JSONL
    messages = raw.split("\n").filter(l => l.trim()).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  }

  /** @type {NormalizedEvent[]} */
  const events = [];
  for (const msg of messages) {
    const parsed = parseClineMessage(msg);
    if (Array.isArray(parsed)) {
      events.push(...parsed);
    } else if (parsed) {
      events.push(parsed);
    }
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

  return {
    sessionId: opts.sessionId || derivSessionId(filePath),
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

function parseClineMessage(msg) {
  if (!msg || typeof msg !== "object") return null;

  const timestamp = msg.timestamp || msg.ts || null;
  const role = msg.role || msg.type;
  const content = msg.content;

  if (role === "user") {
    return { type: "user", text: stringifyContent(content), timestamp, raw: msg };
  }
  if (role === "assistant") {
    // Cline assistant messages may contain tool_use blocks within content arrays.
    // Emit multiple events: one assistant text event + one tool_use event per tool.
    if (Array.isArray(content)) {
      const results = [];
      const textParts = content.filter(c => c?.type === "text").map(c => c.text || "");
      if (textParts.length > 0) {
        results.push({ type: "assistant", text: textParts.join("\n"), timestamp, raw: msg });
      }
      for (const block of content) {
        if (block?.type === "tool_use") {
          results.push({ type: "tool_use", tool: block.name || "unknown", text: safeStringify(block.input), timestamp, raw: block });
        }
        if (block?.type === "tool_result") {
          results.push({ type: "tool_result", text: stringifyContent(block.content), timestamp, raw: block });
        }
      }
      return results.length > 0 ? results : { type: "assistant", text: stringifyContent(content), timestamp, raw: msg };
    }
    return { type: "assistant", text: stringifyContent(content), timestamp, raw: msg };
  }

  // Cline tool-use shape: { type: "tool_use", name: "read_file", input: {...} }
  if (msg.type === "tool_use" || (Array.isArray(content) && content.some(c => c?.type === "tool_use"))) {
    const tool = msg.name || content?.find?.(c => c?.type === "tool_use")?.name || "unknown";
    return { type: "tool_use", tool, text: safeStringify(msg.input || content), timestamp, raw: msg };
  }

  // Cline tool result
  if (msg.type === "tool_result" || (Array.isArray(content) && content.some(c => c?.type === "tool_result"))) {
    return { type: "tool_result", text: stringifyContent(content), timestamp, raw: msg };
  }

  // Cline-specific event names ("api_req_started", "api_req_finished", etc.)
  if (msg.say || msg.ask) {
    return { type: "system", text: stringifyContent(content || msg.say || msg.ask), timestamp, raw: msg };
  }

  return { type: "other", text: null, timestamp, raw: msg };
}

async function resolveFilePath(p) {
  const stat = await fs.stat(p).catch(() => null);
  if (stat?.isFile()) return p;
  if (stat?.isDirectory()) {
    // Look for api_conversation_history.json in the directory
    const candidate = path.join(p, "api_conversation_history.json");
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try ui_messages.json as fallback
      const fallback = path.join(p, "ui_messages.json");
      await fs.access(fallback);
      return fallback;
    }
  }
  throw new Error(`cline adapter: cannot resolve transcript path ${p}`);
}

function derivSessionId(p) {
  // Cline task directories are named with a timestamp + id
  const parts = p.split(/[/\\]/);
  // Try the parent dir name first (most common — file is api_conversation_history.json)
  return parts[parts.length - 2] || parts[parts.length - 1].replace(/\.[a-z]+$/, "");
}

function stringifyContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(b => {
      if (typeof b === "string") return b;
      if (b?.type === "text") return b.text || "";
      if (b?.type === "tool_use") return `[tool_use:${b.name}]`;
      if (b?.type === "tool_result") return typeof b.content === "string" ? b.content : safeStringify(b.content);
      return safeStringify(b);
    }).join("\n");
  }
  return safeStringify(content);
}

function safeStringify(v) {
  try { return typeof v === "string" ? v : JSON.stringify(v); } catch { return String(v); }
}

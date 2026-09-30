// OpenAI Codex rollout transcript adapter.
//
// Codex writes one rollout per thread:
//   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// (the harness CODEX_HOME is ~/.agent-daemon/codex-home). Each line is
//   { timestamp, type, payload }
// with type one of session_meta | turn_context | response_item | event_msg
// | compacted | world_state | … (shapes verified against codex 0.155–0.159
// rollouts; Codex documents the format as unstable, so unknown lines are
// ignored rather than rejected).
//
// Mapping to normalized events:
//   user       ← event_msg user_message      (the real prompt; response_item
//                                             role=user also carries injected
//                                             AGENTS.md / environment context)
//   assistant  ← response_item message role=assistant (output_text parts)
//   tool_use   ← response_item function_call | custom_tool_call | local_shell_call
//   tool_result← response_item *_output
//   system     ← session_meta, compacted

import fs from "node:fs/promises";
import { patchPaths } from "../hooks/io.mjs";

const EDIT_TOOLS = new Set(["apply_patch"]);
const SHELL_TOOLS = new Set(["shell_command", "exec_command", "shell", "local_shell", "exec"]);
const READ_CMD_RE = /^\s*(?:cat|type|head|tail|less|more|rg|grep|findstr|sed -n|Get-Content|gc|ls|dir|Get-ChildItem|git (?:show|log|diff|status))\b/i;

// Does this first line look like a Codex rollout?
export function isRolloutLine(obj) {
  return Boolean(obj && typeof obj === "object" && typeof obj.type === "string" && obj.payload && typeof obj.payload === "object" &&
    ["session_meta", "turn_context", "response_item", "event_msg"].includes(obj.type));
}

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
  return summarizeRollout(raw, { ...opts, transcriptPath });
}

export function summarizeRollout(raw, opts = {}) {
  /** @type {NormalizedEvent[]} */
  const events = [];
  let sessionIdFromTranscript = null;
  let cwd = null;
  let edits = 0;
  let reads = 0;
  // User / assistant text appears in up to three places depending on the
  // Codex version; the cleanest available source wins (see pickSource).
  const user = { items: [], events: [], responses: [] };
  const assistant = { items: [], responses: [] };
  let idx = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const timestamp = obj.timestamp ?? null;
    const p = obj.payload ?? {};
    idx++;

    if (obj.type === "session_meta") {
      // A subagent's rollout (source.subagent) embeds its parent's history
      // with no boundary marker; the parent's own rollout is digested, so
      // the subagent's is skipped rather than double counted.
      if (sessionIdFromTranscript === null && p.source && typeof p.source === "object" && p.source.subagent) {
        return emptySummary(p.session_id ?? p.id, opts, { subagent: true, cwd: p.cwd ?? null });
      }
      sessionIdFromTranscript ??= p.session_id ?? p.id ?? null;
      cwd ??= p.cwd ?? null;
      events.push({ idx, type: "system", text: "session_meta", timestamp });
      continue;
    }
    if (obj.type === "turn_context") {
      cwd = p.cwd ?? cwd;
      continue;
    }
    if (obj.type === "compacted") {
      events.push({ idx, type: "system", text: "compacted", timestamp });
      continue;
    }
    if (obj.type === "event_msg" && p.type === "user_message") {
      user.events.push({ idx, type: "user", text: String(p.message ?? ""), timestamp });
      continue;
    }
    if (obj.type === "event_msg" && p.type === "item_completed") {
      const it = p.item ?? {};
      if (it.type === "UserMessage") user.items.push({ idx, type: "user", text: contentText(it.content), timestamp });
      else if (it.type === "AgentMessage") assistant.items.push({ idx, type: "assistant", text: contentText(it.content) || String(it.text ?? ""), timestamp });
      continue;
    }
    if (obj.type !== "response_item") continue;

    if (p.type === "message" && p.role === "assistant") {
      assistant.responses.push({ idx, type: "assistant", text: contentText(p.content), timestamp });
    } else if (p.type === "message" && p.role === "user") {
      const text = contentText(p.content);
      if (!isInjectedContext(text)) user.responses.push({ idx, type: "user", text, timestamp });
    } else if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
      const tool = p.name ?? (p.type === "local_shell_call" ? "local_shell" : "unknown");
      const input = p.type === "custom_tool_call" ? p.input : p.arguments ?? p.action;
      const text = typeof input === "string" ? input : safeStringify(input);
      if (EDIT_TOOLS.has(tool)) edits += Math.max(1, patchPaths(text, cwd ?? undefined).length);
      else if (SHELL_TOOLS.has(tool) && READ_CMD_RE.test(shellCommand(text))) reads++;
      events.push({ idx, type: "tool_use", tool, text: clip(text, EDIT_TOOLS.has(tool) ? 64_000 : 16_000), timestamp });
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output" || p.type === "local_shell_call_output") {
      events.push({ idx, type: "tool_result", text: clip(outputText(p.output), 8_000), timestamp });
    }
  }

  events.push(...pickSource(user.items, user.events, user.responses), ...pickSource(assistant.responses, assistant.items));
  events.sort((a, b) => (a.idx ?? 0) - (b.idx ?? 0));
  for (const e of events) delete e.idx;

  const userEvents = events.filter((e) => e.type === "user");
  const assistantEvents = events.filter((e) => e.type === "assistant");
  const toolEvents = events.filter((e) => e.type === "tool_use");
  const timestamps = events.map((e) => (e.timestamp ? new Date(e.timestamp) : null)).filter((d) => d && !isNaN(d));
  const startTime = timestamps[0] || null;
  const endTime = timestamps[timestamps.length - 1] || null;
  const fname = String(opts.transcriptPath ?? "").split(/[/\\]/).pop() || "";
  const fromName = fname.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1];

  return {
    sessionId: opts.sessionId || sessionIdFromTranscript || fromName || fname.replace(/\.[a-z]+$/, ""),
    userTurns: userEvents.length,
    assistantTurns: assistantEvents.length,
    toolCalls: toolEvents.length,
    edits,
    reads,
    startTime,
    endTime,
    durationMs: startTime && endTime ? endTime - startTime : 0,
    lastUserText: (userEvents.at(-1)?.text || "").trim(),
    cwd,
    events,
  };
}

// Rollouts can reach tens of MB (tool output, images); keep events small.
const clip = (s, max) => (typeof s === "string" && s.length > max ? `${s.slice(0, max)}\n…[${s.length - max} chars truncated]` : s);

function emptySummary(sessionId, opts, extra) {
  return { sessionId: opts.sessionId || sessionId || "", userTurns: 0, assistantTurns: 0, toolCalls: 0, edits: 0, reads: 0, startTime: null, endTime: null, durationMs: 0, lastUserText: "", events: [], ...extra };
}

// First non-empty source, in preference order — never a mix, which would
// count the same prompt twice.
function pickSource(...sources) {
  return sources.find((s) => s.length) ?? [];
}

// role=user response items also carry context Codex injects on the user's
// behalf (AGENTS.md, environment, hook context); none of it is a prompt.
const INJECTED_RE = /^\s*(?:# AGENTS\.md instructions|<(?:environment_context|user_instructions|INSTRUCTIONS|permissions|skills_instructions|user_shell_command|turn_aborted)\b|<!-- agent-daemon)/;
export function isInjectedContext(text) {
  return INJECTED_RE.test(text);
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (typeof c === "string" ? c : c?.text ?? "")).filter(Boolean).join("\n");
}

function outputText(output) {
  if (typeof output === "string") {
    // function_call_output is often a JSON string {"output": "...", "metadata": …}
    try {
      const o = JSON.parse(output);
      if (typeof o?.output === "string") return o.output;
    } catch {
      // plain text output
    }
    return output;
  }
  if (Array.isArray(output)) return contentText(output);
  return safeStringify(output);
}

// shell_command/exec_command arguments are a JSON string {"command": …}.
function shellCommand(text) {
  try {
    const o = JSON.parse(text);
    const c = o?.command ?? o?.cmd;
    return Array.isArray(c) ? c.join(" ") : String(c ?? "");
  } catch {
    return String(text);
  }
}

function safeStringify(v) {
  if (v == null) return "";
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

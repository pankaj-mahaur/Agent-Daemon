// UserPromptSubmit hook — continuous learning extraction.
//
// Fires before every user turn. Reads the current user prompt + the previous
// assistant turn from the transcript JSONL, runs rules-based regex extractors,
// appends any learnings to the per-project learning-journal.jsonl.
//
// Zero LLM calls. Zero Claude cooperation required. <50ms typical latency.
//
// Hook payload schema (Claude Code UserPromptSubmit):
//   {
//     session_id: "...",
//     transcript_path: "...",     // path to .jsonl on disk
//     cwd: "...",                 // user's project dir
//     hook_event_name: "UserPromptSubmit",
//     prompt: "..."               // the prompt the user just submitted
//   }
//
// We exit 0 always with passthrough output — never block the user. Any
// extraction failure is silent (per SECURITY.md fail-safe rule).

import fs from "node:fs/promises";
import { readStdinJson, passthrough } from "./io.mjs";
import { extractFromText } from "./extractors.mjs";
import { appendLearnings } from "./journal.mjs";
import { markRecentSkillFailure } from "../memory/episodic.mjs";

// 1 MB: Claude turns fit in 64 KB, but Codex rollouts can put >64 KB of
// tool output / injected context between the last assistant message and
// the next prompt (~6% of real prompts). Reading 1 MB costs ~ms.
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;

export async function userPromptExtract() {
  try {
    const input = await readStdinJson();
    // Team workers (AD_WORKER=1) are prompted by the leader, not the user.
    if (process.env.AD_WORKER === "1") {
      passthrough();
      return 0;
    }
    const cwd = String(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const userPrompt = String(input.prompt || "");
    const transcriptPath = String(input.transcript_path || process.env.CLAUDE_TRANSCRIPT_PATH || "");
    const sessionId = String(input.session_id || "");

    /** @type {Array<object>} */
    const learnings = [];

    // 1. Scan the user prompt for corrections / explicit notes. The user is
    //    usually the source of high-signal corrections ("actually we use X").
    if (userPrompt) {
      const fromUser = extractFromText(userPrompt, { speaker: "user", maxLearnings: 4 });
      for (const l of fromUser) {
        learnings.push(stamp(l, { sessionId, source_speaker: "user" }));
      }
      const failure = fromUser.find(l =>
        (l.type === "correction" || l.type === "gotcha") && l.confidence >= 0.55
      );
      if (failure && sessionId) {
        await markRecentSkillFailure({
          sessionId,
          failureReason: failure.text,
          outcomeSource: `user-prompt:${failure.rule_id}`
        });
      }
    }

    // 2. Scan the previous assistant turn for explicit "remember:"-style notes
    //    that the agent itself emitted.
    if (transcriptPath) {
      const lastAssistant = await readLastAssistantTurn(transcriptPath);
      if (lastAssistant && !isInjectedDaemonContent(lastAssistant.text)) {
        const fromAssistant = extractFromText(lastAssistant.text, { speaker: "agent", maxLearnings: 4 });
        for (const l of fromAssistant) {
          learnings.push(stamp(l, { sessionId, source_speaker: "agent", source_turn_uuid: lastAssistant.uuid }));
        }
      }
    }

    if (learnings.length > 0) {
      await appendLearnings({ cwd, entries: learnings });
    }
  } catch {
    // Fail-safe: hooks must never crash the session.
  }

  passthrough();
  return 0;
}

function isInjectedDaemonContent(text) {
  return [
    "<agent-daemon-digest>",
    "<!-- agent-daemon:start -->",
    "UserPromptSubmit",
    "SessionStart hook",
    "agent-daemon: context truncated",
    "learning-journal.jsonl",
    "skill_executions"
  ].some(marker => text.includes(marker));
}

function stamp(learning, extra) {
  return {
    ts: new Date().toISOString(),
    ...learning,
    ...extra
  };
}

/**
 * Read the last assistant turn's text content from a JSONL transcript by
 * tailing the file. Returns {text, uuid} or null.
 *
 * Claude Code's transcript JSONL has one event per line; the assistant turn
 * shape has `type: "assistant"` with `message.content` being either a string
 * or an array of {type:"text", text}. We just need the concatenated text.
 *
 * @param {string} transcriptPath
 * @returns {Promise<{text: string, uuid?: string}|null>}
 */
async function readLastAssistantTurn(transcriptPath) {
  let handle;
  try {
    handle = await fs.open(transcriptPath, "r");
    const stat = await handle.stat();
    const len = Math.min(stat.size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, Math.max(0, stat.size - len));
    const raw = buf.toString("utf8");

    // Walk lines from the END backwards, find the first valid assistant event.
    const lines = raw.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      // Codex rollout: {type:"response_item", payload:{type:"message", role:"assistant", content}}
      // or an item_completed AgentMessage.
      const p = obj.payload;
      const codexMsg =
        (obj.type === "response_item" && p?.type === "message" && p.role === "assistant" && p) ||
        (obj.type === "event_msg" && p?.type === "item_completed" && p.item?.type === "AgentMessage" && p.item) ||
        null;
      const isAssistant =
        Boolean(codexMsg) ||
        obj.type === "assistant" ||
        obj.role === "assistant" ||
        obj.message?.role === "assistant";
      if (!isAssistant) continue;

      const text = stringifyContent(codexMsg ? codexMsg.content ?? codexMsg.text : obj.message?.content ?? obj.content);
      if (!text || text.length < 8) continue;
      return { text, uuid: obj.uuid ?? codexMsg?.id };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (handle) {
      try { await handle.close(); } catch {}
    }
  }
}

function stringifyContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(c => {
        if (typeof c === "string") return c;
        if ((c?.type === "text" || c?.type === "output_text") && typeof c.text === "string") return c.text;
        return "";
      })
      .join("\n")
      .trim();
  }
  return "";
}

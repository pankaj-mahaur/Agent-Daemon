// Anthropic's Messages API, native (P6.4a): a TurnRequest (Chat-shaped messages from
// responses-in.mjs) → a Messages request, and the Messages stream → StreamEvents.
// Everything engine-facing stays responses-out.mjs's; transport, keys and the allowlist
// stay the gateway's.
//
//   anthropicRequest(turn, route) → { path, body }
//   createAnthropicParser() → { events(eventName, data) → StreamEvent[], takeThinking() → blocks }
// Thinking blocks (with their signatures) and redacted blocks are kept whole: the writer
// seals them into the reasoning item, and they go back, unchanged, before the next tool_use.

import { refusal } from "../tools.mjs";

const EFFORT_BUDGET = Object.freeze({ minimal: 1024, low: 2048, medium: 8192, high: 24576, xhigh: 32768 });
const DEFAULT_MAX_TOKENS = 32000;

const textBlocks = (content) => {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return (content ?? []).map((p, i) => {
    if (p.type === "text") return { type: "text", text: p.text };
    if (p.type === "image_url") {
      const url = String(p.image_url?.url ?? "");
      const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
      return m ? { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } } : { type: "image", source: { type: "url", url } };
    }
    throw refusal(`content[${i}]`, `ad can't pass a "${p.type}" part to Anthropic.`);
  });
};

/** Anthropic tool-use ids: [a-zA-Z0-9_-]+ (the engine's are already; anything else is cleaned). */
const toolId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, "_");

export function anthropicRequest(turn, route = {}) {
  const m = route.model ?? {};
  const system = [];
  const messages = [];
  const isThinking = (b) => b.type === "thinking" || b.type === "redacted_thinking";
  const push = (role, blocks) => {
    if (!blocks.length) return; // an empty turn: Anthropic refuses empty content
    // Roles must alternate: consecutive turns of one role become one message, with any
    // thinking first (Anthropic wants an assistant message to open with it).
    const last = messages.at(-1);
    if (last && last.role === role) last.content = [...last.content.filter(isThinking), ...blocks.filter(isThinking), ...last.content.filter((b) => !isThinking(b)), ...blocks.filter((b) => !isThinking(b))];
    else messages.push({ role, content: [...blocks] });
  };
  for (const msg of turn.messages) {
    if (msg.role === "system") system.push(...textBlocks(msg.content));
    else if (msg.role === "user") push("user", textBlocks(msg.content));
    else if (msg.role === "tool") push("user", [{ type: "tool_result", tool_use_id: toolId(msg.tool_call_id), content: String(msg.content ?? "") }]);
    else if (msg.role === "assistant") {
      const blocks = [...(msg.thinkingBlocks ?? []), ...textBlocks(msg.content)];
      for (const c of msg.tool_calls ?? []) {
        let input;
        try {
          input = JSON.parse(c.function.arguments || "{}");
        } catch {
          throw refusal("input", "A tool call in this chat has arguments that aren't JSON; Anthropic can't take it.");
        }
        blocks.push({ type: "tool_use", id: toolId(c.id), name: c.function.name, input });
      }
      if (blocks.length) push("assistant", blocks);
    }
  }
  const body = { model: turn.model, messages, max_tokens: turn.maxOutputTokens ?? route.maxOutputTokens?.[turn.model] ?? DEFAULT_MAX_TOKENS, stream: true };
  if (system.length) {
    // Prompt caching on the stable prefix (system and tools); a preset can turn it off.
    if (route.promptCache !== false) system.at(-1).cache_control = { type: "ephemeral" };
    body.system = system;
  }
  const tools = turn.toolMap.chatTools.map((t) => ({ name: t.function.name, description: t.function.description ?? "", input_schema: t.function.parameters ?? { type: "object", properties: {} } }));
  if (tools.length) {
    if (route.promptCache !== false) tools.at(-1).cache_control = { type: "ephemeral" };
    body.tools = tools;
    const tc = turn.toolChoice;
    if (tc === "auto") body.tool_choice = { type: "auto" };
    else if (tc === "none") body.tool_choice = { type: "none" };
    else if (tc === "required") body.tool_choice = { type: "any" };
    else if (tc?.function?.name) body.tool_choice = { type: "tool", name: tc.function.name };
    if (turn.parallelToolCalls === false) body.tool_choice = { ...(body.tool_choice ?? { type: "auto" }), disable_parallel_tool_use: true };
  }
  // Extended thinking: only when every assistant turn in the current tool loop still has
  // its thinking (Anthropic refuses a loop that lost it); otherwise this request goes without.
  if (turn.reasoningEffort && m.effort) {
    const budget = EFFORT_BUDGET[turn.reasoningEffort] ?? EFFORT_BUDGET.medium;
    if (loopKeepsThinking(turn.messages) && body.max_tokens > budget) body.thinking = { type: "enabled", budget_tokens: budget };
  }
  if (turn.temperature !== null && !body.thinking) body.temperature = Math.min(1, turn.temperature);
  return { path: "/messages", body };
}

function loopKeepsThinking(messages) {
  let i = messages.length - 1;
  while (i >= 0 && messages[i].role !== "user") i--;
  // The loop: assistant turns with tool calls after the last real user message.
  for (let j = i + 1; j < messages.length; j++) if (messages[j].role === "assistant" && messages[j].tool_calls?.length && !messages[j].thinkingBlocks?.length) return false;
  return true;
}

const STOP = { end_turn: "stop", stop_sequence: "stop", tool_use: "tool_calls", max_tokens: "length", refusal: "content_filter", pause_turn: "stop" };

export function createAnthropicParser() {
  const blocks = new Map(); // index → { type, id?, name?, thinking?, signature?, data? }
  let thinking = []; // finished thinking/redacted blocks since the last take
  let inputTokens = null;
  let cached = null;
  return {
    events(event, data) {
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        return [{ t: "error", error: { message: "Anthropic sent a malformed event" } }];
      }
      const type = j?.type ?? event;
      switch (type) {
        case "message_start":
          inputTokens = j.message?.usage?.input_tokens ?? null;
          cached = j.message?.usage?.cache_read_input_tokens ?? 0;
          if (Number.isInteger(inputTokens)) inputTokens += cached + (j.message?.usage?.cache_creation_input_tokens ?? 0);
          return [];
        case "content_block_start": {
          const b = j.content_block ?? {};
          blocks.set(j.index, { ...b });
          if (b.type === "tool_use") return [{ t: "tool", index: j.index, id: b.id, name: b.name }];
          if (b.type === "redacted_thinking") return [{ t: "reasoning", delta: "" }];
          if (b.type === "thinking" && b.thinking) return [{ t: "reasoning", delta: b.thinking }];
          if (b.type === "text" && b.text) return [{ t: "text", delta: b.text }];
          return [];
        }
        case "content_block_delta": {
          const b = blocks.get(j.index) ?? {};
          const d = j.delta ?? {};
          if (d.type === "text_delta") return [{ t: "text", delta: d.text ?? "" }];
          if (d.type === "thinking_delta") {
            b.thinking = (b.thinking ?? "") + (d.thinking ?? "");
            return [{ t: "reasoning", delta: d.thinking ?? "" }];
          }
          if (d.type === "signature_delta") {
            b.signature = (b.signature ?? "") + (d.signature ?? "");
            return [];
          }
          if (d.type === "input_json_delta") return [{ t: "tool", index: j.index, args: d.partial_json ?? "" }];
          return [];
        }
        case "content_block_stop": {
          const b = blocks.get(j.index);
          if (b?.type === "thinking") thinking.push({ type: "thinking", thinking: b.thinking ?? "", signature: b.signature ?? "" });
          else if (b?.type === "redacted_thinking") thinking.push({ type: "redacted_thinking", data: b.data });
          return [];
        }
        case "message_delta": {
          // The window is full: a context failure (the engine compacts), never a cut-off to re-send.
          if (j.delta?.stop_reason === "model_context_window_exceeded") return [{ t: "error", error: { message: "model context window exceeded: context length" } }];
          const out = [];
          const out_ = j.usage?.output_tokens;
          if (Number.isInteger(inputTokens) && Number.isInteger(out_)) out.push({ t: "usage", usage: { prompt_tokens: inputTokens, completion_tokens: out_, total_tokens: inputTokens + out_, prompt_tokens_details: { cached_tokens: cached } } });
          if (j.delta?.stop_reason) out.push({ t: "finish", reason: STOP[j.delta.stop_reason] ?? j.delta.stop_reason });
          return out;
        }
        case "message_stop":
          return [{ t: "done" }];
        case "error":
          return [{ t: "error", error: j.error ?? { message: "Anthropic reported an error" } }];
        default:
          return []; // ping and future events
      }
    },
    /** The thinking blocks finished since the last call (sealed into one reasoning item). */
    takeThinking() {
      const out = thinking;
      thinking = [];
      return out;
    },
  };
}

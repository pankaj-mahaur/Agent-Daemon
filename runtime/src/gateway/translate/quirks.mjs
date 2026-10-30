// Per-provider rules for translated routes (P6.1 §7), pure: each takes the Chat body built
// from a TurnRequest and returns the body to send.
//
//   applyQuirks(names, body, turn, { salt }) → body
//   reasoningBack(names) → true when the provider wants its own reasoning back (DeepSeek)
// deepseek       assistant messages carry their reasoning_content back within the tool loop
//                (re-opened from ad's envelope; refused when it was lost)
// mistral        tool-call IDs of 9 [a-zA-Z0-9], derived per request from the engine's IDs
// single-system  all system messages merged into one, first

import { mistralIds } from "./ids.mjs";
import { refusal } from "./tools.mjs";

const RULES = {
  deepseek(body, _turn, { label } = {}) {
    // With tools in the request, DeepSeek's thinking models need every earlier assistant
    // message's reasoning_content back (api-docs.deepseek.com, thinking mode; checked 25 Oct
    // 2026), not only the current loop's: it answers 400 otherwise. A message that never
    // reasoned (or reasoned on another provider or model) sends it empty; ad's own reasoning
    // for this model that no longer opens (its key changed) is refused, with ad's words.
    const tools = Boolean(body.tools?.length);
    const messages = body.messages.map((m, i, all) => {
      if (m.role !== "assistant") return m;
      if (m.reasoning !== undefined) return { ...m, reasoning_content: m.reasoning };
      // A turn from another provider or model reasoned elsewhere: nothing of ours to send.
      // With tools, the field is still sent, empty, as DeepSeek expects one on every turn.
      if (!m.reasoningLost && tools) return { ...m, reasoning_content: "" };
      if (m.reasoningLost && (tools || (m.tool_calls?.length && isLoopTail(all, i)))) throw refusal(`messages[${i}]`, `${label ?? "DeepSeek"} can't read this chat's earlier reasoning any more (ad's key for it changed). Start a new chat.`);
      return m;
    });
    return { ...body, messages };
  },
  // Gemini's compat layer: each tool call's thought signature (extra_content) must come
  // back on that call. The stream writer seals them per call id and the request side puts
  // them back (responses-in), so nothing changes in the body here. Field per Google's
  // compat docs as last documented (UNVERIFIED on 25 Oct 2026: the page moved).
  "gemini-compat"(body) {
    return body;
  },
  mistral(body, _turn, { salt }) {
    const ids = mistralIds(salt);
    return {
      ...body,
      messages: body.messages.map((m) => {
        if (m.role === "assistant" && m.tool_calls) return { ...m, tool_calls: m.tool_calls.map((c) => ({ ...c, id: ids.toUpstream(c.id) })) };
        if (m.role === "tool") return { ...m, tool_call_id: ids.toUpstream(m.tool_call_id) };
        return m;
      }),
    };
  },
  "single-system"(body) {
    const sys = body.messages.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : ""));
    if (sys.length <= 1) return body;
    return { ...body, messages: [{ role: "system", content: sys.join("\n\n") }, ...body.messages.filter((m) => m.role !== "system")] };
  },
};

// The assistant message at i is part of the current tool loop: only tool results (no user
// message) follow it.
function isLoopTail(messages, i) {
  for (let j = i + 1; j < messages.length; j++) if (messages[j].role === "user") return false;
  return true;
}

export function applyQuirks(names = [], body, turn, opts = {}) {
  let out = body;
  for (const n of names) {
    const rule = RULES[n];
    if (!rule) throw Object.assign(new Error(`unknown translation quirk "${n}"`), { code: "TRANSLATE_CONFIG" });
    out = rule(out, turn, opts);
  }
  return out;
}

export const reasoningBack = (names = []) => names.includes("deepseek");
export const KNOWN_QUIRKS = Object.freeze(Object.keys(RULES));

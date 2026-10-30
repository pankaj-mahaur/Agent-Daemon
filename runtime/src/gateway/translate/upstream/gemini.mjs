// Google's Gemini API, native (P6.4b): a TurnRequest → streamGenerateContent, and its SSE
// chunks → StreamEvents. The key goes in the x-goog-api-key header (the gateway's), never in
// the address. Thought signatures ride with their function calls: each call's signature is
// sealed by the writer (as per-call extras) and put back on that call's part next time.
//
//   geminiRequest(turn, route, { extrasByCall }) → { path, body }
//   createGeminiParser() → { events(data) → StreamEvent[] }

import { refusal } from "../tools.mjs";

// A model id goes into the path: only plain ids, so nothing can bend the path.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EFFORT_LEVEL = Object.freeze({ minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" });

const parts = (content) => {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  return (content ?? []).map((p, i) => {
    if (p.type === "text") return { text: p.text };
    if (p.type === "image_url") {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(String(p.image_url?.url ?? ""));
      if (!m) throw refusal(`content[${i}]`, "Gemini takes images as data through ad, not as a link.");
      return { inlineData: { mimeType: m[1], data: m[2] } };
    }
    throw refusal(`content[${i}]`, `ad can't pass a "${p.type}" part to Gemini.`);
  });
};

export const NO_SIGNATURE_TEXT = "This chat's earlier Gemini steps can't be replayed. Start a new chat on Gemini, or continue on the model you were using.";

export function geminiRequest(turn, route = {}, { extrasByCall = {} } = {}) {
  if (!MODEL_ID.test(turn.model)) throw refusal("model", "That isn't a Gemini model id ad can send.");
  const system = [];
  const contents = [];
  const names = new Map(); // call id → function name (for the response parts: stateless)
  const push = (role, ps) => {
    const last = contents.at(-1);
    if (last && last.role === role) last.parts.push(...ps);
    else contents.push({ role, parts: [...ps] });
  };
  // Calls after the last real user message are the current turn's: Gemini checks their signatures.
  let lastUser = -1;
  turn.messages.forEach((m, i) => {
    if (m.role === "user") lastUser = i;
  });
  turn.messages.forEach((msg, i) => {
    if (msg.role === "system") system.push(...parts(msg.content));
    else if (msg.role === "user") push("user", parts(msg.content));
    else if (msg.role === "assistant") {
      const ps = parts(msg.content);
      for (const [k, c] of (msg.tool_calls ?? []).entries()) {
        let args;
        try {
          args = JSON.parse(c.function.arguments || "{}");
        } catch {
          throw refusal("args", "A tool call in this chat has arguments that aren't JSON; Gemini can't take it.");
        }
        names.set(c.id, c.function.name);
        const sig = c.extra_content?.thoughtSignature ?? extrasByCall[c.id]?.thoughtSignature;
        // Parallel calls carry one signature, on the first call of the step; Gemini checks
        // that one for the current turn (its thinking docs). The rest go as they came.
        if (!sig && k === 0 && i > lastUser) throw refusal("input", NO_SIGNATURE_TEXT);
        ps.push({ functionCall: { name: c.function.name, args, id: c.id }, ...(sig ? { thoughtSignature: sig } : {}) });
      }
      if (ps.length) push("model", ps);
    } else if (msg.role === "tool") {
      const name = names.get(msg.tool_call_id);
      if (!name) throw refusal("input", "A tool result in this chat has no call before it; Gemini can't take it.");
      push("user", [{ functionResponse: { name, id: msg.tool_call_id, response: { output: String(msg.content ?? "") } } }]);
    }
  });
  const body = { contents };
  if (system.length) body.systemInstruction = { parts: system };
  const decls = turn.toolMap.chatTools.map((t) => ({ name: t.function.name, description: t.function.description ?? "", parametersJsonSchema: t.function.parameters ?? { type: "object", properties: {} } }));
  if (decls.length) {
    body.tools = [{ functionDeclarations: decls }];
    const tc = turn.toolChoice;
    const mode = tc === "none" ? "NONE" : tc === "required" || tc?.function ? "ANY" : "AUTO";
    body.toolConfig = { functionCallingConfig: { mode, ...(tc?.function?.name ? { allowedFunctionNames: [tc.function.name] } : {}) } };
  }
  const gen = { thinkingConfig: { includeThoughts: true, ...(turn.reasoningEffort ? { thinkingLevel: EFFORT_LEVEL[turn.reasoningEffort] ?? "medium" } : {}) } };
  if (turn.maxOutputTokens !== null) gen.maxOutputTokens = turn.maxOutputTokens;
  if (turn.temperature !== null) gen.temperature = turn.temperature;
  if (turn.responseFormat?.type === "json_schema") Object.assign(gen, { responseMimeType: "application/json", responseJsonSchema: turn.responseFormat.json_schema?.schema });
  else if (turn.responseFormat?.type === "json_object") gen.responseMimeType = "application/json";
  body.generationConfig = gen;
  return { path: `/models/${turn.model}:streamGenerateContent?alt=sse`, body };
}

const FINISH = { STOP: "stop", MAX_TOKENS: "length" };

export function createGeminiParser() {
  let calls = 0;
  let sawCall = false;
  return {
    events(data) {
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        return [{ t: "error", error: { message: "Gemini sent a malformed event" } }];
      }
      if (j?.error) return [{ t: "error", error: j.error }];
      // A prompt Gemini blocked has no candidate: a filter stop (never a cut-off to retry).
      if (j?.promptFeedback?.blockReason && !j.candidates?.length) return [{ t: "finish", reason: "SAFETY" }];
      const out = [];
      const c = j?.candidates?.[0];
      for (const p of c?.content?.parts ?? []) {
        if (p.functionCall) {
          // A function call arrives whole: one tool event with its signature.
          sawCall = true;
          const index = calls++;
          out.push({ t: "tool", index, id: p.functionCall.id ?? `gemini_call_${index}`, name: p.functionCall.name, args: JSON.stringify(p.functionCall.args ?? {}), ...(p.thoughtSignature ? { extra: { thoughtSignature: p.thoughtSignature } } : {}) });
        } else if (typeof p.text === "string" && p.text) out.push({ t: p.thought ? "reasoning" : "text", delta: p.text });
      }
      const u = j?.usageMetadata;
      if (u && Number.isInteger(u.promptTokenCount) && (Number.isInteger(u.candidatesTokenCount) || Number.isInteger(u.thoughtsTokenCount))) {
        const completion = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
        out.push({ t: "usage", usage: { prompt_tokens: u.promptTokenCount, completion_tokens: completion, total_tokens: u.totalTokenCount ?? u.promptTokenCount + completion, ...(Number.isInteger(u.cachedContentTokenCount) ? { prompt_tokens_details: { cached_tokens: u.cachedContentTokenCount } } : {}), ...(Number.isInteger(u.thoughtsTokenCount) ? { completion_tokens_details: { reasoning_tokens: u.thoughtsTokenCount } } : {}) } });
      }
      if (c?.finishReason) {
        const f = FINISH[c.finishReason] ?? c.finishReason;
        out.push({ t: "finish", reason: f === "stop" && sawCall ? "tool_calls" : f });
      }
      return out;
    },
  };
}

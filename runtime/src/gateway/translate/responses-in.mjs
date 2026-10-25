// The engine's Responses request → a TurnRequest (P6.1 §4). Every item type and field with
// content is either translated or refused (HTTP 400 naming it): never silently dropped.
//
//   toTurnRequest(body, { route, sealKey }) → TurnRequest   (throws TRANSLATE_REFUSED)
//   chatBody(turn, { route }) → the Chat Completions request body
// route.model: { vision, strictTools, parallelTools, effort, jsonFormat } (catalog/preset).

import { buildToolMap, refusal } from "./tools.mjs";
import { open } from "./seal.mjs";

// Fields with no content for a Chat provider: dropped.
const DROP = new Set(["store", "include", "prompt_cache_key", "service_tier", "stream", "client_metadata", "metadata", "user", "safety_identifier", "prompt_cache_retention"]);
// Fields handled below.
const KNOWN = new Set(["model", "input", "instructions", "tools", "tool_choice", "parallel_tool_calls", "max_output_tokens", "reasoning", "text", "temperature", "top_p", "truncation"]);
const REFUSED = { previous_response_id: "continuing a stored response", background: "background responses", conversation: "stored conversations", prompt: "stored prompts", max_tool_calls: "a tool-call limit", top_logprobs: "log probabilities" };

const textOf = (parts, param, { vision, allowImages }) => {
  if (typeof parts === "string") return parts;
  const out = [];
  let image = false;
  for (const [i, p] of (parts ?? []).entries()) {
    if (p?.type === "input_text" || p?.type === "output_text" || p?.type === "text") out.push({ type: "text", text: String(p.text ?? "") });
    else if (p?.type === "input_image" && allowImages) {
      if (!vision) throw refusal(`${param}[${i}]`, "This model can't look at images through ad. Pick a model that can, or leave the image out.");
      const url = p.image_url ?? (p.file_id ? null : null);
      if (!url) throw refusal(`${param}[${i}]`, "ad can only pass an image given as a URL or data URL.");
      out.push({ type: "image_url", image_url: { url, ...(p.detail ? { detail: p.detail } : {}) } });
      image = true;
    } else if (p?.type === "refusal") out.push({ type: "text", text: String(p.refusal ?? "") });
    else throw refusal(`${param}[${i}]`, `ad can't pass a "${p?.type}" part to this provider.`);
  }
  return image ? out : out.map((p) => p.text).join("\n\n");
};

const outputText = (output, param) => {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((p, i) => {
        if (p?.type === "input_text" || p?.type === "output_text" || p?.type === "text") return String(p.text ?? "");
        throw refusal(`${param}[${i}]`, p?.type === "input_image" ? "This provider can't take an image as a tool result through ad." : `ad can't pass a "${p?.type}" tool result to this provider.`);
      })
      .join("\n");
  }
  if (output && typeof output === "object" && typeof output.content === "string") return output.content;
  return JSON.stringify(output ?? "");
};

export function toTurnRequest(body, { route = {}, sealKey = null } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw refusal("", "ad expected a JSON request.");
  for (const [k, v] of Object.entries(body)) {
    if (v === null || v === undefined || DROP.has(k)) continue;
    if (REFUSED[k]) throw refusal(k, `This provider can't take ${REFUSED[k]} through ad.`);
    if (!KNOWN.has(k)) throw refusal(k, `ad can't pass the "${k}" field to this provider.`);
  }
  if (body.truncation && body.truncation !== "disabled") throw refusal("truncation", "This provider can't take automatic truncation through ad.");
  const m = route.model ?? {};
  const scope = { provider: route.provider ?? "", model: body.model ?? "" };

  // Tools: the request's tools plus any additional_tools items (Responses Lite).
  const input = typeof body.input === "string" ? [{ type: "message", role: "user", content: body.input }] : Array.isArray(body.input) ? body.input : [];
  const extra = input.filter((i) => i?.type === "additional_tools").flatMap((i) => i.tools ?? []);
  const toolMap = buildToolMap([...(body.tools ?? []), ...extra], { strict: Boolean(m.strictTools) });
  const flatOf = (kind, name, namespace) => toolMap.flat(kind, name, namespace) ?? buildToolMap([namespace ? { type: "namespace", name: namespace, tools: [{ type: "function", name }] } : { type: kind, name }]).chatTools[0].function.name;

  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: String(body.instructions) });
  // A reasoning item belongs to the assistant output after it: that output starts a new
  // assistant message carrying it (opened), or marked lost (present but not ad's envelope
  // for this provider and model).
  let pending = null; // { text } | { lost: true }
  const newAssistant = (content) => {
    const msg = { role: "assistant", content };
    if (pending?.text !== undefined) msg.reasoning = pending.text;
    else if (pending?.lost) msg.reasoningLost = true;
    pending = null;
    messages.push(msg);
    return msg;
  };
  const assistant = () => {
    const last = messages.at(-1);
    return last?.role === "assistant" && !pending ? last : newAssistant(null);
  };
  const callId = (item, param) => {
    if (typeof item.call_id !== "string" || !item.call_id) throw refusal(`${param}.call_id`, "A tool call without its id can't be passed on.");
    return item.call_id;
  };
  for (const [i, item] of input.entries()) {
    const param = `input[${i}]`;
    const type = item?.type ?? (item?.role ? "message" : undefined);
    if (type === "message") {
      const role = item.role;
      // Reasoning with no assistant output after it (an interrupted turn) stays with that turn.
      if (role !== "assistant") pending = null;
      if (role === "developer" || role === "system") messages.push({ role: "system", content: textOf(item.content, `${param}.content`, { vision: m.vision, allowImages: false }) });
      else if (role === "user") messages.push({ role: "user", content: textOf(item.content, `${param}.content`, { vision: m.vision, allowImages: true }) });
      else if (role === "assistant") {
        const text = textOf(item.content, `${param}.content`, { vision: false, allowImages: false });
        const last = messages.at(-1);
        // Text after tool calls (or after a reasoning item) came later: a new message.
        if (last?.role === "assistant" && !last.tool_calls && !pending) last.content = last.content ? `${last.content}\n\n${text}` : text;
        else newAssistant(text);
      } else throw refusal(`${param}.role`, `ad can't pass a "${role}" message to this provider.`);
    } else if (type === "function_call" || type === "custom_tool_call") {
      const a = assistant();
      const name = type === "custom_tool_call" ? flatOf("custom", item.name) : flatOf("function", item.name, item.namespace);
      const args = type === "custom_tool_call" ? JSON.stringify({ input: String(item.input ?? "") }) : String(item.arguments ?? "{}");
      (a.tool_calls ??= []).push({ id: callId(item, param), type: "function", function: { name, arguments: args } });
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      messages.push({ role: "tool", tool_call_id: callId(item, param), content: outputText(item.output, `${param}.output`) });
    } else if (type === "reasoning") {
      // Hidden reasoning is the provider's own (D11): only ad's envelope for this provider and
      // model comes back; anything else (another provider's, a direct model's) is dropped.
      const text = sealKey && item.encrypted_content ? open(sealKey, scope, item.encrypted_content) : null;
      if (text !== null) pending = { text: pending?.text !== undefined ? `${pending.text}\n${text}` : text };
      else if (pending?.text === undefined) pending = { lost: true };
    } else if (type === "additional_tools") {
      // merged into the tools above
    } else throw refusal(`${param}.type`, type === "tool_search_call" || type === "tool_search_output" ? "This provider can't take deferred tool search through ad." : `ad can't pass a "${type}" item to this provider.`);
  }

  let toolChoice = null;
  const tc = body.tool_choice;
  if (tc === "auto" || tc === "none" || tc === "required") toolChoice = tc;
  else if (tc && typeof tc === "object" && tc.type === "function" && tc.name) {
    const flat = toolMap.flat("function", tc.name, tc.namespace);
    if (!flat) throw refusal("tool_choice", `The tool "${tc.name}" isn't among this request's tools.`);
    toolChoice = { type: "function", function: { name: flat } };
  } else if (tc && typeof tc === "object" && tc.type === "custom" && tc.name) {
    const flat = toolMap.flat("custom", tc.name);
    if (!flat) throw refusal("tool_choice", `The tool "${tc.name}" isn't among this request's tools.`);
    toolChoice = { type: "function", function: { name: flat } };
  } else if (tc !== undefined && tc !== null) throw refusal("tool_choice", "This provider can't take that tool choice through ad.");

  let responseFormat = null;
  const fmt = body.text?.format;
  if (fmt && fmt.type !== "text") {
    if (!m.jsonFormat) throw refusal("text.format", "This model can't be held to a JSON format through ad.");
    responseFormat = fmt.type === "json_schema" ? { type: "json_schema", json_schema: { name: fmt.name ?? "output", schema: fmt.schema, ...(fmt.strict !== undefined ? { strict: fmt.strict } : {}) } } : { type: "json_object" };
  }
  const effort = body.reasoning?.effort ?? null;
  return {
    model: String(body.model ?? ""),
    messages,
    toolMap,
    toolChoice,
    parallelToolCalls: typeof body.parallel_tool_calls === "boolean" ? body.parallel_tool_calls : null,
    maxOutputTokens: Number.isInteger(body.max_output_tokens) ? body.max_output_tokens : null,
    reasoningEffort: effort && effort !== "none" && m.effort ? effort : null,
    temperature: typeof body.temperature === "number" ? body.temperature : null,
    topP: typeof body.top_p === "number" ? body.top_p : null,
    responseFormat,
  };
}

/** A TurnRequest → the Chat Completions body (before any provider quirk). */
export function chatBody(turn, { route = {} } = {}) {
  const m = route.model ?? {};
  const out = { model: route.upstreamModel?.[turn.model] ?? turn.model, messages: turn.messages.map((x) => ({ ...x })), stream: true, stream_options: { include_usage: true } };
  if (turn.toolMap.chatTools.length) {
    out.tools = turn.toolMap.chatTools;
    if (turn.toolChoice) out.tool_choice = turn.toolChoice;
    if (turn.parallelToolCalls !== null && m.parallelTools !== false) out.parallel_tool_calls = turn.parallelToolCalls;
  }
  if (turn.maxOutputTokens !== null) out.max_tokens = turn.maxOutputTokens;
  if (turn.reasoningEffort) out.reasoning_effort = turn.reasoningEffort;
  if (turn.temperature !== null) out.temperature = turn.temperature;
  if (turn.topP !== null) out.top_p = turn.topP;
  if (turn.responseFormat) out.response_format = turn.responseFormat;
  return out;
}

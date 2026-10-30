// StreamEvents → the Responses SSE the engine reads (P6.1 §5–6), in its exact item shapes.
//
//   createResponsesWriter({ write, toolMap, maxArgsBytes, sealReasoning, label }) → {
//     created()               response.created (call once the upstream answered 200)
//     push(event)             a StreamEvent
//     end({ eof })            the stream ended: [DONE]/finish seen, or EOF/abort (eof: true)
//     fail(code, message)     response.failed with an engine-known code
//     result()                { side, emittedCalls, droppedCalls, usage }
//   }
// Rules: a message item is added before its first text delta; reasoning comes first in
// output order; a tool call is emitted only whole — its name mapped back (namespace or
// custom shape), its arguments parsed (empty → {}), a custom tool's {"input": string}
// unwrapped — and never when the stream ended early or for length; usage is complete
// integers or null; every terminal event carries the response id.

import { sseEvent } from "./sse.mjs";
import { mintId } from "./ids.mjs";

const RESPONSE_CAP = 16 * 2 ** 20;
const MAX_CALLS = 128;

/** Complete integer usage, or null (never a partial object). */
export function responsesUsage(u) {
  if (!u || !Number.isInteger(u.prompt_tokens) || !Number.isInteger(u.completion_tokens)) return null;
  const total = Number.isInteger(u.total_tokens) ? u.total_tokens : u.prompt_tokens + u.completion_tokens;
  const out = { input_tokens: u.prompt_tokens, input_tokens_details: null, output_tokens: u.completion_tokens, output_tokens_details: null, total_tokens: total };
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens;
  if (Number.isInteger(cached)) out.input_tokens_details = { cached_tokens: cached };
  const reasoning = u.completion_tokens_details?.reasoning_tokens;
  if (Number.isInteger(reasoning)) out.output_tokens_details = { reasoning_tokens: reasoning };
  return out;
}

const TERMINAL = new Set(["response.completed", "response.incomplete", "response.failed"]);

// sealExtras: a provider's opaque per-call data (Gemini's thought signatures) → an envelope,
// handed to the engine as a reasoning item so it comes back with the next request.
export function createResponsesWriter({ write, toolMap, maxArgsBytes = 2 * 2 ** 20, sealReasoning = null, sealExtras = null, label = "The provider", onTerminal = null }) {
  const id = mintId("resp_");
  let outputIndex = 0;
  let reasoning = null; // { id, index, text }
  let message = null; // { id, index, text }
  const calls = new Map(); // upstream index (or id) → { id, name, args, bytes, over }
  const order = []; // every call, in the order it started
  let last = null; // the call the last fragment went to
  let finish = null;
  let usage = null;
  let total = 0;
  let ended = false;
  const side = { kind: null, message: null, droppedCalls: [] };
  const emitted = [];

  const send = (e) => {
    // Whoever reports the turn's outcome hears it before the engine does.
    if (TERMINAL.has(e.type)) onTerminal?.();
    write(sseEvent(e));
  };
  const closeReasoning = () => {
    if (!reasoning) return;
    const item = { type: "reasoning", id: reasoning.id, summary: [], content: [{ type: "reasoning_text", text: reasoning.text }] };
    const sealed = sealReasoning?.(reasoning.text);
    if (sealed) item.encrypted_content = sealed;
    send({ type: "response.output_item.done", output_index: reasoning.index, item });
    reasoning = null;
  };
  const closeMessage = () => {
    if (!message) return;
    send({ type: "response.output_text.done", item_id: message.id, output_index: message.index, content_index: 0, text: message.text });
    send({ type: "response.output_item.done", output_index: message.index, item: { type: "message", role: "assistant", id: message.id, status: "completed", content: [{ type: "output_text", text: message.text, annotations: [] }] } });
    message = null;
  };

  // A whole call → the engine's item, or null with the reason.
  function itemFor(c) {
    const where = toolMap.resolve(c.name);
    if (!where) return { reason: `unknown tool name ${JSON.stringify(c.name)}` };
    if (c.over) return { reason: `the arguments of ${where.name} are larger than ad accepts` };
    let parsed;
    try {
      parsed = c.args.trim() === "" ? {} : JSON.parse(c.args);
    } catch {
      return { reason: `the arguments of ${where.name} aren't valid JSON` };
    }
    const callId = mintId("call_");
    if (where.kind === "custom") {
      if (!parsed || typeof parsed !== "object" || typeof parsed.input !== "string") return { reason: `${where.name} wasn't given its text input` };
      return { item: { type: "custom_tool_call", status: "completed", call_id: callId, name: where.name, input: parsed.input } };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { reason: `the arguments of ${where.name} aren't a JSON object` };
    return { item: { type: "function_call", status: "completed", call_id: callId, name: where.name, ...(where.namespace ? { namespace: where.namespace } : {}), arguments: JSON.stringify(parsed) } };
  }

  return {
    id,
    created() {
      send({ type: "response.created", response: { id, status: "in_progress" } });
    },
    push(e) {
      if (ended) return;
      // One cap for everything the answer holds: text, reasoning, tool names and arguments.
      total += (e.delta?.length ?? 0) + (e.name?.length ?? 0) + (e.args?.length ?? 0);
      if (total > RESPONSE_CAP) throw Object.assign(new Error("the answer is larger than ad accepts"), { code: "RESPONSE_TOO_LARGE" });
      if (e.t === "reasoning") {
        if (message) return; // reasoning after text: not shown out of order
        if (!reasoning) {
          reasoning = { id: mintId("rs_"), index: outputIndex++, text: "" };
          send({ type: "response.output_item.added", output_index: reasoning.index, item: { type: "reasoning", id: reasoning.id, summary: [], content: [] } });
        }
        reasoning.text += e.delta;
        send({ type: "response.reasoning_text.delta", item_id: reasoning.id, output_index: reasoning.index, content_index: 0, delta: e.delta });
      } else if (e.t === "text") {
        closeReasoning();
        if (!message) {
          message = { id: mintId("msg_"), index: outputIndex++, text: "" };
          send({ type: "response.output_item.added", output_index: message.index, item: { type: "message", role: "assistant", id: message.id, status: "in_progress", content: [] } });
        }
        message.text += e.delta;
        send({ type: "response.output_text.delta", item_id: message.id, output_index: message.index, content_index: 0, delta: e.delta });
      } else if (e.t === "tool") {
        closeReasoning();
        // A call is its index; a fragment with another id at a known index (or with no
        // index at all) starts a new call, so providers that omit or reuse indexes don't
        // glue two calls together.
        const hasIndex = e.index !== null && e.index !== undefined;
        let c = hasIndex ? calls.get(e.index) : e.id ? (order.find((x) => x.id === e.id) ?? null) : last;
        if (c && e.id && c.id && e.id !== c.id) c = null;
        if (!c) {
          if (order.length >= MAX_CALLS) throw Object.assign(new Error("the answer has more tool calls than ad accepts"), { code: "RESPONSE_TOO_LARGE" });
          c = { id: e.id ?? null, name: "", args: "", bytes: 0, over: false, gotArgs: false };
          order.push(c);
          if (hasIndex) calls.set(e.index, c);
        }
        last = c;
        if (e.id && !c.id) c.id = e.id;
        if (e.extra) c.extra = e.extra;
        // Name fragments join until the first argument fragment; a provider that repeats the
        // whole name in every chunk sends it again unchanged.
        if (e.name && !c.gotArgs && e.name !== c.name) c.name += e.name;
        if (e.args) {
          c.gotArgs = true;
          c.bytes += Buffer.byteLength(e.args);
          if (c.bytes > maxArgsBytes) c.over = true;
          else c.args += e.args;
        }
      } else if (e.t === "finish") finish = e.reason;
      else if (e.t === "usage") usage = responsesUsage(e.usage);
    },
    /** The end of the upstream stream. eof: it ended without [DONE] or a finish reason. */
    end({ eof = false } = {}) {
      if (ended) return;
      ended = true;
      const open = order;
      const dropAll = (kind, message) => {
        side.kind = kind;
        side.message = message;
        side.droppedCalls = open.map((c) => c.name);
      };
      if (eof && finish === null) {
        // Cut off mid-way: nothing half-streamed is handed over as finished (no done items),
        // nothing runs; the engine retries once.
        dropAll("transientNetwork", `${label} stopped answering mid-way.`);
        send({ type: "response.failed", response: { id, error: { code: "ad_upstream_disconnected", message: side.message }, usage: null } });
        return;
      }
      const kind = finishKind(finish);
      if (kind === "failed") {
        dropAll("transientNetwork", `${label} ended the answer early (${String(finish).slice(0, 40)}).`);
        send({ type: "response.failed", response: { id, error: { code: "ad_upstream_disconnected", message: side.message }, usage: null } });
        return;
      }
      closeReasoning();
      closeMessage();
      if (kind === "length") {
        dropAll("truncated", open.length ? `${label} hit its output limit inside a tool call; nothing ran.` : `${label} hit its output limit.`);
        send({ type: "response.incomplete", response: { id, incomplete_details: { reason: "max_output_tokens" }, usage } });
        return;
      }
      if (kind === "filter") {
        dropAll("contentPolicy", `${label} stopped the answer (${String(finish).slice(0, 40)}).`);
        send({ type: "response.incomplete", response: { id, incomplete_details: { reason: "content_filter" }, usage } });
        return;
      }
      const items = [];
      for (const c of open) {
        const r = itemFor(c);
        if (!r.item) {
          // A call ad can't hand over whole: none of this response's calls run (terminal, no re-send).
          dropAll("invalidConfig", `The model asked for a tool ad couldn't map (${r.reason}). Nothing ran.`);
          send({ type: "response.incomplete", response: { id, incomplete_details: { reason: "max_output_tokens" }, usage } });
          return;
        }
        items.push({ item: r.item, extra: c.extra ?? null });
      }
      const extras = Object.fromEntries(items.filter((x) => x.extra).map((x) => [x.item.call_id, x.extra]));
      const sealed = Object.keys(extras).length ? sealExtras?.(extras) : null;
      if (sealed) {
        const rid = mintId("rs_");
        const index = outputIndex++;
        const item = { type: "reasoning", id: rid, summary: [], content: [], encrypted_content: sealed };
        send({ type: "response.output_item.added", output_index: index, item });
        send({ type: "response.output_item.done", output_index: index, item });
      }
      for (const { item } of items) {
        const index = outputIndex++;
        send({ type: "response.output_item.added", output_index: index, item: { ...item, status: "in_progress" } });
        send({ type: "response.output_item.done", output_index: index, item });
        emitted.push(item.name);
      }
      send({ type: "response.completed", response: { id, status: "completed", usage } });
    },
    /** Ends with response.failed (retryable codes only for what may pass on a retry). */
    fail(code, message) {
      if (ended) return;
      ended = true;
      side.droppedCalls = order.map((c) => c.name);
      send({ type: "response.failed", response: { id, error: { code, message }, usage: null } });
    },
    /** A deterministic failure (too large): terminal for the turn, never re-sent. */
    stop(message) {
      if (ended) return;
      ended = true;
      side.kind = "invalidConfig";
      side.message = message;
      side.droppedCalls = order.map((c) => c.name);
      send({ type: "response.incomplete", response: { id, incomplete_details: { reason: "max_output_tokens" }, usage } });
    },
    result: () => ({ side, emittedCalls: emitted, usage }),
  };
}

// Finish reasons by what they mean; anything not listed is a cut-off (failed, one retry).
const DONE_REASONS = new Set(["stop", "tool_calls", "function_call", "end_turn", "STOP", "eos"]);
const LENGTH_REASONS = new Set(["length", "max_tokens", "model_length", "MAX_TOKENS"]);
const FILTER_REASONS = new Set(["content_filter", "SAFETY", "safety", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "MALFORMED_FUNCTION_CALL", "IMAGE_SAFETY"]);
function finishKind(reason) {
  if (reason === null || reason === undefined || DONE_REASONS.has(reason)) return "done";
  if (LENGTH_REASONS.has(reason)) return "length";
  if (FILTER_REASONS.has(reason)) return "filter";
  return "failed";
}

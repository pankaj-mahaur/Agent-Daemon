// Chat translation inside the provider gateway (P6.1, D18): the engine speaks Responses,
// a "chat" route's provider speaks Chat Completions. The gateway's server keeps the token,
// path, caps, auth, allowlist and redirect refusal; this module only turns one request and
// its answer from one wire into the other. No child processes, no engine imports.
//
//   prepare(bodyBuffer, route, { sealKey, salt }) → { path, body: Buffer, turn }  (throws TRANSLATE_REFUSED)
//   refusalBody(err)                       the HTTP 400 body for a refusal
//   failure(status, text, { retryAfter, route, capS })   errors.mjs's httpFailure
//   failedStream(res, { code, message })   a 200 SSE answer ending in response.failed
//   pipeAnswer(upBody, res, { turn, route, sealKey, capS, signal }) → Promise<{ side, usage, emittedCalls }>
// route: { mode: "chat", provider, upstreamPath?, quirks?, model?, maxArgsBytes?, label }

import { createSseParser, sseEvent } from "./sse.mjs";
import { chatBody, extrasScope, thinkingScope, toTurnRequest } from "./responses-in.mjs";
import { createResponsesWriter } from "./responses-out.mjs";
import { chatEvents } from "./upstream/chat.mjs";
import { anthropicRequest, createAnthropicParser } from "./upstream/anthropic.mjs";
import { createGeminiParser, geminiRequest } from "./upstream/gemini.mjs";
import { httpFailure, streamFailure } from "./errors.mjs";
import { applyQuirks, reasoningBack } from "./quirks.mjs";
import { mintId } from "./ids.mjs";
import { seal } from "./seal.mjs";

// chat: Chat Completions (P6.1); anthropic: the Messages API; gemini: streamGenerateContent (P6.4).
export const TRANSLATED_MODES = Object.freeze(["chat", "anthropic", "gemini"]);

// Without a seal key (the secret store failed), per-call data (Gemini's thought signatures)
// is kept in this process instead, by ad's own call ids, so tool loops still work for the
// gateway's life. Bounded; the oldest go first.
const EXTRAS_MEMORY = new Map();
const EXTRAS_MEMORY_MAX = 2000;
function remember(x) {
  for (const [id, v] of Object.entries(x)) {
    EXTRAS_MEMORY.delete(id);
    EXTRAS_MEMORY.set(id, v);
  }
  while (EXTRAS_MEMORY.size > EXTRAS_MEMORY_MAX) EXTRAS_MEMORY.delete(EXTRAS_MEMORY.keys().next().value);
}

export function prepare(bodyBuffer, route, { sealKey = null, salt = "" } = {}) {
  let body;
  try {
    body = JSON.parse(Buffer.from(bodyBuffer).toString("utf8"));
  } catch {
    throw Object.assign(new Error("ad expected a JSON request."), { code: "TRANSLATE_REFUSED", param: "" });
  }
  const turn = toTurnRequest(body, { route, sealKey });
  const meta = body.client_metadata && typeof body.client_metadata === "object" ? body.client_metadata : {};
  const threadId = typeof meta.thread_id === "string" ? meta.thread_id : typeof meta.session_id === "string" ? meta.session_id : null;
  // The native APIs (P6.4): their own request shapes from the same TurnRequest.
  if (route.mode === "anthropic" || route.mode === "gemini") {
    const remembered = sealKey ? {} : Object.fromEntries(turn.messages.flatMap((m) => (m.tool_calls ?? []).filter((c) => EXTRAS_MEMORY.has(c.id)).map((c) => [c.id, EXTRAS_MEMORY.get(c.id)])));
    const r = route.mode === "anthropic" ? anthropicRequest(turn, route) : geminiRequest(turn, route, { extrasByCall: remembered });
    return { path: r.path, body: Buffer.from(JSON.stringify(r.body)), turn, threadId };
  }
  const out = applyQuirks(route.quirks, chatBody(turn, { route }), turn, { salt, label: route.provider === "deepseek" || /deepseek/i.test(turn.model) ? "DeepSeek" : (route.label ?? "The model") });
  // ad's own markers (opened reasoning, lost reasoning) never leave the gateway.
  out.messages = out.messages.map(({ reasoning, reasoningLost, thinkingBlocks, ...m }) => m);
  return { path: route.upstreamPath ?? "chat/completions", body: Buffer.from(JSON.stringify(out)), turn, threadId };
}

export const refusalBody = (err) => ({ error: { type: "invalid_request_error", code: "invalid_request", param: err.param ?? null, message: String(err.message) } });

export const failure = (status, text, { retryAfter = null, route = {}, capS = 60, headers = null } = {}) =>
  httpFailure(status, text, { retryAfter, capS, label: route.label ?? "The provider", quotaNames: route.quotaErrors ?? [], dayExhausted: (route.dailyLimitHeaders ?? []).some((h) => headers?.get?.(h) === "0") });

export function failedStream(res, { code, message }) {
  const id = mintId("resp_");
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.end(sseEvent({ type: "response.created", response: { id, status: "in_progress" } }) + sseEvent({ type: "response.failed", response: { id, error: { code, message }, usage: null } }));
}

/**
 * Streams a Chat answer (a web ReadableStream or a Node stream of bytes) to `res` as
 * Responses SSE. Resolves when the answer ended (or the engine hung up).
 */
export async function pipeAnswer(upBody, res, { turn, route = {}, sealKey = null, capS = 60, signal, onTerminal = null } = {}) {
  const label = route.label ?? "The provider";
  const scope = { provider: route.provider ?? "", model: turn.model };
  const upstream = route.mode === "anthropic" ? createAnthropicParser() : route.mode === "gemini" ? createGeminiParser() : null;
  const eventsOf = ({ event, data }) => (route.mode === "anthropic" ? upstream.events(event, data) : route.mode === "gemini" ? upstream.events(data) : chatEvents(data));
  const writer = createResponsesWriter({
    write: (s) => res.write(s),
    toolMap: turn.toolMap,
    maxArgsBytes: route.maxArgsBytes ?? route.model?.maxArgsBytes ?? 2 * 2 ** 20,
    // Anthropic's thinking blocks (signatures included) go back whole; DeepSeek's reasoning as text.
    sealReasoning: !sealKey ? null : route.mode === "anthropic" ? () => seal(sealKey, thinkingScope(scope), JSON.stringify({ blocks: upstream.takeThinking() })) : reasoningBack(route.quirks) ? (text) => seal(sealKey, scope, text) : null,
    sealExtras: !(route.mode === "gemini" || route.quirks?.includes("gemini-compat")) ? null : sealKey ? (x) => seal(sealKey, extrasScope(scope), JSON.stringify({ v: 2, x })) : (x) => (remember(x), null),
    label,
    onTerminal: () => {
      try {
        onTerminal?.(snapshot());
      } catch {
        // an observer's failure never touches the answer
      }
    },
  });
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  writer.created();
  let done = false;
  let side = null;
  const snapshot = () => {
    const r = writer.result();
    return { ...r, side: side ? { ...side, droppedCalls: r.side.droppedCalls } : r.side.kind ? r.side : null };
  };
  const parser = createSseParser({
    onEvent: (ev) => {
      if (done) return;
      for (const e of eventsOf(ev)) {
        if (e.t === "done") {
          done = true;
          writer.end();
          return;
        }
        if (e.t === "error") {
          done = true;
          const f = streamFailure(e.error, { capS, label, quotaNames: route.quotaErrors ?? [] });
          side = f.side;
          writer.fail(f.code, f.message);
          return;
        }
        writer.push(e);
      }
    },
  });
  try {
    for await (const chunk of upBody) {
      if (signal?.aborted || done) break;
      parser.push(chunk);
    }
    if (!done && !signal?.aborted) {
      parser.end();
      // A finish reason without [DONE] is a normal end; neither is a cut-off.
      if (!done) writer.end({ eof: true });
    }
  } catch (err) {
    if (!signal?.aborted && !done) {
      // Too large is deterministic: terminal for the turn (a re-send would only repeat it).
      if (err?.code === "SSE_EVENT_TOO_LARGE" || err?.code === "RESPONSE_TOO_LARGE") writer.stop(`${label}: ${err.message}.`);
      else writer.end({ eof: true });
    }
  } finally {
    if (!res.writableEnded && !res.destroyed) res.end();
  }
  return snapshot();
}

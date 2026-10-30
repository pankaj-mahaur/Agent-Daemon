// Mock providers for M3 tests (P3.1): an OpenAI-, OpenRouter- or generic-shaped API
// on a random loopback port, with the scripted Responses stream of mock-responses.mjs.
//
//   startMockProvider({ personality, keys, models, script, faults, quota })
//     → { url, origin, requests, setScript, setFault, setQuota, close, held, release, hangups }
//
// What a request carried is recorded, never the key: the bearer becomes
// { scheme, matchesKey (index in `keys`, -1 for none), sha256 (12 hex) }. Nothing is
// written to disk.
//
// Personalities:
//   openai      base /v1; 401 invalid_api_key; 429 insufficient_quota | rate_limit_exceeded
//   openrouter  base /api/v1; 401 "No auth credentials found"; 429 free-models-per-day;
//               GET /api/v1/key (usage, free counter); /models with pricing (":free" = 0)
//   generic     base /v1; plain 401 and 429
// Faults (setFault, until cleared or `times` used up):
//   { type: "5xx", status, retryAfter }  { type: "midText" } (cut after the first delta)
//   { type: "slow", delayMs }            { type: "reset" } (socket destroyed, no answer)
// Quota (setQuota): { type: "insufficient_quota" | "rate_limit_exceeded" | "free-limit", retryAfter }.

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createResponsesHandler, defaultScript, ev, lastUserText, roleTexts, sse } from "./mock-responses.mjs";

const PERSONALITIES = new Set(["openai", "openrouter", "generic"]);

function bearerOf(header, keys) {
  if (!header) return { scheme: null, matchesKey: -1, sha256: null };
  const m = /^(\S+)\s+(.+)$/.exec(String(header));
  const scheme = m ? m[1] : String(header);
  const value = m ? m[2] : "";
  return { scheme, matchesKey: keys.indexOf(value), sha256: value ? createHash("sha256").update(value).digest("hex").slice(0, 12) : null };
}

const json = (res, status, body, headers = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

function unauthorized(personality, res) {
  if (personality === "openai") return json(res, 401, { error: { message: "Incorrect API key provided.", type: "invalid_request_error", param: null, code: "invalid_api_key" } });
  if (personality === "openrouter") return json(res, 401, { error: { message: "No auth credentials found", code: 401 } });
  return json(res, 401, { error: { message: "unauthorized" } });
}

function quotaAnswer(personality, quota, res) {
  const headers = quota.retryAfter !== undefined ? { "retry-after": String(quota.retryAfter) } : {};
  if (quota.type === "free-limit") return json(res, 429, { error: { message: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day", code: 429 } }, headers);
  const message = quota.type === "insufficient_quota" ? "You exceeded your current quota, please check your plan and billing details." : "Rate limit reached for requests";
  if (personality === "openrouter") return json(res, 429, { error: { message, code: 429 } }, headers);
  return json(res, 429, { error: { message, type: quota.type === "insufficient_quota" ? "insufficient_quota" : "requests", param: null, code: quota.type } }, headers);
}

const defaultModels = [{ id: "mock-model" }];

/**
 * @param {{ personality?: "openai"|"openrouter"|"generic", keys?: string[], models?: {id:string, free?:boolean}[],
 *           script?: (body:any)=>any, faults?: object, quota?: object }} [o]
 */
export async function startMockProvider({ personality = "generic", keys = [], models = defaultModels, script = defaultScript, faults = null, quota = null } = {}) {
  if (!PERSONALITIES.has(personality)) throw new Error(`unknown personality: ${personality}`);
  const base = personality === "openrouter" ? "/api/v1" : "/v1";
  const requests = [];
  const handler = createResponsesHandler({ script });
  let fault = faults;
  let limit = quota;
  let freeToday = 0;
  const takeFault = () => {
    if (!fault) return null;
    const f = fault;
    if (f.times !== undefined && --f.times <= 0) fault = null;
    return f;
  };

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://mock");
      const { authorization, ...headers } = req.headers;
      const auth = bearerOf(authorization, keys);
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = { invalidJson: true };
      }
      const input = Array.isArray(body?.input) ? body.input : [];
      requests.push({
        method: req.method,
        path: url.pathname,
        headers,
        auth,
        model: body?.model,
        stream: body?.stream,
        store: body?.store,
        previousResponseId: body?.previous_response_id ?? null,
        toolTypes: (body?.tools ?? []).map((t) => t.type),
        tools: (body?.tools ?? []).map((t) => t.name ?? t.type),
        functionOutputs: input.filter((i) => i?.type === "function_call_output").map((i) => ({ callId: i.call_id, output: typeof i.output === "string" ? i.output : JSON.stringify(i.output) })),
        text: body ? lastUserText(body) : "",
        userTexts: body ? roleTexts(body, "user") : [],
        // Each input item's shape (never its text): what a switch carries to a provider.
        items: input.map((i) => ({ type: i?.type ?? null, role: i?.role ?? null, encrypted: Boolean(i?.encrypted_content), callId: i?.call_id ?? null })),
        invalidJson: Boolean(body?.invalidJson) || undefined,
      });
      const f = takeFault();
      if (f?.type === "reset") return void req.socket.destroy();
      if (auth.matchesKey < 0) return void unauthorized(personality, res);

      if (req.method === "GET" && url.pathname === `${base}/models`) {
        if (personality === "openrouter") return void json(res, 200, { data: models.map((m) => ({ id: m.id, name: m.id, pricing: m.free || /:free$/.test(m.id) ? { prompt: "0", completion: "0" } : { prompt: "0.000001", completion: "0.000002" } })) });
        return void json(res, 200, { object: "list", data: models.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: "mock" })) });
      }
      if (personality === "openrouter" && req.method === "GET" && url.pathname === "/api/v1/key") {
        const free = models.every((m) => m.free || /:free$/.test(m.id)) || freeToday > 0;
        return void json(res, 200, { data: { label: "mock", usage: 0, limit: null, is_free_tier: free, free_requests_today: freeToday, rate_limit: { requests: 20, interval: "10s" } } });
      }
      if (req.method !== "POST" || !/\/responses$/.test(url.pathname)) return void json(res, 404, { error: { message: `mock: no route ${req.method} ${url.pathname}` } });

      if (limit) return void quotaAnswer(personality, limit, res);
      if (f?.type === "5xx") return void json(res, f.status ?? 500, { error: { message: "mock upstream error", code: "server_error" } }, f.retryAfter !== undefined ? { "retry-after": String(f.retryAfter) } : {});
      if (/:free$/.test(String(body?.model ?? ""))) freeToday++;
      if (f?.type === "midText") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(sse([ev.created(), ev.messageAdded(), ev.textDelta("partial")]));
        return void setTimeout(() => res.destroy(), 10);
      }
      await handler.respond(res, body, { delayMs: f?.type === "slow" ? (f.delayMs ?? 50) : 0 });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${origin}${base}`,
    origin,
    requests,
    setScript: handler.setScript,
    setFault: (x) => {
      fault = x ? { ...x } : null;
    },
    setQuota: (x) => {
      limit = x ?? null;
    },
    held: handler.held,
    release: () => handler.release(),
    get hangups() {
      return handler.hangups;
    },
    close: () => {
      handler.destroyAll();
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

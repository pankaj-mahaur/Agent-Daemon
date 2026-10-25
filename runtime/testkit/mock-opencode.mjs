// A stand-in for OpenCode Go (P3.6), shaped like what its docs and a live check (25 Oct
// 2026) show: a public model list at /inference/go/v1/models; per-model wires under
// /inference/go/openai/v1 (/responses, /chat/completions); every model request needs
// x-opencode-session (400 MissingSessionID without it) and a key (401 "Invalid credential");
// a model asked on the wrong wire answers "not available on this endpoint"; a used-up
// plan answers 429 GoUsageLimitError.
//
//   startMockOpencode({ keys, wires }) → { origin, base, modelsUrl, requests, setLimit(on, retryAfter), close() }
// requests: { path, model, session, userAgent, keyOk } (never the key).

import { createServer } from "node:http";
import { createResponsesHandler } from "./mock-responses.mjs";
import { chat, defaultChatScript } from "./mock-chat.mjs";

const DEFAULT_WIRES = { "glm-5.3": "chat", "gpt-6-luna": "responses", "claude-haiku-5-5": "messages", "new-model": "chat", mystery: "responses", "param-err": "chat", "deepseek-v4-pro": "chat" };
const frame = (e) => (e === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(e)}\n\n`);
const json = (res, status, body, headers = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

export async function startMockOpencode({ keys = [], wires = DEFAULT_WIRES } = {}) {
  const requests = [];
  const responses = createResponsesHandler();
  let limit = null;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = req.url ?? "";
      if (req.method === "GET" && url === "/inference/go/v1/models") return json(res, 200, { object: "list", data: Object.keys(wires).map((id) => ({ id, object: "model", owned_by: "opencode" })) });
      const m = /^\/inference\/go\/openai\/v1\/(responses|chat\/completions)$/.exec(url);
      if (!m || req.method !== "POST") return json(res, 404, {});
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        body = {};
      }
      const bearer = /^Bearer\s+(.+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? null;
      const rec = { path: url, model: body.model ?? null, session: req.headers["x-opencode-session"] ?? null, userAgent: req.headers["user-agent"] ?? null, keyOk: keys.includes(bearer) };
      requests.push(rec);
      if (!rec.session) return json(res, 400, { type: "error", error: { type: "MissingSessionID", message: "Request is missing x-opencode-session and cannot be routed efficiently." } });
      if (!rec.keyOk) return json(res, 401, { error: { type: "server_error", message: "Upstream request failed: Invalid credential" } });
      const wire = m[1] === "responses" ? "responses" : "chat";
      if (Array.isArray(body.messages) && body.messages.length === 0) return json(res, 400, { error: { type: "invalid_request_error", message: "messages must not be empty" } });
      if (wires[body.model] && wires[body.model] !== wire) return json(res, 400, { type: "error", error: { type: "ModelError", message: `Model ${body.model} is not available on this endpoint` } });
      if (body.model === "param-err") return json(res, 400, { error: { type: "invalid_request_error", message: "reasoning_effort is not supported for this endpoint" } });
      if (limit) return json(res, 429, { type: "error", error: { type: "GoUsageLimitError", message: "Go usage limit reached" } }, limit.retryAfter ? { "retry-after": String(limit.retryAfter) } : {});
      if (wire === "responses") return void responses.respond(res, body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const out = defaultChatScript(body);
      res.end((out.chunks ?? [chat.text("ok"), chat.finish("stop", chat.usage), "[DONE]"]).map(frame).join(""));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    base: `${origin}/inference/go/openai/v1`,
    modelsUrl: `${origin}/inference/go/v1/models`,
    requests,
    setLimit(on, retryAfter = null) {
      limit = on ? { retryAfter } : null;
    },
    close() {
      responses.destroyAll();
      server.closeAllConnections?.();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

// A fault-injecting Responses provider (P4.5), promoted from the S-RECOVERY spike: the real
// pinned engine, through ad's gateway, meets a provider that fails at a chosen point.
//
//   startFaultProvider({ personality, keys })
//     → { url, requests, schedule(marker, steps), onToolResult(callId, step), clear(), close }
//
// A schedule is per prompt marker: the k-th request whose last user message contains the
// marker gets steps[k-1] (a retry and a tool-result request carry the same user message, so
// they count too); past the list, the probe script answers. onToolResult(callId, step) answers
// the first request carrying that call's result with `step`, before any schedule.
//
// Steps (`fault.*`):
//   beforeFirstByte({ status, headers, json })   quota(), rate(retryAfter), freePerDay(), unauthorized()
//   afterCreated()            response.created, then the socket is destroyed
//   midText(n)                n text deltas, then destroyed
//   afterToolCallEmitted(p)   the probe's function_call, then destroyed (no response.completed)
//   sseFailed(code, { afterText }) response.failed (after a partial answer when afterText); an unrecognised code by default (the engine retries
//                             it once); "server_is_overloaded" is terminal
//   slow(ms)                  the probe script's answer, one event every `ms`
//   ok()                      the probe script now
// refusedUrl() is a loopback URL nothing listens on (connection refused).
//
// Probes, by a word in the prompt (each one's call id is fixed, so a retry repeats it):
//   EXEC    exec_command: echo once >> marker.txt
//   WRITE   apply_patch adding made.txt
//   BGHOLD  a long-running command started in the background, which appends to marker.txt first
//   PING    a plain answer
// The probe script runs a probe only when the request shows no evidence it ran: no result for
// its call and no "[done]" / "[still running]" line naming its file in the history ad
// carried. So a lost carry-over shows as a doubled marker.
//
// Requests record (never the key): the step taken, the last user text, function outputs, the
// texts of every message, whether encrypted reasoning came along, the "Still running" lines,
// and the tool calls the answer emitted.

import { createServer } from "node:http";
import { ev, lastUserText, sse } from "./mock-responses.mjs";

const win = process.platform === "win32";
export const PROBES = {
  EXEC: { callId: "call-exec", cmd: win ? "cmd.exe /d /c echo once>>marker.txt" : "echo once >> marker.txt", seen: "marker.txt" },
  WRITE: { callId: "call-write", cmd: "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: made.txt\n+made once\n*** End Patch\nEOF\n", seen: "made.txt" },
  BGHOLD: {
    callId: "call-bghold",
    cmd: win ? "cmd.exe /d /c \"echo once>>marker.txt & ping -n 90 127.0.0.1 >nul\"" : "echo once >> marker.txt; sleep 90",
    seen: "marker.txt",
    yieldMs: 500,
    // The command inside the engine's shell wrapper: what a keep-running rule names.
    keep: win ? "echo once>>marker.txt & ping -n 90 127.0.0.1 >nul" : "echo once >> marker.txt; sleep 90",
  },
};

const json = (status, body, headers = {}) => ({ kind: "json", status, body, headers });
export const fault = {
  beforeFirstByte: ({ status = 500, headers = {}, json: body = {} } = {}) => json(status, body, headers),
  quota: ({ retryAfter } = {}) => json(429, { error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", param: null, code: "insufficient_quota" } }, retryAfter !== undefined ? { "retry-after": String(retryAfter) } : {}),
  rate: (retryAfter) => json(429, { error: { message: `Rate limit reached for requests. Please try again in ${retryAfter}s.`, type: "requests", param: null, code: "rate_limit_exceeded" } }, { "retry-after": String(retryAfter) }),
  freePerDay: () => json(429, { error: { code: 429, message: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day" } }),
  unauthorized: () => json(401, { error: { message: "Incorrect API key provided.", type: "invalid_request_error", param: null, code: "invalid_api_key" } }),
  afterCreated: () => ({ kind: "cut", events: [ev.created()] }),
  midText: (n = 1) => ({ kind: "cut", events: [ev.created(), ev.messageAdded(), ...Array.from({ length: n }, (_, i) => ev.textDelta(i ? " more" : "partial answer"))] }),
  afterToolCallEmitted: (probe = PROBES.EXEC) => ({ kind: "cut", events: [ev.created(), callOf(probe)] }),
  sseFailed: (code = "mock_unrecognised", { afterText } = {}) => ({ kind: "stream", events: [ev.created(), ...(afterText ? [ev.messageAdded(), ev.textDelta(afterText)] : []), { type: "response.failed", response: { id: "resp-1", status: "failed", error: { code, message: `mock ${code}` } } }] }),
  slow: (ms) => ({ kind: "slow", ms }),
  ok: () => ({ kind: "script" }),
};

function callOf(p) {
  return ev.functionCall(p.callId, "exec_command", { cmd: p.cmd, ...(p.yieldMs ? { yield_time_ms: p.yieldMs } : {}) });
}

const textsOf = (input) => input.filter((i) => i?.type === "message").map((i) => (i.content ?? []).map((c) => String(c.text ?? "")).join(""));
const outputsOf = (input) => input.filter((i) => i?.type === "function_call_output").map((i) => ({ callId: i.call_id, output: typeof i.output === "string" ? i.output : JSON.stringify(i.output) }));

/** Whether a request shows that a probe already ran: its result, or ad's line naming it. */
export function ranBefore(body, probe) {
  const input = Array.isArray(body?.input) ? body.input : [];
  if (input.some((i) => (i?.type === "function_call_output" || i?.type === "function_call") && i.call_id === probe.callId)) return true;
  return textsOf(input).some((t) => {
    const lines = t.split("\n");
    // "[done] $ cmd" for a command, "[done] add made.txt (+1 −0)" for a patch.
    if (lines.some((line) => /^\s*\[(done|still running)\] /.test(line) && line.includes(probe.seen))) return true;
    // ad's "Still running from before the switch" block lists live commands as "  $ cmd".
    const at = lines.findIndex((l) => l.startsWith("Still running from before the switch"));
    return at >= 0 && lines.slice(at + 1).some((l) => /^\s+\$ /.test(l) && l.includes(probe.seen));
  });
}

/** The probe script: a probe's call once, then a closing message. */
export function probeScript(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  const last = input[input.length - 1];
  if (last?.type === "function_call_output") return [ev.created(), ev.message(`done after ${last.call_id}`), ev.completed()];
  // The task is any user message: after a switch the last one is ad's continuation.
  const asked = textsOf(input.filter((i) => i?.role === "user")).join("\n");
  for (const [word, p] of Object.entries(PROBES)) {
    if (!asked.includes(word)) continue;
    if (ranBefore(body, p)) return [ev.created(), ev.message(`${word} already ran`), ev.completed()];
    return [ev.created(), callOf(p), ev.completed()];
  }
  return [ev.created(), ev.reasoning("**Thinking**"), ev.messageAdded(), ev.textDelta("pong"), ev.message("pong"), ev.completed()];
}

/**
 * @param {{ personality?: "openai"|"openrouter", keys?: string[], script?: (body:any)=>any[] }} [o]
 */
export async function startFaultProvider({ personality = "openai", keys = [], script = probeScript } = {}) {
  const base = personality === "openrouter" ? "/api/v1" : "/v1";
  const requests = [];
  const schedules = new Map(); // marker → { steps, n }
  const onResult = new Map(); // callId → step
  const sockets = new Set();
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://mock");
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      const auth = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (req.method === "GET" && url.pathname === `${base}/models`) return void send(res, json(200, { object: "list", data: [{ id: "mock-model", object: "model" }] }));
      if (req.method !== "POST" || !/\/responses$/.test(url.pathname) || !body) return void send(res, json(404, { error: { message: "mock: no route" } }));
      const input = Array.isArray(body.input) ? body.input : [];
      const text = lastUserText(body);
      const last = input[input.length - 1];
      let step = null;
      let taken = "script";
      if (keys.length && !keys.includes(auth)) {
        step = fault.unauthorized();
        taken = "unauthorized";
      } else if (last?.type === "function_call_output" && onResult.has(last.call_id)) {
        step = onResult.get(last.call_id);
        onResult.delete(last.call_id);
        taken = `onToolResult:${last.call_id}`;
      } else {
        for (const [marker, s] of schedules) {
          if (!text.includes(marker)) continue;
          step = s.steps[s.n] ?? null;
          taken = step ? `${marker}#${s.n + 1}` : "script";
          s.n++;
          break;
        }
      }
      const all = textsOf(input);
      const rec = {
        at: Date.now(),
        step: taken,
        model: body.model ?? null,
        text,
        functionOutputs: outputsOf(input),
        texts: all,
        hasEncryptedReasoning: input.some((i) => i?.type === "reasoning" && i.encrypted_content),
        stillRunning: all.flatMap((t) => (t.includes("Still running from before the switch") ? t.split("\n").filter((l) => /^\s+\$ /.test(l)).map((l) => l.trim()) : [])),
        emitted: [],
        clientMetadata: body.client_metadata ?? null,
        lastKey: Object.keys(body).at(-1) ?? null,
      };
      requests.push(rec);
      answer(res, step ?? fault.ok(), body, rec);
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  function send(res, a) {
    res.writeHead(a.status, { "content-type": "application/json", ...a.headers }).end(JSON.stringify(a.body));
  }
  function answer(res, step, body, rec) {
    const calls = (events) => events.filter((e) => e.item?.type === "function_call").map((e) => e.item.call_id);
    if (step.kind === "json") return send(res, step);
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (step.kind === "cut") {
      rec.emitted = calls(step.events);
      res.write(sse(step.events));
      return void setTimeout(() => res.destroy(), 30);
    }
    if (step.kind === "stream") return void res.end(sse(step.events));
    const events = script(body);
    rec.emitted = calls(events);
    if (step.kind !== "slow") return void res.end(sse(events));
    (async () => {
      for (const e of events) {
        if (res.destroyed) return;
        res.write(sse([e]));
        await new Promise((r) => setTimeout(r, step.ms));
      }
      res.end();
    })();
  }

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${origin}${base}`,
    origin,
    requests,
    schedule: (marker, steps) => void schedules.set(marker, { steps: [...steps], n: 0 }),
    onToolResult: (callId, step) => void onResult.set(callId, step),
    clear: () => {
      schedules.clear();
      onResult.clear();
    },
    /** Requests carrying a marker. */
    forMarker: (marker) => requests.filter((r) => r.text.includes(marker)),
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

/** A loopback URL nothing listens on: connections are refused. */
export async function refusedUrl(path = "/v1") {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}${path}`;
}

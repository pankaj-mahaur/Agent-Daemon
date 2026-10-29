// P4.3 step 1: what the REAL pinned engine and ad's gateway each see when a provider fails,
// per scenario: the engine's turn error and retry notices, and the gateway's observation.
// AD_REAL_ENGINE=1 runs it; AD_WRITE_FIXTURE=1 also writes test/fixtures/engine-failures-0.163.json
// (the classifier's tests read it). A scripted Responses provider answers each scenario.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { CodexAppServer, resolveCodexCommand } from "../src/engine/codex/app-server.mjs";
import { createGatewayServer } from "../src/gateway/server.mjs";
import { TOKEN_HIDDEN_ARGS } from "../src/gateway/table.mjs";
import { lastUserText, sse, ev } from "../testkit/mock-responses.mjs";

const wanted = process.env.AD_REAL_ENGINE === "1";
const skip = wanted ? false : "set AD_REAL_ENGINE=1 to run the real engine";
const PINNED = resolveCodexCommand({});
const TOKEN = randomBytes(32).toString("base64url");
const KEY = ["sk", "test", "FAILfail0000FAILfail0000"].join("-");
const ENTRY = "ad-fail";
const TURN_MS = 120_000;

const json = (status, body, headers = {}) => ({ status, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const failed = (code, message) => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse([ev.created(), { type: "response.failed", response: { id: "resp-1", status: "failed", error: { code, message } } }]) });
const tomorrow = () => String(Math.floor(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1) / 1000));

// What the provider answers, by a word in the prompt.
export const SCENARIOS = {
  QUOTA: () => json(429, { error: { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota, please check your plan and billing details." } }),
  RATE1: () => json(429, { error: { type: "requests", code: "rate_limit_exceeded", message: "Rate limit reached for requests per min (RPM). Please try again in 1s." } }, { "retry-after": "1" }),
  RATE3600: () => json(429, { error: { type: "requests", code: "rate_limit_exceeded", message: "Rate limit reached." } }, { "retry-after": "3600" }),
  ORFREE: () => json(429, { error: { code: 429, message: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day", metadata: { headers: { "X-RateLimit-Limit": "50", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": `${tomorrow()}000` } } } }),
  OR402: () => json(402, { error: { code: 402, message: "This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford 120." } }),
  GEMDAY: () => json(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 50", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }, { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "36s" }] } }),
  S503: () => json(503, { error: { message: "The server is overloaded." } }),
  CTX400: () => json(400, { error: { type: "invalid_request_error", code: "context_length_exceeded", param: "input", message: "This model's maximum context length is 8192 tokens. However, your messages resulted in 9001 tokens." } }),
  CTXSSE: () => failed("context_length_exceeded", "Your input exceeds the context window of this model."),
  FAILUNK: () => failed("weird_code", "Something odd happened."),
  OVERLOAD: () => failed("server_is_overloaded", "The server is overloaded."),
  RESET: () => "reset",
};

let mock;
let gw;
let server;
let home;
let cwd;
const events = [];

before(async () => {
  if (!wanted) return;
  mock = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        // not JSON
      }
      const text = body ? lastUserText(body) : "";
      const name = Object.keys(SCENARIOS).find((k) => text.includes(k));
      const a = name ? SCENARIOS[name]() : null;
      if (a === "reset") return void req.socket.destroy();
      if (!a) return void res.writeHead(500).end("no scenario");
      res.writeHead(a.status, a.headers).end(a.body);
    });
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const mockUrl = `http://127.0.0.1:${mock.address().port}/v1`;
  const table = new Map([[ENTRY, { accountId: "acct_fail", provider: "openai", upstreamBase: mockUrl, mode: "passthrough", auth: { kind: "static-key", scheme: "bearer" }, headers: {}, allowHttp: true, label: "OpenAI · test" }]]);
  gw = createGatewayServer({ token: TOKEN, table, keys: { acct_fail: KEY }, sealKey: randomBytes(32), onUpstream: (e) => events.push(e) });
  const port = await gw.listen();
  home = mkdtempSync(join(tmpdir(), "ad-fail-home-"));
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "ad-fail-work-")));
  writeFileSync(
    join(home, "config.toml"),
    [
      'model = "gpt-test"',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      'model_provider = "fail"',
      "check_for_update_on_startup = false",
      'cli_auth_credentials_store = "file"',
      "",
      "[features]",
      "plugins = false",
      "apps = false",
      "shell_snapshot = false",
      "unbounded_connection_retries = false",
      "",
      "[model_providers.fail]",
      'name = "OpenAI · test"',
      `base_url = "http://127.0.0.1:${port}/p/${ENTRY}/v1"`,
      'env_key = "AD_GATEWAY_TOKEN"',
      'wire_api = "responses"',
      "request_max_retries = 1",
      "stream_max_retries = 1",
      "supports_websockets = false",
      "",
    ].join("\n"),
  );
  server = new CodexAppServer({ command: PINNED, cwd, env: { CODEX_HOME: home, AD_GATEWAY_TOKEN: TOKEN }, codexArgs: [...TOKEN_HIDDEN_ARGS], clientVersion: "test", initTimeoutMs: 120_000, onServerRequest: async () => "decline" });
  await server.start();
});

after(async () => {
  if (!wanted) return;
  await server?.close().catch(() => {});
  await gw?.close();
  await new Promise((r) => mock?.close(r));
  for (const d of [home, cwd]) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

async function turn(text) {
  const { thread } = await server.request("thread/start", { cwd });
  const notes = [];
  const on = (n) => n.params?.threadId === thread.id && notes.push(n);
  server.on("notification", on);
  const from = events.length;
  try {
    const done = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`turn ${text} didn't finish`)), TURN_MS);
      server.on("notification", function f({ method, params }) {
        if (method === "turn/completed" && params.threadId === thread.id) {
          clearTimeout(t);
          server.off("notification", f);
          resolve(params);
        }
      });
    });
    await server.request("turn/start", { threadId: thread.id, input: [{ type: "text", text }] });
    const completed = await done;
    await new Promise((r) => setTimeout(r, 200)); // the gateway's last event
    return {
      status: completed.turn?.status ?? null,
      turnError: completed.turn?.error ?? null,
      retries: notes.filter((n) => n.method === "error" && n.params.willRetry).map((n) => ({ message: n.params.error?.message ?? null, info: n.params.error?.codexErrorInfo ?? null })),
      gateway: events.slice(from).map((e) => ({ status: e.status, retryAfterS: e.retryAfterS, error: e.error, translate: e.translate ?? null })),
    };
  } finally {
    server.off("notification", on);
  }
}

test("each provider failure: the engine's turn error and the gateway's observation are recorded", { skip, timeout: TURN_MS * 14 }, async () => {
  const out = {};
  for (const name of Object.keys(SCENARIOS)) out[name] = await turn(`${name} please`);
  for (const [name, r] of Object.entries(out)) {
    assert.equal(r.status, "failed", `${name}: ${JSON.stringify(r)}`);
    assert.ok(r.turnError, name);
    if (name !== "RESET" && name !== "CTXSSE" && name !== "FAILUNK" && name !== "OVERLOAD") assert.ok(r.gateway.length >= 1, `${name}: the gateway saw it`);
  }
  assert.ok(!JSON.stringify(out).includes(KEY), "never the key");
  if (process.env.AD_WRITE_FIXTURE === "1") {
    const file = fileURLToPath(new URL("./fixtures/engine-failures-0.163.json", import.meta.url));
    writeFileSync(file, `${JSON.stringify({ engine: "0.163.0", recorded: new Date().toISOString().slice(0, 10), scenarios: out }, null, 2)}\n`);
  }
});

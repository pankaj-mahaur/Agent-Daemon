// P6.2 contract: each wave-2 provider's dangerous shapes through ad's gateway into a mock
// of that provider (its route from the real preset, only the address pointed at the mock).

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createGatewayServer } from "../src/gateway/server.mjs";
import { gatewayTable, PRESETS, threadConfigFor } from "../src/gateway/table.mjs";
import { PROVIDER_PRESETS } from "../src/providers/registry.mjs";
import { createSseParser } from "../src/gateway/translate/sse.mjs";
import { chat, startMockChat } from "../testkit/mock-chat.mjs";

const TOKEN = "t".repeat(43);
const KEY = ["prov", "test", "0000111122223333"].join("_");

async function withProvider(id, script, fn, { preset = {} } = {}) {
  const mock = await startMockChat({ script });
  const entry = `ad-${id}-test`;
  const doc = { accounts: [{ id: "acct_p", provider: id, label: "t", method: "api-key", status: "ready", providerEntry: entry }] };
  const table = gatewayTable(doc, { presets: { ...PRESETS, [id]: { ...PRESETS[id], baseUrl: mock.url, ...preset } } });
  for (const r of table.values()) r.allowHttp = true;
  const events = [];
  const gw = createGatewayServer({ token: TOKEN, table, keys: { acct_p: KEY }, onUpstream: (e) => events.push(e), sealKey: randomBytes(32) });
  const port = await gw.listen();
  const post = async (body) => {
    const r = await fetch(`http://127.0.0.1:${port}/p/${entry}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await r.text();
    const sse = [];
    if ((r.headers.get("content-type") ?? "").includes("event-stream")) {
      const p = createSseParser({ onEvent: (e) => sse.push(JSON.parse(e.data)) });
      p.push(text);
      p.end();
    }
    return { status: r.status, text, sse, json: () => JSON.parse(text) };
  };
  try {
    await fn({ post, mock, events, table, entry });
  } finally {
    await gw.close();
    await mock.close();
  }
}

const TOOLS = [{ type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } }, strict: true }];
const req = (model, input, extra = {}) => ({ model, input: typeof input === "string" ? [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }] : input, tools: TOOLS, tool_choice: "auto", stream: true, ...extra });
const err429 = (json, headers = {}) => () => ({ status: 429, json, headers });

test("Groq: a daily limit (TPD) with retry-after 7 → insufficient_quota, quotaExhausted/day, one upstream request", async () => {
  await withProvider("groq", err429({ error: { message: "Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` on tokens per day (TPD): Limit 200000, Used 199990. Please try again in 7m12s.", type: "tokens", code: "rate_limit_exceeded" } }, { "retry-after": "7" }), async ({ post, mock, events }) => {
    const r = await post(req("openai/gpt-oss-120b", "hi"));
    assert.equal(r.status, 429);
    assert.equal(r.json().error.code, "insufficient_quota");
    assert.equal(events[0].translate.kind, "quotaExhausted");
    assert.equal(events[0].translate.period, "day");
    assert.equal(mock.requests.length, 1);
  });
});

test("Gemini: a PerDay quota with retryDelay 36s → insufficient_quota; a PerMinute one → a rate limit", async () => {
  const body = (quotaId) => [{ error: { code: 429, message: "You exceeded your current quota, please check your plan and billing details.", status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId }] }, { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "36s" }] } }];
  for (const [quotaId, code] of [["GenerateRequestsPerDayPerProjectPerModel-FreeTier", "insufficient_quota"], ["GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "rate_limit_exceeded"]]) {
    await withProvider("gemini", err429(body(quotaId)), async ({ post }) => {
      const r = await post(req("gemini-3.8-flash", "hi"));
      assert.equal(r.json().error.code, code, quotaId);
    });
  }
});

test("an unknown 4xx body → invalid_request, class unknown (never a fallback trigger)", async () => {
  await withProvider("cerebras", () => ({ status: 418, json: { strange: true } }), async ({ post, events }) => {
    const r = await post(req("gpt-oss-120b", "hi"));
    assert.equal(r.status, 400);
    assert.equal(events[0].translate.kind, "unknown");
  });
});

test("Z.ai: a 429 with business code 1113 (balance) is a quota; 1302 is a rate limit", async () => {
  for (const [code, want] of [["1113", "insufficient_quota"], ["1302", "rate_limit_exceeded"]]) {
    await withProvider("zai", err429({ error: { code, message: code === "1113" ? "Insufficient balance or no resource package." : "Rate limit reached for requests" } }), async ({ post }) => {
      assert.equal((await post(req("glm-5.3", "hi"))).json().error.code, want, code);
    });
  }
});

test("Anthropic: the monthly spend cap (429 with details.error_code, no retry-after) is a quota; its requests never carry strict", async () => {
  await withProvider("anthropic", err429({ type: "error", error: { type: "rate_limit_error", message: "You have reached your API usage limits.", details: { error_code: "enforced_spend_limit_reached" } } }), async ({ post, mock }) => {
    const r = await post(req("claude-sonnet-5-5", "hi"));
    assert.equal(r.json().error.code, "insufficient_quota");
    assert.ok(!JSON.stringify(mock.requests[0].body).includes('"strict"'), "strict never sent");
  });
});

test("MiniMax: tool_choice required is refused before sending; Z.ai takes only auto", async () => {
  await withProvider("minimax", () => assert.fail("nothing is sent"), async ({ post, mock }) => {
    const r = await post(req("MiniMax-M3", "hi", { tool_choice: "required" }));
    assert.equal(r.status, 400);
    assert.equal(r.json().error.param, "tool_choice");
    assert.equal(mock.requests.length, 0);
  });
  await withProvider("zai", () => assert.fail("nothing is sent"), async ({ post, mock }) => {
    assert.equal((await post(req("glm-5.3", "hi", { tool_choice: "none" }))).status, 400);
    assert.equal(mock.requests.length, 0);
  });
});

test("Hugging Face: the :provider suffix reaches the router intact", async () => {
  await withProvider("huggingface", () => ({ chunks: [chat.text("ok"), chat.finish("stop"), "[DONE]"] }), async ({ post, mock }) => {
    await post(req("zai-org/GLM-5.3:baseten", "hi"));
    assert.equal(mock.requests[0].body.model, "zai-org/GLM-5.3:baseten");
  });
});

test("Mistral: tool-call ids on the wire are 9 characters, the same on the call and its result", async () => {
  await withProvider("mistral", () => ({ chunks: [chat.text("ok"), chat.finish("stop"), "[DONE]"] }), async ({ post, mock }) => {
    await post(req("devstral-latest", [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }, { type: "function_call", call_id: "call_engine_abcdef", name: "exec_command", arguments: "{}" }, { type: "function_call_output", call_id: "call_engine_abcdef", output: "ok" }]));
    const m = mock.requests[0].body.messages;
    const id = m.find((x) => x.tool_calls).tool_calls[0].id;
    assert.match(id, /^[A-Za-z0-9]{9}$/);
    assert.equal(m.find((x) => x.role === "tool").tool_call_id, id);
  });
});

test("Gemini compat (a chat route with the gemini-compat quirk): a tool call's thought signature comes back on that call", async () => {
  let turn = 0;
  const script = () => (turn++ === 0 ? { chunks: [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "g1", type: "function", function: { name: "exec_command", arguments: '{"cmd":"ls"}' }, extra_content: { google: { thought_signature: "sig-abc" } } }] }, finish_reason: null }] }, chat.finish("tool_calls"), "[DONE]"] } : { chunks: [chat.text("done"), chat.finish("stop"), "[DONE]"] });
  await withProvider("gemini", script, async ({ post, mock }) => {
    const first = await post(req("gemini-3.8-flash", "list"));
    const items = first.sse.filter((e) => e.type === "response.output_item.done").map((e) => e.item);
    const call = items.find((i) => i.type === "function_call");
    const envelope = items.find((i) => i.type === "reasoning" && i.encrypted_content);
    assert.ok(call && envelope, "a call and its sealed signature");
    assert.ok(!envelope.encrypted_content.includes("sig-abc"), "sealed, not readable");
    await post(req("gemini-3.8-flash", [{ type: "message", role: "user", content: [{ type: "input_text", text: "list" }] }, envelope, call, { type: "function_call_output", call_id: call.call_id, output: "a.txt" }]));
    const sent = mock.requests[1].body.messages.find((m) => m.tool_calls).tool_calls[0];
    assert.deepEqual(sent.extra_content, { google: { thought_signature: "sig-abc" } });
  }, { preset: { mode: "chat", upstreamPath: "/chat/completions", quirks: ["gemini-compat"], authHeader: null } });
});

test("DeepSeek: its reasoning comes back as reasoning_content on the next request", async () => {
  let turn = 0;
  const script = () => (turn++ === 0 ? { chunks: [chat.reasoning("think first"), chat.call(0, { id: "d1", name: "exec_command", args: '{"cmd":"ls"}' }), chat.finish("tool_calls"), "[DONE]"] } : { chunks: [chat.text("done"), chat.finish("stop"), "[DONE]"] });
  await withProvider("deepseek", script, async ({ post, mock }) => {
    const first = await post(req("deepseek-v4-pro", "list"));
    const items = first.sse.filter((e) => e.type === "response.output_item.done").map((e) => e.item);
    const rs = items.find((i) => i.type === "reasoning");
    const call = items.find((i) => i.type === "function_call");
    await post(req("deepseek-v4-pro", [{ type: "message", role: "user", content: [{ type: "input_text", text: "list" }] }, rs, call, { type: "function_call_output", call_id: call.call_id, output: "a.txt" }]));
    assert.equal(mock.requests[1].body.messages.find((m) => m.tool_calls).reasoning_content, "think first");
  });
});

test("a wave-2 model's context window reaches its thread through the route", () => {
  const doc = { accounts: [{ id: "a", provider: "gemini", label: "t", method: "api-key", status: "ready", providerEntry: "ad-gemini-x" }] };
  assert.equal(threadConfigFor(gatewayTable(doc), { model: "gemini-3.8-flash", modelProvider: "ad-gemini-x" }).model_context_window, 1048576);
});

test("presets: https, dated docs, a status, windows for listed models; trial and data notices where the terms call for them", () => {
  const wave2 = PROVIDER_PRESETS.filter((p) => ["chat", "anthropic", "gemini"].includes(p.mode));
  assert.equal(wave2.length, 14);
  for (const p of wave2) {
    assert.match(p.upstreamBase, /^https:\/\//, p.id);
    assert.ok(p.docs.length && /^\d{4}-\d{2}-\d{2}$/.test(p.checkedAt), p.id);
    assert.ok(["candidate", "blocked"].includes(p.status), `${p.id}: no real-key acceptance yet`);
    assert.ok(!/(sk|gsk|nvapi|xai)[-_][A-Za-z0-9]{16}/.test(JSON.stringify(p)), `${p.id}: no key-shaped strings`);
    if (p.status !== "blocked" && p.id !== "nvidia") assert.ok(Object.keys(p.contextWindows ?? {}).length, `${p.id}: context windows`);
  }
  assert.match(PROVIDER_PRESETS.find((p) => p.id === "nvidia").privacy.notice, /^NVIDIA's hosted models are for trial use\. Don't send personal or confidential code\.$/);
  assert.ok(PROVIDER_PRESETS.find((p) => p.id === "gemini").privacy.notice);
  assert.match(PROVIDER_PRESETS.find((p) => p.id === "zai-coding").blockedReason, /^Z\.ai Coding Plan — not available yet/);
});

test("MiniMax: base_resp failures (HTTP 200 or an error status) reach the classifier: 1008 balance → insufficient_quota", async () => {
  await withProvider("minimax", () => ({ chunks: [{ base_resp: { status_code: 1008, status_msg: "insufficient balance" } }] }), async ({ post, mock }) => {
    const r = await post(req("MiniMax-M3", "hi"));
    assert.equal(r.sse.at(-1).response.error.code, "insufficient_quota");
    assert.equal(mock.requests.length, 1);
  });
  await withProvider("minimax", () => ({ status: 429, json: { base_resp: { status_code: 1008, status_msg: "insufficient balance" } } }), async ({ post }) => {
    assert.equal((await post(req("MiniMax-M3", "hi"))).json().error.code, "insufficient_quota");
  });
});

test("Anthropic: 'credit balance is too low' (a 400) is a quota, not a bad request", async () => {
  await withProvider("anthropic", () => ({ status: 400, json: { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } } }), async ({ post, events }) => {
    const r = await post(req("claude-haiku-5-5", "hi"));
    assert.equal(r.json().error.code, "insufficient_quota");
    assert.equal(events[0].translate.kind, "quotaExhausted");
  });
});

test("Groq: a 429 without day wording but its daily request counter at 0 is the daily limit", async () => {
  await withProvider("groq", () => ({ status: 429, json: { error: { message: "Rate limit reached for requests", code: "rate_limit_exceeded" } }, headers: { "x-ratelimit-remaining-requests": "0", "retry-after": "2" } }), async ({ post, events }) => {
    assert.equal((await post(req("openai/gpt-oss-120b", "hi"))).json().error.code, "insufficient_quota");
    assert.equal(events[0].translate.period, "day");
  });
  await withProvider("groq", () => ({ status: 429, json: { error: { message: "Rate limit reached on tokens per minute (TPM)", code: "rate_limit_exceeded" } }, headers: { "x-ratelimit-remaining-requests": "990", "retry-after": "2" } }), async ({ post }) => {
    assert.equal((await post(req("openai/gpt-oss-120b", "hi"))).json().error.code, "rate_limit_exceeded");
  });
});

test("context windows: Gemini compacts by its free tier's cap; a default target's model carries its window", async () => {
  const { apiEngineArgs } = await import("../src/gateway/table.mjs");
  const doc = { accounts: [{ id: "a", provider: "gemini", label: "t", method: "api-key", status: "ready", providerEntry: "ad-gemini-x" }], defaults: { target: { account: "a", model: "gemini-3.8-flash" } } };
  const table = gatewayTable(doc);
  assert.deepEqual(threadConfigFor(table, { model: "gemini-3.8-flash", modelProvider: "ad-gemini-x" }), { model_context_window: 1048576, model_auto_compact_token_limit: 250000 });
  const args = apiEngineArgs(doc, table).join(" ");
  assert.match(args, /model_context_window=1048576/);
  assert.match(args, /model_auto_compact_token_limit=250000/);
});

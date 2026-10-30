// P6.4: the native adapters (Anthropic Messages, Gemini streamGenerateContent) through the
// gateway: the request shapes, the stream into the engine's items, thinking and signature
// round trips, the terminal codes, and a key that never travels in an address.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createGatewayServer } from "../src/gateway/server.mjs";
import { gatewayTable, PRESETS } from "../src/gateway/table.mjs";
import { createSseParser } from "../src/gateway/translate/sse.mjs";
import { NO_SIGNATURE_TEXT } from "../src/gateway/translate/upstream/gemini.mjs";
import { anthropicSse, startMockNative } from "../testkit/mock-native.mjs";

const TOKEN = "t".repeat(43);
const KEY = ["native", "test", "key", "0000111122223333"].join("_");

async function withNative(id, script, fn, { seal = randomBytes(32) } = {}) {
  const mock = await startMockNative({ script });
  const entry = `ad-${id}-test`;
  const doc = { accounts: [{ id: "acct_n", provider: id, label: "t", method: "api-key", status: "ready", providerEntry: entry }] };
  const table = gatewayTable(doc, { presets: { ...PRESETS, [id]: { ...PRESETS[id], baseUrl: mock.url } } });
  for (const r of table.values()) r.allowHttp = true;
  const events = [];
  const gw = createGatewayServer({ token: TOKEN, table, keys: { acct_n: KEY }, onUpstream: (e) => events.push(e), sealKey: seal });
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
    const items = sse.filter((e) => e.type === "response.output_item.done").map((e) => e.item);
    return { status: r.status, text, sse, items, json: () => JSON.parse(text) };
  };
  try {
    await fn({ post, mock, events });
  } finally {
    await gw.close();
    await mock.close();
  }
}

const TOOLS = [
  { type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
  { type: "custom", name: "apply_patch", description: "Edit files.", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } },
];
const user = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const req = (model, input, extra = {}) => ({ model, input: typeof input === "string" ? [{ type: "message", role: "developer", content: [{ type: "input_text", text: "be brief" }] }, user(input)] : input, tools: TOOLS, tool_choice: "auto", stream: true, ...extra });

// ---------- Anthropic ----------

const msgStart = { type: "message_start", message: { id: "m1", usage: { input_tokens: 10, output_tokens: 0 } } };
const stop = (reason, out = 5) => [{ type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: out } }, { type: "message_stop" }];

test("Anthropic: the request: key in x-api-key (no Bearer), the pinned version, system on top with caching, max_tokens", async () => {
  await withNative("anthropic", () => ({ events: anthropicSse([msgStart, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }, { type: "content_block_stop", index: 0 }, ...stop("end_turn")]) }), async ({ post, mock }) => {
    const r = await post(req("claude-haiku-5-5", "hello"));
    assert.equal(r.sse.at(-1).type, "response.completed");
    assert.equal(r.items.find((i) => i.type === "message").content[0].text, "hi");
    const q = mock.requests[0];
    assert.equal(q.url, "/v1/messages");
    assert.equal(q.headers["x-api-key"], KEY);
    assert.equal(q.headers.authorization, undefined);
    assert.equal(q.headers["anthropic-version"], "2023-06-01");
    assert.deepEqual(q.body.system, [{ type: "text", text: "be brief", cache_control: { type: "ephemeral" } }]);
    assert.ok(Number.isInteger(q.body.max_tokens));
    assert.deepEqual(r.sse.at(-1).response.usage.total_tokens, 15);
  });
});

test("Anthropic: a tool_use whose input JSON is split mid-string across three events → one call, exact arguments; a flattened apply_patch comes back as custom_tool_call", async () => {
  const patch = "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch\n";
  const pj = JSON.stringify({ input: patch });
  await withNative("anthropic", () => ({
    events: anthropicSse([
      msgStart,
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "exec_command", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"cmd": "ls -' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "la /tm" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'p"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_2", name: "apply_patch", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: pj.slice(0, 20) } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: pj.slice(20) } },
      { type: "content_block_stop", index: 1 },
      ...stop("tool_use"),
    ]),
  }), async ({ post }) => {
    const r = await post(req("claude-sonnet-5-5", "go"));
    const fc = r.items.find((i) => i.type === "function_call");
    assert.equal(fc.arguments, JSON.stringify({ cmd: "ls -la /tmp" }));
    const cc = r.items.find((i) => i.type === "custom_tool_call");
    assert.equal(cc.name, "apply_patch");
    assert.equal(cc.input, patch);
    assert.equal(r.sse.at(-1).type, "response.completed");
  });
});

test("Anthropic: thinking and its signature are sealed, then sent back byte-identical before the tool_use; both tool results in one user message right after", async () => {
  const sig = "EqoBCkgIARABGAIi" + "x".repeat(40);
  let turn = 0;
  const script = () =>
    turn++ === 0
      ? {
          events: anthropicSse([
            msgStart,
            { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me " } },
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "list files." } },
            { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: sig } },
            { type: "content_block_stop", index: 0 },
            { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_a", name: "exec_command", input: {} } },
            { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"cmd":"ls"}' } },
            { type: "content_block_stop", index: 1 },
            { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_b", name: "exec_command", input: {} } },
            { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"cmd":"pwd"}' } },
            { type: "content_block_stop", index: 2 },
            ...stop("tool_use"),
          ]),
        }
      : { events: anthropicSse([msgStart, { type: "content_block_start", index: 0, content_block: { type: "text", text: "done" } }, { type: "content_block_stop", index: 0 }, ...stop("end_turn")]) };
  await withNative("anthropic", script, async ({ post, mock }) => {
    const first = await post(req("claude-opus-5-5", "list", { reasoning: { effort: "medium" } }));
    assert.equal(mock.requests[0].body.thinking?.type, "enabled", "thinking asked for");
    const rs = first.items.find((i) => i.type === "reasoning");
    assert.ok(rs?.encrypted_content && !rs.encrypted_content.includes(sig), "sealed");
    const calls = first.items.filter((i) => i.type === "function_call");
    assert.equal(calls.length, 2);
    const input = [user("list"), rs, ...calls, ...calls.map((c) => ({ type: "function_call_output", call_id: c.call_id, output: "ok" }))];
    await post(req("claude-opus-5-5", input, { reasoning: { effort: "medium" } }));
    const msgs = mock.requests[1].body.messages;
    const a = msgs.findIndex((m) => m.role === "assistant");
    assert.deepEqual(msgs[a].content[0], { type: "thinking", thinking: "Let me list files.", signature: sig }, "byte-identical, first");
    assert.deepEqual(msgs[a].content.slice(1).map((b) => b.type), ["tool_use", "tool_use"]);
    assert.equal(msgs[a + 1].role, "user");
    assert.deepEqual(msgs[a + 1].content.map((b) => b.type), ["tool_result", "tool_result"], "both results, one message");
    assert.equal(mock.requests[1].body.thinking?.type, "enabled");
  });
});

test("Anthropic: the spend cap (429, no retry-after) → insufficient_quota after one request; 529 → server_is_overloaded", async () => {
  await withNative("anthropic", () => ({ status: 429, json: { type: "error", error: { type: "rate_limit_error", message: "You have reached your API usage limits.", details: { error_code: "enforced_spend_limit_reached" } } } }), async ({ post, mock }) => {
    assert.equal((await post(req("claude-haiku-5-5", "x"))).json().error.code, "insufficient_quota");
    assert.equal(mock.requests.length, 1);
  });
  await withNative("anthropic", () => ({ status: 529, json: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } }), async ({ post }) => {
    const r = await post(req("claude-haiku-5-5", "x"));
    assert.equal(r.status, 503);
    assert.equal(r.json().error.code, "server_is_overloaded");
  });
});

test("Anthropic: a stream cut right after a tool_use starts runs nothing; usage only in message_delta is complete or null", async () => {
  await withNative("anthropic", () => ({ events: anthropicSse([msgStart, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "exec_command", input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }]) }), async ({ post }) => {
    const r = await post(req("claude-haiku-5-5", "x"));
    assert.equal(r.items.filter((i) => i.type === "function_call").length, 0);
    assert.equal(r.sse.at(-1).response.error.code, "ad_upstream_disconnected");
  });
  await withNative("anthropic", () => ({ events: anthropicSse([{ type: "message_start", message: { id: "m" } }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "a" } }, { type: "content_block_stop", index: 0 }, ...stop("end_turn")]) }), async ({ post }) => {
    assert.equal((await post(req("claude-haiku-5-5", "x"))).sse.at(-1).response.usage, null, "never partial");
  });
});

test("Anthropic: max_tokens → incomplete max_output_tokens; refusal → content_filter", async () => {
  for (const [reason, want] of [["max_tokens", "max_output_tokens"], ["refusal", "content_filter"]]) {
    await withNative("anthropic", () => ({ events: anthropicSse([msgStart, { type: "content_block_start", index: 0, content_block: { type: "text", text: "a" } }, { type: "content_block_stop", index: 0 }, ...stop(reason)]) }), async ({ post }) => {
      assert.equal((await post(req("claude-haiku-5-5", "x"))).sse.at(-1).response.incomplete_details.reason, want, reason);
    });
  }
});

// ---------- Gemini ----------

const gchunk = (parts, extra = {}) => ({ data: { candidates: [{ content: { role: "model", parts }, ...extra }] } });

test("Gemini: the key never travels in the address: x-goog-api-key header, model in the path, ?alt=sse only", async () => {
  await withNative("gemini", () => ({ events: [gchunk([{ text: "hi" }]), gchunk([], { finishReason: "STOP" })] }), async ({ post, mock }) => {
    const r = await post(req("gemini-3.8-flash", "hello"));
    assert.equal(r.sse.at(-1).type, "response.completed");
    const q = mock.requests[0];
    assert.equal(q.url, "/v1/models/gemini-3.8-flash:streamGenerateContent?alt=sse");
    assert.ok(!q.url.includes(KEY) && !/key=/i.test(q.url));
    assert.equal(q.headers["x-goog-api-key"], KEY);
    assert.equal(q.headers.authorization, undefined);
    assert.deepEqual(q.body.systemInstruction, { parts: [{ text: "be brief" }] });
  });
});

test("Gemini: a function call's thought signature comes back on that call's part; functionResponse.name from the history", async () => {
  let turn = 0;
  const script = () => (turn++ === 0 ? { events: [gchunk([{ text: "thinking about it", thought: true }, { functionCall: { name: "exec_command", args: { cmd: "ls" } }, thoughtSignature: "sigGem123" }]), gchunk([], { finishReason: "STOP" })] } : { events: [gchunk([{ text: "done" }], { finishReason: "STOP" })] });
  await withNative("gemini", script, async ({ post, mock }) => {
    const first = await post(req("gemini-3.8-flash", "list"));
    assert.equal(first.sse.at(-1).type, "response.completed");
    const call = first.items.find((i) => i.type === "function_call");
    assert.equal(call.arguments, JSON.stringify({ cmd: "ls" }));
    const envelopes = first.items.filter((i) => i.type === "reasoning" && i.encrypted_content);
    assert.ok(envelopes.length && !JSON.stringify(envelopes).includes("sigGem123"));
    await post(req("gemini-3.8-flash", [user("list"), ...first.items.filter((i) => i.type === "reasoning"), call, { type: "function_call_output", call_id: call.call_id, output: "a.txt" }]));
    const contents = mock.requests[1].body.contents;
    const model = contents.find((c) => c.role === "model");
    const part = model.parts.find((p) => p.functionCall);
    assert.equal(part.thoughtSignature, "sigGem123");
    const resp = contents.at(-1).parts.find((p) => p.functionResponse);
    assert.equal(resp.functionResponse.name, "exec_command");
    assert.deepEqual(resp.functionResponse.response, { output: "a.txt" });
  });
});

test("Gemini: a current-turn call without its signature is refused before sending (never a fabricated one)", async () => {
  await withNative("gemini", () => assert.fail("nothing is sent"), async ({ post, mock }) => {
    const r = await post(req("gemini-3.8-flash", [user("list"), { type: "function_call", call_id: "call_x", name: "exec_command", arguments: "{}" }, { type: "function_call_output", call_id: "call_x", output: "ok" }]));
    assert.equal(r.status, 400);
    assert.equal(r.json().error.message, NO_SIGNATURE_TEXT);
    assert.equal(mock.requests.length, 0);
  });
});

test("Gemini: a daily quota with retryDelay 36s → insufficient_quota/day after one request; SAFETY → content_filter", async () => {
  const body = { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota.", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }, { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "36s" }] } };
  await withNative("gemini", () => ({ status: 429, json: body }), async ({ post, mock, events }) => {
    assert.equal((await post(req("gemini-3.8-flash", "x"))).json().error.code, "insufficient_quota");
    assert.equal(events[0].translate.period, "day");
    assert.equal(mock.requests.length, 1);
  });
  await withNative("gemini", () => ({ events: [gchunk([{ text: "par" }]), gchunk([], { finishReason: "SAFETY" })] }), async ({ post }) => {
    assert.equal((await post(req("gemini-3.8-flash", "x"))).sse.at(-1).response.incomplete_details.reason, "content_filter");
  });
});

test("Gemini: a model id that could bend the path is refused before sending", async () => {
  await withNative("gemini", () => assert.fail("nothing is sent"), async ({ post, mock }) => {
    assert.equal((await post(req("../models/x", "hi"))).status, 400);
    assert.equal(mock.requests.length, 0);
  });
});

test("cross-provider: an Anthropic thinking envelope on a Gemini route is dropped (and the reverse)", async () => {
  const seal = randomBytes(32);
  let anthEnvelope;
  await withNative("anthropic", () => ({ events: anthropicSse([msgStart, { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "secret plan" } }, { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "s1" } }, { type: "content_block_stop", index: 0 }, { type: "content_block_start", index: 1, content_block: { type: "text", text: "ok" } }, { type: "content_block_stop", index: 1 }, ...stop("end_turn")]) }), async ({ post }) => {
    anthEnvelope = (await post(req("claude-opus-5-5", "x", { reasoning: { effort: "low" } }))).items.find((i) => i.type === "reasoning");
  }, { seal });
  await withNative("gemini", () => ({ events: [gchunk([{ text: "ok" }], { finishReason: "STOP" })] }), async ({ post, mock }) => {
    await post(req("gemini-3.8-flash", [user("x"), anthEnvelope, { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }, user("y")]));
    assert.ok(!JSON.stringify(mock.requests[0].body).includes("secret plan"));
  }, { seal });
});

test("the gateway never sends a key in an address, whoever put it there", async () => {
  const mock = await startMockNative({ script: () => assert.fail("nothing is sent") });
  const entry = "ad-groq-keyurl";
  const doc = { accounts: [{ id: "acct_k", provider: "groq", label: "t", method: "api-key", status: "ready", providerEntry: entry }] };
  const table = gatewayTable(doc, { presets: { ...PRESETS, groq: { ...PRESETS.groq, baseUrl: mock.url, upstreamPath: "/chat/completions?key=leak" } } });
  for (const r of table.values()) r.allowHttp = true;
  const gw = createGatewayServer({ token: TOKEN, table, keys: { acct_k: KEY } });
  const port = await gw.listen();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/p/${entry}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(req("llama", "x")) });
    assert.equal(r.status, 502);
    assert.match((await r.json()).error.message, /key in a request address/);
    assert.equal(mock.requests.length, 0);
  } finally {
    await gw.close();
    await mock.close();
  }
});

test("Gemini: parallel calls carry one signature (on the first): the loop continues", async () => {
  let turn = 0;
  const script = () => (turn++ === 0 ? { events: [gchunk([{ functionCall: { name: "exec_command", args: { cmd: "a" } }, thoughtSignature: "sigFirst" }, { functionCall: { name: "exec_command", args: { cmd: "b" } } }]), gchunk([], { finishReason: "STOP" })] } : { events: [gchunk([{ text: "done" }], { finishReason: "STOP" })] });
  await withNative("gemini", script, async ({ post, mock }) => {
    const first = await post(req("gemini-3.8-flash", "both"));
    const calls = first.items.filter((i) => i.type === "function_call");
    assert.equal(calls.length, 2);
    const r = await post(req("gemini-3.8-flash", [user("both"), ...first.items.filter((i) => i.type === "reasoning"), ...calls, ...calls.map((c) => ({ type: "function_call_output", call_id: c.call_id, output: "ok" }))]));
    assert.equal(r.status, 200, r.text);
    const parts = mock.requests[1].body.contents.find((c) => c.role === "model").parts.filter((p) => p.functionCall);
    assert.equal(parts[0].thoughtSignature, "sigFirst");
    assert.equal(parts[1].thoughtSignature, undefined);
  });
});

test("Gemini without a seal key (the secret store failed): signatures are kept in memory and the loop continues", async () => {
  let turn = 0;
  const script = () => (turn++ === 0 ? { events: [gchunk([{ functionCall: { name: "exec_command", args: { cmd: "ls" } }, thoughtSignature: "sigMem" }]), gchunk([], { finishReason: "STOP" })] } : { events: [gchunk([{ text: "done" }], { finishReason: "STOP" })] });
  await withNative("gemini", script, async ({ post, mock }) => {
    const first = await post(req("gemini-3.8-flash", "list"));
    const call = first.items.find((i) => i.type === "function_call");
    assert.ok(!first.items.some((i) => i.type === "reasoning" && i.encrypted_content), "nothing sealed");
    const r = await post(req("gemini-3.8-flash", [user("list"), call, { type: "function_call_output", call_id: call.call_id, output: "ok" }]));
    assert.equal(r.status, 200, r.text);
    assert.equal(mock.requests[1].body.contents.find((c) => c.role === "model").parts[0].thoughtSignature, "sigMem");
  }, { seal: null });
});

test("Gemini: a blocked prompt ends as content_filter, not a cut-off; Anthropic's full window ends as a context error", async () => {
  await withNative("gemini", () => ({ events: [{ data: { promptFeedback: { blockReason: "SAFETY" } } }] }), async ({ post }) => {
    assert.equal((await post(req("gemini-3.8-flash", "x"))).sse.at(-1).response.incomplete_details?.reason, "content_filter");
  });
  await withNative("anthropic", () => ({ events: anthropicSse([msgStart, { type: "content_block_start", index: 0, content_block: { type: "text", text: "a" } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "model_context_window_exceeded" }, usage: { output_tokens: 1 } }, { type: "message_stop" }]) }), async ({ post }) => {
    assert.equal((await post(req("claude-haiku-5-5", "x"))).sse.at(-1).response.error.code, "context_length_exceeded");
  });
});

test("Anthropic: merged assistant turns keep thinking first; parallel off without a tool_choice; empty turns are skipped", async () => {
  const { anthropicRequest } = await import("../src/gateway/translate/upstream/anthropic.mjs");
  const { buildToolMap } = await import("../src/gateway/translate/tools.mjs");
  const turn = {
    model: "claude-opus-5-5",
    toolMap: buildToolMap([{ type: "function", name: "exec_command", parameters: { type: "object" } }]),
    toolChoice: null,
    parallelToolCalls: false,
    maxOutputTokens: null,
    reasoningEffort: null,
    temperature: null,
    messages: [
      { role: "user", content: "go" },
      { role: "user", content: "" },
      { role: "assistant", content: "first", thinkingBlocks: [{ type: "thinking", thinking: "t1", signature: "s1" }] },
      { role: "assistant", content: null, thinkingBlocks: [{ type: "thinking", thinking: "t2", signature: "s2" }], tool_calls: [{ id: "c1", type: "function", function: { name: "exec_command", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ],
  };
  const { body } = anthropicRequest(turn, {});
  assert.deepEqual(body.messages[0], { role: "user", content: [{ type: "text", text: "go" }] }, "the empty turn left out");
  assert.deepEqual(body.messages[1].content.map((b) => b.type), ["thinking", "thinking", "text", "tool_use"]);
  assert.deepEqual(body.tool_choice, { type: "auto", disable_parallel_tool_use: true });
});

test("Anthropic: an empty user turn between two assistant turns is left out, so roles still alternate", async () => {
  const { anthropicRequest } = await import("../src/gateway/translate/upstream/anthropic.mjs");
  const { buildToolMap } = await import("../src/gateway/translate/tools.mjs");
  const { body } = anthropicRequest({ model: "m", toolMap: buildToolMap([]), toolChoice: null, parallelToolCalls: null, maxOutputTokens: null, reasoningEffort: null, temperature: null, messages: [{ role: "user", content: "go" }, { role: "assistant", content: "a" }, { role: "user", content: "" }, { role: "assistant", content: "b" }] }, {});
  assert.deepEqual(body.messages.map((m) => m.role), ["user", "assistant"]);
  assert.ok(body.messages.every((m) => m.content.length > 0));
});

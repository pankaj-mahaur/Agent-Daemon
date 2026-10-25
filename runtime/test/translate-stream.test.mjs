// P6.1 §5–6: Chat stream → the engine's Responses events, with the tool-call guards.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { buildToolMap } from "../src/gateway/translate/tools.mjs";
import { pipeAnswer } from "../src/gateway/translate/index.mjs";
import { createSseParser } from "../src/gateway/translate/sse.mjs";

const TOOLS = [
  { type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
  { type: "namespace", name: "agent_daemon_memory", tools: [{ type: "function", name: "memory_search", parameters: { type: "object", properties: {} } }] },
  { type: "custom", name: "apply_patch", description: "Edit files.", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } },
];
const toolMap = buildToolMap(TOOLS);
const FLAT_MEM = toolMap.flat("function", "memory_search", "agent_daemon_memory");
const FLAT_PATCH = toolMap.flat("custom", "apply_patch");

const chunk = (delta, extra = {}) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null, ...extra }] })}\n\n`;
const fin = (reason, usage) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }], ...(usage ? { usage } : {}) })}\n\n`;
const DONE = "data: [DONE]\n\n";

/** Runs chunks through pipeAnswer; returns the engine-facing events. */
async function run(chunks, opts = {}) {
  let out = "";
  const res = { writeHead() {}, write: (s) => (out += s), end() {}, writableEnded: false, destroyed: false };
  const r = await pipeAnswer(Readable.from(chunks.map((c) => Buffer.from(c))), res, { turn: { model: "m", toolMap }, route: { label: "Groq", ...opts.route }, ...opts });
  const events = [];
  const p = createSseParser({ onEvent: (e) => events.push(JSON.parse(e.data)) });
  p.push(out);
  p.end();
  return { events, r, types: events.map((e) => e.type), done: events.filter((e) => e.type === "response.output_item.done").map((e) => e.item) };
}

test("text: the message item is added before its first delta; the done item holds the whole text", async () => {
  const { types, done, events } = await run([chunk({ role: "assistant", content: "po" }), chunk({ content: "ng" }), fin("stop", { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }), DONE]);
  assert.deepEqual(types.slice(0, 3), ["response.created", "response.output_item.added", "response.output_text.delta"]);
  assert.equal(done[0].type, "message");
  assert.equal(done[0].content[0].text, "pong");
  const completed = events.at(-1);
  assert.equal(completed.type, "response.completed");
  assert.ok(completed.response.id.startsWith("resp_"));
  assert.deepEqual(completed.response.usage, { input_tokens: 3, input_tokens_details: null, output_tokens: 2, output_tokens_details: null, total_tokens: 5 });
});

test("a tool call split across chunks comes out as one call with exactly its arguments", async () => {
  const { done, events } = await run([
    chunk({ tool_calls: [{ index: 0, id: "call_0", type: "function", function: { name: "exec_", arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { name: "command" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"ls -la"' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: "}" } }] }),
    fin("tool_calls"),
    DONE,
  ]);
  assert.equal(done.length, 1);
  assert.equal(done[0].type, "function_call");
  assert.equal(done[0].name, "exec_command");
  assert.equal(done[0].arguments, '{"cmd":"ls -la"}');
  assert.match(done[0].call_id, /^call_[0-9A-Za-z]{24}$/, "a minted id, never the upstream's");
  assert.equal(events.at(-1).type, "response.completed");
});

test("a namespaced tool comes back with its namespace; a custom tool as custom_tool_call with its raw input", async () => {
  const patch = "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch\n";
  const { done } = await run([
    chunk({ tool_calls: [{ index: 0, id: "x", function: { name: FLAT_MEM, arguments: "{}" } }, { index: 1, id: "y", function: { name: FLAT_PATCH, arguments: JSON.stringify({ input: patch }) } }] }),
    fin("tool_calls"),
    DONE,
  ]);
  assert.deepEqual({ type: done[0].type, name: done[0].name, namespace: done[0].namespace, arguments: done[0].arguments }, { type: "function_call", name: "memory_search", namespace: "agent_daemon_memory", arguments: "{}" });
  assert.equal(done[1].type, "custom_tool_call");
  assert.equal(done[1].name, "apply_patch");
  assert.equal(done[1].input, patch);
});

test("interleaved indexes stay apart; the same upstream id across responses gives distinct ids", async () => {
  const a = await run([
    chunk({ tool_calls: [{ index: 0, id: "call_0", function: { name: "exec_command", arguments: '{"cmd":"a' } }] }),
    chunk({ tool_calls: [{ index: 1, id: "call_1", function: { name: "exec_command", arguments: '{"cmd":"b' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"}' } }] }),
    chunk({ tool_calls: [{ index: 1, function: { arguments: '"}' } }] }),
    fin("tool_calls"),
    DONE,
  ]);
  assert.deepEqual(a.done.map((d) => d.arguments), ['{"cmd":"a"}', '{"cmd":"b"}']);
  const b = await run([chunk({ tool_calls: [{ index: 0, id: "call_0", function: { name: "exec_command", arguments: "{}" } }] }), fin("tool_calls"), DONE]);
  assert.notEqual(a.done[0].call_id, b.done[0].call_id);
});

test("a stream that ends mid-arguments emits no call and fails with the retryable code", async () => {
  const { done, events, r } = await run([chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "exec_command", arguments: '{"cmd":"rm' } }] })]);
  assert.equal(done.filter((i) => i.type === "function_call").length, 0);
  assert.equal(events.at(-1).type, "response.failed");
  assert.equal(events.at(-1).response.error.code, "ad_upstream_disconnected");
  assert.ok(events.at(-1).response.id);
  assert.equal(r.side.kind, "transientNetwork");
});

test("finish length with an open call: incomplete, no call", async () => {
  const { done, events, r } = await run([chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "exec_command", arguments: '{"cmd":"ls"}' } }] }), fin("length"), DONE]);
  assert.equal(done.filter((i) => i.type === "function_call").length, 0);
  assert.equal(events.at(-1).type, "response.incomplete");
  assert.equal(events.at(-1).response.incomplete_details.reason, "max_output_tokens");
  assert.equal(r.side.kind, "truncated");
  assert.deepEqual(r.side.droppedCalls, ["exec_command"]);
});

test("unparseable arguments or an unknown tool name: no call, a terminal incomplete", async () => {
  for (const call of [{ name: "exec_command", arguments: '{"cmd":' }, { name: "no_such_tool", arguments: "{}" }]) {
    const { done, events, r } = await run([chunk({ tool_calls: [{ index: 0, id: "c", function: call }] }), fin("tool_calls"), DONE]);
    assert.equal(done.filter((i) => i.type === "function_call").length, 0);
    assert.equal(events.at(-1).type, "response.incomplete");
    assert.equal(r.side.kind, "invalidConfig");
  }
});

test("a content filter ends as incomplete content_filter", async () => {
  const { events, r } = await run([chunk({ content: "x" }), fin("content_filter"), DONE]);
  assert.equal(events.at(-1).response.incomplete_details.reason, "content_filter");
  assert.equal(r.side.kind, "contentPolicy");
});

test("usage: absent → null; partial → null, never a partial object", async () => {
  for (const usage of [undefined, { prompt_tokens: 3 }]) {
    const { events } = await run([chunk({ content: "x" }), fin("stop", usage), DONE]);
    assert.equal(events.at(-1).response.usage, null);
  }
});

test("reasoning comes first, as its own item, before the message", async () => {
  const { types, done } = await run([chunk({ reasoning_content: "thinking" }), chunk({ content: "answer" }), fin("stop"), DONE]);
  assert.equal(done[0].type, "reasoning");
  assert.equal(done[0].content[0].text, "thinking");
  assert.equal(done[1].type, "message");
  assert.ok(types.indexOf("response.reasoning_text.delta") < types.indexOf("response.output_text.delta"));
});

test("an error event mid-stream ends with an engine-known code", async () => {
  const quota = await run([chunk({ content: "x" }), `data: ${JSON.stringify({ error: { message: "Rate limit reached for tokens per day (TPD)" } })}\n\n`]);
  assert.equal(quota.events.at(-1).response.error.code, "insufficient_quota");
  assert.equal(quota.r.side.kind, "quotaExhausted");
  const other = await run([`data: ${JSON.stringify({ error: { message: "internal oops" } })}\n\n`]);
  assert.equal(other.events.at(-1).response.error.code, "ad_upstream_disconnected");
});

test("a finish reason without [DONE] is a normal end", async () => {
  const { events } = await run([chunk({ content: "x" }), fin("stop")]);
  assert.equal(events.at(-1).type, "response.completed");
});

test("a stream cut off after arguments that already parse: still no call, and no finished items", async () => {
  const { done, events } = await run([chunk({ content: "partial" }), chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "exec_command", arguments: "{}" } }] })]);
  assert.equal(done.length, 0, "no output_item.done at all on a cut-off");
  assert.equal(events.at(-1).response.error.code, "ad_upstream_disconnected");
});

test("finish reasons: unknown → failed (one retry); Mistral's model_length → incomplete; Gemini's RECITATION → content_filter", async () => {
  const unknown = await run([chunk({ content: "x" }), fin("insufficient_system_resource"), DONE]);
  assert.equal(unknown.events.at(-1).type, "response.failed");
  const length = await run([chunk({ content: "x" }), fin("model_length"), DONE]);
  assert.equal(length.events.at(-1).response.incomplete_details.reason, "max_output_tokens");
  const filter = await run([chunk({ content: "x" }), fin("RECITATION"), DONE]);
  assert.equal(filter.events.at(-1).response.incomplete_details.reason, "content_filter");
});

test("caps: arguments past maxArgsBytes → no call; an answer past the cap ends terminal (incomplete), not retried", async () => {
  const big = await run([chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "exec_command", arguments: JSON.stringify({ cmd: "x".repeat(200) }) } }] }), fin("tool_calls"), DONE], { route: { maxArgsBytes: 100 } });
  assert.equal(big.done.filter((i) => i.type === "function_call").length, 0);
  assert.equal(big.events.at(-1).type, "response.incomplete");
  const many = await run([...Array.from({ length: 130 }, (_, i) => chunk({ tool_calls: [{ index: i, id: `c${i}`, function: { name: "exec_command", arguments: "{}" } }] })), fin("tool_calls"), DONE]);
  assert.equal(many.events.at(-1).type, "response.incomplete");
  assert.equal(many.r.side.kind, "invalidConfig");
});

test("providers that omit the index or repeat the whole name: calls stay apart and whole", async () => {
  const noIndex = await run([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ id: "a", function: { name: "exec_command", arguments: '{"cmd":"a"}' } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ id: "b", function: { name: "exec_command", arguments: '{"cmd":"b"}' } }] } }] })}\n\n`,
    fin("tool_calls"),
    DONE,
  ]);
  assert.deepEqual(noIndex.done.map((d) => d.arguments), ['{"cmd":"a"}', '{"cmd":"b"}']);
  const repeated = await run([chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "exec_command" } }] }), chunk({ tool_calls: [{ index: 0, function: { name: "exec_command", arguments: "{}" } }] }), fin("tool_calls"), DONE]);
  assert.equal(repeated.done[0].name, "exec_command");
});

test("an empty data line is a keep-alive, not a failure", async () => {
  const { events } = await run(["data: \n\n", chunk({ content: "x" }), fin("stop"), DONE]);
  assert.equal(events.at(-1).type, "response.completed");
});

test("a custom tool given no string input: no call", async () => {
  const { done, r } = await run([chunk({ tool_calls: [{ index: 0, id: "p", function: { name: FLAT_PATCH, arguments: JSON.stringify({ input: 5 }) } }] }), fin("tool_calls"), DONE]);
  assert.equal(done.filter((i) => i.type === "custom_tool_call").length, 0);
  assert.equal(r.side.kind, "invalidConfig");
});

test("onTerminal runs before the terminal event is written, with the outcome", async () => {
  let out = "";
  let seen = null;
  const res = { writeHead() {}, write: (s) => (out += s), end() {}, writableEnded: false, destroyed: false };
  await pipeAnswer(Readable.from([Buffer.from(chunk({ content: "x" })), Buffer.from(`data: ${JSON.stringify({ error: { message: "tokens per day (TPD) used up" } })}\n\n`)]), res, {
    turn: { model: "m", toolMap },
    route: { label: "Groq" },
    onTerminal: (r) => (seen = { written: out.includes("response.failed"), kind: r.side?.kind }),
  });
  assert.deepEqual(seen, { written: false, kind: "quotaExhausted" });
});

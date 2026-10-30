// P6.1 §4: the engine's Responses request → Chat, the name map, quirks and refusals.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { buildToolMap } from "../src/gateway/translate/tools.mjs";
import { chatBody, toTurnRequest } from "../src/gateway/translate/responses-in.mjs";
import { prepare } from "../src/gateway/translate/index.mjs";
import { seal } from "../src/gateway/translate/seal.mjs";

const route = { mode: "chat", provider: "groq", label: "Groq", model: { vision: false } };
const msg = (role, text) => ({ type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] });
const req = (input, extra = {}) => ({ model: "m", input, tools: [{ type: "function", name: "exec_command", description: "run", parameters: { type: "object", properties: { cmd: { type: "string" } } } }], tool_choice: "auto", parallel_tool_calls: true, stream: true, store: false, include: ["reasoning.encrypted_content"], prompt_cache_key: "k", client_metadata: { a: 1 }, reasoning: { summary: "auto" }, ...extra });
const body = (r, rt = route, o = {}) => JSON.parse(prepare(Buffer.from(JSON.stringify(r)), rt, o).body.toString());

test("messages: developer → system, user and assistant text, in order; metadata dropped; stream with usage", () => {
  const b = body(req([msg("developer", "rules"), msg("user", "hi"), msg("assistant", "hello"), msg("user", "again")], { instructions: "base" }));
  assert.deepEqual(b.messages, [
    { role: "system", content: "base" },
    { role: "system", content: "rules" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "again" },
  ]);
  assert.equal(b.stream, true);
  assert.deepEqual(b.stream_options, { include_usage: true });
  for (const k of ["store", "include", "prompt_cache_key", "client_metadata", "reasoning"]) assert.ok(!(k in b), k);
  assert.equal(b.tools[0].function.name, "exec_command");
  assert.equal(b.tool_choice, "auto");
  assert.equal(b.parallel_tool_calls, true);
});

test("tool calls and their results: consecutive calls and the text before them form one assistant message", () => {
  const b = body(req([
    msg("user", "do it"),
    msg("assistant", "on it"),
    { type: "function_call", call_id: "c1", name: "exec_command", arguments: '{"cmd":"a"}' },
    { type: "function_call", call_id: "c2", name: "exec_command", arguments: '{"cmd":"b"}' },
    { type: "function_call_output", call_id: "c1", output: "A" },
    { type: "function_call_output", call_id: "c2", output: [{ type: "input_text", text: "B1" }, { type: "input_text", text: "B2" }] },
  ]));
  assert.deepEqual(b.messages.slice(1), [
    { role: "assistant", content: "on it", tool_calls: [{ id: "c1", type: "function", function: { name: "exec_command", arguments: '{"cmd":"a"}' } }, { id: "c2", type: "function", function: { name: "exec_command", arguments: '{"cmd":"b"}' } }] },
    { role: "tool", tool_call_id: "c1", content: "A" },
    { role: "tool", tool_call_id: "c2", content: "B1\nB2" },
  ]);
});

test("custom tools: a function taking {input}; a custom call and its output round-trip", () => {
  const r = req([{ type: "custom_tool_call", call_id: "p1", name: "apply_patch", input: "*** Begin Patch" }, { type: "custom_tool_call_output", call_id: "p1", output: "ok" }], { tools: [{ type: "custom", name: "apply_patch", description: "Edit.", format: { type: "grammar", syntax: "lark", definition: "start: x" } }] });
  const b = body(r);
  assert.deepEqual(b.tools[0].function.parameters.required, ["input"]);
  assert.match(b.tools[0].function.description, /lark grammar:\nstart: x/);
  assert.deepEqual(b.messages[0].tool_calls[0].function, { name: "apply_patch", arguments: JSON.stringify({ input: "*** Begin Patch" }) });
});

test("an additional_tools item is flattened like tools", () => {
  const b = body(req([{ type: "additional_tools", tools: [{ type: "namespace", name: "mcp.x", tools: [{ type: "function", name: "t", parameters: { type: "object" } }] }] }, msg("user", "hi")]));
  assert.equal(b.tools.length, 2);
  assert.match(b.tools[1].function.name, /^mcp_x__t_[a-z2-7]{6}$/);
});

test("refusals name the field: previous_response_id, web search, tool search items, unknown items and fields, images to a non-vision model", () => {
  const cases = [
    [req([msg("user", "x")], { previous_response_id: "r1" }), "previous_response_id"],
    [req([msg("user", "x")], { tools: [{ type: "web_search" }] }), "tools[0]"],
    [req([{ type: "tool_search_call", id: "t" }]), "input[0].type"],
    [req([{ type: "local_shell_call" }]), "input[0].type"],
    [req([msg("user", "x")], { brand_new_field: 1 }), "brand_new_field"],
    [req([{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA" }] }]), "input[0].content[0]"],
    [req([{ type: "function_call_output", call_id: "c", output: [{ type: "input_image", image_url: "x" }] }]), "input[0].output[0]"],
  ];
  for (const [r, param] of cases) assert.throws(() => prepare(Buffer.from(JSON.stringify(r)), route), (e) => e.code === "TRANSLATE_REFUSED" && e.param === param, param);
  assert.throws(() => prepare(Buffer.from(JSON.stringify(cases[0][0])), route), /can't take continuing a stored response/, "says why");
});

test("the engine's default cached web search is left out; live search is refused", () => {
  const b = body(req([msg("user", "x")], { tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }, { type: "web_search", external_web_access: false }] }));
  assert.deepEqual(b.tools.map((t) => t.function.name), ["exec_command"]);
  assert.throws(() => prepare(Buffer.from(JSON.stringify(req([msg("user", "x")], { tools: [{ type: "web_search", external_web_access: true }] }))), route), (e) => e.param === "tools[0]" && /web search/.test(e.message));
});

test("an image goes to a vision model as image_url", () => {
  const b = body(req([{ type: "message", role: "user", content: [{ type: "input_text", text: "see" }, { type: "input_image", image_url: "data:image/png;base64,AA" }] }]), { ...route, model: { vision: true } });
  assert.deepEqual(b.messages[0].content, [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }]);
});

test("names: a.b and a_b stay distinct and reversible; long names fit 64", () => {
  const m = buildToolMap([{ type: "function", name: "a.b" }, { type: "function", name: "a_b" }, { type: "namespace", name: "n".repeat(50), tools: [{ type: "function", name: "t".repeat(40) }] }]);
  const names = m.chatTools.map((t) => t.function.name);
  assert.equal(new Set(names).size, 3);
  for (const n of names) assert.ok(n.length <= 64 && /^[A-Za-z0-9_-]+$/.test(n), n);
  assert.deepEqual(m.resolve(m.flat("function", "a.b")), { kind: "function", name: "a.b" });
  assert.deepEqual(m.resolve(m.flat("function", "a_b")), { kind: "function", name: "a_b" });
  assert.deepEqual(m.resolve(m.flat("function", "t".repeat(40), "n".repeat(50))), { kind: "function", name: "t".repeat(40), namespace: "n".repeat(50) });
  assert.equal(m.resolve("nope"), null);
});

test("reasoning: another provider's blob is dropped; DeepSeek's own comes back as reasoning_content in its tool loop", () => {
  const key = randomBytes(32);
  const rt = { ...route, provider: "deepseek", quirks: ["deepseek"] };
  const mine = seal(key, { provider: "deepseek", model: "m" }, "my thoughts");
  const other = seal(key, { provider: "mistral", model: "m" }, "theirs");
  const r = req([msg("user", "go"), { type: "reasoning", summary: [], encrypted_content: mine }, { type: "function_call", call_id: "c1", name: "exec_command", arguments: "{}" }, { type: "function_call_output", call_id: "c1", output: "ok" }]);
  const b = body(r, rt, { sealKey: key });
  assert.equal(b.messages[1].reasoning_content, "my thoughts");
  // Without tools DeepSeek needs no reasoning back: another provider's is dropped, not refused.
  const r2 = req([msg("user", "go"), { type: "reasoning", encrypted_content: other }, msg("assistant", "x")], { tools: [], tool_choice: undefined });
  assert.ok(!("reasoning_content" in body(r2, rt, { sealKey: key }).messages[1]));
  assert.ok(!JSON.stringify(body(r2, route, { sealKey: key })).includes("theirs"));
});

test("DeepSeek: no reasoning, or another provider's or model's, goes (empty reasoning_content); its own that no longer opens is refused", () => {
  const rt = { ...route, provider: "deepseek", quirks: ["deepseek"] };
  const loop = (before) => req([msg("user", "go"), ...before, { type: "function_call", call_id: "c1", name: "exec_command", arguments: "{}" }, { type: "function_call_output", call_id: "c1", output: "ok" }]);
  assert.doesNotThrow(() => prepare(Buffer.from(JSON.stringify(loop([]))), rt, { sealKey: randomBytes(32) }));
  // A switched provider (a foreign blob) or a switched model (ad's envelope, another model): absent.
  for (const blob of ["gAAAA-not-ours", seal(randomBytes(32), { provider: "deepseek", model: "other-model" }, "x")]) {
    const b = JSON.parse(prepare(Buffer.from(JSON.stringify(loop([{ type: "reasoning", summary: [], encrypted_content: blob }]))), rt, { sealKey: randomBytes(32) }).body.toString());
    assert.equal(b.messages.find((m) => m.tool_calls).reasoning_content, "", "sent empty");
  }
  // Ad's own envelope for this model, sealed under a key ad no longer has: truly lost.
  const mine = seal(randomBytes(32), { provider: "deepseek", model: "m" }, "old thoughts");
  const lost = loop([{ type: "reasoning", summary: [], encrypted_content: mine }]);
  assert.throws(() => prepare(Buffer.from(JSON.stringify(lost)), rt, { sealKey: randomBytes(32) }), (e) => e.code === "TRANSLATE_REFUSED" && /can't read this chat's earlier reasoning/.test(e.message));
  // With tools, an earlier finished turn counts too (DeepSeek's docs).
  const done = req([msg("user", "go"), { type: "reasoning", encrypted_content: mine }, { type: "function_call", call_id: "c1", name: "exec_command", arguments: "{}" }, { type: "function_call_output", call_id: "c1", output: "ok" }, msg("user", "next")]);
  assert.throws(() => prepare(Buffer.from(JSON.stringify(done)), rt, { sealKey: randomBytes(32) }), /can't read this chat's earlier reasoning/);
  // Without tools, nothing is needed back.
  assert.doesNotThrow(() => prepare(Buffer.from(JSON.stringify({ ...done, tools: [], tool_choice: undefined })), rt, { sealKey: randomBytes(32) }));
});

test("reasoning text that looks like an extras envelope stays reasoning (extras have their own scope)", () => {
  const key = randomBytes(32);
  const rt = { ...route, provider: "deepseek", quirks: ["deepseek"] };
  const tricky = seal(key, { provider: "deepseek", model: "m" }, '{"v":2,"x":{"c1":{"evil":1}}}');
  const b = body(req([msg("user", "go"), { type: "reasoning", encrypted_content: tricky }, { type: "function_call", call_id: "c1", name: "exec_command", arguments: "{}" }, { type: "function_call_output", call_id: "c1", output: "ok" }]), rt, { sealKey: key });
  const call = b.messages.find((m) => m.tool_calls);
  assert.equal(call.reasoning_content, '{"v":2,"x":{"c1":{"evil":1}}}');
  assert.ok(!("extra_content" in call.tool_calls[0]));
});

test("reasoning starts its own assistant message; two items join; the quirk order doesn't matter", () => {
  const key = randomBytes(32);
  const s = (t) => seal(key, { provider: "deepseek", model: "m" }, t);
  const r = req([msg("developer", "a"), msg("user", "go"), msg("assistant", "earlier"), { type: "reasoning", encrypted_content: s("one") }, { type: "reasoning", encrypted_content: s("two") }, { type: "function_call", call_id: "c1", name: "exec_command", arguments: "{}" }, { type: "function_call_output", call_id: "c1", output: "ok" }, msg("developer", "b")]);
  for (const quirks of [["deepseek", "single-system"], ["single-system", "deepseek"]]) {
    const b = body(r, { ...route, provider: "deepseek", quirks }, { sealKey: key });
    const withCalls = b.messages.find((m) => m.tool_calls);
    assert.equal(withCalls.reasoning_content, "one\ntwo", quirks.join(","));
    assert.equal(b.messages.find((m) => m.content === "earlier").reasoning_content, "", "no reasoning of its own: sent empty");
    assert.ok(!JSON.stringify(b).includes("reasoningLost") && !JSON.stringify(b).includes('"reasoning"'));
  }
});

test("a tool call or result without its call_id is refused", () => {
  assert.throws(() => prepare(Buffer.from(JSON.stringify(req([{ type: "function_call", name: "exec_command", arguments: "{}" }]))), route), (e) => e.param === "input[0].call_id");
});

test("a namespace's description stays with its tools", () => {
  const m = buildToolMap([{ type: "namespace", name: "mem", description: "Project memory.", tools: [{ type: "function", name: "search", description: "Find notes." }] }]);
  assert.equal(m.chatTools[0].function.description, "Project memory.\n\nFind notes.");
});

test("Mistral: tool-call ids are 9 characters, the same on the call and its result", () => {
  const rt = { ...route, provider: "mistral", quirks: ["mistral"] };
  const b = body(req([msg("user", "go"), { type: "function_call", call_id: "call_engine_1", name: "exec_command", arguments: "{}" }, { type: "function_call_output", call_id: "call_engine_1", output: "ok" }]), rt, { salt: "s" });
  const id = b.messages[1].tool_calls[0].id;
  assert.match(id, /^[A-Za-z0-9]{9}$/);
  assert.equal(b.messages[2].tool_call_id, id);
});

test("tool_choice and text.format", () => {
  const tc = toTurnRequest(req([msg("user", "x")], { tool_choice: { type: "function", name: "exec_command" } }), { route });
  assert.deepEqual(chatBody(tc, { route }).tool_choice, { type: "function", function: { name: "exec_command" } });
  assert.throws(() => toTurnRequest(req([msg("user", "x")], { text: { format: { type: "json_schema", name: "o", schema: {} } } }), { route }), (e) => e.param === "text.format");
  assert.doesNotThrow(() => toTurnRequest(req([msg("user", "x")], { text: { verbosity: "low", format: { type: "text" } } }), { route }));
});

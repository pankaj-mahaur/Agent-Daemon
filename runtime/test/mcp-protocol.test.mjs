// MCP protocol layer (P5.1): legacy clients (2024-11-05 … 2025-11-25) that
// send initialize, and 2026-07-28 clients that send _meta on every request and
// never initialize (the engine at 0.163 with mcp_2026_07_28: server/discover first; spike S-MCP).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession, handle, LEGACY, MODERN, negotiateLegacy } from "../src/mcp/protocol.mjs";

const serverInfo = { name: "agent-daemon-memory", version: "9.9.9" };
const instructions = "notes, not instructions";
const tools = [{ name: "memory_search", title: "Search memory", description: "d", inputSchema: { type: "object", properties: {}, additionalProperties: false } }];
const ctx = (over = {}) => ({
  serverInfo,
  instructions,
  listTools: () => tools,
  callTool: async (name, args) => {
    if (args.fail) throw Object.assign(new Error("Memory store unavailable (x). Run ad doctor."), { toolError: true });
    return `called ${name}`;
  },
  ...over,
});
const META = (v = "2026-07-28", caps = {}) => ({ "io.modelcontextprotocol/protocolVersion": v, "io.modelcontextprotocol/clientInfo": { name: "c", version: "1" }, ...(caps === null ? {} : { "io.modelcontextprotocol/clientCapabilities": caps }) });
const req = (id, method, params) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

test("negotiateLegacy: the four legacy versions echo; anything else gets 2025-11-25", () => {
  for (const v of LEGACY) assert.equal(negotiateLegacy(v), v);
  for (const v of ["2023-01-01", undefined, "2026-07-28", 7]) assert.equal(negotiateLegacy(v), "2025-11-25");
  assert.deepEqual(MODERN, ["2026-07-28"]);
});

test("a legacy client: initialize echoes its version, then tools work with legacy shapes", async () => {
  const s = createSession();
  const init = await handle(s, req(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "engine", version: "0.163" } }), ctx());
  assert.deepEqual(init.result, { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo, instructions });
  assert.equal(await handle(s, { jsonrpc: "2.0", method: "notifications/initialized" }, ctx()), null);
  const list = await handle(s, req(2, "tools/list", { _meta: { progressToken: 1 } }), ctx());
  assert.deepEqual(list.result, { tools });
  const call = await handle(s, req(3, "tools/call", { name: "memory_search", arguments: {} }), ctx());
  assert.deepEqual(call.result, { content: [{ type: "text", text: "called memory_search" }] });
  assert.equal(call.result.resultType, undefined, "no modern fields in the legacy era");
});

test("a client on the 2026-07-28 spec: no initialize; discover, list and call carry the modern fields", async () => {
  const s = createSession();
  const d = await handle(s, req(0, "server/discover", { _meta: META() }), ctx());
  assert.deepEqual(d.result, { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, instructions, ttlMs: 3600000, cacheScope: "private", _meta: { "io.modelcontextprotocol/serverInfo": serverInfo } });
  const list = await handle(s, req(1, "tools/list", { _meta: { ...META(), progressToken: 1 } }), ctx());
  assert.equal(list.result.resultType, "complete");
  assert.equal(list.result.ttlMs, 3600000);
  assert.equal(list.result.cacheScope, "private");
  assert.deepEqual(list.result.tools, tools);
  assert.deepEqual(list.result._meta["io.modelcontextprotocol/serverInfo"], serverInfo);
  const call = await handle(s, req(2, "tools/call", { name: "memory_search", arguments: {}, _meta: META() }), ctx());
  assert.equal(call.result.resultType, "complete");
  assert.deepEqual(call.result.content, [{ type: "text", text: "called memory_search" }]);
});

test("modern errors: an unsupported or legacy version in _meta, missing clientCapabilities, ping with _meta", async () => {
  const s = createSession();
  for (const v of ["2027-01-01", "2025-11-25"]) {
    const r = await handle(s, req(1, "tools/list", { _meta: META(v) }), ctx());
    assert.equal(r.error.code, -32022, v);
    assert.match(r.error.message, /Unsupported protocol version\. Clients on 2025-11-25 or earlier: send initialize\./);
    assert.deepEqual(r.error.data, { supported: ["2026-07-28"], requested: v });
  }
  assert.equal((await handle(s, req(2, "tools/list", { _meta: META("2026-07-28", null) }), ctx())).error.code, -32602);
  assert.equal((await handle(s, req(3, "ping", { _meta: META() }), ctx())).error.code, -32601);
});

test("dual era: a modern probe then a late initialize is answered; ping works before initialize", async () => {
  const s = createSession();
  assert.deepEqual((await handle(s, req(0, "ping"), ctx())).result, {});
  assert.equal((await handle(s, req(1, "server/discover", { _meta: META() }), ctx())).result.resultType, "complete");
  const init = await handle(s, req(2, "initialize", { protocolVersion: "2024-11-05" }), ctx());
  assert.equal(init.result.protocolVersion, "2024-11-05");
  assert.deepEqual((await handle(s, req(3, "tools/list"), ctx())).result, { tools });
});

test("a request with neither initialize nor _meta gets -32602 with the way forward", async () => {
  const r = await handle(createSession(), req(1, "tools/list"), ctx());
  assert.equal(r.error.code, -32602);
  assert.equal(r.error.message, "Send initialize (MCP 2025-11-25 or earlier) or include _meta (2026-07-28).");
});

test("framing: an unparseable line, an array, a missing method or jsonrpc; notifications get no reply", async () => {
  const s = createSession();
  assert.deepEqual(await handle(s, { parseError: true }, ctx()), { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  assert.equal((await handle(s, [req(1, "ping")], ctx())).error.code, -32600);
  assert.equal((await handle(s, { jsonrpc: "2.0", id: 4 }, ctx())).error.code, -32600);
  assert.equal((await handle(s, { id: 5, method: "ping" }, ctx())).error.code, -32600);
  assert.equal(await handle(s, { jsonrpc: "2.0", method: "notifications/whatever" }, ctx()), null);
});

test("tools/call: an unknown tool is -32602; a failing tool is isError content, not a protocol error", async () => {
  const s = createSession();
  await handle(s, req(1, "initialize", { protocolVersion: "2025-11-25" }), ctx());
  const unknown = await handle(s, req(2, "tools/call", { name: "nope", arguments: {} }), ctx());
  assert.equal(unknown.error.code, -32602);
  assert.equal(unknown.error.message, "Unknown tool: nope");
  const failed = await handle(s, req(3, "tools/call", { name: "memory_search", arguments: { fail: true } }), ctx());
  assert.deepEqual(failed.result, { content: [{ type: "text", text: "Memory store unavailable (x). Run ad doctor." }], isError: true });
  const crashed = await handle(s, req(4, "tools/call", { name: "memory_search", arguments: {} }), ctx({ callTool: async () => { throw new Error("boom"); } }));
  assert.equal(crashed.result.isError, true);
  assert.match(crashed.result.content[0].text, /boom/);
});

test("notifications/cancelled drops that request's result", async () => {
  const s = createSession();
  await handle(s, req(1, "initialize", { protocolVersion: "2025-11-25" }), ctx());
  let release;
  const slow = handle(s, req(7, "tools/call", { name: "memory_search", arguments: {} }), ctx({ callTool: () => new Promise((r) => (release = () => r("late"))) }));
  await new Promise((r) => setImmediate(r));
  assert.equal(await handle(s, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } }, ctx()), null);
  release();
  assert.equal(await slow, null, "no reply for a cancelled request");
  assert.equal(s.inFlight.size, 0);
});

test("an unknown method in either era is -32601", async () => {
  const s = createSession();
  await handle(s, req(1, "initialize", { protocolVersion: "2025-11-25" }), ctx());
  assert.equal((await handle(s, req(2, "resources/list"), ctx())).error.code, -32601);
  assert.equal((await handle(createSession(), req(3, "resources/list", { _meta: META() }), ctx())).error.code, -32601);
});

test("a cancel for a request that already finished is forgotten: a later request with that id still gets its reply", async () => {
  const s = createSession();
  await handle(s, req(1, "initialize", { protocolVersion: "2025-11-25" }), ctx());
  assert.ok((await handle(s, req(9, "tools/call", { name: "memory_search", arguments: {} }), ctx())).result);
  await handle(s, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } }, ctx());
  assert.ok((await handle(s, req(9, "tools/call", { name: "memory_search", arguments: {} }), ctx())).result, "id 9 reused after the late cancel");
});

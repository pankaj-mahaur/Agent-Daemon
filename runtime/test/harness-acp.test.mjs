// Tests for `ad acp` (harness/acp.mjs): a scripted ACP client drives the
// stdio server, backed by the fake app-server. Properties: protocol v1
// handshake, streamed agent chunks, Codex approvals become
// session/request_permission round trips, session/cancel interrupts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { waitFor } from "../testkit/wait.mjs";
import { approvalFromOutcome, promptText, serveAcp, toolCallFor, toolCallUpdateFor } from "../src/harness/acp.mjs";
import { startHarnessEngine } from "../src/harness/start.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };

function acpClient(root, onPermission = () => ({ outcome: { outcome: "selected", optionId: "allow_once" } })) {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const messages = [];
  const waiters = new Map();
  let id = 0;
  const done = serveAcp({
    input: toAgent,
    output: fromAgent,
    err: { write: () => true },
    clientVersion: "9.9.9",
    engineFactory: (o) => startHarnessEngine({ ...o, home: join(root, "home"), command, store: { get: () => null } }),
  });
  createInterface({ input: fromAgent }).on("line", (line) => {
    const msg = JSON.parse(line);
    messages.push(msg);
    if (msg.method === "session/request_permission") toAgent.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: onPermission(msg.params) }) + "\n");
    else if (msg.id !== undefined && waiters.has(msg.id)) waiters.get(msg.id)(msg);
  });
  const call = (method, params) =>
    new Promise((resolve) => {
      const rid = ++id;
      waiters.set(rid, resolve);
      toAgent.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
    });
  const notify = (method, params) => toAgent.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return { call, notify, messages, end: async () => (toAgent.end(), done) };
}

test("handshake, session, prompt with a permission round trip", async () => {
  const root = mkdtempSync(join(tmpdir(), "ad-acp-"));
  const c = acpClient(root);
  try {
    const init = await c.call("initialize", { protocolVersion: 1, clientCapabilities: {} });
    assert.equal(init.result.protocolVersion, 1);
    assert.equal(init.result.agentInfo.name, "agent-daemon");
    const s = await c.call("session/new", { cwd: root, mcpServers: [] });
    const sessionId = s.result.sessionId;
    assert.ok(sessionId);
    const p = await c.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "do it" }] });
    assert.equal(p.result.stopReason, "end_turn");
    const chunks = c.messages.filter((m) => m.method === "session/update" && m.params.update.sessionUpdate === "agent_message_chunk").map((m) => m.params.update.content.text);
    assert.equal(chunks.join(""), "pong[accept]", "the client's allow_once reached Codex");
    const perm = c.messages.find((m) => m.method === "session/request_permission");
    assert.equal(perm.params.sessionId, sessionId);
    assert.deepEqual(perm.params.options.map((o) => o.kind), ["allow_once", "allow_always", "reject_once"]);
    assert.match(perm.params.toolCall.title, /rm -rf/);
    const bad = await c.call("session/nope", {});
    assert.equal(bad.error.code, -32601);
  } finally {
    await c.end();
    rmSync(root, { recursive: true, force: true });
  }
});

test("session/cancel interrupts the running prompt → stopReason cancelled", async () => {
  const root = mkdtempSync(join(tmpdir(), "ad-acp-"));
  const c = acpClient(root);
  try {
    await c.call("initialize", { protocolVersion: 1 });
    const { result } = await c.call("session/new", { cwd: root, mcpServers: [] });
    const running = c.call("session/prompt", { sessionId: result.sessionId, prompt: [{ type: "text", text: "hang" }] });
    // Sent right away on purpose: a cancel that beats turn/started must still land.
    c.notify("session/cancel", { sessionId: result.sessionId });
    const r = await running;
    assert.equal(r.result.stopReason, "cancelled");
  } finally {
    await c.end();
    rmSync(root, { recursive: true, force: true });
  }
});

test("mapping helpers", () => {
  assert.equal(promptText([{ type: "text", text: "a" }, { type: "resource", resource: { text: "b" } }, { type: "image", data: "x" }]), "a\n\nb");
  assert.deepEqual(toolCallFor({ type: "commandExecution", id: "c1", command: "ls" }), { toolCallId: "c1", title: "$ ls", kind: "execute", status: "in_progress", locations: [] });
  assert.deepEqual(toolCallFor({ type: "fileChange", id: "f1", changes: [{ path: "a.js" }] }).locations, [{ path: "a.js" }]);
  assert.equal(toolCallFor({ type: "reasoning", id: "r" }), null);
  assert.equal(toolCallUpdateFor({ type: "commandExecution", id: "c1", command: "x", exitCode: 1, aggregatedOutput: "boom" }).status, "failed");
  assert.equal(approvalFromOutcome({ outcome: "selected", optionId: "allow_always" }), "acceptForSession");
  assert.equal(approvalFromOutcome({ outcome: "cancelled" }), "decline");
  assert.equal(approvalFromOutcome(undefined), "decline");
});

test("concurrent session/new share one engine; a busy session rejects a second prompt", async () => {
  const { createAcpAgent } = await import("../src/harness/acp.mjs");
  const root = mkdtempSync(join(tmpdir(), "ad-acp-"));
  let starts = 0;
  const agent = createAcpAgent({
    send: () => {},
    request: async () => { throw new Error("client refused"); },
    engineFactory: (o) => (starts++, startHarnessEngine({ ...o, home: join(root, "home"), command, store: { get: () => null } })),
    err: { write: () => true },
  });
  try {
    const [s1, s2] = await Promise.all([agent.handle("session/new", { cwd: root, mcpServers: [] }), agent.handle("session/new", { cwd: root, mcpServers: [] })]);
    assert.equal(starts, 1, "one engine for both sessions");
    assert.notEqual(s1.sessionId, s2.sessionId);
    const running = agent.handle("session/prompt", { sessionId: s1.sessionId, prompt: [{ type: "text", text: "hang" }] });
    await assert.rejects(agent.handle("session/prompt", { sessionId: s1.sessionId, prompt: [{ type: "text", text: "x" }] }), /already running/);
    await agent.handle("session/cancel", { sessionId: s1.sessionId });
    assert.equal((await running).stopReason, "cancelled");
    // A client that errors on request_permission → the approval is declined.
    const r = await agent.handle("session/prompt", { sessionId: s2.sessionId, prompt: [{ type: "text", text: "do it" }] });
    assert.equal(r.stopReason, "end_turn");
  } finally {
    await agent.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("JSON-RPC hygiene: stray responses and unknown notifications get no reply; bad messages get -32600", async () => {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const replies = [];
  createInterface({ input: fromAgent }).on("line", (l) => replies.push(JSON.parse(l)));
  const done = serveAcp({ input: toAgent, output: fromAgent, err: { write: () => true }, engineFactory: async () => assert.fail("no engine needed") });
  toAgent.write(JSON.stringify({ jsonrpc: "2.0", id: "never-asked", result: {} }) + "\n");
  toAgent.write(JSON.stringify({ jsonrpc: "2.0", method: "unknown/notification", params: {} }) + "\n");
  toAgent.write(JSON.stringify({ jsonrpc: "2.0", id: 5, method: 42 }) + "\n");
  toAgent.write("[not an object\n");
  await waitFor(() => replies.length >= 2, { what: "two error replies" });
  toAgent.end();
  await done;
  assert.deepEqual(replies.map((m) => [m.id, m.error?.code]), [[5, -32600], [null, -32700]]);
});

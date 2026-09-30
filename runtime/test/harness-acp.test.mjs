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
    await new Promise((r) => setTimeout(r, 300));
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

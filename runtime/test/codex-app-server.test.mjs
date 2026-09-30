// Tests for the codex app-server client (engine/codex/app-server.mjs).
//
// Runs against a scripted fake server (testkit/fake-codex-app-server.mjs),
// so no network, no Codex install, no login. The load-bearing properties:
// replies route to the right request, approvals are declined unless a
// handler says otherwise, and a dead server never leaves a promise hanging.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { CodexAppServer, resolveCodexCommand, runTurn } from "../src/engine/codex/app-server.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const fakeServer = (opts = {}) => new CodexAppServer({ command: { cmd: process.execPath, prefix: [FAKE] }, ...opts });

test("start() performs initialize and sends the initialized notification", async () => {
  const s = fakeServer({ clientVersion: "9.9.9" });
  try {
    const init = await s.start();
    assert.equal(init.userAgent, "fake/agent_daemon");
    const { notifications } = await s.request("debug/state");
    assert.deepEqual(notifications, ["initialized"]);
  } finally {
    await s.close();
  }
});

test("runTurn streams only this thread's deltas and declines approvals by default", async () => {
  const s = fakeServer();
  try {
    await s.start();
    const { thread } = await s.request("thread/start", {});
    const deltas = [];
    const r = await runTurn(s, { threadId: thread.id, text: "hi", onDelta: (d) => deltas.push(d) });
    assert.equal(r.turn.status, "completed");
    assert.equal(r.output, "pong[decline]");
    assert.deepEqual(deltas, ["po", "ng", "[decline]"]);
  } finally {
    await s.close();
  }
});

test("a custom onServerRequest handler answers approvals", async () => {
  const seen = [];
  const s = fakeServer({
    onServerRequest: (msg) => {
      seen.push(msg.method);
      return { decision: "accept" };
    },
  });
  try {
    await s.start();
    const { thread } = await s.request("thread/start", {});
    const r = await runTurn(s, { threadId: thread.id, text: "hi" });
    assert.equal(r.output, "pong[accept]");
    assert.deepEqual(seen, ["item/commandExecution/requestApproval"]);
  } finally {
    await s.close();
  }
});

test("a throwing handler is reported back to the server as a JSON-RPC error", async () => {
  const s = fakeServer({
    onServerRequest: () => {
      const e = new Error("nope");
      e.code = -32099;
      throw e;
    },
  });
  try {
    await s.start();
    const { thread } = await s.request("thread/start", {});
    const r = await runTurn(s, { threadId: thread.id, text: "hi" });
    assert.equal(r.output, "pong[error:-32099]");
  } finally {
    await s.close();
  }
});

test("error responses reject with message, code and data", async () => {
  const s = fakeServer();
  try {
    await s.start();
    await assert.rejects(s.request("test/fail"), (err) => {
      assert.match(err.message, /test\/fail: boom/);
      assert.equal(err.code, -32000);
      assert.deepEqual(err.data, { why: "scripted" });
      return true;
    });
  } finally {
    await s.close();
  }
});

test("requests time out instead of hanging", async () => {
  const s = fakeServer();
  try {
    await s.start();
    await assert.rejects(s.request("test/silent", {}, { timeoutMs: 100 }), /timed out after 100ms/);
  } finally {
    await s.close();
  }
});

test("a crashed server rejects every pending request and emits exit", async () => {
  const s = fakeServer();
  await s.start();
  const exited = new Promise((resolve) => s.once("exit", resolve));
  const pending = s.request("test/silent", {}, { timeoutMs: 0 });
  await assert.rejects(s.request("test/crash"), /exited \(code=3/);
  await assert.rejects(pending, /exited \(code=3/);
  assert.equal((await exited).code, 3);
  await assert.rejects(s.request("thread/start", {}), /exited \(code=3/);
});

test("request before start rejects", async () => {
  const s = fakeServer();
  await assert.rejects(s.request("thread/start", {}), /not started/);
});

test("resolveCodexCommand honours AD_CODEX_BIN", () => {
  assert.deepEqual(resolveCodexCommand({ AD_CODEX_BIN: "/opt/codex" }), { cmd: "/opt/codex", prefix: [] });
  if (process.platform !== "win32") {
    assert.deepEqual(resolveCodexCommand({}), { cmd: "codex", prefix: [] });
  }
});

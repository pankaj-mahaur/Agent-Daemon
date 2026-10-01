// Tests for the codex app-server client (engine/codex/app-server.mjs) and
// approval replies (engine/codex/approvals.mjs).
//
// Runs against a scripted fake server (testkit/fake-codex-app-server.mjs),
// so no network, no Codex install, no login. The load-bearing properties:
// replies route to the right request, approvals are declined unless a
// handler says otherwise (in the shape each message expects), a protocol
// `error` notification never crashes the host, and a dead server never
// leaves a promise hanging.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { CodexAppServer, pinnedCodexVersion, resolveCodexCommand, withoutStoreAliases } from "../src/engine/codex/app-server.mjs";
import { approvalResponse } from "../src/engine/codex/approvals.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const fakeServer = (opts = {}) => new CodexAppServer({ command: { cmd: process.execPath, prefix: [FAKE] }, ...opts });

// Start a turn and resolve with the last agentMessage text at turn/completed.
async function rawTurn(server, text) {
  const { thread } = await server.request("thread/start", {});
  return new Promise((resolve, reject) => {
    let last = null;
    const onNote = ({ method, params }) => {
      if (method === "item/completed" && params.item?.type === "agentMessage") last = params.item.text;
      if (method === "turn/completed") {
        server.off("notification", onNote);
        resolve(last);
      }
    };
    server.on("notification", onNote);
    server.request("turn/start", { threadId: thread.id, input: [{ type: "text", text }] }).catch(reject);
  });
}

async function withServer(opts, fn) {
  const s = fakeServer(opts);
  try {
    await s.start();
    await fn(s);
  } finally {
    await s.close();
  }
}

test("start() performs initialize and sends the initialized notification", async () => {
  await withServer({ clientVersion: "9.9.9" }, async (s) => {
    const { notifications } = await s.request("debug/state");
    assert.deepEqual(notifications, ["initialized"]);
  });
});

test("default handler declines command approvals", async () => {
  await withServer({}, async (s) => {
    assert.equal(await rawTurn(s, "hi"), "pong[decline]");
  });
});

test("default handler declines permission requests with an empty grant", async () => {
  await withServer({}, async (s) => {
    assert.deepEqual(JSON.parse(await rawTurn(s, "ask-permission")), { permissions: {} });
  });
});

test("default handler answers legacy v1 approvals with a ReviewDecision", async () => {
  await withServer({}, async (s) => {
    assert.deepEqual(JSON.parse(await rawTurn(s, "legacy-approval")), { decision: "denied" });
  });
});

test("a custom onServerRequest handler answers approvals", async () => {
  const seen = [];
  await withServer({ onServerRequest: (msg) => (seen.push(msg.method), { decision: "accept" }) }, async (s) => {
    assert.equal(await rawTurn(s, "hi"), "pong[accept]");
    assert.deepEqual(seen, ["item/commandExecution/requestApproval"]);
  });
});

test("a throwing handler is reported back to the server as a JSON-RPC error", async () => {
  const onServerRequest = () => {
    const e = new Error("nope");
    e.code = -32099;
    throw e;
  };
  await withServer({ onServerRequest }, async (s) => {
    assert.equal(await rawTurn(s, "hi"), "pong[error:-32099]");
  });
});

test("an `error` notification is delivered as a notification and never crashes the host", async () => {
  await withServer({}, async (s) => {
    const seen = [];
    s.on("notification", (m) => seen.push(m.method));
    assert.deepEqual(await s.request("test/error-notification"), { ok: true });
    assert.ok(seen.includes("error"));
  });
});

test("error responses reject with message, code and data", async () => {
  await withServer({}, async (s) => {
    await assert.rejects(s.request("test/fail"), (err) => {
      assert.match(err.message, /test\/fail: boom/);
      assert.equal(err.code, -32000);
      assert.deepEqual(err.data, { why: "scripted" });
      return true;
    });
  });
});

test("requests time out instead of hanging", async () => {
  await withServer({}, async (s) => {
    await assert.rejects(s.request("test/silent", {}, { timeoutMs: 100 }), /timed out after 100ms/);
  });
});

test("a crashed server rejects every pending and later request and emits exit", async () => {
  const s = fakeServer();
  await s.start();
  const exited = new Promise((resolve) => s.once("exit", resolve));
  const pending = s.request("test/silent", {}, { timeoutMs: 0 });
  await assert.rejects(s.request("test/crash"), /exited \(code=3/);
  await assert.rejects(pending, /exited \(code=3/);
  assert.equal((await exited).code, 3);
  await assert.rejects(s.request("thread/start", {}), /exited \(code=3/);
  assert.equal(s.running, false);
  await s.close(); // no-op on a dead server, must not wait
});

test("request before start rejects", async () => {
  await assert.rejects(fakeServer().request("thread/start", {}), /not started/);
});

test("resolveCodexCommand honours AD_CODEX_BIN, else runs the pinned launcher with node", () => {
  assert.deepEqual(resolveCodexCommand({ AD_CODEX_BIN: "/opt/codex" }), { cmd: "/opt/codex", prefix: [], source: "env" });
  const r = resolveCodexCommand({});
  assert.equal(r.source, "pinned");
  assert.equal(r.cmd, process.execPath);
  assert.match(r.prefix[0], /@openai[\\/]codex[\\/]bin[\\/]codex\.js$/);
});

test("the codex dependency is pinned to an exact version", () => {
  assert.match(pinnedCodexVersion(), /^\d+\.\d+\.\d+$/);
});

test("approvalResponse maps one-word answers to each protocol's reply shape", () => {
  const cmd = "item/commandExecution/requestApproval";
  assert.deepEqual(approvalResponse(cmd, {}, "accept"), { decision: "accept" });
  assert.deepEqual(approvalResponse(cmd, {}, "acceptForSession"), { decision: "acceptForSession" });
  assert.deepEqual(approvalResponse(cmd, {}, "bogus"), { decision: "decline" }, "unknown words fail safe");
  assert.deepEqual(approvalResponse(cmd, {}, undefined), { decision: "decline" });
  assert.deepEqual(approvalResponse("execCommandApproval", {}, "accept"), { decision: "approved" });
  assert.deepEqual(approvalResponse("applyPatchApproval", {}, "acceptForSession"), { decision: "approved_for_session" });
  assert.deepEqual(approvalResponse("applyPatchApproval", {}, "cancel"), { decision: "abort" });
  const perm = { permissions: { network: { enabled: true } } };
  assert.deepEqual(approvalResponse("item/permissions/requestApproval", perm, "accept"), { ...perm, scope: "turn" });
  assert.deepEqual(approvalResponse("item/permissions/requestApproval", perm, "acceptForSession").scope, "session");
  assert.deepEqual(approvalResponse("item/permissions/requestApproval", perm, "decline"), { permissions: {} });
  assert.deepEqual(approvalResponse(cmd, {}, { custom: 1 }), { custom: 1 }, "raw objects pass through");
  assert.throws(() => approvalResponse("item/tool/call", {}, "accept"), /not an approval request/);
});

test("approvalResponse is not fooled by Object.prototype keys", () => {
  assert.deepEqual(approvalResponse("execCommandApproval", {}, "toString"), { decision: "denied" });
  assert.throws(() => approvalResponse("toString", {}, "accept"), /not an approval request/);
  assert.throws(() => approvalResponse("constructor", {}, "accept"), /not an approval request/);
});

test("Windows: Store app-alias dirs leave the engine's PATH (the sandbox can't launch them)", () => {
  const Path = "C:/Windows/system32;C:/Users/u/AppData/Local/Microsoft/WindowsApps;C:/Program Files/nodejs;C:/Users/u/AppData/Local/Microsoft/WindowsApps/";
  assert.deepEqual(withoutStoreAliases({ Path, X: "1" }, "win32"), { Path: "C:/Windows/system32;C:/Program Files/nodejs", X: "1" });
  assert.equal(withoutStoreAliases({ PATH: "a;C:/x/WindowsAppsTools" }, "win32").PATH, "a;C:/x/WindowsAppsTools", "only the alias dir itself");
  const posix = { PATH: "/usr/bin:/mnt/c/Users/u/AppData/Local/Microsoft/WindowsApps" };
  assert.equal(withoutStoreAliases(posix, "linux"), posix);
});

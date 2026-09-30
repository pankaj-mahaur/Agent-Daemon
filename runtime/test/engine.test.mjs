// Tests for the engine API (engine/index.mjs) and harness home (codex/home.mjs).
//
// Against the scripted fake app-server. What matters: core never sees
// protocol names, safe defaults are actually sent, only this thread's
// events reach the caller, and complete() matches callHeadlessClaude's shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine, DEFAULT_APPROVAL_POLICY, DEFAULT_SANDBOX, Engine, normalizeNotification } from "../src/engine/index.mjs";
import { ensureCodexHome, isManagedHome, MANAGED_MARKER } from "../src/engine/codex/home.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));

async function withEngine(opts, fn) {
  const home = mkdtempSync(join(tmpdir(), "ad-codex-home-"));
  const engine = await createEngine({ home, command: { cmd: process.execPath, prefix: [FAKE] }, ...opts });
  try {
    await fn(engine, home);
  } finally {
    await engine.close();
    rmSync(home, { recursive: true, force: true });
  }
}

test("engine runs Codex with CODEX_HOME set to the harness home", async () => {
  await withEngine({}, async (engine, home) => {
    const { env } = await engine.server.request("debug/state");
    assert.equal(env.CODEX_HOME, home);
    assert.ok(existsSync(join(home, "config.toml")));
  });
});

test("startThread sends the approved safe defaults", async () => {
  await withEngine({}, async (engine) => {
    const { threadId } = await engine.startThread({ cwd: "/work" });
    assert.equal(threadId, "thread-1");
    const { lastParams } = await engine.server.request("debug/state");
    assert.deepEqual(lastParams["thread/start"], { cwd: "/work", sandbox: DEFAULT_SANDBOX, approvalPolicy: DEFAULT_APPROVAL_POLICY });
    assert.equal(DEFAULT_SANDBOX, "workspace-write");
    assert.equal(DEFAULT_APPROVAL_POLICY, "on-request");
  });
});

test("turn streams normalized events for its own thread and returns the final message", async () => {
  await withEngine({}, async (engine) => {
    const { threadId } = await engine.startThread({});
    const events = [];
    const r = await engine.turn({ threadId, text: "hi", onEvent: (e) => events.push(e) });
    assert.equal(r.status, "completed");
    assert.equal(r.output, "pong[decline]");
    const deltas = events.filter((e) => e.type === "delta").map((e) => e.text);
    assert.deepEqual(deltas, ["po", "ng", "[decline]"]);
    assert.ok(!deltas.includes("NOISE"), "other threads' events must not leak in");
    assert.equal(events.at(-1).type, "turnDone");
  });
});

test("onApproval answers command approvals; the approval event carries the kind", async () => {
  const seen = [];
  await withEngine({ onApproval: (req) => (seen.push(req.kind), "acceptForSession") }, async (engine) => {
    const { threadId } = await engine.startThread({});
    const r = await engine.turn({ threadId, text: "hi" });
    assert.equal(r.output, "pong[acceptForSession]");
    assert.deepEqual(seen, ["command"]);
  });
});

test("permission requests get a grant, not a decision", async () => {
  await withEngine({ onApproval: () => "decline" }, async (engine) => {
    const { threadId } = await engine.startThread({});
    const r = await engine.turn({ threadId, text: "ask-permission" });
    assert.deepEqual(JSON.parse(r.output), { permissions: {} });
  });
});

test("a failed turn resolves with its status and error", async () => {
  await withEngine({}, async (engine) => {
    const { threadId } = await engine.startThread({});
    const r = await engine.turn({ threadId, text: "fail-turn" });
    assert.equal(r.status, "failed");
    assert.equal(r.error.message, "model refused");
  });
});

test("complete() returns the callHeadlessClaude shape with parsed JSON", async () => {
  await withEngine({}, async (engine) => {
    const r = await engine.complete({ system: "be terse", user: "q", schema: { type: "object" } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.parsedJson, { answer: 42 });
    assert.equal(typeof r.durationMs, "number");
    assert.ok(r.sessionId);
    const { lastParams } = await engine.server.request("debug/state");
    assert.equal(lastParams["thread/start"].sandbox, "read-only");
    assert.equal(lastParams["thread/start"].approvalPolicy, "never");
    assert.equal(lastParams["thread/start"].ephemeral, true);
    assert.equal(lastParams["thread/start"].developerInstructions, "be terse");
    assert.deepEqual(lastParams["turn/start"].outputSchema, { type: "object" });
  });
});

test("complete() reports a failed turn as ok:false instead of throwing", async () => {
  await withEngine({}, async (engine) => {
    const r = await engine.complete({ system: "s", user: "fail-turn" });
    assert.equal(r.ok, false);
    assert.match(r.error, /turn failed: model refused/);
  });
});

test("normalizeNotification drops unknown methods", () => {
  assert.equal(normalizeNotification("remoteControl/status/changed", {}), null);
  assert.deepEqual(normalizeNotification("error", { error: { message: "x" }, willRetry: true }), { type: "error", message: "x", willRetry: true });
});

test("ensureCodexHome marks only folders it creates as managed", () => {
  const fresh = mkdtempSync(join(tmpdir(), "ad-home-fresh-"));
  const existing = mkdtempSync(join(tmpdir(), "ad-home-existing-"));
  try {
    const a = ensureCodexHome(fresh);
    assert.equal(a.created, true);
    assert.equal(a.managed, true);
    assert.match(readFileSync(a.configPath, "utf8"), /cli_auth_credentials_store = "file"/);
    assert.equal(ensureCodexHome(fresh).created, false, "second call must not rewrite config");

    writeFileSync(join(existing, "config.toml"), 'model = "mine"\n');
    const b = ensureCodexHome(existing);
    assert.equal(b.created, false);
    assert.equal(b.managed, false);
    assert.equal(readFileSync(b.configPath, "utf8"), 'model = "mine"\n', "user config untouched");
    assert.equal(existsSync(join(existing, MANAGED_MARKER)), false);
    assert.equal(isManagedHome(existing), false);
  } finally {
    rmSync(fresh, { recursive: true, force: true });
    rmSync(existing, { recursive: true, force: true });
  }
});

test("an `error` notification mid-turn becomes an error event, not a crash", async () => {
  await withEngine({}, async (engine) => {
    const { threadId } = await engine.startThread({});
    const errors = [];
    const r = await engine.turn({ threadId, text: "hi", onEvent: (e) => e.type === "error" && errors.push(e) });
    assert.equal(r.status, "completed");
    assert.deepEqual(errors, [{ type: "error", message: "Reconnecting 1/5", willRetry: true }]);
  });
});

test("turn/completed arriving before the turn/start response still resolves the turn", async () => {
  await withEngine({}, async (engine) => {
    const { threadId } = await engine.startThread({});
    const r = await engine.turn({ threadId, text: "early-complete", timeoutMs: 5000 });
    assert.equal(r.status, "completed");
    assert.equal(r.output, "early");
  });
});

test("a stale turn's events on the same thread are not attributed to the new turn", async () => {
  await withEngine({}, async (engine) => {
    const { threadId } = await engine.startThread({});
    const deltas = [];
    const r = await engine.turn({ threadId, text: "stale-noise", onEvent: (e) => e.type === "delta" && deltas.push(e.text) });
    assert.equal(r.output, "fresh");
    assert.notEqual(r.turnId, "turn-stale");
    assert.deepEqual(deltas, []);
  });
});

test("a timed-out turn is interrupted, not left running", async () => {
  await withEngine({}, async (engine) => {
    const { threadId } = await engine.startThread({});
    await assert.rejects(engine.turn({ threadId, text: "hang", timeoutMs: 300 }), /timed out after 300ms/);
    await new Promise((r) => setTimeout(r, 100));
    const { calls, lastParams } = await engine.server.request("debug/state");
    assert.ok(calls.includes("turn/interrupt"));
    assert.equal(lastParams["turn/interrupt"].threadId, threadId);
  });
});

test("a throwing onEvent rejects the turn instead of escaping", async () => {
  await withEngine({}, async (engine) => {
    const { threadId } = await engine.startThread({});
    await assert.rejects(
      engine.turn({ threadId, text: "hi", onEvent: () => { throw new Error("renderer broke"); } }),
      /renderer broke/,
    );
  });
});

test("legacy v1 approvals get ReviewDecision values through the engine", async () => {
  await withEngine({ onApproval: () => "accept" }, async (engine) => {
    const { threadId } = await engine.startThread({});
    const r = await engine.turn({ threadId, text: "legacy-approval" });
    assert.deepEqual(JSON.parse(r.output), { decision: "approved" });
  });
});

test("createEngine closes the child when initialize fails", async () => {
  const home = mkdtempSync(join(tmpdir(), "ad-codex-home-"));
  const engine = new Engine({ home, command: { cmd: process.execPath, prefix: [FAKE] }, env: { FAKE_INIT_FAIL: "1" } });
  try {
    await assert.rejects(engine.start(), /init refused/);
    await engine.close();
    assert.equal(engine.server.running, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const home2 = mkdtempSync(join(tmpdir(), "ad-codex-home-"));
  try {
    await assert.rejects(createEngine({ home: home2, command: { cmd: process.execPath, prefix: [FAKE] }, env: { FAKE_INIT_FAIL: "1" } }), /init refused/);
  } finally {
    rmSync(home2, { recursive: true, force: true });
  }
});

test("complete() accepts callHeadlessClaude option names and drops Claude model aliases", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ad-prompt-"));
  const promptFile = join(dir, "system.md");
  writeFileSync(promptFile, "system from file");
  try {
    await withEngine({}, async (engine) => {
      const r = await engine.complete({ systemPromptFile: promptFile, userMessage: "q", jsonSchema: { type: "object" }, model: "haiku" });
      assert.equal(r.ok, true);
      assert.deepEqual(r.parsedJson, { answer: 42 });
      const { lastParams } = await engine.server.request("debug/state");
      assert.equal(lastParams["thread/start"].developerInstructions, "system from file");
      assert.equal(lastParams["thread/start"].model, undefined);
      assert.deepEqual(lastParams["turn/start"].outputSchema, { type: "object" });
      const missing = await engine.complete({ systemPromptFile: join(dir, "nope.md"), userMessage: "q" });
      assert.equal(missing.ok, false);
      assert.match(missing.error, /cannot read systemPromptFile/);
      assert.equal((await engine.complete({})).error, "userMessage is required");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a folder that already has content (e.g. only auth.json) is never bootstrapped or marked", () => {
  const dir = mkdtempSync(join(tmpdir(), "ad-home-authonly-"));
  try {
    writeFileSync(join(dir, "auth.json"), "{}");
    const r = ensureCodexHome(dir);
    assert.equal(r.created, false);
    assert.equal(r.managed, false);
    assert.equal(existsSync(join(dir, "config.toml")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a turn that times out before turn/start answers is still interrupted", async () => {
  await withEngine({}, async (engine) => {
    const { threadId } = await engine.startThread({});
    await assert.rejects(engine.turn({ threadId, text: "slow-start", timeoutMs: 100 }), /timed out after 100ms/);
    await new Promise((r) => setTimeout(r, 400));
    const { calls } = await engine.server.request("debug/state");
    assert.ok(calls.includes("turn/interrupt"), "late-starting turn must be interrupted");
  });
});

test("a throwing onEvent also interrupts the running turn", async () => {
  await withEngine({}, async (engine) => {
    const { threadId } = await engine.startThread({});
    await assert.rejects(engine.turn({ threadId, text: "hang", onEvent: () => { throw new Error("boom"); } }), /boom/);
    await new Promise((r) => setTimeout(r, 100));
    const { calls } = await engine.server.request("debug/state");
    assert.ok(calls.includes("turn/interrupt"));
  });
});

test("ensureCodexHome refuses a path that is a file, with a clear message", () => {
  const dir = mkdtempSync(join(tmpdir(), "ad-home-file-"));
  try {
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "x");
    assert.throws(() => ensureCodexHome(file), /exists but is not a directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("complete() runs isolated: hooks off and every MCP server disabled for its thread", async () => {
  await withEngine({}, async (engine) => {
    await engine.writeConfig([["mcp_servers.agent-daemon-memory", { command: "node" }], ["mcp_servers.playwright", { command: "npx" }]]);
    await engine.complete({ userMessage: "q" });
    const { lastParams } = await engine.server.request("debug/state");
    assert.deepEqual(lastParams["thread/start"].config, {
      "features.hooks": false,
      "mcp_servers.agent-daemon-memory.enabled": false,
      "mcp_servers.playwright.enabled": false,
    });
  });
});

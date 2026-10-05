// Engine routing and server requests (plan Part 3b): per-thread subscribers
// that follow subagent threads, thread-less events, non-blocking startTurn,
// pending requests answered by a front end or cancelled, and the old
// behaviour for callers that don't opt in (ad run / ad loop).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine, requestResult } from "../src/engine/index.mjs";
import { classifyRequest } from "../src/engine/codex/events.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };

async function withEngine(opts, fn) {
  const root = mkdtempSync(join(tmpdir(), "ad-route-"));
  const engine = await createEngine({ home: join(root, "home"), command, ...opts });
  try {
    const { threadId } = await engine.startThread({ cwd: root });
    await fn({ engine, threadId, root });
  } finally {
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const until = async (pred, what, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timed out waiting for ${what}`);
};

test("subscribe: a thread's events reach its subscriber; other threads' events don't", async () => {
  await withEngine({}, async ({ engine, threadId }) => {
    const seen = [];
    engine.subscribe(threadId, (ev) => seen.push(ev));
    await engine.turn({ threadId, text: "hello", timeoutMs: 0 });
    const deltas = seen.filter((e) => e.type === "item.delta").map((e) => e.delta);
    assert.ok(deltas.includes("po") && deltas.includes("ng"));
    assert.ok(!deltas.includes("NOISE"), "the other thread's delta is not routed here");
    assert.ok(seen.some((e) => e.type === "turn.completed"));
    assert.ok(seen.some((e) => e.type === "notice" && e.code === "turn.retrying"));
  });
});

test("subscribe(null): events without a thread go to thread-less subscribers only", async () => {
  await withEngine({}, async ({ engine, threadId }) => {
    const global = [];
    const mine = [];
    engine.subscribe(null, (ev) => global.push(ev));
    engine.subscribe(threadId, (ev) => mine.push(ev));
    engine.server.emit("notification", { method: "account/updated", params: { authMode: "chatgpt", planType: "go" } });
    assert.deepEqual(global.map((e) => e.type), ["account"]);
    assert.deepEqual(mine, []);
  });
});

test("subagents: the root's subscriber sees the child thread's events and requests, labelled", async () => {
  let asked;
  await withEngine({ onRequest: async (req) => ((asked = req), "accept") }, async ({ engine, threadId }) => {
    const seen = [];
    engine.subscribe(threadId, (ev) => seen.push(ev));
    const r = await engine.turn({ threadId, text: "subagent", timeoutMs: 0 });
    assert.equal(r.output, "subagent[accept]");
    const child = `child-of-${threadId}`;
    assert.deepEqual(engine.threadChain(child), [child, threadId]);
    assert.ok(seen.some((e) => e.type === "item.delta" && e.threadId === child && e.delta === "child says hi"));
    const opened = seen.find((e) => e.type === "request.opened");
    assert.equal(opened.threadId, child);
    assert.equal(opened.request.agentLabel, "explorer");
    assert.equal(asked.kind, "approval-exec");
    assert.ok(seen.some((e) => e.type === "request.resolved" && !e.cancelled));
    assert.deepEqual(engine.openRequests(), []);
  });
});

test("a child thread is linked by thread/started.parentThreadId alone", async () => {
  await withEngine({}, async ({ engine, threadId }) => {
    const seen = [];
    engine.subscribe(threadId, (ev) => seen.push(ev));
    engine.server.emit("notification", { method: "thread/started", params: { thread: { id: "kid", parentThreadId: threadId } } });
    engine.server.emit("notification", { method: "item/agentMessage/delta", params: { threadId: "kid", turnId: "k", itemId: "m", delta: "from kid" } });
    assert.deepEqual(engine.threadChain("kid"), ["kid", threadId]);
    assert.ok(seen.some((e) => e.type === "item.delta" && e.delta === "from kid"));
  });
});

test("user input: the front end's answers go back in Codex's shape", async () => {
  await withEngine({ onRequest: async (req) => (req.kind === "user-input" ? { q: ["A"] } : "decline") }, async ({ engine, threadId }) => {
    const r = await engine.turn({ threadId, text: "user-input", timeoutMs: 0 });
    assert.equal(r.output, 'input{"answers":{"q":{"answers":["A"]}}}');
  });
});

test("elicitation: accept with content", async () => {
  let form;
  await withEngine({ onRequest: async (req) => ((form = req.form), { action: "accept", content: { title: "T" } }) }, async ({ engine, threadId }) => {
    const r = await engine.turn({ threadId, text: "elicitation", timeoutMs: 0 });
    assert.equal(r.output, 'elicit{"action":"accept","content":{"title":"T"}}');
    assert.equal(form.server, "jira");
    assert.deepEqual(form.fields.map((f) => [f.name, f.type, f.required]), [["title", "string", true]]);
  });
});

for (const [scenario, why] of [["resolved-elsewhere", "resolved"], ["revert-pending", "reverted"]]) {
  test(`a request still open when it is ${why} is cancelled and declined`, async () => {
    await withEngine({ onRequest: () => new Promise(() => {}) }, async ({ engine, threadId }) => {
      const seen = [];
      engine.subscribe(threadId, (ev) => seen.push(ev));
      const r = await engine.turn({ threadId, text: scenario, timeoutMs: 0 });
      assert.equal(r.output, `${scenario}[decline]`);
      const resolved = seen.filter((e) => e.type === "request.resolved");
      assert.equal(resolved.length, 1, "exactly one request.resolved");
      assert.equal(resolved[0].cancelled, why);
      assert.deepEqual(engine.openRequests(), []);
    });
  });
}

test("startTurn returns once Codex accepted the turn; events keep coming through subscribe", async () => {
  await withEngine({}, async ({ engine, threadId }) => {
    const seen = [];
    engine.subscribe(threadId, (ev) => seen.push(ev));
    const { turnId } = await engine.startTurn({ threadId, text: "hang" });
    assert.match(turnId, /\S/);
    await until(() => seen.some((e) => e.type === "turn.started" && e.turnId === turnId), "turn.started");
    await engine.interrupt(threadId, turnId);
    await until(() => seen.some((e) => e.type === "turn.completed" && e.turnId === turnId), "turn.completed");
  });
});

test("regression: without onRequest, approvals still go to onApproval and user input is refused", async () => {
  const approvals = [];
  await withEngine({ onApproval: (req) => (approvals.push(req.kind), "accept") }, async ({ engine, threadId }) => {
    const r = await engine.turn({ threadId, text: "hello", timeoutMs: 0 });
    assert.equal(r.output, "pong[accept]");
    assert.deepEqual(approvals, ["command"]);
    const u = await engine.turn({ threadId, text: "user-input", timeoutMs: 0 });
    assert.match(u.output, /"code":-32601/);
  });
});

test("a request open when the engine exits is cancelled", async () => {
  let opened = false;
  await withEngine({ onRequest: () => ((opened = true), new Promise(() => {})) }, async ({ engine, threadId }) => {
    const seen = [];
    engine.subscribe(threadId, (ev) => seen.push(ev));
    const turn = engine.turn({ threadId, text: "hello", timeoutMs: 0 }).catch((e) => e);
    await until(() => opened, "the request");
    engine.server.child.kill();
    await turn;
    await until(() => seen.some((e) => e.type === "request.resolved"), "request.resolved");
    assert.equal(seen.find((e) => e.type === "request.resolved").cancelled, "engine exited");
  });
});

test("a subscriber that throws doesn't break routing", async () => {
  await withEngine({}, async ({ engine, threadId }) => {
    const warnings = [];
    engine.on("warning", (w) => warnings.push(w));
    engine.subscribe(threadId, () => {
      throw new Error("ui bug");
    });
    const ok = [];
    engine.subscribe(threadId, (ev) => ok.push(ev));
    await engine.turn({ threadId, text: "hello", onEvent: () => {}, timeoutMs: 0 });
    assert.ok(ok.length > 0);
    assert.ok(warnings.some((w) => /ui bug/.test(w)));
  });
});

/* ------------------------------------------------------------------ */
/* requestResult                                                       */
/* ------------------------------------------------------------------ */

test("requestResult: only offered options are sent; anything else declines", () => {
  const exec = classifyRequest("item/commandExecution/requestApproval", { availableDecisions: ["accept", "cancel"] }, 1);
  assert.deepEqual(requestResult(exec, "accept"), { decision: "accept" });
  assert.deepEqual(requestResult(exec, "acceptForSession"), { decision: "decline" }, "not offered");
  assert.deepEqual(requestResult(exec, { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["rm"] } }), { decision: "decline" }, "a made-up amendment");
  assert.deepEqual(requestResult(exec, null), { decision: "decline" });
  const perm = classifyRequest("item/permissions/requestApproval", { permissions: { network: { enabled: true } } }, 2);
  assert.deepEqual(requestResult(perm, "session"), { permissions: { network: { enabled: true } }, scope: "session" });
  assert.deepEqual(requestResult(perm, "turn"), { permissions: { network: { enabled: true } }, scope: "turn" });
  assert.deepEqual(requestResult(perm, "yes"), { permissions: {} });
  const ui = classifyRequest("item/tool/requestUserInput", { questions: [{ id: "q", header: "", question: "" }] }, 3);
  assert.deepEqual(requestResult(ui, { q: "not an array", other: ["x"] }), { answers: {} });
  assert.throws(() => requestResult(classifyRequest("item/tool/call", {}, 4), null), (e) => e.code === -32601);
});

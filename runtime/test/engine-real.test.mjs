// The REAL pinned Codex binary against a mock Responses server
// (testkit/mock-responses.mjs). Catches behaviour changes that a protocol
// snapshot can't: what a Codex release actually sends for a streamed turn, an
// approval, a patch, and how it rejects bad requests.
//
// Opt-in: AD_REAL_ENGINE=1 (CI's engine-real job sets it). Each test starts
// the pinned binary — never AD_CODEX_BIN, never the user's own Codex — in a
// throwaway CODEX_HOME, never ~/.codex.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServer, resolveCodexCommand } from "../src/engine/codex/app-server.mjs";
import { approvalResponse, isApprovalMethod } from "../src/engine/codex/approvals.mjs";
import { startMockResponses, writeMockCodexHome } from "../testkit/mock-responses.mjs";

const PINNED = resolveCodexCommand({});
const wanted = process.env.AD_REAL_ENGINE === "1";
const skip = wanted ? false : "set AD_REAL_ENGINE=1 to run the real Codex binary";
const START_TIMEOUT_MS = 120_000; // a first start can be slow while antivirus scans the fresh binary
const TURN_TIMEOUT_MS = 90_000;

if (wanted && PINNED.source !== "pinned") {
  test("the pinned Codex binary is installed", () => {
    assert.fail("AD_REAL_ENGINE=1 but @openai/codex is not installed: cd runtime && npm install");
  });
}

async function removeWithRetry(dir) {
  for (let i = 0; i < 40; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

// One mock + one real app-server per test, in fresh dirs.
async function withRealEngine(fn) {
  const mock = await startMockResponses();
  const home = writeMockCodexHome(mkdtempSync(join(tmpdir(), "ad-real-home-")), { url: mock.url });
  const cwd = mkdtempSync(join(tmpdir(), "ad-real-work-"));
  const requests = [];
  const server = new CodexAppServer({
    command: PINNED,
    cwd,
    env: { CODEX_HOME: home },
    clientVersion: "test",
    initTimeoutMs: START_TIMEOUT_MS,
    onServerRequest: async ({ method, params }) => {
      requests.push({ method, params });
      if (isApprovalMethod(method)) return approvalResponse(method, params, "accept");
      const err = new Error(`unhandled ${method}`);
      err.code = -32601;
      throw err;
    },
  });
  const notes = [];
  server.on("notification", (n) => notes.push(n));
  try {
    await server.start();
    await fn({ server, mock, cwd, notes, requests });
  } finally {
    await server.close().catch(() => {});
    await mock.close();
    await removeWithRetry(home);
    await removeWithRetry(cwd);
  }
}

async function runTurn(server, notes, threadId, text) {
  const from = notes.length;
  let timer;
  let listener;
  try {
    const done = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`turn "${text}" did not complete in ${TURN_TIMEOUT_MS} ms`)), TURN_TIMEOUT_MS);
      listener = ({ method, params }) => {
        if (method === "turn/completed" && params.threadId === threadId) resolve(params);
      };
      server.on("notification", listener);
    });
    await server.request("turn/start", { threadId, input: [{ type: "text", text }] });
    const completed = await done;
    const fresh = notes.slice(from);
    return {
      completed,
      items: fresh.filter((n) => n.method === "item/completed").map((n) => n.params.item),
      deltas: fresh.filter((n) => n.method === "item/agentMessage/delta").map((n) => n.params.delta),
    };
  } finally {
    clearTimeout(timer);
    if (listener) server.off("notification", listener);
  }
}

const opts = { skip, timeout: START_TIMEOUT_MS + TURN_TIMEOUT_MS };

test("a turn streams reasoning, message deltas and the final message", opts, async () => {
  await withRealEngine(async ({ server, cwd, notes, mock }) => {
    const { thread } = await server.request("thread/start", { cwd });
    const { completed, items, deltas } = await runTurn(server, notes, thread.id, "PING");
    assert.equal(completed.turn?.status ?? completed.status, "completed");
    assert.ok(items.some((i) => i.type === "reasoning"), `items: ${items.map((i) => i.type)}`);
    assert.equal(deltas.join(""), "pong", "item/agentMessage/delta streams the text");
    assert.equal(items.find((i) => i.type === "agentMessage")?.text, "pong");
    assert.ok(mock.requests.some((r) => r.tools?.includes("exec_command")), "Codex offered exec_command to the model");
  });
});

test("an escalation request asks for approval with availableDecisions", opts, async () => {
  await withRealEngine(async ({ server, cwd, notes, requests }) => {
    const { thread } = await server.request("thread/start", { cwd });
    const { items } = await runTurn(server, notes, thread.id, "ESCALATE");
    const approval = requests.find((r) => r.method === "item/commandExecution/requestApproval");
    assert.ok(approval, "require_escalated always asks under on-request");
    // Experimental field that leaks through today (plan D5): its removal must fail here by name.
    assert.ok(Array.isArray(approval.params.availableDecisions), "availableDecisions is still sent on exec approvals");
    assert.ok(approval.params.availableDecisions.includes("accept"));
    const exec = items.find((i) => i.type === "commandExecution");
    assert.ok(exec, "the approved command ran");
    assert.equal(exec.exitCode, 0, `aggregated output: ${exec.aggregatedOutput}`);
  });
});

test("a plain shell call runs (sandboxed where the platform has one)", opts, async () => {
  await withRealEngine(async ({ server, cwd, notes }) => {
    const { thread } = await server.request("thread/start", { cwd });
    const { items } = await runTurn(server, notes, thread.id, "SHELL");
    const exec = items.find((i) => i.type === "commandExecution");
    assert.ok(exec, "a commandExecution item completed");
    assert.equal(exec.exitCode, 0, `aggregated output: ${exec.aggregatedOutput}`);
    assert.match(items.find((i) => i.type === "agentMessage")?.text ?? "", /done after call-shell/);
  });
});

test("an apply_patch call becomes a fileChange that writes the file", opts, async () => {
  await withRealEngine(async ({ server, cwd, notes }) => {
    const { thread } = await server.request("thread/start", { cwd });
    const { items } = await runTurn(server, notes, thread.id, "PATCH");
    assert.ok(items.some((i) => i.type === "fileChange"), `items: ${items.map((i) => i.type)}`);
    assert.ok(existsSync(join(cwd, "hello.txt")));
    assert.equal(readFileSync(join(cwd, "hello.txt"), "utf8").trim(), "hello from the mock");
  });
});

test("bad requests are classified the way plan D5 expects", { skip, timeout: START_TIMEOUT_MS + 30_000 }, async () => {
  await withRealEngine(async ({ server }) => {
    const missing = await server.request("thread/doesNotExist", {}).catch((e) => e);
    assert.equal(missing.code, -32600);
    assert.match(missing.message, /unknown variant/);
    // The params must parse first: shape is checked before the experimental gate.
    const gated = await server.request("thread/search", { searchTerm: "x" }).catch((e) => e);
    assert.equal(gated.code, -32600);
    assert.match(gated.message, /requires experimentalApi capability/);
    const shape = await server.request("thread/start", { sandbox: 42 }).catch((e) => e);
    assert.equal(shape.code, -32600);
    assert.match(shape.message, /Invalid request/);
  });
});

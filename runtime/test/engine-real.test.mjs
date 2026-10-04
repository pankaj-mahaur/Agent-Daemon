// The REAL pinned Codex binary against a mock Responses server
// (testkit/mock-responses.mjs). Catches behaviour changes that a protocol
// snapshot can't: what a Codex release actually sends for a turn, an
// approval, a patch, and how it rejects bad requests.
//
// Opt-in: AD_REAL_ENGINE=1 (CI's engine-real job sets it). It starts real
// Codex processes, each in a throwaway CODEX_HOME — never ~/.codex.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServer, resolveCodexCommand } from "../src/engine/codex/app-server.mjs";
import { approvalResponse, isApprovalMethod } from "../src/engine/codex/approvals.mjs";
import { startMockResponses, writeMockCodexHome } from "../testkit/mock-responses.mjs";

const enabled = process.env.AD_REAL_ENGINE === "1" && resolveCodexCommand({}).source === "pinned";
const skip = enabled ? false : "set AD_REAL_ENGINE=1 (needs the pinned @openai/codex installed)";
const START_TIMEOUT = 120_000; // a first start can be slow while antivirus scans the fresh binary

async function removeWithRetry(dir) {
  for (let i = 0; i < 20; i++) {
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
    cwd,
    env: { CODEX_HOME: home },
    clientVersion: "test",
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
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`turn "${text}" did not complete`)), 90_000);
    const on = ({ method, params }) => {
      if (method !== "turn/completed" || params.threadId !== threadId) return;
      clearTimeout(timer);
      server.off("notification", on);
      resolve(params);
    };
    server.on("notification", on);
  });
  await server.request("turn/start", { threadId, input: [{ type: "text", text }] });
  const completed = await done;
  const items = notes.slice(from).filter((n) => n.method === "item/completed").map((n) => n.params.item);
  return { completed, items };
}

test("a plain turn streams reasoning and an agent message", { skip, timeout: START_TIMEOUT + 90_000 }, async () => {
  await withRealEngine(async ({ server, cwd, notes, mock }) => {
    const { thread } = await server.request("thread/start", { cwd });
    const { completed, items } = await runTurn(server, notes, thread.id, "PING");
    assert.equal(completed.turn?.status ?? completed.status, "completed");
    const types = items.map((i) => i.type);
    assert.ok(types.includes("reasoning"), `items: ${types}`);
    assert.equal(items.find((i) => i.type === "agentMessage")?.text, "pong");
    assert.ok(mock.requests.some((r) => r.tools.includes("exec_command")), "Codex offered exec_command to the model");
  });
});

test("an exec approval carries availableDecisions; accepting it runs the command", { skip, timeout: START_TIMEOUT + 90_000 }, async () => {
  await withRealEngine(async ({ server, cwd, notes, requests }) => {
    const { thread } = await server.request("thread/start", { cwd });
    const { items } = await runTurn(server, notes, thread.id, "SHELL");
    const approval = requests.find((r) => r.method === "item/commandExecution/requestApproval");
    if (approval) {
      // Experimental field that leaks through today (plan D5): its removal must fail here by name.
      assert.ok(Array.isArray(approval.params.availableDecisions), "availableDecisions still sent on exec approvals");
      assert.ok(approval.params.availableDecisions.includes("accept"));
    }
    const exec = items.find((i) => i.type === "commandExecution");
    assert.ok(exec, "a commandExecution item completed");
    assert.equal(exec.exitCode, 0, `aggregated output: ${exec.aggregatedOutput}`);
    assert.match(items.find((i) => i.type === "agentMessage")?.text ?? "", /done after call-shell/);
  });
});

test("an apply_patch call becomes a fileChange that writes the file", { skip, timeout: START_TIMEOUT + 90_000 }, async () => {
  await withRealEngine(async ({ server, cwd, notes }) => {
    const { thread } = await server.request("thread/start", { cwd });
    const { items } = await runTurn(server, notes, thread.id, "PATCH");
    assert.ok(items.some((i) => i.type === "fileChange"), `items: ${items.map((i) => i.type)}`);
    assert.ok(existsSync(join(cwd, "hello.txt")));
    assert.equal(readFileSync(join(cwd, "hello.txt"), "utf8").trim(), "hello from the mock");
  });
});

test("bad requests are classified the way plan D5 expects", { skip, timeout: START_TIMEOUT + 30_000 }, async () => {
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

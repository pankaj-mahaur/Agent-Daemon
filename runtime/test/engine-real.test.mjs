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
async function withRealEngine(fn, { codexArgs } = {}) {
  const mock = await startMockResponses();
  const home = writeMockCodexHome(mkdtempSync(join(tmpdir(), "ad-real-home-")), { url: mock.url });
  const cwd = mkdtempSync(join(tmpdir(), "ad-real-work-"));
  const requests = [];
  const server = new CodexAppServer({
    command: PINNED,
    cwd,
    env: { CODEX_HOME: home },
    clientVersion: "test",
    codexArgs,
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

// Waits for a notification matching `pred` (seen already or still to come).
function waitNote(server, notes, pred, what, ms = TURN_TIMEOUT_MS) {
  const hit = notes.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (server.off("notification", on), reject(new Error(`no ${what} in ${ms} ms`))), ms);
    const on = (n) => {
      if (!pred(n)) return;
      clearTimeout(timer);
      server.off("notification", on);
      resolve(n);
    };
    server.on("notification", on);
  });
}

test("turn/interrupt ends a running turn as interrupted and hangs up on the model", opts, async () => {
  await withRealEngine(async ({ server, cwd, notes, mock }) => {
    const { thread } = await server.request("thread/start", { cwd });
    const { turn } = await server.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "HOLD" }] });
    await mock.held();
    await waitNote(server, notes, (n) => n.method === "item/agentMessage/delta" && n.params.delta === "waiting", "the held delta");
    await server.request("turn/interrupt", { threadId: thread.id, turnId: turn.id });
    const done = await waitNote(server, notes, (n) => n.method === "turn/completed" && n.params.turn?.id === turn.id, "turn/completed");
    assert.equal(done.params.turn.status, "interrupted");
    assert.ok(mock.release() === false || mock.hangups >= 1, "the held model response was abandoned");
  });
});

test("turn/steer adds input to a running turn; the model sees it", opts, async () => {
  await withRealEngine(async ({ server, cwd, notes, mock }) => {
    const { thread } = await server.request("thread/start", { cwd });
    const { turn } = await server.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "HOLD" }] });
    await mock.held();
    await server.request("turn/steer", { threadId: thread.id, expectedTurnId: turn.id, input: [{ type: "text", text: "STEERED please PING" }] });
    mock.release();
    await waitNote(server, notes, (n) => n.method === "turn/completed" && n.params.turn?.id === turn.id, "turn/completed");
    assert.ok(mock.requests.some((r) => r.text.includes("STEERED")), `requests: ${JSON.stringify(mock.requests.map((r) => r.text))}`);
  });
});

test("the events adapter understands everything the real Codex sends in a turn", opts, async () => {
  const { adaptNotification } = await import("../src/engine/codex/events.mjs");
  await withRealEngine(async ({ server, cwd, notes }) => {
    const { thread } = await server.request("thread/start", { cwd });
    await runTurn(server, notes, thread.id, "PING");
    await runTurn(server, notes, thread.id, "SHELL");
    await runTurn(server, notes, thread.id, "PATCH");
    const unknown = notes.flatMap((n) => adaptNotification(n.method, n.params)).filter((e) => e.type === "unknown");
    assert.deepEqual(unknown.map((e) => e.method), [], "a notification Codex sends that events.mjs doesn't know");
    const types = new Set(notes.flatMap((n) => adaptNotification(n.method, n.params)).map((e) => e.type));
    for (const t of ["turn.started", "turn.completed", "item.started", "item.completed", "item.delta"]) assert.ok(types.has(t), t);
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

test("folder trust: an upsert of projects keeps other folders, and config/read returns it (plan Part 6, S3)", { skip, timeout: START_TIMEOUT_MS + 30_000 }, async () => {
  await withRealEngine(async ({ server, cwd }) => {
    const other = join(cwd, "other folder");
    const write = (path, level) => server.request("config/batchWrite", { edits: [{ keyPath: "projects", value: { [path]: { trust_level: level } }, mergeStrategy: "upsert" }], reloadUserConfig: true });
    await write(cwd, "trusted");
    await write(other, "untrusted");
    const config = (await server.request("config/read", {})).config ?? {};
    const level = (p) => Object.entries(config.projects ?? {}).find(([k]) => k.toLowerCase() === p.toLowerCase())?.[1]?.trust_level;
    assert.equal(level(cwd), "trusted", JSON.stringify(config.projects));
    assert.equal(level(other), "untrusted");
  });
});

test("S8: with thread_unload_delay_secs=0, thread/unsubscribe closes an idle thread at once, and a cold resume has its turns", opts, async () => {
  await withRealEngine(
    async ({ server, cwd, notes }) => {
      const { thread } = await server.request("thread/start", { cwd });
      await runTurn(server, notes, thread.id, "PING");
      const r = await server.request("thread/unsubscribe", { threadId: thread.id });
      assert.equal(r.status, "unsubscribed");
      const end = Date.now() + 15_000;
      while (!notes.some((n) => n.method === "thread/closed" && n.params.threadId === thread.id) && Date.now() < end) await new Promise((res) => setTimeout(res, 50));
      assert.ok(notes.some((n) => n.method === "thread/closed" && n.params.threadId === thread.id), "thread/closed reaches the client that let go of it");
      const resumed = await server.request("thread/resume", { threadId: thread.id, cwd });
      assert.equal(resumed.thread.id, thread.id);
      const { data } = await server.request("thread/turns/list", { threadId: thread.id });
      assert.ok(data.length >= 1, "the cold resume reads the thread's turns from its rollout");
    },
    { codexArgs: ["-c", "thread_unload_delay_secs=0"] },
  );
});

test("S1: Codex's own TUI settings round-trip through config/batchWrite and config/read; wrong types are refused", opts, async () => {
  await withRealEngine(async ({ server }) => {
    const write = (edits) => server.request("config/batchWrite", { edits: edits.map(([keyPath, value]) => ({ keyPath, value, mergeStrategy: "replace" })), reloadUserConfig: true });
    await write([
      ["tui.status_line", ["model-with-reasoning", "current-dir", "not-a-codex-item"]],
      ["tui.terminal_title", ["activity", "project-name"]],
      ["tui.theme", "dracula"],
      ["tui.vim_mode_default", true],
    ]);
    const { config } = await server.request("config/read", {});
    assert.deepEqual(config.tui?.status_line, ["model-with-reasoning", "current-dir", "not-a-codex-item"], "an id Codex doesn't know is kept (the stock UI only warns)");
    assert.deepEqual(config.tui?.terminal_title, ["activity", "project-name"]);
    assert.equal(config.tui?.theme, "dracula");
    assert.equal(config.tui?.vim_mode_default, true);
    await write([["tui.status_line", []]]);
    assert.deepEqual((await server.request("config/read", {})).config.tui?.status_line, [], "[] is kept (status line off)");
    await assert.rejects(write([["tui.vim_mode_default", "yes"]]), "a value of the wrong type is refused");
    await write([["tui.status_line", null]]);
    assert.equal((await server.request("config/read", {})).config.tui?.status_line ?? null, null, "null removes it (back to the default)");
  });
});

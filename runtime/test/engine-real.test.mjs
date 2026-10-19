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
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServer, resolveCodexCommand } from "../src/engine/codex/app-server.mjs";
import { approvalResponse, isApprovalMethod } from "../src/engine/codex/approvals.mjs";
import { defaultScript, ev, lastUserText, startMockResponses, writeMockCodexHome } from "../testkit/mock-responses.mjs";
import { adaptNotification as adapt } from "../src/engine/codex/events.mjs";
import { waitFor } from "../testkit/wait.mjs";
import { experimentalCapabilities } from "../src/engine/codex/surface.mjs";
import { fileURLToPath } from "node:url";
import { projectSlug } from "../src/memory/episodic.mjs";

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
async function withRealEngine(fn, { codexArgs, capabilities, script, extraConfig } = {}) {
  const mock = await startMockResponses(script ? { script } : {});
  const home = writeMockCodexHome(mkdtempSync(join(tmpdir(), "ad-real-home-")), { url: mock.url });
  if (extraConfig) appendFileSync(join(home, "config.toml"), `\n${extraConfig(home)}\n`);
  const cwd = mkdtempSync(join(tmpdir(), "ad-real-work-"));
  const requests = [];
  const server = new CodexAppServer({
    command: PINNED,
    cwd,
    env: { CODEX_HOME: home },
    clientVersion: "test",
    codexArgs,
    capabilities,
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

async function runTurn(server, notes, threadId, text, extra = {}) {
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
    await server.request("turn/start", { threadId, input: [{ type: "text", text }], ...extra });
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

// codex-parity-2 S0 / Part 4: the experimental allowlist on the real engine.
const PLAN_BODY = ["# Add hello", "", "- write hello.txt", ""].join("\n");
const PLAN_REPLY = ["Looked around.", "<proposed_plan>", PLAN_BODY + "</proposed_plan>", ""].join("\n");
const planScript = (body) => (lastUserText(body).includes("PLAN")
  ? [ev.created(), ev.messageAdded(), ev.textDelta(PLAN_REPLY.slice(0, 25)), ev.textDelta(PLAN_REPLY.slice(25)), ev.message(PLAN_REPLY), ev.completed()]
  : defaultScript(body));
const mask = (mode, effort = null) => ({ mode, settings: { model: "mock-model", reasoning_effort: effort, developer_instructions: null } });

test("plan mode on the allowlist: presets, settings update, a proposed plan item, and the opted-out notifications stay quiet", { skip, timeout: START_TIMEOUT_MS + 2 * TURN_TIMEOUT_MS }, async () => {
  await withRealEngine(async ({ server, cwd, notes }) => {
    const list = await server.request("collaborationMode/list", {});
    assert.deepEqual(list.data.map((m) => [m.name, m.mode]), [["Plan", "plan"], ["Default", "default"]]);
    assert.equal(list.data[0].reasoning_effort, "medium", "Plan's preset effort");
    const { thread } = await server.request("thread/start", { cwd });
    assert.deepEqual(await server.request("thread/settings/update", { threadId: thread.id, collaborationMode: mask("plan", "medium") }), {});
    const updated = await waitFor(() => notes.find((n) => n.method === "thread/settings/updated"));
    assert.deepEqual(adapt(updated.method, updated.params)[0].collaborationMode, { mode: "plan", model: "mock-model", effort: "medium" });
    assert.match(updated.params.threadSettings.collaborationMode.settings.developer_instructions, /Plan Mode/, "a null asks for Codex's own plan.md");
    const { items } = await runTurn(server, notes, thread.id, "PLAN please", { collaborationMode: mask("plan", "medium") });
    assert.equal(items.find((i) => i.type === "plan")?.text, PLAN_BODY);
    assert.equal(items.find((i) => i.type === "agentMessage")?.text, "Looked around.\n", "the plan block isn't in the message");
    assert.ok(notes.some((n) => n.method === "item/plan/delta"), "the plan streams");
    // Back to Default through turn/start alone: Codex reports the change too.
    const from = notes.length;
    await runTurn(server, notes, thread.id, "Implement the plan.", { collaborationMode: mask("default") });
    const back = notes.slice(from).find((n) => n.method === "thread/settings/updated");
    assert.equal(back?.params.threadSettings.collaborationMode.mode, "default");
    assert.equal((await server.request("thread/resume", { threadId: thread.id })).collaborationMode?.mode, "default", "resume reports the mode");
    assert.deepEqual(await server.request("thread/backgroundTerminals/clean", { threadId: thread.id }), {});
    const muted = new Set(experimentalCapabilities().optOutNotificationMethods);
    assert.deepEqual(notes.filter((n) => muted.has(n.method)).map((n) => n.method), [], "opted-out notifications arrived");
    const unknown = notes.flatMap((n) => adapt(n.method, n.params)).filter((e) => e.type === "unknown");
    assert.deepEqual(unknown.map((e) => e.method), [], "a notification Codex sends with experimentalApi that events.mjs doesn't know");
  }, { capabilities: experimentalCapabilities(), script: planScript });
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

// codex-parity-2 Part 10.
test("S7: thread/approveGuardianDeniedAction takes ad's core GuardianAssessmentEvent for every action kind; a v2-shaped one is refused", opts, async () => {
  const { guardianDenialEvent } = await import("../src/engine/codex/events.mjs");
  await withRealEngine(async ({ server, cwd }) => {
    const { thread } = await server.request("thread/start", { cwd });
    const base = { threadId: thread.id, turnId: "turn-x", targetItemId: null, startedAtMs: 1, completedAtMs: 2, decisionSource: "agent", review: { status: "denied", riskLevel: "high", userAuthorization: "low", rationale: "risky" } };
    const actions = [
      { type: "command", source: "shell", command: "rm -rf build", cwd },
      { type: "execve", source: "unifiedExec", program: "rm", argv: ["rm", "-rf", "build"], cwd },
      { type: "applyPatch", cwd, files: [join(cwd, "a.txt")] },
      { type: "networkAccess", target: "https://example.com", host: "example.com", protocol: "https", port: 443 },
      { type: "mcpToolCall", server: "docs", toolName: "search", connectorId: null, connectorName: null, toolTitle: null },
      { type: "writeStdin", approvalId: "a1", processId: "p1", stdin: "y\n", cwd },
      // As the notification sends them: read and write beside entries (or entries left out).
      { type: "requestPermissions", reason: null, permissions: { network: { enabled: true }, fileSystem: { read: null, write: null, entries: [{ path: { type: "path", path: cwd }, access: "write" }], globScanMaxDepth: 2 } } },
      { type: "requestPermissions", reason: "read the docs", permissions: { network: null, fileSystem: { read: [cwd], write: null } } },
      { type: "requestPermissions", reason: null, permissions: { network: null, fileSystem: { read: [cwd], write: [cwd], entries: [] } } },
    ];
    for (const action of actions) {
      const event = guardianDenialEvent({ ...base, reviewId: `review-${action.type}`, action });
      assert.deepEqual(await server.request("thread/approveGuardianDeniedAction", { threadId: thread.id, event }), {}, action.type);
    }
    await assert.rejects(server.request("thread/approveGuardianDeniedAction", { threadId: thread.id, event: { reviewId: "x", review: base.review, action: actions[0] } }), /invalid Guardian denial event/);
  });
});

test("/recap's temporary thread: Codex takes its tool-off config and starts it read-only and ephemeral", opts, async () => {
  const { TEMPORARY_THREAD_CONFIG } = await import("../src/tui/recap.mjs");
  await withRealEngine(async ({ server, cwd }) => {
    const r = await server.request("thread/start", { cwd, approvalPolicy: "never", sandbox: "read-only", ephemeral: true, threadSource: "system", config: { ...TEMPORARY_THREAD_CONFIG } });
    assert.equal(r.sandbox?.type, "readOnly");
    assert.equal(r.thread.ephemeral, true);
    assert.equal(r.thread.path ?? null, null, "an ephemeral thread has no rollout file");
    assert.equal((await server.request("thread/unsubscribe", { threadId: r.thread.id })).status, "unsubscribed");
  });
});

// ---------- the memory scope contract (plan §M, P0.8a) ----------

const MEMORY_SERVER = fileURLToPath(new URL("../src/mcp/memory-server.mjs", import.meta.url));
const MEM_KEY = "mcp_servers.agent-daemon-memory.env.AD_MEMORY_PROJECT";
const tomlStr = (s) => JSON.stringify(s); // a TOML basic string
const memoryServerToml = (fakeHome) => [
  `[mcp_servers.agent-daemon-memory]`,
  `command = ${tomlStr(process.execPath)}`,
  `args = [${tomlStr(MEMORY_SERVER)}]`,
  `startup_timeout_sec = 30`,
  ``,
  `[mcp_servers.agent-daemon-memory.env]`,
  `HOME = ${tomlStr(fakeHome)}`,
  `USERPROFILE = ${tomlStr(fakeHome)}`,
].join("\n");

test("memory scope: a bare home (no memory server) starts threads; the façade adds no override there", opts, async () => {
  await withRealEngine(async ({ server, cwd }) => {
    const { thread } = await server.request("thread/start", { cwd });
    assert.ok(thread.id);
    // Why the façade checks first: an override for a server that isn't configured
    // makes the engine reject the thread's whole config.
    await assert.rejects(server.request("thread/start", { cwd, config: { [MEM_KEY]: cwd } }));
  });
});

test("memory scope: each thread's memory server binds to the folder ad passes (AD_MEMORY_PROJECT)", { skip, timeout: START_TIMEOUT_MS + 60_000 }, async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "ad-real-memhome-"));
  const P = join(fakeHome, "work", "p");
  const Q = join(fakeHome, "work", "q");
  for (const d of [P, Q]) mkdirSync(join(d, ".git"), { recursive: true });
  const dbg = (n) => join(fakeHome, `scope-${n}.json`);
  try {
    await withRealEngine(async ({ server, cwd }) => {
      for (const [n, dir] of [["p", P], ["q", Q]]) {
        await server.request("thread/start", { cwd, config: { [MEM_KEY]: dir, "mcp_servers.agent-daemon-memory.env.AD_MEMORY_DEBUG_FILE": dbg(n) } });
        await waitFor(() => existsSync(dbg(n)), { timeoutMs: 20_000, what: `memory server debug file for ${n}` });
        const seen = JSON.parse(readFileSync(dbg(n), "utf8"));
        assert.equal(seen.source, "env:AD_MEMORY_PROJECT");
        assert.equal(seen.key, projectSlug(dir));
      }
    }, { extraConfig: () => memoryServerToml(fakeHome) });
  } finally {
    await removeWithRetry(fakeHome);
  }
});

const lastIsToolOutput = (body) => Array.isArray(body?.input) && body.input[body.input.length - 1]?.type === "function_call_output";
const envScript = (body) => (!lastIsToolOutput(body) && lastUserText(body).includes("ENVSHELL")
  ? [ev.created(), ev.functionCall("call-env", "exec_command", { cmd: process.platform === "win32" ? "cmd.exe /d /c echo [%AD_TOOL_SHELL%]" : "echo [$AD_TOOL_SHELL]" }), ev.completed()]
  : defaultScript(body));

test("the agent-shell marker: a tool shell carries AD_TOOL_SHELL=1 from shell_environment_policy.set", opts, async () => {
  await withRealEngine(async ({ server, cwd, notes }) => {
    const { thread } = await server.request("thread/start", { cwd });
    const { items } = await runTurn(server, notes, thread.id, "ENVSHELL");
    const exec = items.find((i) => i.type === "commandExecution");
    assert.ok(exec, "a commandExecution item completed");
    assert.match(exec.aggregatedOutput ?? "", /\[1\]/, `output: ${exec.aggregatedOutput}`);
  }, { script: envScript, extraConfig: () => `[shell_environment_policy.set]\nAD_TOOL_SHELL = "1"` });
});

// ---- Start-up isolation (P0.2a, S-HOME): the user's own ~/.codex never reaches the model ----

const SENTINELS = /SENTINEL_[A-Z_]+|sentinel-model-zz/g;
// A temp user home (HOME/USERPROFILE for ad and the engine): a git repo whose
// ~/.codex has a sentinel skill and settings, and is trusted in ad's engine
// settings; a project inside it with its own .git and a repo skill.
async function withIsolationTree(fn) {
  const { createEngine } = await import("../src/engine/index.mjs");
  const root = mkdtempSync(join(tmpdir(), "ad-real-iso-"));
  const home = join(root, "home");
  const put = (p, s) => {
    mkdirSync(join(p, ".."), { recursive: true });
    appendFileSync(p, s);
  };
  put(join(home, ".git", "HEAD"), "ref: refs/heads/main\n");
  put(join(home, ".codex", "config.toml"), 'model = "sentinel-model-zz"\n');
  put(join(home, ".codex", "skills", "sentinel-a", "SKILL.md"), "---\nname: sentinel-a\ndescription: SENTINEL_SKILL_A\n---\nbody\n");
  const proj = join(home, "shop-app");
  put(join(proj, ".git", "HEAD"), "ref: refs/heads/main\n");
  put(join(proj, ".codex", "skills", "repo-skill", "SKILL.md"), "---\nname: repo-skill\ndescription: SENTINEL_REPO_SKILL\n---\nbody\n");
  mkdirSync(join(proj, "src"), { recursive: true });
  mkdirSync(join(home, "notes"), { recursive: true });
  const bodies = [];
  const mock = await startMockResponses({ script: (body) => (bodies.push(JSON.stringify(body)), [ev.created(), ev.message("pong"), ev.completed()]) });
  const engineHome = writeMockCodexHome(join(root, "engine"), { url: mock.url });
  appendFileSync(join(engineHome, "config.toml"), `\n[projects.'${home}']\ntrust_level = "trusted"\n`);
  appendFileSync(join(engineHome, ".agent-daemon-managed"), "test\n");
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const engines = [];
  const make = async (o = {}) => {
    const e = await createEngine({ home: engineHome, command: PINNED, cwd: proj, clientVersion: "test", ...o });
    engines.push(e);
    return e;
  };
  const sentinelsOf = (from) => [...new Set(bodies.slice(from).join("\n").match(SENTINELS) ?? [])].sort();
  const turnSentinels = async (engine, threadId) => {
    const from = bodies.length;
    const r = await engine.turn({ threadId, text: "PING", timeoutMs: TURN_TIMEOUT_MS });
    assert.equal(r.status, "completed", JSON.stringify(r.error));
    return sentinelsOf(from);
  };
  try {
    await fn({ make, home, proj, root, engineHome, turnSentinels });
  } finally {
    for (const e of engines) await e.close().catch(() => {});
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await mock.close();
    await removeWithRetry(root);
  }
}

test("start-up isolation: the user's settings and skills never reach the model (P0.2, S-HOME)", { skip, timeout: START_TIMEOUT_MS * 3 + TURN_TIMEOUT_MS * 4 }, async () => {
  await withIsolationTree(async ({ make, home, proj, turnSentinels }) => {
    const engine = await make();
    // The trusted home entry is gone, whoever wrote it.
    const projects = (await engine.readConfig()).projects ?? {};
    assert.ok(!Object.keys(projects).some((k) => k.toLowerCase().replace(/[\/]+$/, "") === home.toLowerCase()), `projects: ${Object.keys(projects)}`);
    assert.ok(engine.homeEvents?.some((e) => e.type === "trustRemoved"));
    // From the repo project: its own skill, nothing from ~/.codex.
    const { threadId } = await engine.startThread({ cwd: join(proj, "src") });
    assert.deepEqual(await turnSentinels(engine, threadId), ["SENTINEL_REPO_SKILL"]);
    // The home folder and a non-git subfolder of the git home are refused.
    await assert.rejects(engine.startThread({ cwd: home }), { code: "HOME_FOLDER_REFUSED" });
    await assert.rejects(engine.startThread({ cwd: join(home, "notes") }), { code: "HOME_FOLDER_REFUSED" });
    // Control: with the override the probe sees the leak (so the assertions above can fail).
    const open = await make({ allowHomeFolder: true });
    const t2 = await open.startThread({ cwd: join(home, "notes") });
    assert.ok((await turnSentinels(open, t2.threadId)).includes("SENTINEL_SKILL_A"), "the control shows sentinel-a");
  });
});

test("start-up isolation, markers-off launch: a resumed thread in a repo subfolder still loads its repo's .codex", { skip, timeout: START_TIMEOUT_MS * 3 + TURN_TIMEOUT_MS * 3 }, async () => {
  await withIsolationTree(async ({ make, home, proj, turnSentinels }) => {
    // The launch folder inside the git home: only -c project_root_markers=[] keeps ~/.codex out.
    const launchAt = join(home, "launch-here");
    mkdirSync(launchAt, { recursive: true });
    const launch = { dir: launchAt, codexArgs: ["-c", "project_root_markers=[]"], mode: "markers-off" };
    const first = await make({ launch });
    const { threadId } = await first.startThread({ cwd: join(proj, "src") });
    assert.deepEqual(await turnSentinels(first, threadId), ["SENTINEL_REPO_SKILL"]);
    await first.close();
    const again = await make({ launch });
    await again.resumeThread(threadId);
    assert.deepEqual(await turnSentinels(again, threadId), ["SENTINEL_REPO_SKILL"], "resumed with the real markers");
  });
});

// ---- 0.163 checks (P1.1, change table) ----

// A folder's identity for comparing with what a child process reports as its
// cwd: macOS tmpdir() is /var/… while getcwd() says /private/var/…, and a
// Windows runner's TEMP can be an 8.3 short name.
const samePath = (a, b) => {
  const id = (p) => {
    let r = p;
    try {
      r = realpathSync.native(p);
    } catch {
      // gone: compare as given
    }
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return id(a) === id(b);
};

// An MCP server that records the folder it was started in, then exits.
function cwdProbe(dir) {
  const script = join(dir, "cwd-probe.mjs");
  const log = join(dir, "cwd-probe.log");
  appendFileSync(script, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(log)}, process.cwd() + String.fromCharCode(10)); process.exit(1);\n`);
  const seen = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  const startedIn = (folder) => seen().some((p) => samePath(p, folder));
  const toml = [`[mcp_servers.cwd_probe]`, `command = ${tomlStr(process.execPath)}`, `args = [${tomlStr(script)}]`, `startup_timeout_sec = 5`].join("\n");
  return { toml, seen, startedIn };
}

test("0.163: each thread starts its MCP servers in the thread's folder", { skip, timeout: START_TIMEOUT_MS + 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ad-real-mcpcwd-"));
  const a = join(dir, "a");
  const b = join(dir, "b");
  for (const d of [a, b]) mkdirSync(d, { recursive: true });
  const probe = cwdProbe(dir);
  try {
    await withRealEngine(async ({ server, notes }) => {
      const ta = await server.request("thread/start", { cwd: a });
      await runTurn(server, notes, ta.thread.id, "PING");
      await waitFor(() => probe.startedIn(a), { timeoutMs: 20_000, what: "the probe for thread a" });
      const tb = await server.request("thread/start", { cwd: b });
      await runTurn(server, notes, tb.thread.id, "PING");
      await waitFor(() => probe.startedIn(b), { timeoutMs: 20_000, what: "the probe for thread b" });
    }, { extraConfig: () => probe.toml });
  } finally {
    await removeWithRetry(dir);
  }
});

test("0.163: a per-thread mcp_servers.<id>.enabled=false keeps the server off, also after an MCP reload", { skip, timeout: START_TIMEOUT_MS + 90_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ad-real-mcpoff-"));
  const off = join(dir, "off");
  mkdirSync(off, { recursive: true });
  const probe = cwdProbe(dir);
  try {
    await withRealEngine(async ({ server, notes }) => {
      const { thread } = await server.request("thread/start", { cwd: off, config: { "mcp_servers.cwd_probe.enabled": false, "features.hooks": false } });
      await runTurn(server, notes, thread.id, "PING");
      await server.request("config/batchWrite", { edits: [{ keyPath: "mcp_servers.cwd_probe.startup_timeout_sec", value: 6, mergeStrategy: "replace" }], reloadUserConfig: true });
      await server.request("config/mcpServer/reload", {});
      await runTurn(server, notes, thread.id, "PING");
      // Control: a thread without the override does start it, so the probe can see a start.
      const on = join(dir, "on");
      mkdirSync(on, { recursive: true });
      const t2 = await server.request("thread/start", { cwd: on });
      await runTurn(server, notes, t2.thread.id, "PING");
      await waitFor(() => probe.startedIn(on), { timeoutMs: 20_000, what: "the control start" });
      assert.ok(!probe.startedIn(off), `started in ${probe.seen()}`);
    }, { extraConfig: () => probe.toml });
  } finally {
    await removeWithRetry(dir);
  }
});

test("0.163: two tool calls in one response both run and complete, each item once", opts, async () => {
  const outputs = [];
  const twoCalls = (body) => {
    const input = Array.isArray(body?.input) ? body.input : [];
    const outs = input.filter((i) => i?.type === "function_call_output");
    if (outs.length) {
      outputs.splice(0, outputs.length, ...outs.map((o) => o.call_id));
      return outs.length >= 2 ? [ev.created(), ev.message("both done"), ev.completed()] : [ev.created(), ev.completed()];
    }
    const echo = (t) => (process.platform === "win32" ? `cmd.exe /d /c echo ${t}` : `echo ${t}`);
    return [ev.created(), ev.functionCall("call-one", "exec_command", { cmd: echo("one") }), ev.functionCall("call-two", "exec_command", { cmd: echo("two") }), ev.completed()];
  };
  await withRealEngine(async ({ server, cwd, notes }) => {
    const { thread } = await server.request("thread/start", { cwd });
    const { items } = await runTurn(server, notes, thread.id, "TWO");
    const execs = items.filter((i) => i.type === "commandExecution");
    assert.equal(execs.length, 2, `items: ${items.map((i) => i.type)}`);
    assert.equal(new Set(execs.map((i) => i.id)).size, 2, "each item once");
    for (const [word, e] of [["one", execs.find((x) => /one/.test(x.command))], ["two", execs.find((x) => /two/.test(x.command))]]) {
      assert.ok(e, `the "${word}" command`);
      assert.equal(e.exitCode, 0, `${word}: ${e.aggregatedOutput}`);
      assert.match(e.aggregatedOutput ?? "", new RegExp(word));
    }
    assert.deepEqual([...outputs].sort(), ["call-one", "call-two"], "the model got both outputs");
    assert.match(items.find((i) => i.type === "agentMessage")?.text ?? "", /both done/);
  }, { script: twoCalls });
});

test("0.163: with mcp_2026_07_28 on, ad's memory server still starts and binds", { skip, timeout: START_TIMEOUT_MS + 60_000 }, async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "ad-real-mem2026-"));
  const P = join(fakeHome, "work", "p");
  mkdirSync(join(P, ".git"), { recursive: true });
  const dbg = join(fakeHome, "scope.json");
  try {
    await withRealEngine(async ({ server, cwd }) => {
      await server.request("thread/start", { cwd, config: { [MEM_KEY]: P, "mcp_servers.agent-daemon-memory.env.AD_MEMORY_DEBUG_FILE": dbg } });
      await waitFor(() => existsSync(dbg), { timeoutMs: 20_000, what: "memory server debug file" });
      assert.equal(JSON.parse(readFileSync(dbg, "utf8")).key, projectSlug(P));
    }, { extraConfig: () => memoryServerToml(fakeHome), codexArgs: ["-c", "features.mcp_2026_07_28=true"] });
  } finally {
    await removeWithRetry(fakeHome);
  }
});

// ---- P5.1: ad's memory server on the real engine ----

const memCall = (body) => {
  const input = Array.isArray(body?.input) ? body.input : [];
  const last = input[input.length - 1];
  if (last?.type === "function_call_output") return [ev.created(), ev.message(`tool said: ${typeof last.output === "string" ? last.output : JSON.stringify(last.output)}`), ev.completed()];
  if (lastUserText(body).includes("RECENT")) return [ev.created(), ev.functionCall("call-recent", "memory_recent", {}, "mcp__agent_daemon_memory"), ev.completed()];
  return defaultScript(body);
};

async function memoryWorld() {
  const fakeHome = mkdtempSync(join(tmpdir(), "ad-real-memsrv-"));
  const A = join(fakeHome, "work", "alpha");
  const B = join(fakeHome, "work", "beta");
  for (const d of [A, B]) mkdirSync(join(d, ".git"), { recursive: true });
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    const ep = await import(`../src/memory/episodic.mjs?realmem=${Date.now()}`);
    await ep.upsertSession({ id: "sa", projectPath: A, startedAt: "2026-10-01T00:00:00Z" });
    await ep.upsertSession({ id: "sb", projectPath: B, startedAt: "2026-10-01T00:00:00Z" });
    await ep.insertLearning({ sessionId: "sa", projectSlug: ep.projectSlug(A), category: "gotcha", text: "ALPHA-ONLY note", confidence: 0.8, origin: "user" });
    await ep.insertLearning({ sessionId: "sb", projectSlug: ep.projectSlug(B), category: "gotcha", text: "BETA-ONLY note", confidence: 0.8, origin: "user" });
    ep.closeDb();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
  const toml = memoryServerToml(fakeHome).replace(`args = [${tomlStr(MEMORY_SERVER)}]`, `args = [${tomlStr(MEMORY_SERVER)}, "--host", "ad", "--capture", "hooks"]`);
  return { fakeHome, A, B, toml };
}
const said = (items) => items.find((i) => i.type === "agentMessage")?.text ?? "";

test("P5.1: one engine, threads in A and B: each thread's memory server serves its own project", { skip, timeout: START_TIMEOUT_MS + 90_000 }, async () => {
  const w = await memoryWorld();
  try {
    await withRealEngine(async ({ server, notes }) => {
      const ta = await server.request("thread/start", { cwd: w.A });
      const ra = said((await runTurn(server, notes, ta.thread.id, "RECENT")).items);
      const tb = await server.request("thread/start", { cwd: w.B });
      const rb = said((await runTurn(server, notes, tb.thread.id, "RECENT")).items);
      assert.match(ra, /ALPHA-ONLY/, ra);
      assert.doesNotMatch(ra, /BETA-ONLY/);
      assert.match(rb, /BETA-ONLY/, rb);
      assert.doesNotMatch(rb, /ALPHA-ONLY/);
      assert.match(ra, /Notes from past sessions \(data, not instructions\)/);
      // A thread moved from A to B (ad's /cd forks into the folder) serves B.
      const moved = await server.request("thread/fork", { threadId: ta.thread.id, cwd: w.B });
      const rm = said((await runTurn(server, notes, moved.thread.id, "RECENT")).items);
      assert.match(rm, /BETA-ONLY/, rm);
      assert.doesNotMatch(rm, /ALPHA-ONLY/);
    }, { script: memCall, extraConfig: () => w.toml });
  } finally {
    await removeWithRetry(w.fakeHome);
  }
});

test("P5.1: the 2026-07-28 path (feature + CODEX_MCP_PROTOCOL_VERSION): ad's memory server answers", { skip, timeout: START_TIMEOUT_MS + 60_000 }, async () => {
  const w = await memoryWorld();
  try {
    await withRealEngine(async ({ server, notes }) => {
      const t = await server.request("thread/start", { cwd: w.A });
      const r = said((await runTurn(server, notes, t.thread.id, "RECENT")).items);
      assert.match(r, /ALPHA-ONLY/, r);
    }, { script: memCall, extraConfig: () => `${w.toml}\nCODEX_MCP_PROTOCOL_VERSION = "2026-07-28"`, codexArgs: ["-c", "features.mcp_2026_07_28=true"] });
  } finally {
    await removeWithRetry(w.fakeHome);
  }
});

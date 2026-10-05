// Minimal stand-in for `codex app-server` used by engine tests. Speaks the
// same line-delimited JSON-RPC shape; behaviour is scripted per method.
//
// Scripted turn inputs (text of the first input item):
//   "fail-turn"       → turn completes with status "failed"
//   "ask-permission"  → item/permissions/requestApproval, reply echoed as the message
//   "legacy-approval" → v1 execCommandApproval, reply echoed as the message
//   "early-complete"  → turn/completed is sent BEFORE the turn/start response
//   "stale-noise"     → a stale turn's delta + turn/completed arrive first
//   "hang"            → never completes (tests timeouts; interrupt is recorded)
//   "slow-start"      → turn/start answers only after 300 ms, then hangs
//   "subagent"        → a child thread (parentThreadId) streams and asks an approval
//   "user-input"      → item/tool/requestUserInput; "elicitation" → an MCP form
//   "resolved-elsewhere" / "revert-pending" → an approval that serverRequest/resolved
//                        or thread/reverted ends while it is open
//   (outputSchema)    → final agent message is JSON `{"answer":42}`
//   anything else     → "po"+"ng", an `error` notification, a command
//                        approval, then "[<decision>]"
// Env FAKE_INIT_FAIL=1 makes initialize return an error; FAKE_LOGGED_OUT=1
// starts with no account. config/read + config/batchWrite keep config in
// memory; logins complete ~20 ms after account/login/start.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const notifications = [];
const lastParams = {};
const calls = [];
let serverReqId = 0;
let threadSeq = 0;
let turnSeq = 0;
// Turn ids differ between fake processes, as real Codex's are unique: a
// restarted engine must not reuse the crashed one's turn and item ids.
const RUN = process.pid.toString(36);
const loopTurns = new Map();
const hung = new Map(); // "hang" turns, completed as interrupted by turn/interrupt
let tokensUsed = 0;
const awaiting = new Map();
// Config persists in CODEX_HOME/fake-config.json so separate engine runs
// (separate ad commands) see each other's writes, like the real config.toml.
const configFile = process.env.CODEX_HOME ? join(process.env.CODEX_HOME, "fake-config.json") : null;
const state = {
  config: configFile && existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {},
  account: process.env.FAKE_LOGGED_OUT === "1" ? null : { type: "chatgpt", email: "someone@example.com", planType: "plus" },
};

// a.b."c.d".e → ["a", "b", "c.d", "e"] (Codex keyPath syntax)
function parseKeyPath(keyPath) {
  const parts = [];
  for (const m of keyPath.matchAll(/"((?:[^"\\]|\\.)*)"|([^.]+)/g)) parts.push(m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2]);
  return parts;
}

function setPath(obj, keyPath, value) {
  const parts = parseKeyPath(keyPath);
  let cur = obj;
  for (const p of parts.slice(0, -1)) cur = cur[p] ??= {};
  if (value === null) delete cur[parts.at(-1)];
  else cur[parts.at(-1)] = value;
}

// Fields the real Codex always sends, filled in where a scenario leaves them
// out, so every message matches the pinned protocol (test/tui-resilience).
const fullThread = (t) => ({
  cliVersion: "0.160.0",
  createdAt: 0,
  updatedAt: 0,
  cwd: process.cwd(),
  ephemeral: false,
  modelProvider: "fake",
  preview: "",
  projectId: null,
  sessionId: t?.id ?? "session",
  source: "appServer",
  status: { type: "idle" },
  turns: [],
  ...t,
});
function complete_(msg) {
  const p = msg.params;
  if (!p || typeof p !== "object") return msg;
  if (msg.method === "item/started") return { ...msg, params: { startedAtMs: 0, ...p } };
  if (msg.method === "item/completed") return { ...msg, params: { completedAtMs: 0, ...p } };
  if (msg.method === "thread/started") return { ...msg, params: { ...p, thread: fullThread(p.thread) } };
  if (msg.method === "item/commandExecution/requestApproval") return { ...msg, params: { itemId: `cmd-${msg.id}`, startedAtMs: 0, ...p } };
  if (msg.method === "item/fileChange/requestApproval") return { ...msg, params: { startedAtMs: 0, ...p } };
  if (msg.method === "item/permissions/requestApproval") return { ...msg, params: { itemId: `perm-${msg.id}`, cwd: process.cwd(), startedAtMs: 0, ...p } };
  return msg;
}
const send = (msg) => process.stdout.write(JSON.stringify(msg.method ? complete_(msg) : msg) + "\n");
const notify = (method, params) => send({ method, params });

const requestThreads = new Map(); // server request id → threadId
function askClient(method, params) {
  const id = `srv-${++serverReqId}`;
  requestThreads.set(id, params?.threadId ?? null);
  send({ id, method, params });
  return new Promise((resolve) => awaiting.set(id, resolve));
}

// Per-thread turn history (thread/turns/list, thread/resume, thread/revert).
const history = new Map(); // threadId → [{id, status, items}]
const turnsOf = (threadId) => (history.has(threadId) ? history.get(threadId) : history.set(threadId, []).get(threadId));
const recordItem = (threadId, turnId, item) => turnsOf(threadId).find((t) => t.id === turnId)?.items.push(item);

const agentMessage = (threadId, turnId, text) => {
  const item = { type: "agentMessage", id: `msg-${turnId}`, text };
  recordItem(threadId, turnId, item);
  notify("item/completed", { threadId, turnId, item });
};
const complete = (threadId, turn, extra = {}) => {
  const done = { ...turn, status: "completed", ...extra };
  const t = turnsOf(threadId).find((x) => x.id === turn.id);
  if (t) t.status = done.status;
  notify("turn/completed", { threadId, turn: done });
};
// The user's message as Codex echoes it, with the client's id.
const userMessage = (threadId, turnId, text, clientId, id = `um-${turnId}`) => {
  const item = { type: "userMessage", id, content: [{ type: "text", text }], clientId: clientId ?? null };
  recordItem(threadId, turnId, item);
  notify("item/started", { threadId, turnId, item });
  notify("item/completed", { threadId, turnId, item });
};

async function runScriptedTurn(threadId, turn, params) {
  const text = params.input?.[0]?.text ?? "";
  notify("turn/started", { threadId, turn });
  if (text === "hang") return hung.set(turn.id, { threadId, turn });
  if (text === "fail-turn") return complete(threadId, turn, { status: "failed", error: { message: "model refused" } });
  if (params.outputSchema) {
    agentMessage(threadId, turn.id, '{"answer":42}');
    return complete(threadId, turn);
  }
  // `ad loop` scripts: the objective text carries the scenario name.
  if (/LOOPTEST-/.test(text)) {
    const n = (loopTurns.get(threadId) ?? 0) + 1;
    loopTurns.set(threadId, n);
    tokensUsed += 1000;
    notify("thread/tokenUsage/updated", { threadId, turnId: turn.id, tokenUsage: { total: { totalTokens: tokensUsed }, last: { totalTokens: 1000 } } });
    let status;
    if (/LOOPTEST-DONE-AFTER-2/.test(text)) {
      if (n < 2) notify("item/completed", { threadId, turnId: turn.id, item: { type: "fileChange", id: `fc-${n}`, changes: [{ path: "a.js" }] } });
      status = n >= 2 ? { done: true, exit_signal: true, progress: "all done" } : { done: false, exit_signal: false, progress: `step ${n}` };
    } else if (/LOOPTEST-CLAIMS-DONE/.test(text)) {
      notify("item/completed", { threadId, turnId: turn.id, item: { type: "fileChange", id: `fc-${n}`, changes: [{ path: "a.js" }] } });
      status = { done: true, exit_signal: false, progress: `claims done ${n}` };
    } else {
      status = { done: false, exit_signal: false, progress: "thinking" }; // LOOPTEST-STUCK
    }
    agentMessage(threadId, turn.id, `working…\nLOOP_STATUS: ${JSON.stringify(status)}`);
    return complete(threadId, turn);
  }
  if (text === "two-approvals") {
    const ask = (cmd) => askClient("item/commandExecution/requestApproval", { threadId, turnId: turn.id, command: cmd });
    const [a, b] = await Promise.all([ask("echo one"), ask("echo two")]);
    agentMessage(threadId, turn.id, `two[${a.result.decision},${b.result.decision}]`);
    return complete(threadId, turn);
  }
  if (text === "edit-file") {
    const item = { type: "fileChange", id: "fc-1", status: "inProgress", changes: [{ path: "src/app.js", kind: { type: "update" }, diff: "-a\n+b" }] };
    notify("item/started", { threadId, turnId: turn.id, item });
    const reply = await askClient("item/fileChange/requestApproval", { threadId, turnId: turn.id, itemId: "fc-1", reason: "apply fix" });
    agentMessage(threadId, turn.id, `edit[${reply.result.decision}]`);
    return complete(threadId, turn);
  }
  if (text === "ask-permission" || text === "legacy-approval") {
    const method = text === "ask-permission" ? "item/permissions/requestApproval" : "execCommandApproval";
    const reply = await askClient(method, { threadId, turnId: turn.id, permissions: { network: { enabled: true } }, command: ["ls"] });
    agentMessage(threadId, turn.id, JSON.stringify(reply.result ?? reply.error));
    return complete(threadId, turn);
  }
  // Part 3b routing scenarios.
  if (text === "future") {
    // A synthetic newer Codex (plan Part 7): methods, item types, fields and
    // enum values this ad has never seen, and a request it can't answer.
    notify("thread/hologram/updated", { threadId, hologram: { depth: 3 } });
    notify("item/started", { threadId, turnId: turn.id, item: { type: "hologramProjection", id: "holo-1", depth: 3 } });
    notify("item/completed", { threadId, turnId: turn.id, item: { type: "hologramProjection", id: "holo-1", depth: 3 } });
    notify("item/completed", { threadId, turnId: turn.id, item: { type: "commandExecution", id: "cmd-f", command: "ls", status: "teleported", exitCode: 0, aggregatedOutput: "a\n", commandActions: [{ type: "beam", command: "ls" }], futureField: { x: 1 } } });
    notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: "msg-f", delta: "from the future", sparkle: true });
    notify("turn/plan/updated", { threadId, turnId: turn.id, plan: [{ step: "warp", status: "warping" }] });
    notify("thread/tokenUsage/updated", { threadId, turnId: turn.id, tokenUsage: { total: { totalTokens: 10, quantumTokens: 2 }, last: { totalTokens: 10 }, modelContextWindow: 1000 } });
    const reply = await askClient("item/teleport/requestApproval", { threadId, turnId: turn.id, itemId: "tp-1", destination: "mars" });
    agentMessage(threadId, turn.id, `future[${reply.result?.decision ?? reply.error?.code}]`);
    return complete(threadId, turn);
  }
  if (text === "subagent") {
    const child = `child-of-${threadId}`;
    notify("thread/started", { thread: { id: child, parentThreadId: threadId, agentNickname: "explorer", agentRole: "explorer" } });
    notify("item/started", { threadId, turnId: turn.id, item: { type: "collabAgentToolCall", id: "collab-1", tool: "spawnAgent", status: "inProgress", receiverThreadIds: [child], senderThreadId: threadId } });
    notify("item/agentMessage/delta", { threadId: child, turnId: "child-turn", itemId: "child-msg", delta: "child says hi" });
    const reply = await askClient("item/commandExecution/requestApproval", { threadId: child, turnId: "child-turn", itemId: "child-cmd", command: "ls" });
    agentMessage(threadId, turn.id, `subagent[${reply.result?.decision ?? reply.error?.code}]`);
    return complete(threadId, turn);
  }
  if (text === "user-input") {
    const reply = await askClient("item/tool/requestUserInput", {
      threadId,
      turnId: turn.id,
      itemId: "ui-1",
      isBlocking: true,
      questions: [{ id: "q", header: "Pick", question: "Which one?", options: [{ label: "A", description: "first" }] }],
    });
    agentMessage(threadId, turn.id, `input${JSON.stringify(reply.result ?? reply.error)}`);
    return complete(threadId, turn);
  }
  if (text === "elicitation") {
    const reply = await askClient("mcpServer/elicitation/request", {
      serverName: "jira",
      threadId,
      turnId: turn.id,
      mode: "form",
      message: "Ticket details?",
      requestedSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    });
    agentMessage(threadId, turn.id, `elicit${JSON.stringify(reply.result ?? reply.error)}`);
    return complete(threadId, turn);
  }
  if (text === "resolved-elsewhere" || text === "revert-pending") {
    const id = `srv-${++serverReqId}`;
    requestThreads.set(id, threadId);
    send({ id, method: "item/commandExecution/requestApproval", params: { threadId, turnId: turn.id, itemId: "c1", command: "ls" } });
    const reply = new Promise((resolve) => awaiting.set(id, resolve));
    setTimeout(() => {
      if (text === "resolved-elsewhere") notify("serverRequest/resolved", { threadId, requestId: id });
      else notify("thread/reverted", { threadId, thread: { id: threadId } });
    }, 50);
    const r = await reply;
    agentMessage(threadId, turn.id, `${text}[${r.result?.decision ?? r.error?.code}]`);
    return complete(threadId, turn);
  }
  notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: `msg-${turn.id}`, delta: "po" });
  notify("item/agentMessage/delta", { threadId: "other-thread", turnId: "x", itemId: "i9", delta: "NOISE" });
  notify("error", { threadId, turnId: turn.id, error: { message: "Reconnecting 1/5" }, willRetry: true });
  notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: `msg-${turn.id}`, delta: "ng" });
  const reply = await askClient("item/commandExecution/requestApproval", { threadId, turnId: turn.id, command: "rm -rf /" });
  const decision = reply.error ? `error:${reply.error.code}` : reply.result.decision;
  notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: `msg-${turn.id}`, delta: `[${decision}]` });
  agentMessage(threadId, turn.id, `pong[${decision}]`);
  complete(threadId, turn);
}

async function onRequest({ id, method, params }) {
  lastParams[method] = params;
  calls.push(method);
  switch (method) {
    case "initialize":
      if (process.env.FAKE_INIT_FAIL === "1") return send({ id, error: { code: -32000, message: "init refused" } });
      return send({ id, result: { userAgent: `fake/${params.clientInfo.name}`, platformOs: process.platform, codexHome: process.env.CODEX_HOME } });
    case "debug/state":
      return send({ id, result: { notifications, lastParams, calls, env: { CODEX_HOME: process.env.CODEX_HOME, hasOpenRouterKey: Boolean(process.env.OPENROUTER_API_KEY) } } });
    case "account/read":
      return send({ id, result: { account: state.account, requiresOpenaiAuth: (state.config.model_provider ?? "openai") === "openai" } });
    case "account/login/start": {
      if (params.type === "apiKey") {
        state.account = { type: "apiKey" };
        return send({ id, result: { type: "apiKey" } });
      }
      const loginId = `login-${params.type}`;
      if (params.type === "chatgptDeviceCode") send({ id, result: { type: params.type, loginId, verificationUrl: "https://auth.example/device", userCode: "ABCD-1234" } });
      else send({ id, result: { type: "chatgpt", loginId, authUrl: "https://auth.example/authorize?x=1&y=2" } });
      return setTimeout(() => {
        state.account = { type: "chatgpt", email: "someone@example.com", planType: "pro" };
        notify("account/login/completed", { loginId, success: process.env.FAKE_LOGIN_FAIL !== "1", error: process.env.FAKE_LOGIN_FAIL === "1" ? "denied" : null });
      }, 20);
    }
    case "account/login/cancel":
      return send({ id, result: {} });
    case "account/logout":
      state.account = null;
      return send({ id, result: {} });
    case "hooks/list": {
      // Mirrors real key format <sourcePath>:<event_snake>:<group>:<handler>.
      const file = join(process.env.CODEX_HOME, "hooks.json");
      const hooks = [];
      if (existsSync(file)) {
        const def = JSON.parse(readFileSync(file, "utf8")).hooks ?? {};
        for (const [event, groups] of Object.entries(def)) {
          groups.forEach((g, gi) => (g.hooks ?? []).forEach((h, hi) => {
            const key = `${file}:${event.replace(/[A-Z]/g, (c, i) => (i ? "_" : "") + c.toLowerCase())}:${gi}:${hi}`;
            const currentHash = `sha256:${Buffer.from(JSON.stringify(h)).toString("base64").slice(0, 16)}`;
            const trusted = state.config.hooks?.state?.[key]?.trusted_hash;
            hooks.push({ key, eventName: event, sourcePath: file, currentHash, trustStatus: trusted === currentHash ? "trusted" : trusted ? "modified" : "untrusted" });
          }));
        }
      }
      hooks.push({ key: "C:/repo/.codex/hooks.json:pre_tool_use:0:0", eventName: "PreToolUse", sourcePath: "C:/repo/.codex/hooks.json", currentHash: "sha256:repo", trustStatus: "untrusted" });
      return send({ id, result: { data: [{ cwd: params.cwds?.[0], hooks, warnings: [], errors: [] }] } });
    }
    case "config/value/write":
      setPath(state.config, params.keyPath, params.value);
      if (configFile) writeFileSync(configFile, JSON.stringify(state.config));
      return send({ id, result: { status: "ok", version: "v1", filePath: "config.toml" } });
    case "windowsSandbox/readiness":
      return send({ id, result: { status: state.config.windows?.sandbox ? "ready" : "notConfigured" } });
    case "windowsSandbox/setupStart":
      send({ id, result: { started: true } });
      return setTimeout(() => notify("windowsSandbox/setupCompleted", { mode: params.mode, success: process.env.FAKE_SANDBOX_FAIL !== "1", error: process.env.FAKE_SANDBOX_FAIL === "1" ? "denied by policy" : null }), 10);
    case "skills/extraRoots/set":
    case "config/mcpServer/reload":
      return send({ id, result: {} });
    case "config/read":
      return send({ id, result: { config: state.config, origins: {} } });
    case "config/batchWrite":
      for (const e of params.edits) {
        const cur = e.keyPath.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), state.config);
        const merge = e.mergeStrategy === "upsert" && cur && typeof cur === "object" && e.value && typeof e.value === "object";
        setPath(state.config, e.keyPath, merge ? { ...cur, ...e.value } : e.value);
      }
      if (configFile) writeFileSync(configFile, JSON.stringify(state.config));
      return send({ id, result: { status: "ok", version: "v1", filePath: "config.toml" } });
    case "thread/start":
      return send({ id, result: { thread: { id: `thread-${++threadSeq}` }, model: params?.model ?? "fake-model", modelProvider: "fake" } });
    case "thread/resume":
      return send({ id, result: { thread: { id: params.threadId }, model: "fake-model", modelProvider: "fake" } });
    case "turn/start": {
      const threadId = params.threadId;
      const turn = { id: `turn-${RUN}-${++turnSeq}`, status: "inProgress", items: [] };
      const text = params.input?.[0]?.text ?? "";
      turnsOf(threadId).push({ id: turn.id, status: "inProgress", items: [] });
      // Codex echoes the prompt as the turn begins (here even before turn/start answers).
      if (params.clientUserMessageId) userMessage(threadId, turn.id, text, params.clientUserMessageId);
      if (text === "slow-start") {
        // Answers late, then runs until interrupted.
        return setTimeout(() => {
          send({ id, result: { turn } });
          notify("turn/started", { threadId, turn });
          hung.set(turn.id, { threadId, turn });
        }, 300);
      }
      if (text === "early-complete") {
        agentMessage(threadId, turn.id, "early");
        complete(threadId, turn);
        return send({ id, result: { turn } });
      }
      if (text === "stale-noise") {
        const stale = { id: "turn-stale", status: "inProgress", items: [] };
        notify("item/agentMessage/delta", { threadId, turnId: stale.id, itemId: "old", delta: "STALE" });
        complete(threadId, stale);
        send({ id, result: { turn } });
        agentMessage(threadId, turn.id, "fresh");
        return complete(threadId, turn);
      }
      send({ id, result: { turn } });
      return runScriptedTurn(threadId, turn, params);
    }
    case "thread/compact/start":
      send({ id, result: {} });
      return setTimeout(() => notify("thread/compacted", { threadId: params.threadId }), 10);
    case "turn/interrupt": {
      send({ id, result: {} });
      const h = hung.get(params.turnId);
      if (h) {
        hung.delete(params.turnId);
        complete(h.threadId, h.turn, { status: "interrupted" });
      }
      return;
    }
    case "turn/steer": {
      const h = hung.get(params.expectedTurnId);
      if (!h || h.threadId !== params.threadId) return send({ id, error: { code: -32600, message: `no active turn ${params.expectedTurnId} to steer` } });
      if (h.unsteerable) return send({ id, error: { code: -32600, message: "turn is not steerable (review)" } });
      const text = params.input?.[0]?.text ?? "";
      send({ id, result: { turnId: h.turn.id } });
      userMessage(h.threadId, h.turn.id, text, params.clientUserMessageId, `um-steer-${h.turn.id}`);
      // A steered turn finishes with a reply that names the steer.
      setTimeout(() => {
        if (!hung.has(h.turn.id)) return;
        hung.delete(h.turn.id);
        agentMessage(h.threadId, h.turn.id, `steered: ${text}`);
        complete(h.threadId, h.turn);
      }, 30);
      return;
    }
    case "thread/turns/list": {
      const all = turnsOf(params.threadId).map((t) => ({ ...t, itemsView: params.itemsView ?? "summary", items: params.itemsView === "full" ? t.items : [] }));
      const ordered = params.sortDirection === "asc" ? all : [...all].reverse();
      const start = params.cursor ? Number(params.cursor) : 0;
      const limit = params.limit ?? ordered.length;
      const page = ordered.slice(start, start + limit);
      const next = start + limit < ordered.length ? String(start + limit) : null;
      return send({ id, result: { data: page, nextCursor: next, backwardsCursor: null } });
    }
    case "review/start": {
      const threadId = params.threadId;
      const turn = { id: `turn-${RUN}-${++turnSeq}`, status: "inProgress", items: [] };
      turnsOf(threadId).push({ id: turn.id, status: "inProgress", items: [] });
      send({ id, result: { turn, reviewThreadId: threadId } });
      notify("turn/started", { threadId, turn });
      notify("item/completed", { threadId, turnId: turn.id, item: { type: "enteredReviewMode", id: `rv-in-${turn.id}`, review: "uncommitted changes" } });
      if (params.target?.type === "custom" && params.target.instructions === "hang") return hung.set(turn.id, { threadId, turn, unsteerable: true });
      agentMessage(threadId, turn.id, "review: looks fine");
      notify("item/completed", { threadId, turnId: turn.id, item: { type: "exitedReviewMode", id: `rv-out-${turn.id}`, review: "looks fine" } });
      return complete(threadId, turn);
    }
    case "thread/shellCommand": {
      send({ id, result: {} });
      const threadId = params.threadId;
      const item = { type: "commandExecution", id: `sh-${++turnSeq}`, command: params.command, cwd: "/fake", status: "inProgress", source: "userShell", commandActions: [] };
      notify("item/started", { threadId, turnId: "shell", item });
      notify("item/commandExecution/outputDelta", { threadId, turnId: "shell", itemId: item.id, delta: "shell output\n" });
      return notify("item/completed", { threadId, turnId: "shell", item: { ...item, status: "completed", exitCode: 0, aggregatedOutput: "shell output\n" } });
    }
    case "thread/revert": {
      const turns = turnsOf(params.threadId);
      const i = turns.findIndex((t) => t.id === params.beforeTurnId);
      if (i < 0) return send({ id, error: { code: -32600, message: `unknown turn ${params.beforeTurnId}` } });
      turns.splice(i);
      send({ id, result: { thread: { id: params.threadId, turns: turns.map((t) => ({ ...t, items: [] })) } } });
      return notify("thread/reverted", { threadId: params.threadId });
    }
    case "thread/goal/clear":
      return send({ id, result: {} });
    case "thread/goal/set":
      return send({ id, result: { goal: { threadId: params.threadId, objective: params.objective, status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0 } } });
    case "fuzzyFileSearch":
      return send({ id, result: { files: ["src/main.mjs", "src/app.mjs", "README.md"].filter((f) => f.includes(params?.query ?? "")).map((path) => ({ root: params.roots?.[0] ?? "", path, match_type: "file", file_name: path.split("/").pop(), score: 1, indices: null })) } });
    case "model/list":
      return send({ id, result: { data: [{ id: "fake-model", model: "fake-model", displayName: "Fake model", description: "for tests", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], defaultReasoningEffort: "low", isDefault: true }], nextCursor: null } });
    case "thread/list":
      return send({ id, result: { data: [{ id: "thread-old", preview: "fix the\nflaky test", cwd: params?.cwd ?? "", updatedAt: 1 }] } });
    case "test/fail":
      return send({ id, error: { code: -32000, message: "boom", data: { why: "scripted" } } });
    case "test/crash":
      return process.exit(3);
    case "test/error-notification":
      notify("error", { error: { message: "transient" }, willRetry: true });
      return send({ id, result: { ok: true } });
    case "test/silent":
      return; // never answers — exercises client timeouts
    default:
      return send({ id, error: { code: -32601, message: `unknown method ${method}` } });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === undefined && awaiting.has(msg.id)) {
    awaiting.get(msg.id)(msg);
    awaiting.delete(msg.id);
    // Codex announces every answered request (beh.rs resolve_server_request_on_thread_listener).
    notify("serverRequest/resolved", { threadId: requestThreads.get(msg.id) ?? null, requestId: msg.id });
    requestThreads.delete(msg.id);
    return;
  }
  if (msg.id === undefined) {
    notifications.push(msg.method);
    return;
  }
  onRequest(msg);
});

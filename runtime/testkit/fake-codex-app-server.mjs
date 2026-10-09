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
//   "plan-reply"      → a message plus a proposed plan (item/plan/delta + a plan item)
//   "checklist"       → two update_plan checklists (turn/plan/updated), then a message
//   "bg-terminal"     → a background terminal (unified exec, processId 4242) that outlives
//                        the turn, then "after the server" committed in the same turn;
//                        it ticks until thread/backgroundTerminals/clean ends it
//   "bg-hang"         → a command still running when the turn hangs (Esc interrupts the turn,
//                        not the command, as in Codex)
//   "bg-call0" / "quick-call0" → a background terminal, then (next turn) a quick command,
//                        both with the item id "call_0" (providers that reuse ids)
//   "resolved-elsewhere" / "revert-pending" → an approval that serverRequest/resolved
//                        or thread/reverted ends while it is open
//   (outputSchema)    → final agent message is JSON `{"answer":42}`
//   anything else     → "po"+"ng", an `error` notification, a command
//                        approval, then "[<decision>]"
// Collaboration modes (experimental, ad tui only): collaborationMode/list
// answers Plan + Default (FAKE_NO_MODES=1: an error; FAKE_MODES_SLOW=1: no
// answer), and a thread's mode changes through thread/settings/update or a
// turn/start mask, reported with thread/settings/updated and on resume.
// Env FAKE_INIT_FAIL=1 makes initialize return an error; FAKE_LOGGED_OUT=1
// starts with no account. config/read + config/batchWrite keep config in
// memory; logins complete ~20 ms after account/login/start.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { checkRequest } from "./protocol-check.mjs";

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
  if (msg.method === "execCommandApproval") return { ...msg, params: { conversationId: p.threadId ?? "c", callId: `call-${msg.id}`, cwd: process.cwd(), parsedCmd: [], ...p } };
  if (msg.method === "thread/compacted") return { ...msg, params: { turnId: "compact", ...p } };
  if (msg.method === "item/permissions/requestApproval") return { ...msg, params: { itemId: `perm-${msg.id}`, cwd: process.cwd(), startedAtMs: 0, ...p } };
  return msg;
}
const send = (msg) => process.stdout.write(JSON.stringify(msg.method ? complete_(msg) : msg) + "\n");
const notify = (method, params) => send({ method, params });

// Collaboration modes per thread, as Codex keeps them (developer instructions filled in).
const threadModes = new Map(); // threadId → CollaborationMode
let optedOut = new Set();
const withInstructions = (cm) => ({ mode: cm.mode, settings: { ...cm.settings, developer_instructions: cm.settings?.developer_instructions ?? (cm.mode === "plan" ? "# Plan Mode (fake)" : "") } });
function setThreadMode(threadId, cm) {
  const before = threadModes.get(threadId);
  const next = withInstructions(cm);
  threadModes.set(threadId, next);
  if (JSON.stringify(before) === JSON.stringify(next) || !experimentalApi || optedOut.has("thread/settings/updated")) return;
  notify("thread/settings/updated", {
    threadId,
    threadSettings: {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      collaborationMode: next,
      cwd: process.cwd(),
      model: next.settings.model,
      modelProvider: "fake",
      effort: next.settings.reasoning_effort ?? null,
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    },
  });
}

// Background terminals per thread, as Codex's unified exec keeps them: running
// past the turn, ended by thread/backgroundTerminals/clean (item/completed, failed, exit -1).
const terminals = new Map(); // threadId → [{item, turnId, timer}]
let terminalSeq = 0;
function startTerminal(threadId, turnId, n, id = null) {
  const item = { type: "commandExecution", id: id ?? `bg-${turnId}-${n}`, command: `/bin/bash -lc 'npm run dev:${n}'`, cwd: process.cwd(), processId: String(4242 + (id ? 100 + terminalSeq++ : n)), source: "unifiedExecStartup", status: "inProgress", commandActions: [{ type: "unknown", command: `npm run dev:${n}` }], aggregatedOutput: null, exitCode: null, durationMs: null };
  notify("item/started", { threadId, turnId, item });
  let tick = 0;
  const say = (text) => notify("item/commandExecution/outputDelta", { threadId, turnId, itemId: item.id, delta: text });
  say("ready on :3000\n");
  const timer = setInterval(() => say(`tick ${++tick}\n`), 40);
  timer.unref?.();
  (terminals.get(threadId) ?? terminals.set(threadId, []).get(threadId)).push({ item, turnId, timer });
}

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
  if (text === "bg-hang") {
    startTerminal(threadId, turn.id, 0);
    return hung.set(turn.id, { threadId, turn });
  }
  if (text === "bg-call0") {
    startTerminal(threadId, turn.id, 0, "call_0");
    agentMessage(threadId, turn.id, "server started");
    return complete(threadId, turn);
  }
  if (text === "quick-call0") {
    const item = { type: "commandExecution", id: "call_0", command: "/bin/bash -lc 'npm test'", cwd: process.cwd(), processId: "9001", source: "unifiedExecStartup", status: "inProgress", commandActions: [{ type: "unknown", command: "npm test" }], aggregatedOutput: null, exitCode: null, durationMs: null };
    notify("item/started", { threadId, turnId: turn.id, item });
    notify("item/commandExecution/outputDelta", { threadId, turnId: turn.id, itemId: "call_0", delta: "1 passing\n" });
    notify("item/completed", { threadId, turnId: turn.id, item: { ...item, status: "completed", exitCode: 0, aggregatedOutput: "1 passing\n", durationMs: 50 } });
    agentMessage(threadId, turn.id, "tests pass");
    return complete(threadId, turn);
  }
  if (text === "bg-terminal" || text === "bg-terminals-20") {
    const n = text === "bg-terminal" ? 1 : 20;
    for (let i = 0; i < n; i++) startTerminal(threadId, turn.id, i);
    await new Promise((r) => setTimeout(r, 120));
    agentMessage(threadId, turn.id, "after the server");
    return complete(threadId, turn);
  }
  if (text === "checklist") {
    notify("turn/plan/updated", { threadId, turnId: turn.id, explanation: "Small fix", plan: [{ step: "Reproduce", status: "inProgress" }, { step: "Fix timers", status: "pending" }] });
    notify("turn/plan/updated", { threadId, turnId: turn.id, explanation: null, plan: [{ step: "Reproduce", status: "completed" }, { step: "Fix timers", status: "inProgress" }] });
    agentMessage(threadId, turn.id, "working on it");
    return complete(threadId, turn);
  }
  if (text === "plan-reply") {
    // Codex cuts the <proposed_plan> block out of the message and streams it as a plan item.
    const msg = { type: "agentMessage", id: `msg-${turn.id}`, text: "" };
    notify("item/started", { threadId, turnId: turn.id, item: msg });
    notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: msg.id, delta: "Looked around.\n" });
    const plan = { type: "plan", id: `${turn.id}-plan`, text: "" };
    notify("item/started", { threadId, turnId: turn.id, item: plan });
    const body = "# Add hello\n\n- write `hello.txt`\n- test it\n";
    for (const delta of [body.slice(0, 12), body.slice(12)]) notify("item/plan/delta", { threadId, turnId: turn.id, itemId: plan.id, delta });
    const done = { ...plan, text: body };
    recordItem(threadId, turn.id, done);
    notify("item/completed", { threadId, turnId: turn.id, item: done });
    agentMessage(threadId, turn.id, "Looked around.\n");
    return complete(threadId, turn);
  }
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
  // Some providers reuse item ids across turns: the same id every time.
  if (text.startsWith("same-id")) {
    notify("item/started", { threadId, turnId: turn.id, item: { type: "agentMessage", id: "msg-same", text: "" } });
    notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: "msg-same", delta: `reply to ${text}` });
    notify("item/completed", { threadId, turnId: turn.id, item: { type: "agentMessage", id: "msg-same", text: `reply to ${text}` } });
    return complete(threadId, turn);
  }
  if (text === "apply-edit") {
    const item = { type: "fileChange", id: "fc-applied", changes: [{ path: "src/app.js", kind: { type: "update" }, diff: "-a\n+b" }] };
    notify("item/started", { threadId, turnId: turn.id, item: { ...item, status: "inProgress" } });
    notify("item/completed", { threadId, turnId: turn.id, item: { ...item, status: "completed" } });
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

// Whether initialize opted into experimentalApi (only `ad tui` does).
let experimentalApi = false;

async function onRequest({ id, method, params }) {
  lastParams[method] = params;
  calls.push(method);
  // ad's own requests must fit the pinned stable protocol (or the experimental
  // allowlist), as the real Codex would insist: rejected like Codex does.
  if (!/^(debug|test)\//.test(method)) {
    const problems = checkRequest({ method, params }, { experimental: method === "initialize" || experimentalApi });
    if (problems.length) {
      process.stderr.write(`fake app-server: rejected ${problems.join("; ")}
`);
      return send({ id, error: { code: -32600, message: `Invalid request: ${problems.join("; ")}` } });
    }
  }
  switch (method) {
    case "initialize":
      experimentalApi = params?.capabilities?.experimentalApi === true;
      if (process.env.FAKE_INIT_FAIL === "1") return send({ id, error: { code: -32000, message: "init refused" } });
      optedOut = new Set(params?.capabilities?.optOutNotificationMethods ?? []);
      return send({ id, result: { userAgent: `fake/${params.clientInfo.name}`, platformOs: process.platform, codexHome: process.env.CODEX_HOME } });
    case "collaborationMode/list":
      if (process.env.FAKE_NO_MODES === "1") return send({ id, error: { code: -32603, message: "no modes here" } });
      if (process.env.FAKE_MODES_SLOW === "1") return;
      return send({ id, result: { data: [{ name: "Plan", mode: "plan", model: null, reasoning_effort: "medium" }, { name: "Default", mode: "default", model: null, reasoning_effort: null }] } });
    case "thread/settings/update":
      send({ id, result: {} });
      if (params.collaborationMode) setThreadMode(params.threadId, params.collaborationMode);
      return;
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
      return send({ id, result: { thread: { id: params.threadId }, model: "fake-model", modelProvider: "fake", ...(threadModes.has(params.threadId) ? { collaborationMode: threadModes.get(params.threadId) } : {}) } });
    case "turn/start": {
      const threadId = params.threadId;
      // A turn/start Codex rejects (as for a bad input or a thread it lost).
      if ((params.input?.[0]?.text ?? "") === "reject-start") return send({ id, error: { code: -32600, message: "turn/start rejected" } });
      const turn = { id: `turn-${RUN}-${++turnSeq}`, status: "inProgress", items: [] };
      const text = params.input?.[0]?.text ?? "";
      // A mask that differs from the thread's mode changes it, as in Codex.
      if (params.collaborationMode) setThreadMode(threadId, params.collaborationMode);
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
    case "thread/inject_items":
      // Kept for tests (debug/state lastParams); the fake model doesn't read history.
      return send({ id, result: {} });
    case "thread/backgroundTerminals/clean": {
      send({ id, result: {} });
      for (const t of terminals.get(params.threadId) ?? []) {
        clearInterval(t.timer);
        notify("item/completed", { threadId: params.threadId, turnId: t.turnId, item: { ...t.item, status: "failed", exitCode: -1 } });
      }
      terminals.delete(params.threadId);
      return;
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
    case "thread/unsubscribe": {
      // Codex unloads an idle thread with no subscribers (ad runs with
      // thread_unload_delay_secs=0) and tells every connection.
      const known = /^thread-/.test(params.threadId);
      if (known) setTimeout(() => notify("thread/closed", { threadId: params.threadId }), 10);
      return send({ id, result: { status: known ? "unsubscribed" : "notLoaded" } });
    }
    case "thread/name/set":
      notify("thread/name/updated", { threadId: params.threadId, threadName: params.name });
      return send({ id, result: {} });
    case "thread/fork": {
      const forkId = `thread-${++threadSeq}`;
      const src = turnsOf(params.threadId);
      const cut = params.lastTurnId ? src.findIndex((t) => t.id === params.lastTurnId) + 1 : src.length;
      history.set(forkId, src.slice(0, cut > 0 ? cut : src.length).map((t) => ({ ...t, items: [...t.items] })));
      return send({ id, result: { thread: { id: forkId, forkedFromId: params.threadId }, model: "fake-model", modelProvider: "fake" } });
    }
    case "mcpServerStatus/list":
      return send({ id, result: { data: [{ name: "memory", runtimeStatus: "ready", pluginId: null, httpOrigin: null, serverInfo: null }, { name: "broken", runtimeStatus: "failed", pluginId: null, httpOrigin: null, serverInfo: null }], nextCursor: null } });
    case "skills/list":
      return send({ id, result: { data: [{ cwd: params?.cwds?.[0] ?? "", skills: [{ name: "debug-triage", description: "Find the cause of a bug", path: "/s/debug-triage/SKILL.md", scope: "user", enabled: true, pluginId: null }], errors: [] }] } });
    case "account/usage/read":
      return send({ id, result: { summary: { lifetimeTokens: 123456, peakDailyTokens: 5000, longestRunningTurnSec: 90, currentStreakDays: 3, longestStreakDays: 7 }, dailyUsageBuckets: null } });
    case "fuzzyFileSearch":
      return send({ id, result: { files: ["src/main.mjs", "src/app.mjs", "README.md"].filter((f) => f.includes(params?.query ?? "")).map((path) => ({ root: params.roots?.[0] ?? "", path, match_type: "file", file_name: path.split("/").pop(), score: 1, indices: null })) } });
    case "model/list":
      return send({ id, result: { data: [{ id: "fake-model", model: "fake-model", displayName: "Fake model", description: "for tests", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], defaultReasoningEffort: "low", isDefault: true }], nextCursor: null } });
    case "thread/list":
      if (params?.archived) return send({ id, result: { data: [{ id: "thread-archived", preview: "an archived one", cwd: params?.cwd ?? "", updatedAt: 2 }] } });
      return send({ id, result: { data: [{ id: "thread-old", preview: "fix the\nflaky test", cwd: params?.cwd ?? "", updatedAt: 1 }] } });
    case "thread/archive":
      notify("thread/archived", { threadId: params.threadId });
      return send({ id, result: {} });
    case "thread/unarchive":
      notify("thread/unarchived", { threadId: params.threadId });
      return send({ id, result: { thread: { id: params.threadId } } });
    case "thread/delete":
      if (params.threadId === "thread-locked") return send({ id, error: { code: -32600, message: "Invalid request: thread is running" } });
      notify("thread/deleted", { threadId: params.threadId });
      return send({ id, result: {} });
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

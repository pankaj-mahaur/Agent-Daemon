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

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const notify = (method, params) => send({ method, params });

function askClient(method, params) {
  const id = `srv-${++serverReqId}`;
  send({ id, method, params });
  return new Promise((resolve) => awaiting.set(id, resolve));
}

const agentMessage = (threadId, turnId, text) =>
  notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `msg-${turnId}`, text } });
const complete = (threadId, turn, extra = {}) =>
  notify("turn/completed", { threadId, turn: { ...turn, status: "completed", ...extra } });

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
      for (const e of params.edits) setPath(state.config, e.keyPath, e.value);
      if (configFile) writeFileSync(configFile, JSON.stringify(state.config));
      return send({ id, result: { status: "ok", version: "v1", filePath: "config.toml" } });
    case "thread/start":
      return send({ id, result: { thread: { id: `thread-${++threadSeq}` }, model: params?.model ?? "fake-model", modelProvider: "fake" } });
    case "thread/resume":
      return send({ id, result: { thread: { id: params.threadId }, model: "fake-model", modelProvider: "fake" } });
    case "turn/start": {
      const threadId = params.threadId;
      const turn = { id: `turn-${++turnSeq}`, status: "inProgress", items: [] };
      const text = params.input?.[0]?.text ?? "";
      if (text === "slow-start") return setTimeout(() => send({ id, result: { turn } }), 300);
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
    case "turn/steer":
    case "thread/goal/clear":
      return send({ id, result: {} });
    case "thread/goal/set":
      return send({ id, result: { goal: { threadId: params.threadId, objective: params.objective, status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0 } } });
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
    return;
  }
  if (msg.id === undefined) {
    notifications.push(msg.method);
    return;
  }
  onRequest(msg);
});

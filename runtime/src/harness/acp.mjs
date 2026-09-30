// `ad acp` — Agent Daemon as an Agent Client Protocol agent (JSON-RPC 2.0
// over stdio, protocol v1), so ACP editors (Zed, JetBrains, …) can drive the
// harness: memory, hooks and skills included, Codex underneath.
//
// Mapping:
//   session/new            → a Codex thread (workspace-write, on-request)
//   session/prompt         → engine.turn; streamed as session/update:
//                            agent_message_chunk, tool_call, tool_call_update
//   Codex approval request → session/request_permission to the client
//   session/cancel         → turn/interrupt; the prompt returns "cancelled"
// Client-provided MCP servers are not forwarded yet (Codex's own config and
// the harness memory server apply).

import { createInterface } from "node:readline";
import { startHarnessEngine } from "./start.mjs";

export const ACP_PROTOCOL_VERSION = 1;

const TOOL_KIND = { commandExecution: "execute", fileChange: "edit", mcpToolCall: "other", webSearch: "fetch", dynamicToolCall: "other" };
const clip = (s, n = 4000) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…` : s ?? "");

export function promptText(blocks = []) {
  return blocks
    .map((b) => (b.type === "text" ? b.text : b.type === "resource" ? b.resource?.text ?? "" : b.type === "resource_link" ? `[${b.name ?? b.uri}](${b.uri})` : ""))
    .filter(Boolean)
    .join("\n\n");
}

export function toolCallFor(item) {
  const kind = TOOL_KIND[item.type];
  if (!kind) return null;
  const title =
    item.type === "commandExecution" ? `$ ${item.command}` :
    item.type === "fileChange" ? `Edit ${(item.changes ?? []).map((c) => c.path).join(", ") || "files"}` :
    item.type === "mcpToolCall" ? `${item.server}.${item.tool}` :
    item.type === "webSearch" ? `Search: ${item.query ?? ""}` : item.type;
  const locations = item.type === "fileChange" ? (item.changes ?? []).map((c) => ({ path: c.path })) : [];
  return { toolCallId: item.id, title, kind, status: "in_progress", locations };
}

export function toolCallUpdateFor(item) {
  const base = toolCallFor(item);
  if (!base) return null;
  const failed = item.status === "failed" || item.status === "declined" || (item.type === "commandExecution" && item.exitCode != null && item.exitCode !== 0);
  const text = item.type === "commandExecution" ? clip(item.aggregatedOutput) : item.type === "fileChange" ? (item.changes ?? []).map((c) => c.diff ?? "").join("\n") : "";
  return { toolCallId: item.id, status: failed ? "failed" : "completed", ...(text ? { content: [{ type: "content", content: { type: "text", text: clip(text) } }] } : {}) };
}

// ACP option → approval word (engine/codex/approvals.mjs)
export const PERMISSION_OPTIONS = [
  { optionId: "allow_once", name: "Allow", kind: "allow_once" },
  { optionId: "allow_always", name: "Always allow (this session)", kind: "allow_always" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
];
export function approvalFromOutcome(outcome) {
  if (outcome?.outcome !== "selected") return "decline";
  return { allow_once: "accept", allow_always: "acceptForSession" }[outcome.optionId] ?? "decline";
}

export function createAcpAgent({ send, request, engineFactory, clientVersion, err = process.stderr }) {
  let engine = null;
  const sessions = new Map(); // sessionId (= threadId) → { cwd, turnId, cancelled }

  const getEngine = async (cwd) => {
    if (engine) return engine;
    const started = await engineFactory({ cwd, clientVersion, err });
    if (!started.engine) throw Object.assign(new Error(started.error), { code: -32000 });
    engine = started.engine;
    engine.onApproval = async (req) => {
      const sessionId = req.params.threadId;
      if (!sessions.has(sessionId)) return "decline";
      const item = { type: req.kind === "command" ? "commandExecution" : req.kind === "fileChange" ? "fileChange" : "other", id: req.params.itemId ?? `perm-${Date.now()}`, command: req.params.command, changes: [] };
      const toolCall = toolCallFor(item) ?? { toolCallId: item.id, title: "Grant extra permissions", kind: "other" };
      const r = await request("session/request_permission", { sessionId, toolCall: { ...toolCall, status: "pending" }, options: PERMISSION_OPTIONS });
      return approvalFromOutcome(r?.outcome);
    };
    return engine;
  };

  const update = (sessionId, u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });

  async function handle(method, params = {}) {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: true } },
          authMethods: [],
          agentInfo: { name: "agent-daemon", title: "Agent Daemon", version: clientVersion ?? "0.0.0" },
        };
      case "authenticate":
        return {}; // login is `ad auth` in a terminal; nothing to do over ACP
      case "session/new": {
        const e = await getEngine(params.cwd);
        const { threadId } = await e.startThread({ cwd: params.cwd });
        sessions.set(threadId, { cwd: params.cwd, turnId: null, cancelled: false });
        return { sessionId: threadId };
      }
      case "session/prompt": {
        const s = sessions.get(params.sessionId);
        if (!s) throw Object.assign(new Error(`unknown session ${params.sessionId}`), { code: -32602 });
        s.cancelled = false;
        const r = await engine.turn({
          threadId: params.sessionId,
          text: promptText(params.prompt),
          timeoutMs: 0,
          onEvent: (evt) => {
            if (evt.type === "turnStarted") s.turnId = evt.turnId;
            else if (evt.type === "delta") update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: evt.text } });
            else if (evt.type === "itemStarted") {
              const tc = toolCallFor(evt.item);
              if (tc) update(params.sessionId, { sessionUpdate: "tool_call", ...tc });
            } else if (evt.type === "item") {
              const tu = toolCallUpdateFor(evt.item);
              if (tu) update(params.sessionId, { sessionUpdate: "tool_call_update", ...tu });
            }
          },
        });
        s.turnId = null;
        if (s.cancelled || r.status === "interrupted") return { stopReason: "cancelled" };
        if (r.status !== "completed") update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n[turn ${r.status}${r.error?.message ? `: ${r.error.message}` : ""}]` } });
        return { stopReason: "end_turn" };
      }
      case "session/cancel": {
        const s = sessions.get(params.sessionId);
        if (s?.turnId) {
          s.cancelled = true;
          await engine.interrupt(params.sessionId, s.turnId).catch((e) => err.write(`[acp] interrupt failed: ${e.message}\n`));
        }
        return undefined; // notification
      }
      default:
        throw Object.assign(new Error(`method not supported: ${method}`), { code: -32601 });
    }
  }

  return { handle, close: () => engine?.close(), sessions };
}

// stdio JSON-RPC 2.0 peer: requests from the client are handled by the
// agent; our own requests to the client (session/request_permission)
// resolve when the client answers.
export function serveAcp({ input = process.stdin, output = process.stdout, err = process.stderr, clientVersion, engineFactory = startHarnessEngine } = {}) {
  let nextId = 1;
  const pending = new Map();
  const send = (msg) => output.write(JSON.stringify(msg) + "\n");
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = `ad-${nextId++}`;
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params });
    });
  const agent = createAcpAgent({ send, request, engineFactory, clientVersion, err });

  return new Promise((resolve) => {
    const rl = createInterface({ input });
    rl.on("line", async (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      }
      if (msg.method === undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        return msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
      try {
        const result = await agent.handle(msg.method, msg.params);
        if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: result ?? null });
      } catch (e) {
        if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: e.code ?? -32603, message: e.message } });
        else err.write(`[acp] ${msg.method}: ${e.message}\n`);
      }
    });
    rl.on("close", async () => {
      for (const p of pending.values()) p.reject(new Error("client disconnected"));
      await agent.close();
      resolve(0);
    });
  });
}

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

// Tool-call description for a permission request, with the details the
// user needs to decide: diff + paths for edits, command + cwd for commands.
export function permissionToolCall(req, fileChanges = new Map()) {
  const p = req.params ?? {};
  const id = p.itemId ?? p.approvalId ?? `perm-${Date.now()}`;
  if (req.kind === "fileChange") {
    const changes = fileChanges.get(p.itemId)?.changes ?? [];
    return {
      toolCallId: id,
      title: `Edit ${changes.map((c) => c.path).join(", ") || "files"}`,
      kind: "edit",
      status: "pending",
      locations: changes.map((c) => ({ path: c.path })),
      content: changes.filter((c) => c.diff).map((c) => ({ type: "content", content: { type: "text", text: clip(`${c.path}\n${c.diff}`) } })),
      rawInput: { reason: p.reason ?? null, grantRoot: p.grantRoot ?? null },
    };
  }
  if (req.kind === "command") {
    const command = Array.isArray(p.command) ? p.command.join(" ") : p.command;
    return { toolCallId: id, title: `$ ${command}`, kind: "execute", status: "pending", rawInput: { command, cwd: p.cwd ?? null, reason: p.reason ?? null } };
  }
  return { toolCallId: id, title: "Grant extra permissions", kind: "other", status: "pending", rawInput: { permissions: p.permissions ?? null, reason: p.reason ?? null } };
}

export function createAcpAgent({ send, request, engineFactory, clientVersion, err = process.stderr }) {
  let enginePromise = null; // cached promise: concurrent session/new share one engine
  let engine = null;
  const sessions = new Map(); // sessionId (= threadId) → { cwd, turnId, busy, cancelRequested }
  const fileChanges = new Map(); // itemId → fileChange item (for permission diffs)
  const itemThread = new Map(); // itemId → the thread it belongs to

  const getEngine = (cwd) => {
    enginePromise ??= (async () => {
      const started = await engineFactory({ cwd, clientVersion, err });
      if (!started.engine) throw Object.assign(new Error(started.error), { code: -32000 });
      engine = started.engine;
      engine.on("itemStarted", ({ item, threadId }) => {
        if (item.type !== "fileChange") return;
        fileChanges.set(item.id, item);
        itemThread.set(item.id, threadId);
      });
      engine.onApproval = async (req) => {
        // v1 legacy approvals name the thread conversationId.
        const sessionId = req.params.threadId ?? req.params.conversationId;
        const s = sessions.get(sessionId);
        if (!s || s.cancelRequested) return s?.cancelRequested ? "cancel" : "decline";
        try {
          const r = await request("session/request_permission", { sessionId, toolCall: permissionToolCall(req, fileChanges), options: PERMISSION_OPTIONS });
          return approvalFromOutcome(r?.outcome);
        } catch (e) {
          err.write(`[acp] permission request failed (${e.message}); declining\n`);
          return "decline";
        }
      };
      return engine;
    })().catch((e) => {
      enginePromise = null; // let a later session/new retry
      throw e;
    });
    return enginePromise;
  };

  const update = (sessionId, u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });

  async function interruptIfRunning(sessionId, s) {
    if (!s.turnId) return; // not started yet — interrupted as soon as it is
    await engine.interrupt(sessionId, s.turnId).catch((e) => err.write(`[acp] interrupt failed: ${e.message}\n`));
  }

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
        sessions.set(threadId, { cwd: params.cwd, turnId: null, busy: false, cancelRequested: false });
        return { sessionId: threadId };
      }
      case "session/prompt": {
        const s = sessions.get(params.sessionId);
        if (!s) throw Object.assign(new Error(`unknown session ${params.sessionId}`), { code: -32602 });
        if (s.busy) throw Object.assign(new Error("a prompt is already running in this session"), { code: -32000 });
        s.busy = true;
        s.cancelRequested = false;
        try {
          const r = await engine.turn({
            threadId: params.sessionId,
            text: promptText(params.prompt),
            timeoutMs: 0,
            onEvent: (evt) => {
              if (evt.type === "turnStarted") {
                s.turnId = evt.turnId;
                if (s.cancelRequested) interruptIfRunning(params.sessionId, s); // cancel arrived early
              } else if (evt.type === "delta") update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: evt.text } });
              else if (evt.type === "itemStarted") {
                const tc = toolCallFor(evt.item);
                if (tc) update(params.sessionId, { sessionUpdate: "tool_call", ...tc });
              } else if (evt.type === "item") {
                const tu = toolCallUpdateFor(evt.item);
                if (tu) update(params.sessionId, { sessionUpdate: "tool_call_update", ...tu });
              }
            },
          });
          if (s.cancelRequested || r.status === "interrupted") return { stopReason: "cancelled" };
          if (r.status !== "completed") update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n[turn ${r.status}${r.error?.message ? `: ${r.error.message}` : ""}]` } });
          return { stopReason: "end_turn" };
        } finally {
          s.turnId = null;
          s.busy = false;
          // Only what no running prompt can still ask about: another session's
          // pending edit keeps its diff for its permission request.
          for (const id of [...fileChanges.keys()]) {
            if (sessions.get(itemThread.get(id))?.busy) continue;
            fileChanges.delete(id);
            itemThread.delete(id);
          }
        }
      }
      case "session/cancel": {
        const s = sessions.get(params.sessionId);
        if (s?.busy) {
          s.cancelRequested = true;
          await interruptIfRunning(params.sessionId, s);
        }
        return undefined; // notification
      }
      default:
        throw Object.assign(new Error(`method not supported: ${method}`), { code: -32601 });
    }
  }

  return { handle, close: async () => (enginePromise ? (await enginePromise.catch(() => null))?.close() : undefined), sessions };
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
      if (!msg || typeof msg !== "object") return send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
      if (msg.method === undefined) {
        // A response to one of our requests — never answered back.
        const p = pending.get(msg.id);
        if (!p) return err.write(`[acp] ignoring response to unknown request ${JSON.stringify(msg.id)}\n`);
        pending.delete(msg.id);
        return msg.error ? p.reject(new Error(msg.error.message ?? "client error")) : p.resolve(msg.result);
      }
      if (typeof msg.method !== "string") {
        if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "invalid request" } });
        return;
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

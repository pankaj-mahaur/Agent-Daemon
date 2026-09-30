// Minimal stand-in for `codex app-server` used by engine tests. Speaks the
// same line-delimited JSON-RPC shape; behaviour is scripted per method.

import { createInterface } from "node:readline";

const notifications = [];
let serverReqId = 0;
const awaiting = new Map();

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const notify = (method, params) => send({ method, params });

function askClient(method, params) {
  const id = `srv-${++serverReqId}`;
  send({ id, method, params });
  return new Promise((resolve) => awaiting.set(id, resolve));
}

async function onRequest({ id, method, params }) {
  switch (method) {
    case "initialize":
      return send({ id, result: { userAgent: `fake/${params.clientInfo.name}`, platformOs: process.platform } });
    case "debug/state":
      return send({ id, result: { notifications } });
    case "thread/start":
      return send({ id, result: { thread: { id: "thread-1" }, model: "fake-model", modelProvider: "fake" } });
    case "turn/start": {
      const threadId = params.threadId;
      const turn = { id: "turn-1", status: "inProgress", items: [] };
      send({ id, result: { turn } });
      notify("turn/started", { threadId, turn });
      notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: "i1", delta: "po" });
      notify("item/agentMessage/delta", { threadId: "other-thread", turnId: "x", itemId: "i9", delta: "NOISE" });
      notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: "i1", delta: "ng" });
      const reply = await askClient("item/commandExecution/requestApproval", { threadId, turnId: turn.id, command: "rm -rf /" });
      const decision = reply.error ? `error:${reply.error.code}` : reply.result.decision;
      notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: "i1", delta: `[${decision}]` });
      return notify("turn/completed", { threadId, turn: { ...turn, status: "completed" } });
    }
    case "test/fail":
      return send({ id, error: { code: -32000, message: "boom", data: { why: "scripted" } } });
    case "test/crash":
      return process.exit(3);
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

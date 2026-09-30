// Zero-dep client for `codex app-server` — JSON-RPC over stdio (one JSON
// object per line). This file is the ONLY place that knows the wire format;
// everything above it talks to CodexAppServer's methods and events.
//
// Protocol notes (from `codex app-server generate-json-schema`):
//   - client → initialize {clientInfo}, then notification `initialized`
//   - thread/start → {thread:{id}}, turn/start {threadId, input:[...]}
//   - server streams notifications (turn/started, item/*, turn/completed)
//   - server may send requests (approvals, user input) that need a reply

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const DEFAULT_TIMEOUT_MS = 60_000;

// On Windows the npm install is a .cmd shim; spawning it needs a shell,
// which mangles args. Run the package's JS entry with our own node instead.
export function resolveCodexCommand(env = process.env) {
  if (env.AD_CODEX_BIN) return { cmd: env.AD_CODEX_BIN, prefix: [] };
  if (process.platform === "win32" && env.APPDATA) {
    const entry = join(env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(entry)) return { cmd: process.execPath, prefix: [entry] };
  }
  return { cmd: "codex", prefix: [] };
}

// Approvals are declined unless the caller supplies a handler — the safe
// default for a harness that has not asked the user.
function defaultServerRequestHandler(msg) {
  if (/requestApproval$|Approval$/.test(msg.method)) return { decision: "decline" };
  const err = new Error(`unhandled server request: ${msg.method}`);
  err.code = -32601;
  throw err;
}

export class CodexAppServer extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.nextId = 1;
    this.pending = new Map();
    this.child = null;
    this.stderr = "";
    this.onServerRequest = opts.onServerRequest ?? defaultServerRequestHandler;
  }

  async start() {
    const { cmd, prefix } = this.opts.command ?? resolveCodexCommand(this.opts.env);
    const args = [...prefix, "app-server", ...(this.opts.codexArgs ?? [])];
    this.child = spawn(cmd, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stderr.on("data", (chunk) => {
      // Keep a bounded tail for error reports.
      this.stderr = (this.stderr + chunk.toString()).slice(-8192);
    });
    this.child.on("error", (err) => this.#failAll(new Error(`codex spawn failed: ${err.message}`)));
    // EPIPE after the server dies would otherwise crash the host process;
    // the exit handler below already fails every pending request.
    this.child.stdin.on("error", (err) => this.emit("stdin-error", err));
    this.child.on("exit", (code, signal) => {
      this.exitError = new Error(`codex app-server exited (code=${code}, signal=${signal}) ${this.stderr.trim().slice(-500)}`);
      this.#failAll(this.exitError);
      this.emit("exit", { code, signal });
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => this.#onLine(line));

    const init = await this.request("initialize", {
      clientInfo: { name: "agent_daemon", title: "Agent Daemon", version: this.opts.clientVersion ?? "0.0.0" },
      ...(this.opts.capabilities ? { capabilities: this.opts.capabilities } : {}),
    });
    this.notify("initialized");
    return init;
  }

  request(method, params, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!this.child) return Promise.reject(new Error("codex app-server not started"));
    if (this.exitError) return Promise.reject(this.exitError);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`codex ${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;
      this.pending.set(id, { resolve, reject, timer, method });
      this.#send({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method, params) {
    this.#send({ method, ...(params === undefined ? {} : { params }) });
  }

  async close() {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.stdin.end();
    await new Promise((resolve) => {
      const t = setTimeout(() => { this.child.kill(); resolve(); }, 3000);
      this.child.once("exit", () => { clearTimeout(t); resolve(); });
    });
  }

  #send(msg) {
    if (!this.child.stdin.writable) return;
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  #onLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit("protocol-error", { line });
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) return this.#onResponse(msg);
    if (msg.id !== undefined) return this.#onServerRequest(msg);
    this.emit("notification", msg);
    this.emit(msg.method, msg.params);
  }

  #onResponse(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (p.timer) clearTimeout(p.timer);
    if (msg.error) {
      const err = new Error(`codex ${p.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
      err.code = msg.error.code;
      err.data = msg.error.data;
      p.reject(err);
    } else {
      p.resolve(msg.result);
    }
  }

  async #onServerRequest(msg) {
    this.emit("server-request", msg);
    try {
      const result = await this.onServerRequest(msg);
      this.#send({ id: msg.id, result: result ?? {} });
    } catch (err) {
      this.#send({ id: msg.id, error: { code: err.code ?? -32603, message: err.message } });
    }
  }

  #failAll(err) {
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }
}

// One user turn: start it, stream agent text, resolve when turn/completed.
export function runTurn(server, { threadId, text, onDelta, timeoutMs = 300_000, ...turnOpts }) {
  return new Promise((resolve, reject) => {
    let turnId = null;
    let output = "";
    const timer = setTimeout(() => { cleanup(); reject(new Error(`turn timed out after ${timeoutMs}ms`)); }, timeoutMs);
    const onDeltaEvt = (p) => {
      if (p.threadId !== threadId) return;
      output += p.delta;
      onDelta?.(p.delta);
    };
    const onCompleted = (p) => {
      if (p.threadId !== threadId || (turnId && p.turn.id !== turnId)) return;
      cleanup();
      resolve({ turn: p.turn, output });
    };
    const onExit = () => { cleanup(); reject(new Error(`codex exited mid-turn: ${server.stderr.trim().slice(-500)}`)); };
    function cleanup() {
      clearTimeout(timer);
      server.off("item/agentMessage/delta", onDeltaEvt);
      server.off("turn/completed", onCompleted);
      server.off("exit", onExit);
    }
    server.on("item/agentMessage/delta", onDeltaEvt);
    server.on("turn/completed", onCompleted);
    server.on("exit", onExit);
    server
      .request("turn/start", { threadId, input: [{ type: "text", text }], ...turnOpts })
      .then((r) => { turnId = r?.turn?.id ?? null; })
      .catch((err) => { cleanup(); reject(err); });
  });
}

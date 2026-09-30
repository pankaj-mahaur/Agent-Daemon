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
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { approvalResponse, isApprovalMethod } from "./approvals.mjs";

const DEFAULT_TIMEOUT_MS = 60_000;

const require = createRequire(import.meta.url);

// The exact version runtime/package.json pins — the protocol we are tested against.
export function pinnedCodexVersion() {
  try {
    return require("../../../package.json").dependencies?.["@openai/codex"] ?? null;
  } catch {
    return null;
  }
}

// Order: explicit override → pinned npm dependency → global install.
// Always run the package's JS launcher with our own node: on Windows the
// global install is a .cmd shim, and spawning that needs a shell, which
// mangles args.
export function resolveCodexCommand(env = process.env) {
  if (env.AD_CODEX_BIN) return { cmd: env.AD_CODEX_BIN, prefix: [], source: "env" };
  try {
    const pkg = require.resolve("@openai/codex/package.json");
    const entry = join(dirname(pkg), "bin", "codex.js");
    if (existsSync(entry)) return { cmd: process.execPath, prefix: [entry], source: "pinned" };
  } catch {
    // not installed as a dependency (e.g. global-only install) — fall through
  }
  if (process.platform === "win32" && env.APPDATA) {
    const entry = join(env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(entry)) return { cmd: process.execPath, prefix: [entry], source: "global" };
  }
  return { cmd: "codex", prefix: [], source: "path" };
}


// Nobody answered → the safe reply: decline approvals, refuse everything else.
function defaultServerRequestHandler(msg) {
  if (isApprovalMethod(msg.method)) return approvalResponse(msg.method, msg.params, "decline");
  const err = new Error(`unhandled server request: ${msg.method}`);
  err.code = -32601;
  throw err;
}

// Events: "notification" ({method, params}), "server-request", "exit",
// "protocol-error", "stdin-error". Notifications are NOT re-emitted under
// their own method names: the protocol has one called "error", and emitting
// "error" on an EventEmitter with no listener throws.
export class CodexAppServer extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.nextId = 1;
    this.pending = new Map();
    this.child = null;
    this.stderr = "";
    this.exitError = null;
    this.onServerRequest = opts.onServerRequest ?? defaultServerRequestHandler;
  }

  async start() {
    const env = { ...process.env, ...(this.opts.env ?? {}) };
    const { cmd, prefix } = this.opts.command ?? resolveCodexCommand(env);
    const args = [...prefix, "app-server", ...(this.opts.codexArgs ?? [])];
    this.child = spawn(cmd, args, {
      cwd: this.opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stderr.on("data", (chunk) => {
      // Keep a bounded tail for error reports.
      this.stderr = (this.stderr + chunk.toString()).slice(-8192);
    });
    this.child.on("error", (err) => {
      this.exitError ??= new Error(`codex spawn failed: ${err.message}`);
      this.#failAll(this.exitError);
    });
    // EPIPE after the server dies would otherwise crash the host process;
    // the exit handler below already fails every pending request.
    this.child.stdin.on("error", (err) => this.emit("stdin-error", err));
    // "close" (not "exit"): it fires only after stdout is fully drained, so
    // a response or turn/completed written just before exit is still seen.
    this.child.on("close", (code, signal) => {
      this.exitError ??= new Error(`codex app-server exited (code=${code}, signal=${signal}) ${this.stderr.trim().slice(-500)}`);
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

  get running() {
    return Boolean(this.child) && this.child.exitCode === null && this.child.signalCode === null;
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

  // Closing stdin asks codex to exit; after 3 s it is killed. On Windows the
  // child is the node launcher that spawned codex.exe, so kill the tree.
  async close() {
    if (!this.running) return;
    this.child.stdin.end();
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        this.#killTree();
        resolve();
      }, 3000);
      this.child.once("close", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  #killTree() {
    if (process.platform === "win32" && this.child.pid) {
      spawn("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
        .on("error", () => this.child.kill())
        .on("exit", (code) => {
          if (code !== 0) this.child.kill();
        });
    } else {
      this.child.kill();
    }
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

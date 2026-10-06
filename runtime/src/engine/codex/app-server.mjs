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
import { codexEnv } from "./home.mjs";

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

// Order: explicit override → the pinned npm dependency. Never the user's own
// global or PATH install: ad runs exactly the version it is tested against,
// and the user's Codex stays theirs. Run the package's JS launcher with our
// own node (a .cmd shim would need a shell, which mangles args on Windows).
export function resolveCodexCommand(env = process.env) {
  if (env.AD_CODEX_BIN) return { cmd: env.AD_CODEX_BIN, prefix: [], source: "env" };
  try {
    const pkg = require.resolve("@openai/codex/package.json");
    const entry = join(dirname(pkg), "bin", "codex.js");
    if (existsSync(entry)) return { cmd: process.execPath, prefix: [entry], source: "pinned" };
  } catch {
    // not installed as a dependency — reported as missing below
  }
  return { cmd: null, prefix: [], source: "missing" };
}

export const CODEX_MISSING = "Codex engine not installed — run: cd runtime && npm install";

// Codex picks the first pwsh.exe on PATH as the agent's shell. The Microsoft
// Store's pwsh is an app-execution alias under ...\Microsoft\WindowsApps, and
// the Windows sandbox's restricted token can't launch it (CreateProcessAsUserW:
// Access is denied), so every command fails. Started from that PowerShell 7,
// ad also inherits its package folder (C:\Program Files\WindowsApps\
// Microsoft.PowerShell_...) at the front of PATH. Without every WindowsApps
// entry Codex falls back to an installed pwsh 7 or powershell.exe.
export function withoutStoreAliases(env, platform = process.platform) {
  if (platform !== "win32") return env;
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (key.toUpperCase() !== "PATH" || typeof out[key] !== "string") continue;
    out[key] = out[key].split(";").filter((p) => !/[\\/]WindowsApps(?:[\\/]|$)/i.test(p.trim())).join(";");
  }
  return out;
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
    // Only test doubles that say so skip isolation. Anything else is treated as
    // the real Codex: its home must come from opts.env and be ad's own, and
    // inherited CODEX_* variables never reach it (codexEnv).
    const testDouble = this.opts.command?.source === "test-double";
    const env = withoutStoreAliases(testDouble
      ? { ...process.env, ...(this.opts.env ?? {}) }
      : codexEnv({ home: this.opts.env?.CODEX_HOME, extra: this.opts.env ?? {}, cwd: this.opts.cwd ?? process.cwd() }));
    const { cmd, prefix } = this.opts.command ?? resolveCodexCommand(env);
    if (!cmd) throw new Error(CODEX_MISSING);
    const args = [...prefix, "app-server", ...(this.opts.codexArgs ?? [])];
    this.child = spawn(cmd, args, {
      cwd: this.opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // CREATE_NO_WINDOW on Windows (with piped stdio). On POSIX the terminal
      // UI asks for its own process group, so terminal job control (Ctrl+Z,
      // SIGINT to the foreground group) never reaches the engine.
      windowsHide: true,
      detached: this.opts.detached === true && process.platform !== "win32",
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
    }, { timeoutMs: this.opts.initTimeoutMs ?? DEFAULT_TIMEOUT_MS });
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

  // Closing stdin asks codex to exit. Codex then runs SessionEnd hooks (up
  // to 3 s each), so allow a grace period well past that before killing.
  // On Windows the child is the node launcher that spawned codex.exe, so
  // kill the tree.
  async close({ graceMs = 8000 } = {}) {
    if (!this.running) return;
    this.child.stdin.end();
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        this.#killTree();
        resolve();
      }, graceMs);
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

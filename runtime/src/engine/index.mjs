// Engine API — the only surface Agent Daemon core uses to run an agent.
//
// Today the one engine is Codex (codex app-server over stdio). Core code
// never sees JSON-RPC method names: it calls startThread / turn / complete
// and receives normalized events. Protocol knowledge stays in engine/codex/.

import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { CodexAppServer } from "./codex/app-server.mjs";
import { APPROVAL_METHODS, approvalResponse } from "./codex/approvals.mjs";
import { defaultCodexHome, ensureCodexHome } from "./codex/home.mjs";

// Harness defaults (user-approved): writes only inside the workspace, asks
// before anything riskier.
export const DEFAULT_SANDBOX = "workspace-write";
export const DEFAULT_APPROVAL_POLICY = "on-request";

// Claude model aliases used by existing callers of callHeadlessClaude mean
// nothing to Codex — drop them so Codex uses its configured default.
const CLAUDE_MODEL_ALIASES = new Set(["haiku", "sonnet", "opus"]);

// Codex notification → normalized engine event. Returning null drops it.
export function normalizeNotification(method, params = {}) {
  switch (method) {
    case "item/agentMessage/delta":
      return { type: "delta", text: params.delta, itemId: params.itemId };
    case "item/started":
      return { type: "itemStarted", item: params.item };
    case "item/completed":
      return { type: "item", item: params.item };
    case "item/commandExecution/outputDelta":
      return { type: "commandOutput", itemId: params.itemId, text: params.delta };
    case "turn/plan/updated":
      return { type: "plan", plan: params.plan ?? params };
    case "thread/tokenUsage/updated":
      return { type: "usage", usage: params.tokenUsage ?? params };
    case "turn/started":
      return { type: "turnStarted", turnId: params.turn?.id };
    case "turn/completed":
      return { type: "turnDone", turn: params.turn };
    case "error":
      return { type: "error", message: params.error?.message ?? params.message ?? "unknown error", willRetry: params.willRetry };
    default:
      return null;
  }
}

// The turn a notification belongs to, when it says.
const turnIdOf = (params) => params?.turnId ?? params?.turn?.id ?? null;

export class Engine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.env = { ...process.env, ...(opts.env ?? {}) };
    this.home = opts.home ?? defaultCodexHome(this.env);
    this.onApproval = opts.onApproval ?? (() => "decline");
    this.server = null;
  }

  async start() {
    ensureCodexHome(this.home);
    this.server = new CodexAppServer({
      command: this.opts.command,
      cwd: this.opts.cwd,
      clientVersion: this.opts.clientVersion,
      env: { ...(this.opts.env ?? {}), CODEX_HOME: this.home },
      onServerRequest: (msg) => this.#onServerRequest(msg),
    });
    this.server.on("exit", (info) => this.emit("exit", info));
    this.initInfo = await this.server.start();
    return this;
  }

  // {account: {type, email?, planType?} | null, requiresOpenaiAuth}
  account() {
    return this.server.request("account/read", {});
  }

  // Effective config (config.toml + defaults) as an object.
  async readConfig() {
    return (await this.server.request("config/read", {})).config ?? {};
  }

  // edits: [[keyPath, value], …]; a null value deletes the key. Goes through
  // Codex itself so we never hand-edit TOML that Codex also writes.
  writeConfig(edits, { reload = true } = {}) {
    return this.server.request("config/batchWrite", {
      edits: edits.map(([keyPath, value]) => ({ keyPath, value, mergeStrategy: "replace" })),
      reloadUserConfig: reload,
    });
  }

  // Start a login. params: {type:"chatgpt"} | {type:"chatgptDeviceCode"} |
  // {type:"apiKey", apiKey}. Browser/device flows finish later with
  // waitForLogin(loginId).
  loginStart(params) {
    return this.server.request("account/login/start", params);
  }

  waitForLogin(loginId, { timeoutMs = 600_000 } = {}) {
    return this.waitForNotification("account/login/completed", (p) => !loginId || !p.loginId || p.loginId === loginId, { timeoutMs });
  }

  loginCancel(loginId) {
    return this.server.request("account/login/cancel", { loginId });
  }

  logout() {
    return this.server.request("account/logout", {});
  }

  // Resolve with the params of the first matching notification.
  waitForNotification(method, predicate = () => true, { timeoutMs = 60_000 } = {}) {
    const server = this.server;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => finish(reject, new Error(`timed out waiting for ${method}`)), timeoutMs) : null;
      const onNote = (msg) => {
        if (msg.method === method && predicate(msg.params ?? {})) finish(resolve, msg.params ?? {});
      };
      const onExit = () => finish(reject, new Error(`codex exited while waiting for ${method}`));
      function finish(settle, value) {
        if (timer) clearTimeout(timer);
        server.off("notification", onNote);
        server.off("exit", onExit);
        settle(value);
      }
      server.on("notification", onNote);
      server.on("exit", onExit);
    });
  }

  async startThread({ cwd, model, sandbox = DEFAULT_SANDBOX, approvalPolicy = DEFAULT_APPROVAL_POLICY, ephemeral, developerInstructions, config } = {}) {
    const r = await this.server.request("thread/start", clean({ cwd, model, sandbox, approvalPolicy, ephemeral, developerInstructions, config }));
    return { threadId: r.thread.id, model: r.model, modelProvider: r.modelProvider, thread: r.thread };
  }

  async resumeThread(threadId, overrides = {}) {
    const r = await this.server.request("thread/resume", clean({ threadId, ...overrides }));
    return { threadId: r.thread.id, model: r.model, modelProvider: r.modelProvider, thread: r.thread };
  }

  // Run one turn to completion. onEvent receives normalized events for THIS
  // turn only (events of other threads, or stale events of an earlier turn
  // on the same thread, are dropped). Resolves {turnId, status, output, error}.
  // On timeout the turn is interrupted, not left running.
  turn({ threadId, text, input, onEvent, timeoutMs = 600_000, ...turnOpts }) {
    const server = this.server;
    return new Promise((resolve, reject) => {
      let turnId = null;
      let settled = false;
      let deltas = "";
      let lastMessage = null;
      const early = []; // notifications that arrived before turn/start answered
      // Whenever we stop listening before turn/completed, the Codex turn must
      // not keep running unobserved (it may be writing files).
      const stopTurn = (why) => {
        if (turnId) this.interrupt(threadId, turnId).catch((err) => this.emit("warning", `interrupt (${why}) failed: ${err.message}`));
      };
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            stopTurn("timeout");
            finish(reject, new Error(`turn timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;

      const handle = ({ method, params }) => {
        const tid = turnIdOf(params);
        if (tid && tid !== turnId) return;
        const evt = normalizeNotification(method, params);
        if (!evt) return;
        if (evt.type === "delta") deltas += evt.text;
        if (evt.type === "item" && evt.item?.type === "agentMessage") lastMessage = evt.item.text;
        try {
          onEvent?.(evt);
        } catch (err) {
          stopTurn("event handler threw");
          return finish(reject, err);
        }
        if (evt.type === "turnDone") {
          finish(resolve, { turnId, status: evt.turn?.status, output: lastMessage ?? deltas, error: evt.turn?.error ?? null });
        }
      };
      const onNote = (msg) => {
        if (settled || msg.params?.threadId !== threadId) return;
        if (turnId === null) early.push(msg);
        else handle(msg);
      };
      const onExit = () => finish(reject, new Error(`codex exited mid-turn: ${server.stderr.trim().slice(-500)}`));
      function finish(settle, value) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        server.off("notification", onNote);
        server.off("exit", onExit);
        settle(value);
      }
      server.on("notification", onNote);
      server.on("exit", onExit);
      server
        .request("turn/start", clean({ threadId, input: input ?? [{ type: "text", text }], ...turnOpts }))
        .then((r) => {
          turnId = r?.turn?.id ?? null;
          if (!turnId) return finish(reject, new Error("turn/start returned no turn id"));
          if (settled) return stopTurn("settled before turn/start answered");
          for (const msg of early.splice(0)) if (!settled) handle(msg);
        })
        .catch((err) => finish(reject, err));
    });
  }

  interrupt(threadId, turnId) {
    return this.server.request("turn/interrupt", { threadId, turnId });
  }

  steer(threadId, expectedTurnId, text) {
    return this.server.request("turn/steer", { threadId, expectedTurnId, input: [{ type: "text", text }] });
  }

  // One-shot structured completion. Accepts both our names (system, user,
  // schema) and callHeadlessClaude's (systemPromptFile/systemPromptText,
  // userMessage, jsonSchema) and returns callHeadlessClaude's result shape,
  // so existing callers can switch backends unchanged.
  async complete(opts = {}) {
    const t0 = Date.now();
    const done = (r) => ({ durationMs: Date.now() - t0, costUsd: null, ...r });
    const user = opts.user ?? opts.userMessage;
    const schema = opts.schema ?? opts.jsonSchema;
    const model = CLAUDE_MODEL_ALIASES.has(opts.model) ? undefined : opts.model;
    if (!user) return done({ ok: false, error: "userMessage is required" });
    let system = opts.system ?? opts.systemPromptText;
    if (!system && opts.systemPromptFile) {
      try {
        system = await readFile(opts.systemPromptFile, "utf8");
      } catch (err) {
        return done({ ok: false, error: `cannot read systemPromptFile ${opts.systemPromptFile}: ${err.message}` });
      }
    }
    try {
      const { threadId } = await this.startThread({
        cwd: opts.cwd ?? tmpdir(),
        model,
        ephemeral: true,
        sandbox: "read-only",
        approvalPolicy: "never",
        developerInstructions: system,
      });
      const r = await this.turn({ threadId, text: user, outputSchema: schema, timeoutMs: opts.timeoutMs ?? 120_000 });
      if (r.status !== "completed") {
        return done({ ok: false, error: `turn ${r.status}: ${r.error?.message ?? "no detail"}`, result: r.output, sessionId: threadId });
      }
      let parsedJson = null;
      if (schema) {
        try {
          parsedJson = JSON.parse(r.output);
        } catch (err) {
          return done({ ok: false, error: `output is not valid JSON: ${err.message}`, result: r.output, sessionId: threadId });
        }
      }
      return done({ ok: true, result: r.output, parsedJson, sessionId: threadId });
    } catch (err) {
      return done({ ok: false, error: err.message });
    }
  }

  close() {
    return this.server?.close();
  }

  async #onServerRequest(msg) {
    const spec = Object.hasOwn(APPROVAL_METHODS, msg.method) ? APPROVAL_METHODS[msg.method] : null;
    if (!spec) {
      const err = new Error(`agent-daemon does not handle ${msg.method}`);
      err.code = -32601;
      throw err;
    }
    const req = { kind: spec.kind, method: msg.method, params: msg.params ?? {} };
    this.emit("approval", req);
    return approvalResponse(msg.method, req.params, await this.onApproval(req));
  }
}

export async function createEngine(opts) {
  const engine = new Engine(opts);
  try {
    await engine.start();
  } catch (err) {
    await engine.close();
    throw err;
  }
  return engine;
}

function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

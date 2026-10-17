// Engine API — the façade: the only module outside `engine/codex/` that may
// speak the protocol. Callers use the named capabilities below (threads, turns,
// …); the raw server is private (`#server`); features on the engine's
// experimental API are gated on the protocol snapshot (`featureFlags`).

import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexAppServer, installedCodexVersion, pinnedCodexVersion } from "./codex/app-server.mjs";
import { engineError } from "./codex/errors.mjs";
import { APPROVAL_METHODS, approvalResponse } from "./codex/approvals.mjs";
import { canonicalPath, codexEnv, defaultCodexHome, ensureCodexHome, homeOverride, isManagedHome, prepareDefaultHome, MANAGED_MARKER } from "./codex/home.mjs";
import { defaultRoot, entryKind, homeFacts, NEW_HOME_NAME, OLD_HOME_NAME, removeLink, createLegacyLink, resolveHomeState } from "./codex/home-resolve.mjs";
import { acquireLockWithin } from "../lock.mjs";
import { adaptNotification, classifyRequest, collaborationMode, elicitationResponse, execDisplay, guardianDenialEvent, normalizeItem } from "./codex/events.mjs";
import { experimentalCapabilities } from "./codex/surface.mjs";
import { codexHooksForProfile } from "./codex/hooks-config.mjs";
import { codexCompat, engineChecks, engineLiveChecks, parseCodexVersion, probeVersion } from "./codex/doctor.mjs";
import { MIRROR_MARKER, MIRRORED_FLAG, runStockUi, stockUiArgs, syncSkills } from "./codex/stock-ui.mjs";
import PINNED_SNAPSHOT from "./codex/protocol-snapshot.json" with { type: "json" };
import UPSTREAM_COMMANDS from "./codex/upstream-commands.json" with { type: "json" };

export { engineError };

// The engine's errors and notices in ad's words (design G2): the screen shows
// these; the raw text goes to /warnings (terminal UI) or a "details:" line (CLI).
const ENGINE_CODES = new Set(["ENGINE_EXITED", "ENGINE_SPAWN_FAILED", "ENGINE_TIMEOUT", "ENGINE_NOT_STARTED"]);

/** True for an error that came from the engine (its numeric JSON-RPC codes) or from talking to it. */
export const isEngineError = (err) => typeof err?.code === "number" || ENGINE_CODES.has(err?.code);

/** ad's words for an error. `details`: where the raw text can be read ("/warnings" in the UI; null in the CLI). */
export function engineErrorText(err, { details = "/warnings" } = {}) {
  const see = details ? ` Details: ${details}` : "";
  const code = err?.code;
  if (typeof code === "number") {
    if (code === -32600 || code === -32601) return `The engine refused a request from ad; it may not be the version ad was tested with (ad doctor shows it).${see}`;
    return `The engine reported a problem.${see}`;
  }
  switch (code) {
    case "ENGINE_EXITED":
      return `The engine stopped${err.exitCode != null ? ` (exit ${err.exitCode})` : ""}.${see}`;
    case "ENGINE_SPAWN_FAILED":
      return `The engine could not start.${see || " Run: ad doctor"}`;
    case "ENGINE_TIMEOUT":
      return "The engine didn't answer in time.";
    case "ENGINE_NOT_STARTED":
      return "The engine isn't running.";
    default:
      return err?.message ?? String(err); // ad's own words (HOME_*, FEATURE_UNAVAILABLE, ENGINE_NOT_INSTALLED, …), or not an engine error
  }
}

/** The engine's raw text for an error, unmodified, or null. */
export function engineErrorDetail(err) {
  if (!isEngineError(err)) return null;
  return err.raw ?? err.stderr ?? err.message ?? null;
}

/** ad's words for a notice the engine sent (events.mjs codes: warning, deprecation, config, …). */
export function engineNoticeText(ev) {
  switch (ev?.code) {
    case "warning":
      return "The engine sent a warning. Details: /warnings";
    case "deprecation":
      return "The engine says a setting or feature it uses is going away. Details: /warnings";
    case "config":
      return "The engine found a problem in its settings file. Details: /warnings";
    default:
      return "The engine sent a notice. Details: /warnings";
  }
}

/** The engine's own UI's slash commands at the pinned tag: {tag, names, commands[{name, aliases, duringTask, sideAllowed, visible, popup, …}]}. */
export const engineCommands = UPSTREAM_COMMANDS;

// Harness defaults (user-approved): writes only inside the workspace, asks
// before anything riskier.
export const DEFAULT_SANDBOX = "workspace-write";
export const DEFAULT_APPROVAL_POLICY = "on-request";

// What each feature on the engine's experimental API needs from the pinned
// protocol. The gate reads the snapshot the façade is given (opts.protocolSnapshot,
// else the committed one), so a release that drops a method turns the feature
// off with a notice instead of failing mid-use (design D11, G5).
const FEATURE_NEEDS = {
  planMode: { methods: ["collaborationMode/list", "thread/settings/update"], fields: { "turn/start": ["collaborationMode"] } },
  stopTerminals: { methods: ["thread/backgroundTerminals/clean"], fields: {} },
};

/** {planMode, stopTerminals}, each {available, reason}; reason says why not, in ad's words. */
export function featureFlags(snapshot, { experimental = false } = {}) {
  const exp = snapshot?.experimental ?? {};
  const methods = Array.isArray(exp.methods) ? exp.methods : [];
  const fields = exp.fields ?? {};
  const out = {};
  for (const [name, need] of Object.entries(FEATURE_NEEDS)) {
    let reason = null;
    if (!experimental) {
      reason = "this front end doesn't use the engine's experimental API";
    } else {
      const missing = [
        ...need.methods.filter((m) => !methods.includes(m)),
        ...Object.entries(need.fields).flatMap(([m, fs]) => fs.filter((f) => !Object.hasOwn(fields[m] ?? {}, f)).map((f) => `${m}.${f}`)),
      ];
      if (missing.length) reason = `the pinned protocol has no ${missing.join(", ")}`;
    }
    out[name] = { available: reason === null, reason };
  }
  return out;
}

/** The engine's automatic model ids ("codex-auto-…") take no reasoning effort. */
export const isAutoModel = (m) => typeof m === "string" && m.startsWith("codex-auto-");

/** Thrown when a gated feature is off. code FEATURE_UNAVAILABLE; the message is shown as is. */
export class EngineFeatureUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "EngineFeatureUnavailable";
    this.code = "FEATURE_UNAVAILABLE";
  }
}

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
  #server = null;
  #features = null;
  #defaultHome = false;

  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.env = { ...process.env, ...(opts.env ?? {}) };
    // An explicit home (opts.home, AD_ENGINE_DIR, AD_CODEX_HOME) is used as given;
    // the default one is resolved again under the migrate lock in start().
    this.#defaultHome = opts.home === undefined && !homeOverride(this.env);
    this.home = resolve(opts.cwd ?? process.cwd(), opts.home ?? defaultCodexHome(this.env, { root: opts.homeRoot }));
    this.onApproval = opts.onApproval ?? (() => "decline");
    // Front ends that handle every server request themselves (the TUI) set
    // onRequest(PendingRequest) → answer. Without it the old behaviour stays:
    // approvals go to onApproval, user input and elicitation are refused.
    this.onRequest = opts.onRequest ?? null;
    this.unknown = new Map(); // unknown notification method → count
    // Routing (plan 3b): child threads (subagents) and their parents, the
    // labels to show for them, subscribers per thread, open requests.
    this.parents = new Map();
    this.labels = new Map();
    this.subscribers = new Map(); // threadId | null (thread-less) → Set(fn)
    this.pendingRequests = new Map(); // JSON-RPC id → {request, cancel}
    this.answered = new Set(); // ids we answered; the engine's serverRequest/resolved for them is dropped
    // Named capabilities: the only way code outside engine/ reaches the engine.
    this.threads = {
      start: (o) => this.startThread(o),
      resume: (threadId, o) => this.resumeThread(threadId, o),
      /** → the engine's answer ({thread, …}). */
      fork: (threadId, o = {}) => this.#request("thread/fork", clean({ threadId, ...o })),
      inject: (threadId, items) => this.#request("thread/inject_items", { threadId, items }),
      /** → {status: "unsubscribed" | "notLoaded" | …}. */
      unsubscribe: (threadId) => this.#request("thread/unsubscribe", { threadId }),
      /** → [thread]; o: {cwd, limit, modelProviders, sourceKinds, archived}. */
      list: async (o = {}) => (await this.#request("thread/list", clean(o)))?.data ?? [],
      archive: (threadId) => this.#request("thread/archive", { threadId }),
      /** → the engine's answer ({thread}). */
      unarchive: (threadId) => this.#request("thread/unarchive", { threadId }),
      delete: (threadId) => this.#request("thread/delete", { threadId }),
      rename: (threadId, name) => this.#request("thread/name/set", { threadId, name }),
      revert: (threadId, beforeTurnId) => this.#request("thread/revert", { threadId, beforeTurnId }),
      /** One page of history, oldest first, full items → {data, nextCursor}. */
      turns: (threadId, { cursor, limit = 50 } = {}) => this.#request("thread/turns/list", clean({ threadId, itemsView: "full", sortDirection: "asc", limit, cursor })),
      compact: (threadId) => this.compactThread(threadId),
      goal: {
        set: (threadId, objective, o) => this.setGoal(threadId, objective, o),
        clear: (threadId) => this.clearGoal(threadId),
      },
    };
    this.turns = {
      start: (o) => this.startTurn(o),
      /** input: an input array or a string; → {turnId}. */
      steer: (threadId, expectedTurnId, input, { clientUserMessageId } = {}) =>
        this.#request("turn/steer", clean({ threadId, expectedTurnId, input: typeof input === "string" ? [{ type: "text", text: input }] : input, clientUserMessageId })),
      interrupt: (threadId, turnId) => this.interrupt(threadId, turnId),
    };
    this.review = {
      /** → {reviewThreadId, …}. */
      start: (threadId, target) => this.#request("review/start", { threadId, target }),
    };
    this.guardian = {
      /** One retry of an action the engine's auto-review denied; builds the engine's event from the denial. */
      approve: (threadId, denial) => this.#request("thread/approveGuardianDeniedAction", { threadId, event: guardianDenialEvent(denial) }),
    };
    this.terminals = {
      run: (threadId, command) => this.#request("thread/shellCommand", { threadId, command }),
      clean: async (threadId) => {
        this.#gate("stopTerminals", "/stop");
        return this.#request("thread/backgroundTerminals/clean", { threadId });
      },
    };
    this.config = {
      /** → the engine's whole answer ({config, layers, …}). */
      read: async ({ includeLayers = false, cwd } = {}) => {
        const r = await this.#request("config/read", clean({ includeLayers, cwd }));
        // The engine calls a project layer's folder dotCodexFolder; ad calls it projectFolder.
        for (const layer of r?.layers ?? []) {
          if (layer?.name && Object.hasOwn(layer.name, "dotCodexFolder")) {
            layer.name.projectFolder = layer.name.dotCodexFolder;
            delete layer.name.dotCodexFolder;
          }
        }
        return r;
      },
      write: (edits, o) => this.writeConfig(edits, o),
      /** → the requirements object, or null. */
      requirements: async () => (await this.#request("configRequirements/read", undefined))?.requirements ?? null,
    };
    this.models = {
      /** → [model]. */
      list: async () => (await this.#request("model/list", {}))?.data ?? [],
    };
    this.skills = {
      /** → [{cwd, skills: [...]}]. */
      list: async (cwds) => (await this.#request("skills/list", { cwds }))?.data ?? [],
      setRoots: (roots) => this.setSkillRoots(roots),
    };
    this.files = {
      /** → [{path, …}]. */
      search: async (query, roots, { token } = {}) => (await this.#request("fuzzyFileSearch", clean({ query, roots, cancellationToken: token })))?.files ?? [],
    };
    this.mcp = {
      /** → [server status]. */
      status: async () => (await this.#request("mcpServerStatus/list", {}))?.data ?? [],
      reload: () => this.reloadMcpServers(),
    };
    this.usage = {
      /** → the engine's answer ({summary, …}). */
      read: () => this.#request("account/usage/read", {}),
      /** → the engine's answer ({rateLimits, …}). */
      limits: () => this.#request("account/rateLimits/read", {}),
    };
    this.modes = {
      /** Plan/Default presets [{name, mode, model, effort}]; gated (plan mode). */
      list: async ({ timeoutMs = 2000 } = {}) => {
        this.#gate("planMode", "Plan mode");
        const r = await this.#request("collaborationMode/list", {}, { timeoutMs });
        return (r?.data ?? []).filter((m) => typeof m?.mode === "string").map((m) => ({ name: m.name ?? m.mode, mode: m.mode, model: m.model ?? null, effort: m.reasoning_effort ?? null }));
      },
    };
    this.sandbox = {
      /** → "ready" | "notConfigured" | …. */
      readiness: async () => (await this.#request("windowsSandbox/readiness", {}))?.status,
      /** Starts the Windows sandbox setup and waits for its end → {success, mode, error?}. */
      setup: async ({ mode = "unelevated", cwd, timeoutMs = 10 * 60_000 } = {}) => {
        const done = this.#waitFor("windowsSandbox/setupCompleted", () => true, { timeoutMs });
        done.catch(() => {}); // awaited below; no unhandled rejection if setupStart throws
        const started = await this.#request("windowsSandbox/setupStart", clean({ mode, cwd: cwd || undefined }));
        if (!started?.started) throw engineError("SANDBOX_NOT_STARTED", "the engine did not start the sandbox setup");
        return done;
      },
    };
  }

  /** Whether the engine process is running. */
  get running() {
    return Boolean(this.#server?.running);
  }

  /** Why the engine stopped (an error with code ENGINE_EXITED / ENGINE_SPAWN_FAILED), or null. */
  get exitError() {
    return this.#server?.exitError ?? null;
  }

  /** The gated features of this engine (see featureFlags). */
  get features() {
    this.#features ??= featureFlags(this.opts.protocolSnapshot ?? PINNED_SNAPSHOT, { experimental: Boolean(this.opts.experimental) });
    return this.#features;
  }

  #request(method, params, opts) {
    if (!this.#server) return Promise.reject(engineError("ENGINE_NOT_STARTED", "the engine is not started"));
    return this.#server.request(method, params, opts);
  }

  #gate(feature, label) {
    const f = this.features[feature];
    if (!f.available) throw new EngineFeatureUnavailable(`${label} is unavailable: ${f.reason}.`);
  }

  // Resolve with the params of the first matching notification.
  #waitFor(method, predicate = () => true, { timeoutMs = 60_000 } = {}) {
    const server = this.#server;
    if (!server) return Promise.reject(engineError("ENGINE_NOT_STARTED", "the engine is not started"));
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => finish(reject, engineError("ENGINE_TIMEOUT", `timed out waiting for ${method}`)), timeoutMs) : null;
      const onNote = (msg) => {
        if (msg.method === method && predicate(msg.params ?? {})) finish(resolve, msg.params ?? {});
      };
      const onExit = () => finish(reject, engineError("ENGINE_EXITED", `the engine exited while ad waited for ${method}`));
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

  /**
   * Adapted events (the engine's events module) for one thread and every child
   * thread it spawned (subagents), or with threadId null the events that
   * belong to no thread (account, rate limits, MCP status, warnings).
   * Returns an unsubscribe function.
   */
  subscribe(threadId, fn) {
    const key = threadId ?? null;
    if (!this.subscribers.has(key)) this.subscribers.set(key, new Set());
    this.subscribers.get(key).add(fn);
    return () => {
      const set = this.subscribers.get(key);
      set?.delete(fn);
      if (set && !set.size) this.subscribers.delete(key);
    };
  }

  /** The chain from a thread up to its root: [thread, parent, …, root]. */
  threadChain(threadId) {
    const chain = [];
    const seen = new Set();
    for (let t = threadId; t && !seen.has(t); t = this.parents.get(t)) {
      seen.add(t);
      chain.push(t);
    }
    return chain;
  }

  #deliver(ev) {
    const targets = ev.threadId ? this.threadChain(ev.threadId) : [null];
    for (const key of targets) {
      for (const fn of this.subscribers.get(key) ?? []) {
        try {
          fn(ev);
        } catch (err) {
          this.emit("warning", `event subscriber threw: ${err.message}`);
        }
      }
    }
    this.emit("event", ev);
  }

  // Learn the thread tree from what Codex says, before events are delivered.
  #learn(method, params) {
    // Only Codex's own spawn records link threads: a model-chosen tool call
    // (sendInput, wait, closeAgent…) names threads it doesn't own. A known
    // parent is never replaced, and a link that would make a cycle is refused.
    const link = (child, parent) => {
      if (typeof child !== "string" || typeof parent !== "string" || child === parent) return;
      if (this.parents.has(child)) return;
      if (this.threadChain(parent).includes(child)) return;
      this.parents.set(child, parent);
    };
    if (method === "thread/started" && params?.thread) {
      const t = params.thread;
      link(t.id, t.parentThreadId);
      const label = t.agentNickname ?? t.agentRole ?? null;
      if (label) this.labels.set(t.id, label);
    }
    if ((method === "item/started" || method === "item/completed") && params?.item) {
      const it = params.item;
      if (it.type === "collabAgentToolCall" && it.tool === "spawnAgent" && Array.isArray(it.receiverThreadIds)) {
        for (const r of it.receiverThreadIds) link(r, params.threadId);
      }
      if (it.type === "subAgentActivity" && it.kind === "started") link(it.agentThreadId, params.threadId);
    }
  }

  #route(msg) {
    try {
      this.#routeUnsafe(msg);
    } catch (err) {
      this.emit("warning", `could not handle ${msg?.method}: ${err.message}`);
    }
  }

  #routeUnsafe({ method, params }) {
    this.#learn(method, params);
    if (method === "thread/closed" || method === "thread/deleted") this.#forget(params?.threadId);
    if (method === "serverRequest/resolved") {
      // #handleRequest emits the one request.resolved for every request it
      // opened; Codex's own notification (sent after any answer) adds nothing.
      const id = params?.requestId;
      if (this.pendingRequests.has(id)) this.#cancelRequests((r) => r.id === id, "resolved");
      this.answered.delete(id);
      return;
    }
    if (method === "thread/reverted") this.#cancelRequests((r) => r.threadId === params?.threadId, "reverted");
    for (const ev of adaptNotification(method, params)) {
      // Notifications a newer Codex sends that this ad doesn't know: counted for /warnings.
      if (ev.type === "unknown" && (this.unknown.has(ev.method) || this.unknown.size < 200)) this.unknown.set(ev.method, (this.unknown.get(ev.method) ?? 0) + 1);
      this.#deliver(ev);
    }
  }

  /** {method: count} of notifications this ad didn't recognise. */
  unknownCounts() {
    return Object.fromEntries(this.unknown);
  }

  #forget(threadId) {
    if (!threadId) return;
    queueMicrotask(() => {
      this.labels.delete(threadId);
      for (const [child, parent] of this.parents) if (child === threadId || parent === threadId) this.parents.delete(child);
    });
  }

  #cancelRequests(match, why) {
    for (const [id, entry] of this.pendingRequests) if (match(entry.request)) entry.cancel(why);
  }

  /** Open requests (for a reconnecting UI), oldest first. */
  openRequests() {
    return [...this.pendingRequests.values()].map((e) => e.request);
  }

  async start() {
    if (this.#defaultHome) {
      let release;
      try {
        release = await acquireLockWithin("migrate", { dir: this.opts.lockDir, waitMs: this.opts.lockWaitMs ?? 5000 });
      } catch (err) {
        if (err.code === "LOCK_BUSY") throw engineError("HOME_BUSY", "Another ad is moving the engine's folder. Try again in a minute.");
        throw err;
      }
      try {
        this.home = prepareDefaultHome({ root: this.opts.homeRoot, autoPickEmpty: this.opts.interactive === true, env: this.env });
      } finally {
        release();
      }
    } else {
      ensureCodexHome(this.home);
    }
    this.#server = new CodexAppServer({
      command: this.opts.command,
      cwd: this.opts.cwd,
      clientVersion: this.opts.clientVersion,
      detached: this.opts.detached,
      codexArgs: this.opts.engineArgs ?? this.opts.codexArgs,
      // Only the terminal UI opts into the experimental allowlist (codex-parity-2 P0).
      capabilities: this.opts.experimental ? experimentalCapabilities() : undefined,
      env: { ...(this.opts.env ?? {}), CODEX_HOME: this.home },
      onServerRequest: (msg) => this.#onServerRequest(msg),
    });
    this.#server.on("exit", (info) => this.emit("exit", info));
    // Unbuffered item stream: approval requests can arrive before a turn's
    // buffered events are replayed, and an approval prompt needs the item
    // (e.g. the fileChange with its paths) it refers to.
    this.#server.on("notification", ({ method, params }) => {
      if (method === "item/started" && params?.item) this.emit("itemStarted", params);
    });
    this.#server.on("notification", (msg) => this.#route(msg));
    this.#server.on("exit", () => this.#cancelRequests(() => true, "engine exited"));
    this.initInfo = await this.#server.start();
    return this;
  }

  // {account: {type, email?, planType?} | null, requiresOpenaiAuth}
  account() {
    return this.#request("account/read", {});
  }

  // Effective config (config.toml + defaults) as an object.
  async readConfig() {
    return (await this.#request("config/read", { includeLayers: false }))?.config ?? {};
  }

  // edits: [[keyPath, value, strategy?], …]; a null value deletes the key;
  // strategy "upsert" merges a table into what is there. Goes through Codex
  // itself so we never hand-edit TOML that Codex also writes.
  writeConfig(edits, { reload = true } = {}) {
    return this.#request("config/batchWrite", {
      edits: edits.map(([keyPath, value, strategy]) => ({ keyPath, value, mergeStrategy: strategy === "upsert" ? "upsert" : "replace" })),
      reloadUserConfig: reload,
    });
  }

  // [{key, eventName, sourcePath, trustStatus, currentHash, …}] for cwds.
  async listHooks(cwds) {
    const r = await this.#request("hooks/list", { cwds });
    return (r.data ?? []).flatMap((d) => d.hooks ?? []);
  }

  // Record trust for one hook definition (the same thing /hooks does).
  trustHook(key, currentHash) {
    return this.#request("config/value/write", {
      keyPath: `hooks.state.${JSON.stringify(key)}.trusted_hash`,
      value: currentHash,
      mergeStrategy: "replace",
    });
  }

  // Re-read mcp_servers after a config change so new servers start.
  reloadMcpServers() {
    return this.#request("config/mcpServer/reload", {});
  }

  // Extra skill folders for this app-server process (not persisted).
  setSkillRoots(roots) {
    return this.#request("skills/extraRoots/set", { extraRoots: roots });
  }

  // Start a login. params: {type:"chatgpt"} | {type:"chatgptDeviceCode"} |
  // {type:"apiKey", apiKey}. Browser/device flows finish later with
  // waitForLogin(loginId).
  loginStart(params) {
    return this.#request("account/login/start", params);
  }

  waitForLogin(loginId, { timeoutMs = 600_000 } = {}) {
    return this.waitForNotification("account/login/completed", (p) => !loginId || !p.loginId || p.loginId === loginId, { timeoutMs });
  }

  loginCancel(loginId) {
    return this.#request("account/login/cancel", { loginId });
  }

  logout() {
    return this.#request("account/logout", {});
  }

  // Resolve with the params of the first matching notification.
  waitForNotification(method, predicate = () => true, { timeoutMs = 60_000 } = {}) {
    return this.#waitFor(method, predicate, { timeoutMs });
  }

  async startThread({ cwd, model, sandbox = DEFAULT_SANDBOX, approvalPolicy = DEFAULT_APPROVAL_POLICY, ephemeral, developerInstructions, config, sessionStartSource } = {}) {
    const r = await this.#request("thread/start", clean({ cwd, model, sandbox, approvalPolicy, ephemeral, developerInstructions, config, sessionStartSource }));
    return { threadId: r.thread.id, model: r.model, modelProvider: r.modelProvider, thread: r.thread };
  }

  async resumeThread(threadId, overrides = {}) {
    const r = await this.#request("thread/resume", clean({ threadId, ...overrides }));
    return { threadId: r.thread.id, model: r.model, modelProvider: r.modelProvider, thread: r.thread, collaborationMode: collaborationMode(r.collaborationMode) };
  }

  /**
   * Codex's collaboration-mode presets ([{name, mode, model, effort}], in its
   * order). Codex's own TUI waits 2 s for them. Experimental: only an engine
   * started with experimental: true.
   */
  async listCollaborationModes({ timeoutMs = 2000 } = {}) {
    return this.modes.list({ timeoutMs });
  }

  /** Ends every background terminal of a thread (experimental; /stop). */
  cleanBackgroundTerminals(threadId) {
    return this.terminals.clean(threadId);
  }

  /** Changes a thread's settings for its next turns (experimental; ad sends only collaborationMode). */
  async updateThreadSettings(threadId, settings) {
    this.#gate("planMode", "Plan mode");
    return this.#request("thread/settings/update", { threadId, ...settings });
  }

  // Run one turn to completion. onEvent receives normalized events for THIS
  // turn only (events of other threads, or stale events of an earlier turn
  // on the same thread, are dropped). Resolves {turnId, status, output, error}.
  // On timeout the turn is interrupted, not left running.
  turn({ threadId, text, input, onEvent, timeoutMs = 600_000, ...turnOpts }) {
    if (!this.#server) return Promise.reject(engineError("ENGINE_NOT_STARTED", "the engine is not started"));
    const server = this.#server;
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
      const onExit = () => finish(reject, engineError("ENGINE_EXITED", `the engine exited mid-turn`, { stderr: server.stderr.trim().slice(-500) }));
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
      this.#request("turn/start", clean({ threadId, input: input ?? [{ type: "text", text }], ...turnOpts }))
        .then((r) => {
          turnId = r?.turn?.id ?? null;
          if (!turnId) return finish(reject, new Error("turn/start returned no turn id"));
          if (settled) return stopTurn("settled before turn/start answered");
          for (const msg of early.splice(0)) if (!settled) handle(msg);
        })
        .catch((err) => finish(reject, err));
    });
  }

  // Recent threads (newest first): [{id, preview, cwd, updatedAt, name?}]
  // sourceKinds: omitted = Codex's default (interactive sources only).
  async listThreads({ cwd, limit = 20, sourceKinds } = {}) {
    const r = await this.#request("thread/list", clean({ cwd, limit, sourceKinds }));
    return r.data ?? [];
  }

  compactThread(threadId) {
    return this.#request("thread/compact/start", { threadId });
  }

  // Durable objective for long-running work (Codex tracks time/tokens used).
  async setGoal(threadId, objective, { tokenBudget } = {}) {
    return (await this.#request("thread/goal/set", clean({ threadId, objective, tokenBudget }))).goal;
  }

  clearGoal(threadId) {
    return this.#request("thread/goal/clear", { threadId });
  }

  /**
   * Start a turn and return as soon as Codex accepted it ({turnId}); events
   * arrive through subscribe(). turn() stays for callers that want to wait.
   */
  async startTurn({ threadId, text, input, ...turnOpts }) {
    const r = await this.#request("turn/start", clean({ threadId, input: input ?? [{ type: "text", text }], ...turnOpts }));
    const turnId = r?.turn?.id ?? null;
    if (!turnId) throw new Error("turn/start returned no turn id");
    return { turnId, turn: r.turn };
  }

  interrupt(threadId, turnId) {
    return this.#request("turn/interrupt", { threadId, turnId });
  }

  steer(threadId, expectedTurnId, text) {
    return this.#request("turn/steer", { threadId, expectedTurnId, input: [{ type: "text", text }] });
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
        config: await this.#isolatedThreadConfig(),
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

  /**
   * Codex's temporary structured request (its /recap): an ephemeral thread,
   * read-only, approvals never, every tool off (`config`, dotted keys, plus
   * every MCP server off), one turn with an output schema, then unsubscribed.
   * → the answer's text. As Codex: one deadline to start the thread, another
   * for the turn. Stable fields only: Codex's own also sends experimental
   * ones that lock the thread down further.
   */
  async structuredRequest({ cwd, model, modelProvider, text, outputSchema, config = {}, timeoutMs = 30_000 }) {
    let deadline = Date.now() + timeoutMs;
    const left = () => Math.max(1, deadline - Date.now());
    const read = await this.#request("config/read", { includeLayers: false, cwd }, { timeoutMs: left() });
    const overrides = { ...config };
    for (const id of Object.keys(read?.config?.mcp_servers ?? {})) overrides[`mcp_servers.${id}.enabled`] = false;
    const r = await this.#request(
      "thread/start",
      clean({ model, modelProvider, cwd, approvalPolicy: "never", sandbox: "read-only", ephemeral: true, threadSource: "system", config: overrides }),
      { timeoutMs: left() },
    );
    const threadId = r.thread.id;
    try {
      if (r.sandbox?.type !== "readOnly") throw new Error("temporary structured thread did not start with read-only permissions");
      deadline = Date.now() + timeoutMs;
      const t = await this.turn({ threadId, input: [{ type: "text", text, text_elements: [] }], outputSchema, timeoutMs: left() });
      if (t.status !== "completed") throw engineError(-32000, `temporary structured turn ended with status ${t.status}`, { raw: t.error?.message ?? `temporary structured turn ended with status ${t.status}` });
      if (!t.output) throw new Error("temporary structured turn completed without a response");
      if (Buffer.byteLength(t.output, "utf8") > 8192) throw new Error("temporary structured response exceeds 8192 bytes");
      return t.output;
    } finally {
      this.#request("thread/unsubscribe", { threadId }).catch((err) => this.emit("warning", `could not unsubscribe a temporary thread: ${err.message}`));
    }
  }

  close() {
    return this.#server?.close();
  }

  /** Resolves with the compaction notice for this thread (start the compaction after calling this). */
  waitForCompaction(threadId, { timeoutMs = 60_000 } = {}) {
    return this.#waitFor("thread/compacted", (p) => p.threadId === threadId, { timeoutMs });
  }

  // ---- Test doors: for tests and the scripted fake only. ----

  /** Reaches only a test double's own debug/ and test/ methods; anything else is refused (code TEST_DOOR). */
  testRequest(method, params, opts) {
    if (!/^(debug|test)\//.test(String(method))) return Promise.reject(engineError("TEST_DOOR", `testRequest reaches only a test double's debug/ and test/ methods, not ${method}`));
    return this.#request(method, params, opts);
  }

  /** Feeds a notification through the router, as if the engine had sent it. */
  testNotify(method, params) {
    this.#server?.emit("notification", { method, params });
  }

  /** Observes every raw notification; returns a function that stops observing. */
  onRawNotification(fn) {
    const server = this.#server;
    server?.on("notification", fn);
    return () => server?.off("notification", fn);
  }

  /** Observes every raw server request; returns a function that stops observing. */
  onRawServerRequest(fn) {
    const server = this.#server;
    server?.on("server-request", fn);
    return () => server?.off("server-request", fn);
  }

  /** Kills the engine process (tests of crash handling). */
  kill() {
    this.#server?.child?.kill();
  }

  // A completion is a pure function call: no harness hooks (they would
  // inject memory into GEPA prompts and re-extract "corrections" from the
  // transcript being analysed) and no MCP servers. Dotted keys are what
  // thread/start's config override honours (verified on codex 0.159.2).
  async #isolatedThreadConfig() {
    const config = { "features.hooks": false };
    let cfg = {};
    try {
      cfg = await this.readConfig();
    } catch (err) {
      this.emit("warning", `could not read config to disable MCP servers: ${err.message}`);
    }
    for (const id of Object.keys(cfg.mcp_servers ?? {})) config[`mcp_servers.${id}.enabled`] = false;
    return config;
  }

  async #onServerRequest(msg) {
    if (this.onRequest) return this.#handleRequest(msg);
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

  // onRequest mode: every server request becomes a PendingRequest, open until
  // the front end answers, Codex says it was resolved elsewhere, the thread
  // is reverted, or the engine exits (those decline).
  async #handleRequest(msg) {
    const tid = msg.params?.threadId ?? msg.params?.conversationId ?? null;
    const req = classifyRequest(msg.method, msg.params ?? {}, msg.id, { agentLabel: tid ? (this.labels.get(tid) ?? null) : null });
    if (req.kind === "unknown" || req.kind === "tool-call") return requestResult(req, null); // refused (-32601)
    let cancel;
    const cancelled = new Promise((resolve) => (cancel = (why) => resolve({ cancelled: why })));
    this.pendingRequests.set(msg.id, { request: req, cancel });
    this.#deliver({ type: "request.opened", threadId: req.threadId ?? undefined, turnId: req.turnId ?? undefined, request: req });
    let outcome;
    try {
      outcome = await Promise.race([Promise.resolve(this.onRequest(req)).then((answer) => ({ answer })), cancelled]);
    } catch (err) {
      this.emit("warning", `request handler failed: ${err.message}`);
      outcome = { cancelled: "handler failed" };
    } finally {
      this.pendingRequests.delete(msg.id);
    }
    this.answered.add(msg.id);
    if (this.answered.size > 1000) this.answered.delete(this.answered.values().next().value);
    this.#deliver({ type: "request.resolved", threadId: req.threadId ?? undefined, requestId: msg.id, ...(outcome.cancelled ? { cancelled: outcome.cancelled } : {}) });
    return requestResult(req, outcome.cancelled ? null : outcome.answer);
  }
}

// Turns a front end's answer to a PendingRequest into the JSON-RPC result.
// Anything unexpected declines.
export function requestResult(req, answer) {
  switch (req.kind) {
    case "approval-exec":
    case "approval-patch": {
      const ok = req.options.some((o) => JSON.stringify(o) === JSON.stringify(answer));
      return approvalResponse(req.method, req.params, ok ? answer : "decline");
    }
    case "approval-permissions": {
      const word = answer === "turn" ? "accept" : answer === "session" ? "acceptForSession" : "decline";
      return approvalResponse(req.method, req.params, word);
    }
    case "user-input": {
      // {questionId: [answers]} → {answers: {questionId: {answers: [...]}}}.
      // Strings only, and only offered labels unless the question takes free text.
      const answers = {};
      for (const q of req.questions ?? []) {
        const a = answer?.[q.id];
        if (!Array.isArray(a)) continue;
        const labels = new Set((q.options ?? []).map((o) => o.label));
        const ok = a.filter((x) => typeof x === "string" && (q.other || q.secret || !labels.size || labels.has(x)));
        if (ok.length) answers[q.id] = { answers: ok };
      }
      return { answers };
    }
    case "elicitation": {
      const action = answer?.action;
      if (action !== "accept") return elicitationResponse(action === "cancel" ? "cancel" : "decline");
      const form = req.form ?? {};
      if (form.mode === "url") return elicitationResponse("accept", null, answer?._meta);
      const content = answer?.content;
      if (!content || typeof content !== "object" || Array.isArray(content)) return elicitationResponse("decline");
      if (form.mode === "form") {
        // Every required field present; only fields the form asked for.
        for (const f of form.fields ?? []) if (f.required && (content[f.name] === undefined || content[f.name] === null || content[f.name] === "")) return elicitationResponse("decline");
        const names = new Set((form.fields ?? []).map((f) => f.name));
        const clean = Object.fromEntries(Object.entries(content).filter(([k]) => names.has(k)));
        return elicitationResponse("accept", clean, answer?._meta);
      }
      return elicitationResponse("accept", content, answer?._meta);
    }
    default: {
      const err = new Error(`agent-daemon does not handle ${req.method}`);
      err.code = -32601;
      throw err;
    }
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

// ---- Helpers for code outside engine/ that needs the engine's facts, not a running engine. ----

/** The engine's home folder: where it is, whether ad made it, how to start the engine in it. */
export const engineHome = {
  defaultPath: (env = process.env) => defaultCodexHome(env),
  isManaged: (dir) => isManagedHome(dir),
  canonical: (p, base) => canonicalPath(p, base),
  ensure: (dir, o) => ensureCodexHome(dir, o),
  env: (o) => codexEnv(o),
  MANAGED_MARKER,
  /** The user's own folder from AD_ENGINE_DIR / AD_CODEX_HOME, or null (throws HOME_CONFLICT, HOME_STRAY_STAMP). */
  override: (env = process.env) => homeOverride(env),
  /** Where the folder is and in which state (read-only). {path, state: "custom" | "fresh" | "old" | "new" | "two-folders", …}. */
  state: ({ env = process.env, root } = {}) => {
    const custom = homeOverride(env);
    return custom ? { path: custom, state: "custom" } : resolveHomeState({ root });
  },
  /** The engine's settings file (TOML), or null when the folder can't be resolved. */
  settingsPath: (env = process.env) => {
    try {
      return join(defaultCodexHome(env), "config.toml");
    } catch {
      return null; // two folders, a conflict: the caller says "see ad doctor"
    }
  },
  /** {path, conversations, lastUsed, signedIn} of a folder (reads only). */
  facts: (dir) => homeFacts(dir),
  OLD_NAME: OLD_HOME_NAME,
  NEW_NAME: NEW_HOME_NAME,
  root: () => defaultRoot(),
  entryKind: (p) => entryKind(p),
  removeLink: (p) => removeLink(p),
  createLink: (target, link) => createLegacyLink(target, link),
};

/** Turning the engine's items and requests into ad's shapes. */
export const engineEvents = {
  normalizeItem: (item) => normalizeItem(item),
  execDisplay: (p) => execDisplay(p),
  classifyRequest: (...a) => classifyRequest(...a),
  guardianDenial: (p) => guardianDenialEvent(p),
};

/** The hooks file ad writes into a managed engine home. */
export const engineHooks = {
  forProfile: (profile, o) => codexHooksForProfile(profile, o),
};

/** The pinned engine version, the tested versions, and parsing a version string. */
export const engineVersion = {
  pinned: () => pinnedCodexVersion(),
  parse: (text) => parseCodexVersion(text),
  compat: () => codexCompat(),
  /** {version, source}: the pinned package's version read from disk; a custom binary (AD_ENGINE_BIN) is probed. */
  installed: (env = process.env, { run } = {}) => {
    const v = installedCodexVersion(env);
    return v.source === "env" ? probeVersion({ env, run }) : v;
  },
  /** {code: "pinned" | "tested" | "untested" | "unknown", installed, pinned, tested}. Never refuses (Part 3, D3-1). */
  check: ({ installed, pinned = pinnedCodexVersion(), tested = codexCompat().tested ?? [] } = {}) => {
    if (!installed) return { code: "unknown", installed: null, pinned, tested };
    if (installed === pinned) return { code: "pinned", installed, pinned, tested };
    return { code: tested.includes(installed) ? "tested" : "untested", installed, pinned, tested };
  },
};

/** The engine's own UI, for maintainers only (removed from the product in Part 3/4). */
export const engineDebugUi = {
  run: (o) => runStockUi(o),
  args: (o) => stockUiArgs(o),
  syncSkills: (o) => syncSkills(o),
  MIRROR_MARKER,
  MIRRORED_FLAG,
};

// `ad doctor`: the adapter reports codes and data; these are ad's words for them.
const doctorDetailLines = (raw) => raw ? "\n" + String(raw).split("\n").slice(0, 8).map((line) => `  details: ${line}`).join("\n") : "";

const DOCTOR_WORDS = {
  "engine.missing": () => ({ name: "Engine", note: "not installed. Run: cd runtime && npm install" }),
  "engine.notRunnable": (d) => ({ name: "Engine", note: `not runnable (${d.error}). Run: cd runtime && npm install` }),
  "engine.versionDiagnostic": (d) => ({ name: "Engine version details", note: "The engine sent a notice." + doctorDetailLines(d.detail) }),
  "engine.version": (d) => ({
    name: "Engine version",
    note: d.installed === d.pinned ? `${d.installed} (${d.source}), the version ad is tested with` : `${d.installed} (${d.source}), but ad was tested with ${d.pinned}. Run: cd runtime && npm install`,
  }),
  "engine.home": (d) => ({
    name: "Engine home",
    note: !d.exists ? `${d.path} (created on the first run)` : !d.managed ? `${d.path} (not created by ad, so ad never changes it)` : d.state === "old" ? `${d.path} (older folder name; nothing is wrong; ad migrate is optional)` : d.path,
  }),
  "engine.link": (d) => ({
    name: "Engine home link",
    note: d.kind === "link" ? `${d.link} (a link older versions of ad need${d.migratedAt ? `; made by ad migrate on ${d.migratedAt.slice(0, 10)}` : ""})` : d.kind === "dangling" ? `${d.link} points nowhere; the next ad start replaces it` : `no link at ${d.link}: an ad 2.x would start a new, empty folder`,
  }),
  "engine.twoFolders": (d) => ({ name: "Engine home", note: `two engine folders: ${d.oldPath} and ${d.newPath}. Rename the one you don't want (for example to engine.old); delete nothing until you've checked.` }),
  "engine.folderFacts": (d) => ({ name: `Engine folder (${d.which})`, note: `${d.path}: ${d.conversations} conversations, last used ${d.lastUsed ? d.lastUsed.slice(0, 10) : "never"}, ${d.signedIn ? "signed in" : "not signed in"}` }),
  "engine.homeError": (d) => ({ name: "Engine home", note: d.message }),
  "engine.compat": (d) => ({ name: "Engine compatibility", note: `tested: ${d.tested.join(", ")}. ${d.note}` }),
  "engine.login": (d) => ({ name: "Engine sign-in", note: d.loggedIn ? d.label : "not signed in. Run: ad auth login chatgpt" }),
  "engine.hooks": (d) => ({ name: "Engine hooks", note: `${d.trusted}/${d.total} trusted${d.trusted < d.total ? "; the next ad run trusts them again" : ""}` }),
  "engine.windowsSandbox": (d) => ({ name: "Windows sandbox", note: d.status === "ready" ? `ready (${d.mode ?? "?"})` : `${d.status}. Run: ad sandbox setup` }),
  "engine.unreachable": (d) => {
    const err = { ...d, message: d.error };
    return { name: "Engine", note: `could not start: ${engineErrorText(err, { details: null })}${doctorDetailLines(engineErrorDetail(err))}` };
  },
};

const doctorWords = (c) => ({ ok: c.ok, ...(DOCTOR_WORDS[c.code]?.(c.data ?? {}) ?? { name: "Engine", note: c.code }) });

export const engineDoctor = {
  /** [{name, ok, note}] without starting the engine. */
  checks: (o) => engineChecks(o).map(doctorWords),
  /** [{name, ok, note}] that need a running engine; [] until the home exists. */
  liveChecks: async (o = {}) => (await engineLiveChecks({ engineFactory: createEngine, ...o })).map(doctorWords),
};

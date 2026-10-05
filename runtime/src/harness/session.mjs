// The session controller (plan Part 4): one conversation with the engine,
// independent of any UI. The TUI (and later chat, web, ACP) drive it with
// submit / steer / queue / interrupt / resolve and render `state`; every
// change is announced with a "change" event, so a front end only re-renders.
//
// createSession({engine, cwd, model, sandbox, approvalPolicy, hooks, lockDir,
//                restart, maxRestarts}) → session (see the returned object)
//
//   - Lazy thread: nothing is created (thread, lock, hooks) until the first
//     prompt, so quitting with zero turns leaves no trace.
//   - Local echo: a submitted prompt shows at once; Codex's copy (matched by
//     clientUserMessageId) replaces it.
//   - Enter while a turn runs steers it (turn/steer with expectedTurnId); a
//     turn that can't be steered (review) or that just ended takes it as a
//     queued prompt instead. The queue is visible and editable, and drains
//     when a turn completes.
//   - Requests (approvals, user input, MCP forms) wait in state.requests, in
//     arrival order, until resolve(); subagent requests carry their label.
//   - A thread lock (~/.agent-daemon/locks) keeps two ad instances off one thread.
//   - Engine crash: state.engine says so; with `restart` the engine is
//     replaced (capped) and the thread resumed.

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_APPROVAL_POLICY, DEFAULT_SANDBOX } from "../engine/index.mjs";

export const DEFAULT_LOCK_DIR = join(homedir(), ".agent-daemon", "locks");
const NOTICE_CAP = 50;
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

export class SessionLockedError extends Error {
  constructor(threadId, holder) {
    super(`thread ${threadId} is open in another ad (pid ${holder.pid}). Close it there first.`);
    this.code = "SESSION_LOCKED";
    this.holder = holder;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** Takes the lock for a thread, or throws SessionLockedError. Returns a release function. */
export function lockThread(threadId, { dir = DEFAULT_LOCK_DIR, pid = process.pid, isAlive = alive } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${String(threadId).replace(/[^A-Za-z0-9_.-]/g, "_")}.lock`);
  const me = JSON.stringify({ pid, startedAt: PROCESS_STARTED_AT, threadId });
  try {
    writeFileSync(file, me, { flag: "wx" });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    let holder = null;
    try {
      holder = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      holder = null; // unreadable: treat as stale
    }
    if (holder && holder.pid !== pid && isAlive(holder.pid)) throw new SessionLockedError(threadId, holder);
    writeFileSync(file, me); // stale (its process is gone) or our own: take it
  }
  return () => {
    try {
      const holder = JSON.parse(readFileSync(file, "utf8"));
      if (holder.pid === pid) rmSync(file, { force: true });
    } catch {
      // Already gone.
    }
  };
}

const toInput = (input) => (typeof input === "string" ? [{ type: "text", text: input }] : input);
const inputText = (input) =>
  toInput(input)
    .map((i) => (i.type === "text" ? i.text : i.type === "localImage" ? `[image ${i.path}]` : ""))
    .join("\n");

export function createSession({
  engine,
  cwd,
  model,
  sandbox = DEFAULT_SANDBOX,
  approvalPolicy = DEFAULT_APPROVAL_POLICY,
  hooks = {},
  lockDir = DEFAULT_LOCK_DIR,
  restart = null,
  maxRestarts = 3,
} = {}) {
  let eng = engine;
  const emitter = new EventEmitter();
  const state = {
    thread: null,
    turns: [], // [{id, status, error, itemIds: []}]
    items: new Map(), // itemId → ViewItem + {threadId, turnId, streaming…}
    echoes: new Map(), // clientUserMessageId → text (shown until Codex echoes it)
    activeTurnId: null,
    starting: false, // a turn/start is on its way
    requests: [], // [{request, resolve}] in arrival order
    queue: [], // [{id, input, text}]
    config: { model: model ?? null, effort: null, sandbox, approvalPolicy, cwd },
    account: null,
    goal: null,
    agents: new Map(), // child threadId → {label, parentThreadId}
    mcp: new Map(),
    tokens: null,
    plan: null,
    diff: null,
    rateLimits: null,
    notices: [],
    engine: { state: "ready", exitCode: null, restarts: 0 },
  };
  let nextTurn = {};
  let releaseLock = null;
  let unsubThread = null;
  let unsubGlobal = null;
  let pendingInterrupt = false;
  let closed = false;
  const doneWaiters = new Map(); // turnId → [resolve]

  const change = (what) => emitter.emit("change", { what, state });
  const notice = (level, code, message) => {
    state.notices.push({ level, code, message, at: Date.now() });
    if (state.notices.length > NOTICE_CAP) state.notices.splice(0, state.notices.length - NOTICE_CAP);
    change("notices");
  };

  /* -------------------------------------------------------------- */
  /* Engine wiring                                                  */
  /* -------------------------------------------------------------- */

  function wire() {
    eng.onRequest = (request) =>
      new Promise((resolve) => {
        state.requests.push({ request, resolve });
        change("requests");
      });
    unsubGlobal = eng.subscribe(null, onGlobal);
    eng.on("exit", onExit);
  }

  function unwire() {
    unsubGlobal?.();
    unsubThread?.();
    unsubGlobal = unsubThread = null;
    eng.off?.("exit", onExit);
    if (eng.onRequest) eng.onRequest = null;
  }

  function onGlobal(ev) {
    if (ev.type === "account") state.account = { ...(state.account ?? {}), ...ev.account };
    else if (ev.type === "rateLimits") state.rateLimits = ev.limits;
    else if (ev.type === "mcp.status") state.mcp.set(ev.server, { status: ev.status, error: ev.error, failureReason: ev.failureReason });
    else if (ev.type === "notice") return notice(ev.level, ev.code, ev.message);
    else return;
    change(ev.type);
  }

  function turnOf(id) {
    let t = state.turns.find((x) => x.id === id);
    if (!t && id) {
      t = { id, status: "inProgress", error: null, itemIds: [] };
      state.turns.push(t);
    }
    return t;
  }

  // Items that arrived before their turn was known join it once it is.
  function adoptItems(t) {
    for (const it of state.items.values()) if (it.turnId === t.id && it.threadId === state.thread?.id && !t.itemIds.includes(it.id)) t.itemIds.push(it.id);
  }

  function placeItem(item, ev) {
    const prev = state.items.get(item.id);
    state.items.set(item.id, { ...prev, ...item, threadId: ev.threadId, turnId: ev.turnId ?? prev?.turnId ?? null, at: ev.at ?? prev?.at ?? null });
    // Only into a turn we know: a user shell command (!cmd) has items but no turn.
    const t = ev.threadId === state.thread?.id ? state.turns.find((x) => x.id === ev.turnId) : null;
    if (t && !t.itemIds.includes(item.id)) t.itemIds.push(item.id);
    // Codex's copy of a prompt replaces the local echo.
    if (item.kind === "userMessage" && item.clientId && state.echoes.delete(item.clientId)) change("echoes");
  }

  const DELTA_TARGET = { text: "agentMessage", plan: "plan", reasoning: "reasoning", reasoningPart: "reasoning", reasoningRaw: "reasoning", output: "commandExecution", terminal: "commandExecution", progress: "mcpToolCall", patch: "fileChange" };

  function applyDelta(ev) {
    const cur = state.items.get(ev.itemId) ?? { id: ev.itemId, kind: DELTA_TARGET[ev.kind] ?? "unknown", streaming: true };
    const next = { ...cur };
    if (ev.kind === "text" || ev.kind === "plan") next.text = (cur.text ?? "") + ev.delta;
    else if (ev.kind === "reasoning") next.summaryText = (cur.summaryText ?? "") + ev.delta;
    else if (ev.kind === "reasoningPart") next.summaryText = cur.summaryText ? `${cur.summaryText}\n\n` : "";
    else if (ev.kind === "reasoningRaw") next.rawText = (cur.rawText ?? "") + ev.delta;
    else if (ev.kind === "output") next.output = (cur.output ?? "") + ev.delta;
    else if (ev.kind === "terminal") next.stdin = (cur.stdin ?? "") + ev.delta;
    else if (ev.kind === "progress") next.progress = ev.delta;
    else if (ev.kind === "patch") next.changes = ev.changes ?? cur.changes;
    placeItem(next, ev);
  }

  function onThreadEvent(ev) {
    const root = ev.threadId === state.thread?.id;
    switch (ev.type) {
      case "thread.started":
        if (root) state.thread = { ...state.thread, ...ev.thread };
        else if (ev.thread?.parentThreadId) state.agents.set(ev.thread.id, { label: ev.thread.agentNickname ?? ev.thread.agentRole ?? null, parentThreadId: ev.thread.parentThreadId });
        break;
      case "thread.name":
        if (root) state.thread = { ...state.thread, name: ev.name };
        break;
      case "thread.status":
        if (root) state.thread = { ...state.thread, status: ev.status };
        break;
      case "thread.goal":
        if (root) state.goal = ev.goal;
        break;
      case "thread.tokens":
        if (root) state.tokens = ev.usage;
        break;
      case "turn.plan":
        if (root) state.plan = { steps: ev.steps, explanation: ev.explanation };
        break;
      case "turn.diff":
        if (root) state.diff = ev.diff;
        break;
      case "turn.started": {
        if (!root) break;
        const t = turnOf(ev.turnId);
        adoptItems(t);
        t.status = "inProgress";
        state.activeTurnId = ev.turnId;
        state.plan = null;
        hooks.turnStarted?.({ turn: t, session: api });
        break;
      }
      case "turn.completed": {
        if (!root) break;
        const t = turnOf(ev.turnId);
        adoptItems(t);
        t.status = ev.status ?? "completed";
        t.error = ev.error ?? null;
        if (state.activeTurnId === ev.turnId) state.activeTurnId = null;
        for (const it of state.items.values()) if (it.turnId === ev.turnId) it.streaming = false;
        hooks.turnCompleted?.({ turn: t, status: t.status, session: api });
        for (const resolve of doneWaiters.get(ev.turnId) ?? []) resolve({ turnId: ev.turnId, status: t.status, error: t.error });
        doneWaiters.delete(ev.turnId);
        change("turn");
        queueMicrotask(drainQueue);
        return;
      }
      case "item.started":
      case "item.completed":
        placeItem({ ...ev.item, streaming: ev.type === "item.started" }, ev);
        break;
      case "item.delta":
        applyDelta(ev);
        break;
      case "request.resolved": {
        const i = state.requests.findIndex((r) => r.request.id === ev.requestId);
        if (i >= 0) state.requests.splice(i, 1);
        if (ev.cancelled) notice("info", "request.cancelled", `A pending request was withdrawn (${ev.cancelled}).`);
        break;
      }
      case "notice":
        return notice(ev.level, ev.code, ev.message);
      case "thread.reverted":
      case "thread.compacted":
        break;
      default:
        return;
    }
    change(ev.type);
  }

  async function onExit(info) {
    if (closed) return;
    state.engine = { ...state.engine, state: "crashed", exitCode: info?.code ?? null };
    // The running turn won't complete: end it as failed for whoever waits.
    if (state.activeTurnId) {
      const t = turnOf(state.activeTurnId);
      t.status = "failed";
      t.error = { message: "Codex stopped" };
      for (const resolve of doneWaiters.get(t.id) ?? []) resolve({ turnId: t.id, status: "failed", error: t.error });
      doneWaiters.delete(t.id);
      state.activeTurnId = null;
    }
    state.starting = false;
    for (const r of state.requests.splice(0)) r.resolve(null);
    change("engine");
    if (!restart || state.engine.restarts >= maxRestarts) return;
    try {
      unwire();
      state.engine = { ...state.engine, state: "restarting" };
      change("engine");
      eng = await restart();
      wire();
      if (state.thread) {
        await eng.resumeThread(state.thread.id, { cwd, sandbox: state.config.sandbox, approvalPolicy: state.config.approvalPolicy, excludeTurns: true });
        unsubThread = eng.subscribe(state.thread.id, onThreadEvent);
      }
      // Ready only once the thread is back: a prompt sent now goes to the right place.
      state.engine = { state: "ready", exitCode: null, restarts: state.engine.restarts + 1 };
      notice("info", "engine.restarted", "Codex restarted; the conversation continues.");
      change("engine");
    } catch (err) {
      state.engine = { ...state.engine, state: "crashed" };
      notice("error", "engine.restartFailed", `Codex could not be restarted: ${err.message}`);
    }
  }

  /* -------------------------------------------------------------- */
  /* Threads                                                        */
  /* -------------------------------------------------------------- */

  function attach(threadId, thread) {
    releaseLock = lockThread(threadId, { dir: lockDir });
    state.thread = { ...(thread ?? {}), id: threadId };
    unsubThread = eng.subscribe(threadId, onThreadEvent);
  }

  function detach() {
    unsubThread?.();
    unsubThread = null;
    releaseLock?.();
    releaseLock = null;
    for (const r of state.requests.splice(0)) r.resolve(null);
  }

  async function ensureThread() {
    if (state.thread) return state.thread.id;
    const t = await eng.startThread({ cwd, model: state.config.model ?? undefined, sandbox: state.config.sandbox, approvalPolicy: state.config.approvalPolicy });
    state.config.model ??= t.model ?? null;
    attach(t.threadId, t.thread);
    change("thread");
    return t.threadId;
  }

  function resetThreadState() {
    state.thread = null;
    state.turns = [];
    state.items = new Map();
    state.echoes = new Map();
    state.activeTurnId = null;
    state.starting = false;
    state.queue = [];
    state.goal = null;
    state.plan = null;
    state.diff = null;
    state.tokens = null;
    state.agents = new Map();
  }

  /* -------------------------------------------------------------- */
  /* Turns                                                          */
  /* -------------------------------------------------------------- */

  function waitTurn(turnId) {
    const t = state.turns.find((x) => x.id === turnId);
    if (t && t.status !== "inProgress") return Promise.resolve({ turnId, status: t.status, error: t.error });
    return new Promise((resolve) => {
      if (!doneWaiters.has(turnId)) doneWaiters.set(turnId, []);
      doneWaiters.get(turnId).push(resolve);
    });
  }

  function takeNextTurn() {
    const o = nextTurn;
    nextTurn = {};
    return o;
  }

  function startTurn(input, cid) {
    state.starting = true;
    change("starting");
    const accepted = (async () => {
      try {
        const threadId = await ensureThread();
        let inp = toInput(input);
        if (hooks.beforeTurn) inp = toInput((await hooks.beforeTurn({ input: inp, session: api })) ?? inp);
        const o = takeNextTurn();
        const { turnId } = await eng.startTurn({ threadId, input: inp, clientUserMessageId: cid, ...o });
        const t = turnOf(turnId);
        adoptItems(t);
        // Codex may finish a turn before turn/start even answers: only a turn
        // still in progress becomes the active one.
        if (t.status === "inProgress") state.activeTurnId ??= turnId;
        return { turnId };
      } catch (err) {
        state.echoes.delete(cid);
        throw err;
      } finally {
        state.starting = false;
        change("starting");
      }
    })();
    accepted.then(
      ({ turnId }) => {
        if (pendingInterrupt) {
          pendingInterrupt = false;
          eng.interrupt(state.thread.id, turnId).catch((e) => notice("warn", "interrupt.failed", e.message));
        }
      },
      () => {
        pendingInterrupt = false;
        queueMicrotask(drainQueue);
      },
    );
    const done = accepted.then(({ turnId }) => waitTurn(turnId));
    done.catch(() => {});
    return { accepted, done };
  }

  /**
   * Send a prompt. Starts a turn when idle; steers the running turn otherwise
   * (or queues when that turn can't take it). accepted resolves once Codex has
   * it ({turnId} | {steered, turnId} | {queued}); done when its turn ends.
   */
  function submit(input) {
    if (closed) throw new Error("session closed");
    if (state.activeTurnId) return steer(input);
    const cid = randomUUID();
    if (state.starting) {
      const accepted = Promise.resolve({ queued: true, index: queue(input) });
      return { clientUserMessageId: cid, accepted, done: accepted };
    }
    state.echoes.set(cid, inputText(input));
    change("echoes");
    return { clientUserMessageId: cid, ...startTurn(input, cid) };
  }

  function steer(input) {
    const cid = randomUUID();
    if (!state.activeTurnId) return submit(input);
    const turnId = state.activeTurnId;
    state.echoes.set(cid, inputText(input));
    change("echoes");
    const accepted = eng.server
      .request("turn/steer", { threadId: state.thread.id, expectedTurnId: turnId, input: toInput(input), clientUserMessageId: cid })
      .then(
        (r) => ({ steered: true, turnId: r?.turnId ?? turnId }),
        () => {
          // Not steerable (review, compact) or the turn just ended: keep it as
          // a queued prompt, which runs as soon as the thread is idle.
          state.echoes.delete(cid);
          const index = queue(input);
          queueMicrotask(drainQueue);
          return { queued: true, index };
        },
      );
    const done = accepted.then((a) => (a.steered ? waitTurn(a.turnId) : a));
    done.catch(() => {});
    return { clientUserMessageId: cid, accepted, done };
  }

  function queue(input) {
    state.queue.push({ id: randomUUID(), input: toInput(input), text: inputText(input) });
    change("queue");
    return state.queue.length - 1;
  }

  function editQueued(index, text) {
    if (index < 0 || index >= state.queue.length) return false;
    if (text == null) state.queue.splice(index, 1);
    else state.queue[index] = { ...state.queue[index], input: toInput(text), text };
    change("queue");
    return true;
  }

  function drainQueue() {
    if (closed || state.activeTurnId || state.starting || !state.queue.length) return;
    const next = state.queue.shift();
    change("queue");
    const cid = randomUUID();
    state.echoes.set(cid, next.text);
    startTurn(next.input, cid).accepted.catch((err) => notice("error", "turn.start", err.message));
  }

  async function interrupt() {
    if (state.activeTurnId) {
      await eng.interrupt(state.thread.id, state.activeTurnId).catch((e) => notice("warn", "interrupt.failed", e.message));
      return true;
    }
    if (state.starting) {
      pendingInterrupt = true;
      return true;
    }
    return false;
  }

  function resolve(requestId, answer) {
    const i = state.requests.findIndex((r) => r.request.id === requestId);
    if (i < 0) return false;
    const [r] = state.requests.splice(i, 1);
    r.resolve(answer);
    change("requests");
    return true;
  }

  function setNextTurn(o = {}) {
    for (const k of ["model", "effort", "approvalPolicy", "sandboxPolicy"]) if (o[k] !== undefined) nextTurn[k] = o[k];
    if (o.model !== undefined) state.config.model = o.model;
    if (o.effort !== undefined) state.config.effort = o.effort;
    if (o.approvalPolicy !== undefined) state.config.approvalPolicy = o.approvalPolicy;
    if (o.sandboxPolicy !== undefined) state.config.sandbox = o.sandboxPolicy?.type ?? o.sandboxPolicy;
    change("config");
  }

  async function loadTurns(threadId) {
    const turns = [];
    let cursor = null;
    for (let page = 0; page < 1000; page++) {
      const r = await eng.server.request("thread/turns/list", { threadId, itemsView: "full", sortDirection: "asc", limit: 50, ...(cursor ? { cursor } : {}) });
      turns.push(...(r?.data ?? []));
      cursor = r?.nextCursor ?? null;
      if (!cursor) break;
    }
    const { normalizeItem } = await import("../engine/codex/events.mjs");
    for (const t of turns) {
      const turn = turnOf(t.id);
      turn.status = t.status ?? "completed";
      turn.error = t.error ?? null;
      for (const item of t.items ?? []) placeItem(normalizeItem(item), { threadId, turnId: t.id });
    }
  }

  const api = {
    state,
    on: (event, fn) => (emitter.on(event, fn), () => emitter.off(event, fn)),
    get engine() {
      return eng;
    },

    /** Account and rate limits, read once at startup; later changes arrive as events. */
    async init() {
      const acct = await eng.account().catch(() => null);
      if (acct) state.account = { ...(acct.account ?? {}), requiresOpenaiAuth: Boolean(acct.requiresOpenaiAuth) };
      const limits = await eng.server.request("account/rateLimits/read", {}).catch(() => null);
      if (limits) state.rateLimits = limits.rateLimits ?? limits;
      change("account");
    },
    submit,
    steer,
    queue,
    editQueued,
    interrupt,
    resolve,
    setNextTurn,
    async review(target = { type: "uncommittedChanges" }) {
      const threadId = await ensureThread();
      return eng.server.request("review/start", { threadId, target });
    },
    async compact() {
      if (!state.thread) return false;
      await eng.compactThread(state.thread.id);
      return true;
    },
    async shell(command) {
      const threadId = await ensureThread();
      return eng.server.request("thread/shellCommand", { threadId, command });
    },
    async setGoal(text) {
      const threadId = await ensureThread();
      state.goal = text == null ? (await eng.clearGoal(threadId), null) : await eng.setGoal(threadId, text);
      change("goal");
      return state.goal;
    },
    /** Rewinds the thread to just before `turnId`. */
    async revert(turnId) {
      if (!state.thread) throw new Error("no thread to revert");
      if (state.activeTurnId) throw new Error("interrupt the running turn first");
      await eng.server.request("thread/revert", { threadId: state.thread.id, beforeTurnId: turnId });
      const i = state.turns.findIndex((t) => t.id === turnId);
      if (i >= 0) {
        const gone = new Set(state.turns.slice(i).map((t) => t.id));
        state.turns = state.turns.slice(0, i);
        for (const [id, it] of state.items) if (gone.has(it.turnId)) state.items.delete(id);
      }
      change("revert");
    },
    /** Leaves the current thread; the next prompt starts a new one. */
    newThread() {
      detach();
      resetThreadState();
      change("thread");
    },
    /** Continues an earlier thread, with its history loaded. */
    async resume(threadId) {
      detach();
      resetThreadState();
      const t = await eng.resumeThread(threadId, { cwd, sandbox: state.config.sandbox, approvalPolicy: state.config.approvalPolicy, excludeTurns: true });
      state.config.model = t.model ?? state.config.model;
      attach(t.threadId, t.thread);
      await loadTurns(t.threadId);
      change("thread");
      return t.threadId;
    },
    close() {
      if (closed) return;
      closed = true;
      detach();
      unwire();
      for (const [, list] of doneWaiters) for (const r of list) r({ status: "closed" });
      doneWaiters.clear();
      emitter.removeAllListeners();
    },
  };

  wire();
  return api;
}

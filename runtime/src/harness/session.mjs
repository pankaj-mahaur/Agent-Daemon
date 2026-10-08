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
//     Only requests for the current thread (or its subagents) are shown;
//     others are declined. One session per engine.
//   - A thread lock (~/.agent-daemon/locks) keeps two ad instances off one thread.
//   - newThread / resume / close leave the current thread: a running turn is
//     interrupted and its waiters settle ("abandoned" / "closed"); a thread or
//     turn still being started when that happens is dropped (and stopped).
//   - Setting overrides (setNextTurn) stick: a new or resumed thread gets them
//     on its first turn.
//   - Engine crash: state.engine says so; with `restart` the engine is
//     replaced (capped), the thread resumed, then the queue drains.

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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

/**
 * Takes the lock for a thread, or throws SessionLockedError. Returns a release
 * function.
 *
 * A holder refreshes its file's mtime every `heartbeatMs`. A lock is stale
 * when its process is gone or its heartbeat stopped `staleMs` ago (a reused
 * pid can't keep a dead holder's lock). Takeover is serialised by a `.takeover`
 * file made with O_EXCL, so two processes never both take a stale lock. An
 * unreadable lock younger than `staleMs` is someone mid-write: busy. A live
 * holder is never skipped, the same process included (one session per thread).
 */
export function lockThread(threadId, opts = {}) {
  const { dir = DEFAULT_LOCK_DIR, pid = process.pid, isAlive = alive, now = Date.now, staleMs = 120_000, heartbeatMs = 30_000 } = opts;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${String(threadId).replace(/[^A-Za-z0-9_.-]/g, "_")}.lock`);
  const token = randomUUID();
  const me = JSON.stringify({ pid, startedAt: PROCESS_STARTED_AT, threadId, token });
  const busy = (holder) => new SessionLockedError(threadId, holder ?? { pid: "unknown" });
  try {
    writeFileSync(file, me, { flag: "wx" });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    const guard = `${file}.takeover`;
    try {
      writeFileSync(guard, String(pid), { flag: "wx" });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Another process is taking it over; a guard left by a crash expires.
      let age = Infinity;
      try {
        age = now() - statSync(guard).mtimeMs;
      } catch {
        // Gone already: retry.
      }
      if (opts.retried || age < 10_000) throw busy(null);
      rmSync(guard, { force: true });
      return lockThread(threadId, { ...opts, retried: true });
    }
    try {
      let holder = null;
      let fresh = true;
      try {
        fresh = now() - statSync(file).mtimeMs < staleMs;
        holder = JSON.parse(readFileSync(file, "utf8"));
      } catch (e) {
        if (e.code === "ENOENT") fresh = false;
      }
      if (!holder && fresh) throw busy(null);
      if (holder && fresh && isAlive(holder.pid)) throw busy(holder);
      writeFileSync(file, me); // stale: take it
    } finally {
      rmSync(guard, { force: true });
    }
  }
  const beat = setInterval(() => {
    try {
      const t = new Date(now());
      utimesSync(file, t, t);
    } catch {
      // The file is gone; release will find out.
    }
  }, heartbeatMs);
  beat.unref?.();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(beat);
    try {
      if (JSON.parse(readFileSync(file, "utf8")).token === token) rmSync(file, { force: true });
    } catch {
      // Already gone, or someone else's now.
    }
  };
}

// A turn's sandboxPolicy type → the sandbox mode thread/start and thread/resume take.
const SANDBOX_MODE = { readOnly: "read-only", workspaceWrite: "workspace-write", dangerFullAccess: "danger-full-access" };

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
  // Every override so far: a new or resumed thread gets them on its first turn.
  let sticky = {};
  let releaseLock = null;
  // Bumped by newThread / resume / close: work begun under an older epoch
  // (a thread being created, a turn being started) is dropped when it lands.
  let epoch = 0;
  let threadStarting = null; // the one in-flight thread/start
  let unsubThread = null;
  let unsubGlobal = null;
  let pendingInterrupt = false;
  let closed = false;
  let restarting = false; // one restart loop at a time
  let exitHandler = null;
  const stale = (e) => closed || e !== epoch;
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

  // Requests for another thread (one this session left) are declined: they
  // must not show up as the current thread's.
  const onRequest = (request) => {
    const root = state.thread?.id;
    if (request.threadId && (!root || !eng.threadChain(request.threadId).includes(root))) return null;
    return new Promise((resolve) => {
      state.requests.push({ request, resolve });
      change("requests");
    });
  };

  function wire() {
    if (eng.onRequest && eng.onRequest !== onRequest) throw new Error("this engine already has a session");
    eng.onRequest = onRequest;
    unsubGlobal = eng.subscribe(null, onGlobal);
    const wired = eng;
    exitHandler = (info) => onExit(info, wired);
    eng.on("exit", exitHandler);
  }

  function unwire() {
    unsubGlobal?.();
    unsubThread?.();
    unsubGlobal = unsubThread = null;
    if (exitHandler) eng.off?.("exit", exitHandler);
    exitHandler = null;
    if (eng.onRequest === onRequest) eng.onRequest = null;
  }

  function onGlobal(ev) {
    if (ev.type === "hook.started" || ev.type === "hook.completed") return void emitter.emit("hook", { ...ev.run, phase: ev.type.slice(5) });
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

  // Some providers reuse item ids across turns ("msg-1", "call_0"): an item
  // of a later turn gets its own key (`<id>@<turn>`), so it neither merges
  // into the earlier one nor hides behind it as already shown.
  let itemKeys = new Map(); // "<turnId>\0<codex item id>" → key in state.items
  function itemKey(id, turnId, { create = true } = {}) {
    if (!turnId) return id;
    const k = `${turnId}\0${id}`;
    if (itemKeys.has(k)) return itemKeys.get(k);
    const prev = state.items.get(id);
    const key = prev?.turnId && prev.turnId !== turnId ? `${id}@${turnId}` : id;
    if (create) itemKeys.set(k, key);
    return key;
  }

  function placeItem(item, ev) {
    const key = itemKey(item.id, ev.turnId);
    const prev = state.items.get(key);
    state.items.set(key, { ...prev, ...item, id: key, threadId: ev.threadId, turnId: ev.turnId ?? prev?.turnId ?? null, at: ev.at ?? prev?.at ?? null });
    // Only into a turn we know: a user shell command (!cmd) has items but no turn.
    const t = ev.threadId === state.thread?.id ? state.turns.find((x) => x.id === ev.turnId) : null;
    if (t && !t.itemIds.includes(key)) t.itemIds.push(key);
    // Codex's copy of a prompt replaces the local echo.
    if (item.kind === "userMessage" && item.clientId && state.echoes.delete(item.clientId)) change("echoes");
  }

  const DELTA_TARGET = { text: "agentMessage", plan: "plan", reasoning: "reasoning", reasoningPart: "reasoning", reasoningRaw: "reasoning", output: "commandExecution", terminal: "commandExecution", progress: "mcpToolCall", patch: "fileChange" };

  function applyDelta(ev) {
    const key = itemKey(ev.itemId, ev.turnId);
    const cur = state.items.get(key) ?? { id: key, kind: DELTA_TARGET[ev.kind] ?? "unknown", streaming: true };
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
        if (root) (ev.type === "item.completed" ? hooks.itemCompleted : hooks.itemStarted)?.({ item: state.items.get(itemKey(ev.item.id, ev.turnId)), session: api });
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
      case "hook.started":
      case "hook.completed":
        // ad's hook rows (recalled memory, guard blocks…) for the front end.
        return void emitter.emit("hook", { ...ev.run, phase: ev.type.slice(5), threadId: ev.threadId });
      case "thread.reverted":
      case "thread.compacted":
        break;
      default:
        return;
    }
    change(ev.type);
  }

  // An engine exit: the running turn fails, open requests are declined, and
  // with `restart` new engines are tried (each attempt counts towards
  // maxRestarts) until one is up with the thread resumed. A thread the new
  // engine can't resume is dropped: the next prompt starts a new one.
  async function onExit(info, from) {
    if (closed || from !== eng || restarting) return;
    state.engine = { ...state.engine, state: "crashed", exitCode: info?.code ?? null };
    // The running turn won't complete: end it as failed for whoever waits.
    if (state.activeTurnId) {
      const t = turnOf(state.activeTurnId);
      t.status = "failed";
      t.error = { message: "Codex stopped" };
      // Its items will never complete either.
      for (const it of state.items.values()) {
        if (it.turnId !== t.id) continue;
        it.streaming = false;
        if (it.status === "inProgress") it.status = "failed";
      }
      for (const resolve of doneWaiters.get(t.id) ?? []) resolve({ turnId: t.id, status: "failed", error: t.error });
      doneWaiters.delete(t.id);
      state.activeTurnId = null;
    }
    state.starting = false;
    // Nothing that was running in that engine will finish (a ! command has no turn).
    for (const it of state.items.values()) {
      if (!it.streaming && it.status !== "inProgress") continue;
      it.streaming = false;
      if (it.status === "inProgress") it.status = "failed";
    }
    for (const r of state.requests.splice(0)) r.resolve(null);
    change("engine");
    if (restart) await recover(maxRestarts);
  }

  // Starts new engines until one is up with the thread resumed, or `limit`
  // attempts (counted in state.engine.restarts) are used. True when ready.
  async function recover(limit) {
    if (restarting || closed) return false;
    restarting = true;
    try {
      while (!closed && state.engine.restarts < limit) {
        state.engine = { ...state.engine, state: "restarting", restarts: state.engine.restarts + 1 };
        change("engine");
        unwire();
        let fresh = null;
        try {
          fresh = await restart();
          if (closed) return void (await fresh?.close?.());
          eng = fresh;
          wire();
        } catch (err) {
          await fresh?.close?.()?.catch?.(() => {});
          notice("error", "engine.restartFailed", `Codex could not be restarted: ${err.message}`);
          continue;
        }
        if (state.thread) {
          const id = state.thread.id;
          try {
            await eng.resumeThread(id, { cwd, sandbox: state.config.sandbox, approvalPolicy: state.config.approvalPolicy, excludeTurns: true });
          } catch (err) {
            if (closed) return void (await eng.close?.());
            if (eng.server?.exitError) {
              notice("error", "engine.restartFailed", `Codex stopped again: ${err.message}`);
              continue; // the new engine died too
            }
            notice("warn", "thread.notResumed", `The conversation could not be resumed (${err.message}); the next prompt starts a new one.`);
            const queued = state.queue;
            detach();
            resetThreadState();
            state.queue = queued;
            change("thread");
          }
          if (closed) return void (await eng.close?.());
          if (state.thread?.id === id) unsubThread = eng.subscribe(id, onThreadEvent);
        }
        // Overrides go again on the next turn, in case Codex lost them.
        nextTurn = { ...sticky, ...nextTurn };
        // Ready only once the thread is back: a prompt sent now goes to the right place.
        state.engine = { state: "ready", exitCode: null, restarts: state.engine.restarts };
        notice("info", "engine.restarted", "Codex restarted; the conversation continues.");
        change("engine");
        queueMicrotask(drainQueue);
        return true;
      }
      if (!closed) {
        state.engine = { ...state.engine, state: "crashed" };
        change("engine");
      }
      return false;
    } finally {
      restarting = false;
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

  // Leaves the current thread: a running turn is interrupted (it would go on
  // writing files unobserved) and its waiters settle as "abandoned".
  function detach(status = "abandoned") {
    epoch++;
    threadStarting = null;
    pendingInterrupt = false;
    if (state.thread && state.activeTurnId) eng.interrupt(state.thread.id, state.activeTurnId).catch(() => {});
    for (const [turnId, list] of doneWaiters) for (const r of list) r({ turnId, status, error: null });
    doneWaiters.clear();
    unsubThread?.();
    unsubThread = null;
    releaseLock?.();
    releaseLock = null;
    for (const r of state.requests.splice(0)) r.resolve(null);
  }

  // One thread/start at a time; a result that lands after newThread, resume
  // or close is dropped.
  function ensureThread() {
    if (state.thread) return Promise.resolve(state.thread.id);
    if (threadStarting) return threadStarting;
    const e = epoch;
    const p = (async () => {
      const t = await eng.startThread({ cwd, model: state.config.model ?? undefined, sandbox: state.config.sandbox, approvalPolicy: state.config.approvalPolicy });
      if (stale(e)) throw new Error("the session moved on before the thread started");
      state.config.model ??= t.model ?? null;
      attach(t.threadId, t.thread);
      change("thread");
      return t.threadId;
    })().finally(() => {
      if (threadStarting === p) threadStarting = null;
    });
    threadStarting = p;
    return p;
  }

  function resetThreadState() {
    state.thread = null;
    state.turns = [];
    state.items = new Map();
    itemKeys = new Map();
    state.echoes = new Map();
    state.activeTurnId = null;
    state.starting = false;
    state.queue = [];
    state.goal = null;
    state.plan = null;
    state.diff = null;
    state.tokens = null;
    state.agents = new Map();
    nextTurn = { ...sticky };
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
    const e = epoch;
    state.starting = true;
    change("starting");
    const accepted = (async () => {
      try {
        const threadId = await ensureThread();
        let inp = toInput(input);
        if (hooks.beforeTurn) inp = toInput((await hooks.beforeTurn({ input: inp, session: api })) ?? inp);
        if (stale(e)) throw new Error("the session moved on before the turn started");
        const o = takeNextTurn();
        const { turnId } = await eng.startTurn({ threadId, input: inp, clientUserMessageId: cid, ...o });
        if (stale(e)) {
          // Started on a thread this session has left: stop it.
          eng.interrupt(threadId, turnId).catch(() => {});
          throw new Error("the session moved on before the turn started");
        }
        const t = turnOf(turnId);
        adoptItems(t);
        // Codex may finish a turn before turn/start even answers: only a turn
        // still in progress becomes the active one.
        if (t.status === "inProgress") state.activeTurnId ??= turnId;
        if (pendingInterrupt) {
          pendingInterrupt = false;
          eng.interrupt(threadId, turnId).catch((err) => notice("warn", "interrupt.failed", err.message));
        }
        return { turnId };
      } catch (err) {
        if (!stale(e)) state.echoes.delete(cid);
        hooks.turnStartFailed?.({ error: err, session: api });
        throw err;
      } finally {
        if (!stale(e)) {
          state.starting = false;
          change("starting");
          // A turn that completed before turn/start answered couldn't drain the queue.
          queueMicrotask(drainQueue);
        }
      }
    })();
    accepted.catch(() => {
      if (stale(e)) return;
      pendingInterrupt = false;
      queueMicrotask(drainQueue);
    });
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
    // While a turn is starting or the engine is restarting, the prompt waits in the queue.
    if (state.starting || state.engine.state !== "ready") {
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

  // Queued prompts run in order whenever the thread is idle (edits made in
  // the same tick still apply).
  function queue(input) {
    state.queue.push({ id: randomUUID(), input: toInput(input), text: inputText(input) });
    change("queue");
    queueMicrotask(drainQueue);
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
    if (closed || state.engine.state !== "ready" || state.activeTurnId || state.starting || !state.queue.length) return;
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
    for (const k of ["model", "effort", "approvalPolicy", "sandboxPolicy"]) if (o[k] !== undefined) nextTurn[k] = sticky[k] = o[k];
    if (o.model !== undefined) state.config.model = o.model;
    if (o.effort !== undefined) state.config.effort = o.effort;
    if (o.approvalPolicy !== undefined) state.config.approvalPolicy = o.approvalPolicy;
    if (o.sandboxPolicy !== undefined) state.config.sandbox = SANDBOX_MODE[o.sandboxPolicy?.type] ?? state.config.sandbox;
    change("config");
  }

  async function loadTurns(threadId, e) {
    const { normalizeItem } = await import("../engine/codex/events.mjs");
    const turns = [];
    let cursor = null;
    for (let page = 0; page < 1000; page++) {
      const r = await eng.server.request("thread/turns/list", { threadId, itemsView: "full", sortDirection: "asc", limit: 50, ...(cursor ? { cursor } : {}) });
      if (stale(e)) throw new Error("the session moved on before the history loaded");
      turns.push(...(r?.data ?? []));
      cursor = r?.nextCursor ?? null;
      if (!cursor) break;
    }
    for (const t of turns) {
      const turn = turnOf(t.id);
      turn.status = t.status ?? "completed";
      turn.error = t.error ?? null;
      for (const item of t.items ?? []) placeItem(normalizeItem(item), { threadId, turnId: t.id });
    }
  }

  const api = {
    state,
    /** The item a request or event names (Codex's id within its turn). */
    itemFor: (id, turnId) => state.items.get(itemKey(id, turnId, { create: false })),
    on: (event, fn) => (emitter.on(event, fn), () => emitter.off(event, fn)),
    get engine() {
      return eng;
    },

    /**
     * Restarts Codex by hand: after a crash the automatic attempts gave up on
     * (one more try), or to pick up a new login. Not while a turn runs.
     */
    async restartEngine() {
      if (!restart) throw new Error("Codex can't be restarted from here: quit and start ad again.");
      if (closed || restarting) return false;
      if (state.activeTurnId || state.starting) throw new Error("wait for the turn to finish first");
      // "restarting" first: a prompt sent meanwhile is queued, not sent to the engine being closed.
      const wasReady = state.engine.state === "ready";
      const budget = state.engine.restarts;
      state.engine = { ...state.engine, state: "restarting" };
      change("engine");
      if (wasReady) {
        // A live engine: let it go quietly (no crash handling), then start fresh.
        const old = eng;
        unwire();
        await old.close?.().catch?.(() => {});
      }
      const ok = await recover(budget + 1);
      // A restart asked for by hand doesn't use up the automatic ones.
      if (ok) state.engine = { ...state.engine, restarts: budget };
      return ok;
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
        for (const [k, key] of itemKeys) if (!state.items.has(key)) itemKeys.delete(k);
      }
      change("revert");
    },
    /** Names the thread (Codex's thread/name/set). */
    async rename(name) {
      if (!state.thread) throw new Error("nothing to name yet: send a prompt first");
      const n = String(name ?? "").trim();
      if (!n) throw new Error("a name is needed");
      await eng.server.request("thread/name/set", { threadId: state.thread.id, name: n });
      state.thread = { ...state.thread, name: n };
      change("thread.name");
      return n;
    },
    /** Copies the thread (up to and including `throughTurnId`, or all of it) into a new one and continues there. */
    async fork(throughTurnId = null) {
      if (!state.thread) throw new Error("nothing to fork yet");
      if (state.activeTurnId || state.starting) throw new Error("wait for the turn to finish first");
      const r = await eng.server.request("thread/fork", { threadId: state.thread.id, ...(throughTurnId ? { lastTurnId: throughTurnId } : {}) });
      const id = r?.thread?.id;
      if (!id) throw new Error("Codex didn't return the new thread");
      return api.resume(id);
    },
    /** Leaves the current thread; the next prompt starts a new one. */
    newThread() {
      detach();
      resetThreadState();
      change("thread");
    },
    /**
     * Leaves the thread and has Codex unload it (thread/unsubscribe, then
     * thread/closed), so another program can take it over: the stock UI on
     * the same thread (/codex) must not share a live runtime with ad's engine.
     * → true once Codex closed it (or never had it loaded), false on timeout.
     */
    async release(threadId, { timeoutMs = 15_000 } = {}) {
      if (state.thread?.id === threadId) api.newThread();
      let off = null;
      let timer = null;
      const closed = new Promise((resolve) => {
        off = eng.subscribe(threadId, (ev) => ev.type === "thread.closed" && resolve(true));
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      try {
        const r = await eng.server.request("thread/unsubscribe", { threadId });
        return r?.status === "notLoaded" ? true : await closed;
      } catch {
        return false;
      } finally {
        off?.();
        clearTimeout(timer);
      }
    },
    /** Continues an earlier thread, with its history loaded. */
    async resume(threadId) {
      if (closed) throw new Error("session closed");
      if (threadId === state.thread?.id) return threadId;
      // Locked first: a thread another ad holds is never resumed here.
      const release = lockThread(threadId, { dir: lockDir });
      detach();
      resetThreadState();
      const e = epoch;
      let t;
      try {
        t = await eng.resumeThread(threadId, { cwd, sandbox: state.config.sandbox, approvalPolicy: state.config.approvalPolicy, excludeTurns: true });
        if (stale(e)) throw new Error("the session moved on before the thread resumed");
      } catch (err) {
        release();
        throw err;
      }
      state.config.model = t.model ?? state.config.model;
      releaseLock = release;
      state.thread = { ...(t.thread ?? {}), id: t.threadId };
      unsubThread = eng.subscribe(t.threadId, onThreadEvent);
      await loadTurns(t.threadId, e);
      change("thread");
      return t.threadId;
    },
    close() {
      if (closed) return;
      closed = true;
      detach("closed");
      state.queue = [];
      unwire();
      for (const [, list] of doneWaiters) for (const r of list) r({ status: "closed" });
      doneWaiters.clear();
      emitter.removeAllListeners();
    },
  };

  wire();
  return api;
}

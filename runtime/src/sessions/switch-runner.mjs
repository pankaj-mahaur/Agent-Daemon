// Runs a switch (P4.2): sessions/switch.mjs decides, this does. One per window.
//
//   createSwitchRunner({ session, ledger, prepare, current, checkpoint, git, notify, ask, timeouts })
//     → { request(target, { mode, reason, fallback }), answer(choice), onEvent(ev), how(target), state(), lastOutcome() }
//
// session: the harness session (retarget, adoptThread, useEngine, hold, interrupt, resolve,
// state). ledger: the window's coordinator (record, unknownNonRead, rebind, markAdTurn).
// prepare(target, how) → { engine, release, restart, sameEngine } for the target, or throws
// an error with .reason ("signIn" | "model" | "engine"). current() → the window's target now
// ({ modelProvider, homeKey, provider, model, effort, passthrough, label, key }).
// checkpoint() → { ref, diffStat } | null; git() → { branch, files, added, deleted } | null.
// notify(level, text, { line }) shows a notice; ask(text, choices) a choice ("anyway" | "cancel").
// onEvent(ev): the session's observer events (compose it with the ledger's observer).
//
// The fork and same-account paths are the session's retarget (P3.4's one safe-switch
// routine); the continuation path starts a thread on the target, seeds it with the
// capsule, recreates the goal paused, moves the window there and lets the old thread go.

import { buildCapsule, buildNote } from "./capsule.mjs";
import { safePoint, step, switchHow } from "./switch.mjs";
import { letGo } from "../engine/switch.mjs";
import { assertRetargeted } from "../engine/retarget.mjs";

export const CONTINUE_TEXT = "Continue where you left off.";

const isActive = (thread) => thread?.status?.type === "active";
const DEFAULT_TIMEOUTS = { quiesceMs: 30_000, subagentMs: 60_000, pollMs: 250, slowPollMs: 1000, quietMs: 5000 };

export function createSwitchRunner({ session, ledger, prepare, current = () => ({}), checkpoint = async () => null, git = async () => null, notify = () => {}, ask = () => {}, timeouts = {}, now = Date.now } = {}) {
  const T = { ...DEFAULT_TIMEOUTS, ...timeouts };
  let s = { state: "RUNNING" };
  let ctx = null; // this switch's working data
  let outcome = null; // the last request's end: { kind: "committed"|"aborted", reason } (the fallback controller reads it)
  const outcomeWaiters = []; // whenOutcome() callers: a switch ends later than its request's effects
  let work = Promise.resolve();
  let timer = null;
  let goalResume = null; // { engine, threadId, objective } once the first turn there completes
  const olds = []; // old threads still watched (their terminals run): { watch, release }
  let inFlight = 0;
  let queued = 0; // requests waiting for the last switch's effects
  const eng = () => session.engine;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  function dispatch(ev) {
    const r = step(s, ev);
    s = r.state;
    if (s.state === "RUNNING") clearTimer();
    // Never awaited from inside an effect: the effect is part of the chain it would wait on.
    for (const e of r.effects) {
      // The last request's ledger end (committed or aborted), known the moment it is written.
      if (e.type === "ledger") {
        if (e.event?.type === "switchCommitted") outcome = { kind: "committed", reason: e.event.reason ?? null };
        else if (e.event?.type === "switchAborted") outcome = { kind: "aborted", reason: e.event.reason ?? null };
        if (outcome) for (const w of outcomeWaiters.splice(0)) w(outcome);
      }
      // Holding starts at once: a prompt sent right after the request must already wait.
      if (e.type === "hold" && e.on) {
        session.hold(true);
        continue;
      }
      inFlight++;
      work = work
        .then(() => run(e))
        .catch((err) => failWith(err))
        .finally(() => inFlight--);
    }
  }

  function failWith(err) {
    const reason = err?.code === "RETARGET_IGNORED" ? "kept" : err?.reason ?? "failed";
    if (err && !err.reason && err.code !== "RETARGET_IGNORED") notify("warn", `Switch: ${err.message ?? err}`, { detail: String(err?.stack ?? err) });
    if (s.state !== "RUNNING") dispatch({ type: "fail", reason });
  }

  async function facts() {
    const st = session.state;
    const tid = st.thread?.id ?? null;
    const goal = tid ? await eng().threads.goal.get(tid).catch(() => null) : null;
    const read = tid ? await eng().threads.read(tid).catch(() => null) : null;
    return {
      activeTurnId: st.activeTurnId,
      starting: st.starting,
      threadStarting: false,
      goal: goal?.status ?? null,
      requests: st.requests.length,
      foregroundTools: 0, // a running turn covers them (activeTurnId)
      subagents: [...(st.agents?.values?.() ?? [])].filter((a) => a.running).length,
      unknownNonRead: ledger?.unknownNonRead?.() ?? [],
      idle: tid ? !isActive(read) : true,
      terminals: st.terminals?.size ?? 0,
    };
  }

  async function checkSafe() {
    if (s.state !== "QUIESCING") return;
    const f = await facts();
    if (f.subagents && !ctx.subagentSince) ctx.subagentSince = now();
    if (!f.subagents) ctx.subagentSince = null;
    const check = safePoint(f, { mode: s.mode, anyway: s.anyway, subagentWaitOver: Boolean(ctx.subagentSince && now() - ctx.subagentSince >= T.subagentMs) });
    dispatch({ type: "safe", check });
    if (s.state === "QUIESCING" && check.wait) {
      // Waiting: look again soon; give up (to the user) after the quiesce time.
      clearTimer();
      if (s.mode === "now" && now() - ctx.since >= T.quiesceMs) return void dispatch({ type: "timeout" });
      // Now: stop the turn again (also one starting, or one the engine started meanwhile).
      if (s.mode === "now" && check.wait === "turn" && (session.state.activeTurnId || session.state.starting)) await session.interrupt().catch(() => {});
      // A turn's end checks again; the slow look covers a turn that never came (a failed start).
      timer = setTimeout(() => dispatch({ type: "recheck" }), check.wait === "turn" && s.mode === "wait" ? T.slowPollMs : T.pollMs);
      timer.unref?.();
    }
  }

  async function pauseGoal() {
    const tid = session.state.thread?.id;
    if (!tid) return;
    const g = await eng().threads.goal.get(tid).catch(() => null);
    const pending = goalResume?.threadId === tid; // paused by the last switch, not yet back
    if (pending) {
      ctx.tookResume = goalResume;
      goalResume = null;
    }
    ctx.goal ??= g ? { threadId: tid, objective: g.objective, status: g.status, tokenBudget: g.tokenBudget ?? null, wasActive: g.status === "active" || pending } : null;
    if (g?.status === "active") await eng().threads.goal.set(tid, g.objective, { status: "paused" });
  }

  // Terminals left by an earlier switch that still run on this engine.
  const priorOn = (engine) => (session.state.priorTerminals ?? []).some((p) => p.engine === engine);

  // A turn the engine started on the old thread after the safe point: stopped before the move.
  async function quietOld() {
    const end = now() + T.quietMs;
    while (session.state.activeTurnId || session.state.starting) {
      await session.interrupt().catch(() => {});
      if (now() > end) throw Object.assign(new Error("the old conversation kept starting turns"), { reason: "selfStarting" });
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function bind(how) {
    const st = session.state;
    const target = ctx.target;
    const sessionTarget = { modelProvider: target.modelProvider ?? null, homeKey: target.homeKey ?? null, provider: target.provider ?? null, model: target.model, ...(target.effort !== undefined ? { effort: target.effort } : {}), passthrough: target.passthrough };
    await quietOld();
    if (how === "nextTurn") {
      await session.retarget(sessionTarget);
      ledger?.rebind?.("nextTurn");
      return void dispatch({ type: "bound", threadId: st.thread?.id ?? null });
    }
    if (how === "fork") {
      const note = buildNote(await noteInput());
      const r = await session.retarget(sessionTarget);
      if (r.kind !== "continues" || !r.threadId) throw Object.assign(new Error("the fork didn't happen"), { reason: "failed" });
      // The fork keeps its history; it still learns what runs and where it stands.
      await eng().threads.inject(r.threadId, [note]).catch(() => {});
      return void dispatch({ type: "bound", threadId: r.threadId });
    }
    // continuation
    const prepared = ctx.prepared ?? {};
    const to = prepared.sameEngine === false ? prepared.engine : eng();
    const from = eng();
    const oldId = st.thread?.id ?? null;
    const oldTerminals = [...(st.terminals?.values?.() ?? [])].map((x) => x.itemId).filter(Boolean);
    const started = await to.startThread({ cwd: st.config.cwd, model: target.model, modelProvider: target.modelProvider, sandbox: st.config.sandbox, approvalPolicy: st.config.approvalPolicy });
    let moved = false;
    try {
      assertRetargeted(started, { modelProvider: target.modelProvider, ...(target.model ? { model: target.model } : {}) });
      if (!target.model && started.model) sessionTarget.model = started.model;
      const cap = buildCapsule({ ...(await noteInput()), turns: turnsOf(st), budgetChars: target.contextWindow ? 2 * target.contextWindow : undefined });
      await to.threads.inject(started.threadId, cap.items);
      // The goal, paused in one call: it becomes active only after the first turn there.
      const goalInPlay = ctx.goal && (ctx.goal.wasActive || ctx.goal.status === "paused");
      if (goalInPlay) await to.threads.goal.set(started.threadId, ctx.goal.objective, { status: "paused", ...(ctx.goal.tokenBudget != null ? { tokenBudget: ctx.goal.tokenBudget } : {}) });
      // Once more right before the move: the engine may have started one while the thread was seeded.
      await quietOld();
      if (prepared.sameEngine === false) {
        const r = await session.useEngine({ engine: prepared.engine, release: prepared.release, restart: prepared.restart }, sessionTarget, { threadId: started.threadId, thread: started.thread, keepOld: oldTerminals.length > 0 || priorOn(from) });
        ctx.releaseOld = r.releaseOld ?? null;
      } else session.adoptThread(started.threadId, started.thread, sessionTarget, "continuation");
      moved = true;
      ctx.moved = true;
      // Off the old thread, so a goal is never on two.
      if (goalInPlay && oldId) await from.threads.goal.clear(oldId).catch(() => {});
      const releaseOld = ctx.releaseOld;
      const entry = { watch: null };
      if (oldId) {
        ctx.watch = await letGo({
          engine: from,
          threadId: oldId,
          terminals: () => oldTerminals,
          onItemDone: (id) => session.priorTerminalDone?.(id),
          // The watch's end lets the old engine go (its terminals ended, or the thread closed).
          onDone: () => {
            const i = olds.indexOf(entry);
            if (i >= 0) olds.splice(i, 1);
            void releaseOld?.().catch(() => {});
          },
          onViolation: (v) => {
            ledger?.record?.({ type: "violation", gen: ledger?.status?.()?.gen ?? null, threadId: v.threadId, turnId: v.turnId });
            notify("warn", "The previous conversation started a turn by itself after the switch; ad stopped it.");
          },
        }).catch(() => null);
      }
      // The old engine stays leased while its terminals run (the watch); else it goes now.
      if (ctx.watch?.watching) olds.push(Object.assign(entry, { watch: ctx.watch }));
      // Terminals from an earlier fork still run on the old engine: it stays until the window closes.
      else if (releaseOld && priorOn(from)) olds.push({ watch: { stop: () => releaseOld() } });
      else if (releaseOld) await releaseOld().catch(() => {});
      return void dispatch({ type: "bound", threadId: started.threadId, turns: cap.meta.turns, leftOut: cap.meta.leftOut });
    } catch (err) {
      if (!moved) {
        // Nothing moved: the seeded thread goes (it would show as a stray conversation).
        await to.threads.unsubscribe(started.threadId).catch(() => {});
        await to.threads.archive?.(started.threadId).catch(() => {});
        // The prepared engine goes with the abort (releaseTarget), once.
      }
      throw err;
    }
  }

  function turnsOf(st) {
    return st.turns.map((t) => ({ id: t.id, status: t.status, items: (t.itemIds ?? []).map((id) => st.items.get(id)).filter(Boolean) }));
  }

  async function noteInput() {
    const st = session.state;
    const terminals = [...(st.terminals?.values?.() ?? []), ...(st.priorTerminals ?? [])].map((x) => ({ command: x.command, itemId: x.itemId, startedAt: x.startedAt ?? null }));
    return {
      from: ctx.from,
      cwd: st.config.cwd,
      git: ctx.git ?? (await git().catch(() => null)),
      checkpoint: ctx.checkpoint?.ref ?? null,
      permissions: { sandbox: st.config.sandbox, approvalPolicy: st.config.approvalPolicy },
      goal: ctx.goal ? { objective: ctx.goal.objective } : null,
      terminals,
      turns: turnsOf(st),
    };
  }

  async function run(e) {
    switch (e.type) {
      case "ledger":
        return ledger?.record?.(e.event);
      case "hold":
        return session.hold(e.on);
      case "pauseGoal":
        await pauseGoal();
        return;
      case "interrupt":
        if (session.state.activeTurnId) await session.interrupt().catch(() => {});
        return;
      case "checkSafe":
        return checkSafe();
      case "declineRequests":
        for (const r of [...session.state.requests]) session.resolve(r.request.id, null);
        return;
      case "checkpoint": {
        ctx.checkpoint = await checkpoint().catch(() => null);
        ctx.git = await git().catch(() => null);
        return ledger?.record?.({ type: "checkpoint", ref: ctx.checkpoint?.ref ?? null, diffStat: ctx.checkpoint?.diffStat ?? null });
      }
      case "prepareTarget":
        try {
          if (s.how !== "continuation") ctx.prepared = { sameEngine: true };
          else ctx.prepared ??= await prepare(ctx.target, s.how);
        } catch (err) {
          return void dispatch({ type: "fail", reason: err?.reason ?? "engine" });
        }
        return void dispatch({ type: "targetReady" });
      case "confirmIdle": {
        const tid = session.state.thread?.id;
        const read = tid ? await eng().threads.read(tid).catch(() => null) : null;
        if (session.state.activeTurnId || isActive(read)) return void dispatch({ type: "turnStarted" });
        return void dispatch({ type: "idleConfirmed" });
      }
      case "bind":
        return bind(e.how);
      case "commit": {
        session.markSwitched?.(ctx?.target?.label ?? "another account");
        // The goal comes back after the first completed turn there (never at once: it would start one).
        if (ctx.goal?.wasActive) goalResume = { engine: eng(), threadId: e.threadId, objective: ctx.goal.objective };
        // A policy switch (P4.5 B1) hands the conversation over as ad's: the continuation queues first.
        if (ctx.fallback?.continuation) {
          ledger?.markAdTurn?.();
          session.queue(ctx.fallback.continuation, { first: true, via: "ad" });
        }
        // Stopped mid-turn: ad continues the work there, unless prompts already wait.
        else if (e.mode === "now" && ctx.wasRunning && !session.state.queue.length) {
          ledger?.markAdTurn?.();
          session.queue(CONTINUE_TEXT);
        }
        // The fallback's goal objective (P4.5 B1): after the first completed turn it becomes active.
        if (ctx.fallback?.resumeGoal && !goalResume) goalResume = { engine: eng(), threadId: e.threadId, objective: ctx.fallback.resumeGoal };
        ctx = null;
        return;
      }
      case "releaseTarget":
        if (ctx?.prepared?.sameEngine === false && !ctx.moved) await ctx.prepared.release?.().catch(() => {});
        return;
      case "resumeGoal": {
        const g = ctx?.goal;
        // Still waiting for its first turn there (an earlier switch): it keeps waiting.
        if (ctx?.tookResume) goalResume = ctx.tookResume;
        else if (g?.wasActive && g.threadId === session.state.thread?.id) await eng().threads.goal.set(g.threadId, g.objective, { status: "active" }).catch(() => {});
        ctx = null;
        return;
      }
      case "notice":
        return notify(e.level ?? "info", e.text, { line: Boolean(e.line) });
      case "ask":
        return ask(e.text, e.choices);
      default:
    }
  }

  const api = {
    how(target) {
      const st = session.state;
      return switchHow({ from: current(), to: target, goal: Boolean(st.goal), canDefer: Boolean(eng()?.features?.deferGoal?.available) });
    },
    request(target, { mode = "wait", reason = "user", fallback = null } = {}) {
      outcome = null; // also for a request queued behind the last switch: never that switch's end
      if (s.state === "RUNNING" && inFlight > 0) {
        // The last switch's effects run first; prompts already wait.
        session.hold(true);
        queued++;
        work = work.then(() => {
          queued--;
          void api.request(target, { mode, reason, fallback });
        });
        return work;
      }
      if (s.state !== "RUNNING") {
        dispatch({ type: "request", target, mode, how: null });
        return work;
      }
      const how = api.how(target);
      ctx = { target, from: current(), since: now(), wasRunning: Boolean(session.state.activeTurnId), fallback };
      outcome = null;
      dispatch({ type: "request", target, from: ctx.from, mode, how, reason, line: fallback?.line ?? null });
      return work;
    },
    /** How the last request ended (P4.5 B1): { kind: "committed"|"aborted", reason } or null. */
    lastOutcome: () => outcome,
    /** Resolves when the last request commits or aborts (settled() only covers the effects queued so far). */
    whenOutcome: () => (outcome ? Promise.resolve(outcome) : new Promise((resolve) => outcomeWaiters.push(resolve))),
    answer(choice) {
      dispatch({ type: choice === "anyway" ? "anyway" : "cancel" });
      return work;
    },
    /** A pending switch, given up (the user's Cancel). */
    cancel() {
      if (s.state !== "RUNNING") dispatch({ type: "cancel" });
      return work;
    },
    pending: () => s.state !== "RUNNING" || queued > 0,
    /** The switch is binding the new thread: it can't be cancelled any more. */
    finishing: () => s.state === "BINDING_STARTED",
    onEvent(ev) {
      if (!ev) return;
      const tid = session.state.thread?.id;
      if (ev.type === "turn.completed" && ev.threadId === tid) {
        if (goalResume && goalResume.threadId === tid) {
          const g = goalResume;
          goalResume = null;
          g.engine.threads.goal.set(g.threadId, g.objective, { status: "active" }).then(() => ledger?.record?.({ type: "goalResumed", threadId: g.threadId }), () => {});
        }
        if (s.state === "QUIESCING") dispatch({ type: "turnCompleted" });
      }
      if (ev.type === "turn.started" && ev.threadId === tid && ["SAFE_POINT", "TARGET_READY"].includes(s.state)) dispatch({ type: "turnStarted" });
      if (ev.type === "turn.startFailed" && s.state === "QUIESCING") dispatch({ type: "recheck" });
      if (ev.type === "thread.goal" && s.state === "QUIESCING") dispatch({ type: "goalPaused" });
    },
    state: () => ({ ...s }),
    /** Settles the work queued so far (tests). */
    settled: () => work,
    async dispose() {
      clearTimer();
      // Each watch's end releases its engine (letGo's onDone).
      for (const o of [...olds]) await o.watch.stop?.()?.catch?.(() => {});
    },
  };
  return api;
}

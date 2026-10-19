// The safe switch (P3.4, 03 §I): move a conversation to another account of the same
// provider by forking it, never by resuming a loaded thread with a new provider (the
// engine keeps the old one and answers success, S-THREADCFG Q5). Reused by P4.2/P4.5/P4.7.
//
//   switchThread({ engine, threadId, target: { modelProvider, model }, terminals, onViolation })
//     → { threadId: newId, goalMoved, watching, stop() }
//
// 1. A goal that is active is refused unless the engine can fork with
//    deferGoalContinuation (experimental), then paused before anything else.
// 2–3. A running turn is interrupted (callers switch at idle; this is a guard) and the
//    thread confirmed idle with thread/read.
// 4. Fork with the target; the answer must name it (else RETARGET_IGNORED: the fork is
//    archived). Any failure up to here puts a goal ad paused back to active.
// 5. The goal moves: cleared on the old thread, then set on the fork, an active one as
//    paused (it becomes active only after the fork's first turn completes, P4.2), any
//    other status kept.
// 6. The old thread is unsubscribed (it unloads at once with thread_unload_delay_secs=0),
//    unless background terminals still run in it: unloading would end them. Then it
//    stays subscribed and watched; a turn the engine starts on it is interrupted and
//    reported, and once its last terminal ends (or the thread closes, or the engine
//    exits) the watch ends and it is unsubscribed. No step waits on thread/closed.

import { engineError } from "./codex/errors.mjs";

export const SWITCH_TEXTS = Object.freeze({
  GOAL_ACTIVE: "Pause the goal first (/goal pause), then switch.",
  NOT_IDLE: "The conversation is still busy. Wait for the turn to finish (or Esc), then switch.",
  VIOLATION: "The engine started a turn in the old conversation after the switch; ad stopped it.",
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const isActive = (thread) => thread?.status?.type === "active";

async function settleIdle(engine, threadId, { timeoutMs }) {
  let thread = await engine.threads.read(threadId);
  if (!isActive(thread)) return;
  const full = await engine.threads.read(threadId, { includeTurns: true });
  for (const t of full?.turns ?? []) if (t.status === "inProgress") await engine.turns.interrupt(threadId, t.id).catch(() => {});
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    thread = await engine.threads.read(threadId);
    if (!isActive(thread)) return;
    await wait(50);
  }
  throw engineError("SWITCH_NOT_IDLE", SWITCH_TEXTS.NOT_IDLE);
}

/**
 * @param {{ engine: any, threadId: string, target: { modelProvider?: string, model?: string },
 *   terminals?: (threadId: string) => string[], onViolation?: (v: { threadId: string, turnId: string, text: string }) => void,
 *   idleTimeoutMs?: number }} o
 *   terminals: the item ids of background terminals still running in the thread (the
 *   session's own tracking: the engine's thread data has no terminal field)
 */
export async function switchThread({ engine, threadId, target = {}, terminals = () => [], onViolation = () => {}, idleTimeoutMs = 10_000 }) {
  const want = {};
  if (target.modelProvider !== undefined) want.modelProvider = target.modelProvider;
  if (target.model !== undefined) want.model = target.model;
  const canDefer = Boolean(engine.features?.deferGoal?.available);

  // 1. The goal: refuse before changing anything; then pause it.
  const goal = await engine.threads.goal.get(threadId);
  const wasActive = goal?.status === "active";
  if (wasActive && !canDefer) throw engineError("SWITCH_GOAL_ACTIVE", SWITCH_TEXTS.GOAL_ACTIVE);
  if (wasActive) await engine.threads.goal.set(threadId, goal.objective, { status: "paused" });

  // 2–4. Idle, then fork with the target (the façade checks the answer).
  let newId;
  try {
    await settleIdle(engine, threadId, { timeoutMs: idleTimeoutMs });
    const forked = await engine.threads.fork(threadId, { ...want, ...(goal && canDefer ? { deferGoalContinuation: true } : {}) });
    newId = forked?.thread?.id;
  } catch (err) {
    // The fork kept the old account: drop it (it would show as a duplicate conversation).
    if (err?.forkedThreadId) {
      await engine.threads.goal.clear(err.forkedThreadId).catch(() => {});
      await engine.threads.unsubscribe(err.forkedThreadId).catch(() => {});
      await engine.threads.archive(err.forkedThreadId).catch(() => {});
    }
    // Nothing moved: the conversation and its goal stay as they were.
    if (wasActive) await engine.threads.goal.set(threadId, goal.objective, { status: "active" }).catch(() => {});
    throw err;
  }

  // 5. Move the goal: off the old thread first, so it is never on two.
  let goalMoved = false;
  if (goal) {
    await engine.threads.goal.clear(threadId);
    await engine.threads.goal.set(newId, goal.objective, { status: wasActive ? "paused" : goal.status, ...(goal.tokenBudget != null ? { tokenBudget: goal.tokenBudget } : {}) });
    goalMoved = true;
  }

  // 6. The old thread.
  const live = new Set(terminals(threadId) ?? []);
  if (!live.size) {
    await engine.threads.unsubscribe(threadId);
    return { threadId: newId, goalMoved, watching: false, stop: async () => {} };
  }
  let offEvents = null;
  const onExit = () => done(false);
  const done = async (unsubscribe = true) => {
    if (!offEvents) return;
    offEvents();
    offEvents = null;
    engine.off?.("exit", onExit);
    if (unsubscribe) await engine.threads.unsubscribe(threadId).catch(() => {});
  };
  offEvents = engine.subscribe(threadId, (ev) => {
    if (ev.threadId && ev.threadId !== threadId) return; // a subagent's events
    if (ev.type === "turn.started" && ev.turnId) {
      engine.turns.interrupt(threadId, ev.turnId).catch(() => {});
      try {
        onViolation({ threadId, turnId: ev.turnId, text: SWITCH_TEXTS.VIOLATION });
      } catch {
        // the observer's failure is its own
      }
      return;
    }
    if (ev.type === "thread.closed") return done(false);
    if (ev.type === "item.completed" && live.delete(ev.itemId) && !live.size) done();
  });
  engine.once?.("exit", onExit);
  return { threadId: newId, goalMoved, watching: true, stop: () => done() };
}

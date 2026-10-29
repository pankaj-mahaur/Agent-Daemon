// Automatic fallback at turn boundaries (P4.5 B1): feeds sessions/fallback.mjs with the session's
// events and acts on its answers. A failed turn the policy covers holds the queue, then switches
// to the next target in the user's order (the switch runner), or pauses with the reason. A turn
// that keeps retrying is interrupted at the end of the budget, the goal paused first.
//
//   createFallbackController(deps) → { onEvent(ev), turnCompleted({ turn, status }), tick(), resume(), retry(),
//                                      handled(turnId), state(), settled(), dispose() }
//
// Every exit of a triggered turn either switches or pauses; a pause keeps the session held until
// resume() (B2 wires /retry, a manual switch and the user's own prompt to it).

import { benchedUntil, benchKey, limitState } from "../providers/quota.mjs";
import { nextTarget } from "../routing/next-target.mjs";
import { targetInfo, targetKey } from "../routing/policy.mjs";
import { reasonText } from "../routing/preview.mjs";
import { afterRetry, afterSwitch, beforeDispatch, boundaryCheck, budgetLeft, causeText, detect, episodeFromEvents, episodeOver, fallbackGate, FALLBACK_RUN_TEXTS, retryDecision, runInterrupt, startEpisode, SUBAGENT_WAIT_MS, switchesLastHour, watchdogStart, watchdogStep } from "./fallback.mjs";
import { providerDisplay } from "../auth/accounts/target.mjs";

const LIMITS = new Set(["rateLimit", "quotaExhausted"]);
const GOAL_PAUSE_MS = 5000;
const WAIT_POLL_MS = 250;
const SWITCH_WAIT_MS = 120_000; // a switch that neither commits nor aborts by then: pause, never hang

export function createFallbackController({
  session,
  ledger,
  runner,
  policy,
  routing,
  current,
  toSwitchTarget,
  classify,
  retryObservation = () => null,
  bench = async () => {},
  events = () => [],
  notify = () => {},
  env = process.env,
  windowOn = () => true,
  now = Date.now,
  tickMs = 1000,
  setInterval: si = setInterval,
  clearInterval: ci = clearInterval,
  newEpisodeId = () => `ep_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  limit = (accountId, ctx) => limitState(accountId, { now: ctx.now, root: ctx.root }),
  benched = (key, ctx) => benchedUntil(key, { now: ctx.now, root: ctx.root }),
} = {}) {
  let watch = null; // part A's watchdog over the running root turn
  let ticker = null;
  const interrupts = new Map(); // turnId → { turnId, cause }: ad's own interrupts
  const sessionLimited = new Map(); // benchKey → untilMs
  let goalBefore = null; // the goal objective when the root turn started, if it was active
  let chosenBy = "user";
  let paused = null; // { code, text }
  const startedAt = new Map(); // turnId → when it started (classification's window)
  const handled = new Set(); // turns fallback acted on: the TUI shows ad's line, not the engine's
  let switches = 0; // automatic switches in this window (/status)
  let lastSwitch = null; // { at, why }
  let noticeFor = null; // the bench a manual pick's notice was shown for (once per bench)
  let disposed = false;
  const timers = new Set();
  let work = Promise.resolve();

  let episode = null;
  try {
    episode = episodeFromEvents(events());
  } catch {
    episode = null; // an unreadable ledger never invents an episode
  }
  if (episode?.paused) {
    paused = { code: episode.paused, text: null };
    session.hold(true);
  }

  const tid = () => session.state.thread?.id ?? null;
  const gate = () => fallbackGate({ policy: policy(), ...routing(), env, windowOn: windowOn() });
  const routeOf = (t) => ({ account: t.account.id, model: t.model ?? null, ...(t.effort ? { effort: t.effort } : {}) });
  const wait = (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(() => {
        timers.delete(t);
        resolve();
      }, ms);
      timers.add(t);
    });
  const stopTicker = () => {
    if (ticker) ci(ticker);
    ticker = null;
  };
  const toolsRunning = () => (watch ? (ledger.toolsOfRoot?.(watch.turnId) ?? []).some((t) => t.status === "running" && !t.background) : false);

  async function pauseGoal() {
    const id = tid();
    if (!id) return;
    const goal = session.engine.threads.goal;
    let timer;
    const cap = new Promise((resolve) => (timer = setTimeout(resolve, GOAL_PAUSE_MS)));
    try {
      await Promise.race([
        (async () => {
          const g = await goal.get(id).catch(() => null);
          if (g?.status !== "active") return;
          await goal.set(id, g.objective, { status: "paused" });
          ledger.record?.({ type: "goalPaused", threadId: id, by: "fallback" });
        })(),
        cap,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function doInterrupt(cause) {
    const turnId = watch?.turnId;
    if (!turnId) return;
    work = work
      .then(() =>
        runInterrupt({
          turnId,
          cause,
          toolsInProgress: toolsRunning,
          pauseGoal,
          record: (e) => {
            interrupts.set(e.turnId, e);
            ledger.record?.(e);
          },
          interrupt: () => session.interrupt(),
        }),
      )
      .catch(() => {});
  }

  function step(ev) {
    if (!watch) return;
    const r = watchdogStep(watch, ev, { budgetMs: policy().recoveryBudgetMs, toolsInProgress: toolsRunning() });
    watch = r.st;
    if (r.interrupt) doInterrupt(r.interrupt.cause);
  }

  function tick() {
    if (disposed || !watch) return;
    step({ type: "tick", at: now() });
  }

  function onEvent(ev) {
    if (disposed || !ev) return;
    const id = tid();
    if (ev.type === "turn.started" && ev.threadId === id) {
      watch = watchdogStart({ turnId: ev.turnId, at: now() });
      startedAt.set(ev.turnId, now());
      // The goal as the engine has it when the turn starts: resumed on the target after a switch.
      const turnId = ev.turnId;
      goalBefore = session.state.goal?.status === "active" ? (session.state.goal.objective ?? null) : null;
      void session.engine?.threads?.goal
        ?.get(id)
        .then((g) => {
          if (watch?.turnId === turnId) goalBefore = g?.status === "active" ? (g.objective ?? null) : goalBefore;
        })
        .catch(() => {});
      stopTicker();
      if (gate().on) {
        ticker = si(tick, tickMs);
        ticker?.unref?.();
      }
      return;
    }
    if (!watch || ev.turnId !== watch.turnId) return;
    if (ev.type === "turn.completed") {
      step({ type: "end" });
      stopTicker();
      watch = null;
      return;
    }
    if (ev.type === "notice" && ev.code === "turn.retrying") return step({ type: "notice", at: now(), failure: retryObservation(ev.threadId, startedAt.get(ev.turnId) ?? null) });
    step({ type: "event", at: now() });
  }

  function pause(code, text) {
    paused = { code, text };
    ledger.setState?.("paused", code);
    if (episode) {
      episode = { ...episode, paused: code };
      ledger.record?.({ type: "paused", episodeId: episode.id, reason: code, text });
    }
    notify("warn", FALLBACK_RUN_TEXTS.PAUSED(text), { line: true });
  }

  // The session hook: runs before the session drains its queue, so the hold below comes first.
  function turnCompleted({ turn, status }) {
    if (disposed || !turn) return;
    // A window on an engine home ad didn't make has no account: nothing to fall back from.
    const from = current();
    const began = startedAt.get(turn.id) ?? null;
    startedAt.delete(turn.id);
    if (!from?.account) return;
    const g = gate();
    if (!g.on) {
      if (status === "completed") episode = null;
      return;
    }
    const interrupted = interrupts.get(turn.id) ?? null;
    const failure = classify({ error: turn.error ?? null, status, threadId: tid(), turnId: turn.id, startedAt: began, fallbackInterrupt: interrupted });
    const p = policy();
    const d = detect({ turn: { id: turn.id, status }, failure, interrupted, policy: p });
    if (!d.trigger) {
      if (status === "completed") {
        episode = null;
        paused = null;
      }
      return;
    }
    session.hold(true);
    handled.add(turn.id);
    if (!episode) episode = startEpisode({ id: newEpisodeId(), from: routeOf(from), at: now() });
    ledger.record?.({ type: "routeFailure", episode: { id: episode.id, startedAt: episode.startedAt, from: episode.from }, turnId: turn.id, failure });
    if (LIMITS.has(failure.class) && from.account) {
      const until = Date.parse(failure.resetsAt ?? "");
      sessionLimited.set(benchKey(from.account.provider, from.account.id), Number.isFinite(until) ? until : Infinity);
      void Promise.resolve(bench({ provider: from.account.provider, accountId: from.account.id, until: failure.resetsAt ?? null, reason: failure.class })).catch(() => {});
    }
    work = work.then(() => proceed(failure, from, turn.id, p)).catch((err) => pause("failed", `ad couldn't continue (${err?.message ?? err})`));
  }

  // mode "turn": a failed turn (ad's continuation follows the switch); "prompt": before the
  // user's prompt starts on a target that ran out (the prompt itself follows the switch).
  async function proceed(failure, from, turnId, p, mode = "turn") {
    if (disposed) return;
    const why = causeText(failure, from.account?.provider);
    // 1. A short, known Retry-After on the same target.
    const retry = mode === "prompt" ? null : retryDecision(episode, { failure, current: routeOf(from), policy: p, now: now() });
    if (retry) {
      episode = afterRetry(episode, routeOf(from));
      const n = episode.retries[targetKey(routeOf(from))] ?? 1;
      notify("info", FALLBACK_RUN_TEXTS.RETRYING(providerDisplay(from.account.provider), Math.ceil(retry.retryInMs / 1000), n, p.perTargetRetries), { line: true });
      await wait(retry.retryInMs);
      if (disposed) return;
      ledger.markAdTurn?.();
      session.queue(FALLBACK_RUN_TEXTS.CONTINUATION(from.label, why), { first: true, via: "ad" });
      session.hold(false);
      return;
    }
    // 2. The episode's own budget, then the hourly cap.
    const over = episodeOver(episode, p, now());
    if (over) return pause("budget", FALLBACK_RUN_TEXTS.BUDGET(episode.hops, Math.max(1, Math.round((now() - episode.startedAt) / 60_000))));
    let lastHour = 0;
    try {
      lastHour = switchesLastHour(events(), now());
    } catch {
      lastHour = p.maxSwitchesPerHour; // can't count: stop rather than guess
    }
    if (lastHour >= p.maxSwitchesPerHour) return pause("tooOften", FALLBACK_RUN_TEXTS.TOO_OFTEN(lastHour));
    // 3. The boundary: wait for what is still moving, pause on what can't be left behind.
    const root = ledger.lastRootTurnId?.() ?? turnId;
    const deadline = now() + Math.min(SUBAGENT_WAIT_MS, budgetLeft(episode, p, now()));
    for (;;) {
      const st = session.state;
      const b = boundaryCheck({
        tools: ledger.toolsOfRoot?.(root) ?? [],
        terminals: [...(st.terminals?.values?.() ?? [])],
        requests: st.requests?.length ?? 0,
        subagents: [...(st.agents?.values?.() ?? [])].filter((a) => a.running).length,
        allowRunningBackground: p.allowRunningBackground ?? [],
      });
      if (b.pause) return pause(b.pause, b.text);
      if (b.ok) break;
      if (now() >= deadline) return pause(b.wait === "subagent" ? "subagent" : "budget", b.wait === "subagent" ? FALLBACK_RUN_TEXTS.SUBAGENT : FALLBACK_RUN_TEXTS.BUDGET(episode.hops, Math.max(1, Math.round((now() - episode.startedAt) / 60_000))));
      await wait(WAIT_POLL_MS);
      if (disposed) return;
    }
    // 4. The next target in the user's order.
    const ctx = routing();
    const r = nextTarget(p, { from: routeOf(from), failure: failure.class, tried: episode.tried, hops: episode.hops, switchesLastHour: lastHour, sessionLimitedProviders: sessionLimited }, ctx);
    if (r.none) {
      const skipped = (r.skipped ?? [])
        .filter((s) => !s.reasons.includes("tried"))
        .slice(0, 3)
        .map((s) => {
          const info = targetInfo(s.target, ctx);
          return `${info.label}: ${reasonText(s.reasons[0], info, { now: ctx.now, root: ctx.root })}`;
        });
      return pause("noneLeft", FALLBACK_RUN_TEXTS.NONE_LEFT(why, skipped.length ? skipped.join("; ") : "none listed"));
    }
    // 5. Switch: the runner holds, quiesces, binds, queues ad's continuation first, releases.
    const target = await toSwitchTarget(r.target);
    if (!target) return pause("noneLeft", FALLBACK_RUN_TEXTS.NONE_LEFT(why, "none listed"));
    await runner.request(target, {
      mode: "wait",
      reason: "policy",
      fallback:
        mode === "prompt"
          ? { line: FALLBACK_RUN_TEXTS.USING_FOR_PROMPT(target.label, why), continuation: null, resumeGoal: null }
          : { line: FALLBACK_RUN_TEXTS.SWITCHED(target.label, why, episode.hops + 1, p.maxHops), continuation: FALLBACK_RUN_TEXTS.CONTINUATION(from.label, why), resumeGoal: goalBefore },
    });
    // The switch ends later than the request's first effects: wait for its commit or abort.
    const outcome = await Promise.race([runner.whenOutcome(), wait(SWITCH_WAIT_MS).then(() => null)]);
    if (disposed) return;
    if (outcome?.kind === "committed") {
      episode = afterSwitch(episode, r.target);
      chosenBy = "fallback";
      switches += 1;
      lastSwitch = { at: now(), why };
      return;
    }
    // The runner said why (its own notice); keep the queue held for the user.
    session.hold(true);
    return pause("switchFailed", `the switch to ${target.label} didn't work (details above)`);
  }

  /**
   * A prompt is about to start (the TUI asks first). Switch before it when the current target
   * itself ran out, or fallback chose it and its provider has been benched since; a target the
   * user picked by hand is kept, with one notice per bench. → { switching: true } | null
   */
  function beforePrompt() {
    if (disposed || paused || runner.pending?.()) return null;
    const from = current();
    if (!from?.account || !gate().on) return null;
    const ctx = routing();
    const key = benchKey(from.account.provider, from.account.id);
    const until = benched(key, ctx);
    const d = beforeDispatch({ current: from, chosenBy, limit: limit(from.account.id, ctx), benchedUntil: until, now: now(), noticeShown: noticeFor === key });
    if (!d) return null;
    if (d.notice) {
      noticeFor = key;
      notify("info", d.notice, { line: true });
      return null;
    }
    session.hold(true);
    const failure = { class: "quotaExhausted", period: null, retryAfterMs: null, resetsAt: Number.isFinite(until) ? new Date(until).toISOString() : null, source: "beforeDispatch", reason: d.why };
    if (!episode) episode = startEpisode({ id: newEpisodeId(), from: routeOf(from), at: now() });
    ledger.record?.({ type: "routeFailure", episode: { id: episode.id, startedAt: episode.startedAt, from: episode.from }, turnId: null, failure });
    sessionLimited.set(key, Number.isFinite(until) ? until : Infinity);
    const p = policy();
    work = work.then(() => proceed(failure, from, null, p, "prompt")).catch((err) => pause("failed", `ad couldn't continue (${err?.message ?? err})`));
    return { switching: true };
  }

  return {
    onEvent,
    turnCompleted,
    beforePrompt,
    tick,
    /** /retry, a manual switch or the user's own prompt: the episode ends and the queue runs. */
    resume() {
      if (paused) ledger.setState?.("open");
      paused = null;
      episode = null;
      session.hold(false);
    },
    /** /retry: a new episode, the current target first (ad's continuation, once). */
    retry() {
      if (!paused) return false;
      const from = current();
      ledger.setState?.("open");
      paused = null;
      episode = null;
      ledger.markAdTurn?.();
      session.queue(FALLBACK_RUN_TEXTS.CONTINUATION(from?.label ?? "this model", "you asked to try again"), { first: true, via: "ad" });
      session.hold(false);
      return true;
    },
    /** Whether fallback acted on this turn (the TUI then shows ad's line, not the engine's). */
    handled: (turnId) => handled.has(turnId),
    state: () => ({ episode, paused, chosenBy, watching: Boolean(watch), switches, lastSwitch }),
    /** Settles the work started so far (tests). */
    settled: () => work,
    dispose() {
      disposed = true;
      stopTicker();
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}

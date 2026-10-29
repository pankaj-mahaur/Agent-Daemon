// Automatic fallback at turn boundaries (P4.5): every decision, as pure functions. The session,
// the switch runner and the TUI call these (P4.5 B); nothing here talks to an engine.
//
//   fallbackGate(...)        may fallback act now at all
//   watchdogStep(...)        while a turn retries: when to interrupt it
//   runInterrupt(...)        the interrupt order: tools, goal pause, record, interrupt
//   detect(...)              a finished turn: does it start or continue an episode
//   episode helpers          start, budget, same-target retry, after a switch, rebuild from the ledger
//   boundaryCheck(...)       may the conversation move now, wait, or must it pause
//   beforeDispatch(...)      a prompt about to start on a target that ran out
//   FALLBACK_RUN_TEXTS       every line the user sees (final words)

import { FALLBACK_ON, keepRunningMatches, targetKey, validatePolicy } from "../routing/policy.mjs";
import { consentState } from "../routing/store.mjs";
import { isReadOnlyCommand } from "./effects.mjs";
import { providerDisplay } from "../auth/accounts/target.mjs";
import { AD_CONTINUATION_PREFIX } from "../hooks/generated-prompts.mjs";

// S-RECOVERY (research/spikes/S-RECOVERY.md): the pinned engine runs an emitted tool once, reports
// it completed and carries its output into its one retry, so a turn whose tools all settled may
// move. An unknown non-read tool still pauses (boundaryCheck's rule 3). false makes every failed
// turn that ran a non-read tool pause instead.
export const SWITCH_AFTER_TOOL_CALLS = true;
export const SUBAGENT_WAIT_MS = 30_000;
export const SILENCE_MS = 90_000; // a WebSocket provider hides its first retry notice
export const SAME_TARGET_RETRY_MAX_MS = 30_000;
const HOUR = 3_600_000;

/** Local hours and minutes, two digits each ("05:30"). */
export function hhmm(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** " (resets 05:30)" for an ISO string or ms, or " (reset time unknown)" for null or garbage. */
export function untilText(resetsAt) {
  const ms = typeof resetsAt === "number" ? resetsAt : Date.parse(resetsAt ?? "");
  return Number.isFinite(ms) ? ` (resets ${hhmm(ms)})` : " (reset time unknown)";
}

/** Why the attempt stopped, in words: the first line of a switch, a pause or a retry notice. */
export function causeText(failure, providerId) {
  const provider = providerDisplay(providerId);
  const until = untilText(failure?.resetsAt);
  switch (failure?.class) {
    case "quotaExhausted":
      return failure.period === "day" ? `${provider}'s daily limit is used up${until}` : `${provider}'s limit is used up${until}`;
    case "rateLimit":
      return `${provider} is rate limiting${until}`;
    case "transientNetwork":
      return `${provider} can't be reached`;
    case "provider5xx":
      return `${provider}'s servers are failing`;
    default:
      return `${provider} stopped the turn`;
  }
}

/**
 * May fallback act now at all (the spec's P4.4 review rule: every automatic decision re-checks
 * the file). The first hit wins, in this order: the env, this window, the order, the consent,
 * the rules. A consented file still has to pass its own rules.
 * @returns {{ on: true } | { on: false, reason: "env"|"window"|"off"|"changed"|"rules", text?: string }}
 */
export function fallbackGate({ policy, accounts = [], catalog = () => null, now = Date.now(), env = process.env, windowOn = true }) {
  if (env.AD_FALLBACK === "0") return { on: false, reason: "env" };
  if (windowOn === false) return { on: false, reason: "window" };
  if (!policy?.enabled) return { on: false, reason: "off" };
  const cs = consentState(policy, accounts);
  if (!cs.ok) {
    if (cs.reason !== "changed") return { on: false, reason: "off" };
    return { on: false, reason: "changed", text: cs.name ? FALLBACK_RUN_TEXTS.CHANGED(cs.name) : FALLBACK_RUN_TEXTS.RULES };
  }
  const { errors } = validatePolicy(policy, { accounts, catalog, now, enabling: true });
  if (errors.length > 0) return { on: false, reason: "rules", text: FALLBACK_RUN_TEXTS.RULES };
  return { on: true };
}

/** The last-resort cause: the wall-clock budget ran out with no classified observation. */
const WATCHDOG_CAUSE = () => ({ class: "transientNetwork", period: null, retryAfterMs: null, resetsAt: null, source: "watchdog", reason: "the provider kept failing" });

/** A watch over one turn, in the state watchdogStep steps on. websocket: the provider hides its first retry notice (start the clock on silence). */
export function watchdogStart({ turnId, at, websocket = false }) {
  return { turnId, clockFrom: null, lastCause: null, lastEventAt: at, websocket, done: false };
}

/**
 * @param st     the state from watchdogStart / a previous step
 * @param ev     { type: "notice", at, failure? }   a retry notice ("Reconnecting…", willRetry);
 *               failure = the gateway's classified observation, or null
 *               { type: "event", at }               any other event of this turn (a delta, an item)
 *               { type: "tick", at }                time passing (the caller ticks every second)
 *               { type: "end" }                     the turn finished
 * @param opts   { budgetMs, toolsInProgress }       toolsInProgress: a tool of the root turn or a
 *               child turn runs
 * @returns { st, interrupt: null | { cause } }      cause is a failure object;
 *               st.waitingForTool: an interrupt is due but waits for tools to end
 */
export function watchdogStep(st, ev, { budgetMs, toolsInProgress = false } = {}) {
  if (st.done) return { st, interrupt: null };
  if (ev.type === "end") return { st: { ...st, done: true }, interrupt: null };
  if (ev.type === "event") return { st: { ...st, lastEventAt: ev.at }, interrupt: null };

  if (ev.type === "notice") {
    // The clock starts at the first retry notice, so the early check has a budget to compare.
    const next = { ...st, clockFrom: st.clockFrom ?? ev.at, lastCause: ev.failure ?? st.lastCause, lastEventAt: ev.at };
    const f = ev.failure;
    const timeLeft = next.clockFrom + budgetMs - ev.at;
    const early = f?.class === "quotaExhausted" || (f?.class === "rateLimit" && f.retryAfterMs > timeLeft);
    // A suppressed interrupt stays due: it fires on the next notice or tick without tools in progress.
    const pending = st.waitingForTool === true && !toolsInProgress;
    if (!early && !pending) return { st: next, interrupt: null };
    if (toolsInProgress) return { st: { ...next, waitingForTool: true }, interrupt: null };
    return { st: { ...next, done: true }, interrupt: { cause: early ? f : next.lastCause ?? WATCHDOG_CAUSE() } };
  }

  // A tick: never interrupt while a tool of the root or a child turn runs.
  let next = { ...st };
  if (next.clockFrom === null && next.websocket && ev.at - next.lastEventAt >= SILENCE_MS && !toolsInProgress) {
    next = { ...next, clockFrom: ev.at };
  }
  // A suppressed interrupt stays due: it fires on the next tick without tools in progress.
  const over = next.clockFrom !== null && ev.at - next.clockFrom >= budgetMs;
  if (!over && next.waitingForTool !== true) return { st: next, interrupt: null };
  if (toolsInProgress) return { st: { ...next, waitingForTool: true }, interrupt: null };
  return { st: { ...next, done: true }, interrupt: { cause: next.lastCause ?? WATCHDOG_CAUSE() } };
}

/**
 * The interrupt order, every time (spec: T3-verify N1). Each step is injected (brief B passes the
 * real ones); tests pass recorders. The goal pause has its own 5 s cap in the caller; a failure
 * there doesn't stop the interrupt — the goal is paused or already stopped either way.
 * @returns {Promise<{ interrupted: true } | { waited: "tool" }>}
 */
export async function runInterrupt({ turnId, cause, toolsInProgress, pauseGoal, record, interrupt }) {
  if (toolsInProgress()) return { waited: "tool" };
  try {
    await pauseGoal();
  } catch {
    // carry on: the interrupt must still happen
  }
  record({ type: "fallbackInterrupt", turnId, cause });
  await interrupt();
  return { interrupted: true };
}

/**
 * A finished turn (P4.5 B classifies it): does it start or continue a fallback episode?
 * An interruption the user made (Esc) is out; ad's own interrupt (the ledger's recorded cause)
 * is in — that's a continuation, not a start.
 * @returns {{ trigger: true, failure } | { trigger: false, why: "completed"|"cancelled"|<class> }}
 */
export function detect({ turn, failure, interrupted = null, policy }) {
  if (turn.status === "completed") return { trigger: false, why: "completed" };
  if (turn.status === "interrupted" && !interrupted) return { trigger: false, why: "cancelled" }; // the user's Esc
  // Only the four runnable-again classes; a hand-written policy.on can't add a class ad can't run.
  const on = (policy.on ?? FALLBACK_ON).filter((c) => FALLBACK_ON.includes(c));
  if (!failure || !on.includes(failure.class)) return { trigger: false, why: failure?.class ?? "unknown" };
  return { trigger: true, failure };
}

/**
 * One run of automatic recovery: it starts at the first eligible failure and ends at a completed
 * turn, a user action or a pause. from is the routing-shaped target that failed.
 * @returns the episode: { id, startedAt: at, from, tried: [that key], hops: 0, retries: {}, paused: null }
 */
export function startEpisode({ id, from, at }) {
  return { id, startedAt: at, from, tried: [targetKey(from)], hops: 0, retries: {}, paused: null };
}

/** Milliseconds of this episode's recovery budget left (never under 0). */
export function budgetLeft(ep, policy, now) {
  return Math.max(0, ep.startedAt + policy.recoveryBudgetMs - now);
}

/**
 * ad's own re-submission on the same target: only for a short, known Retry-After, and only as
 * often as the order's perTargetRetries allows. Otherwise a switch is the point.
 * @returns {{ retryInMs: number } | null}
 */
export function retryDecision(ep, { failure, current, policy, now }) {
  if (failure.class !== "rateLimit") return null;
  if (!Number.isFinite(failure.retryAfterMs)) return null;
  if (failure.retryAfterMs > Math.min(SAME_TARGET_RETRY_MAX_MS, budgetLeft(ep, policy, now))) return null;
  if ((ep.retries[targetKey(current)] ?? 0) >= policy.perTargetRetries) return null;
  return { retryInMs: failure.retryAfterMs };
}

/** The same-target retry is spent: count it for the target the turn sat on. A new episode. */
export function afterRetry(ep, current) {
  const key = targetKey(current);
  return { ...ep, retries: { ...ep.retries, [key]: (ep.retries[key] ?? 0) + 1 } };
}

/**
 * One automatic hop to a routing-shaped target: the target joins tried (never twice) and hops go
 * up. Hops count even when the target returns to an earlier one, so a loop can't run forever.
 * @returns a new episode
 */
export function afterSwitch(ep, target) {
  const key = targetKey(target);
  return ep.tried.includes(key) ? { ...ep, hops: ep.hops + 1 } : { ...ep, hops: ep.hops + 1, tried: [...ep.tried, key] };
}

/** Over? "hops" when the hop cap is reached, else "time" when the budget is spent; else null. */
export function episodeOver(ep, policy, now) {
  if (ep.hops >= policy.maxHops) return "hops";
  if (budgetLeft(ep, policy, now) === 0) return "time";
  return null;
}

/**
 * "<accountId>/<provider>/<model>/<effort>" (the switch key, P4.1) back to a routing target.
 * The model may contain "/"; effort is not routed on. "-" means none; fewer than four parts is
 * garbage and gives null.
 */
export function routeTargetOf(switchKey) {
  const parts = typeof switchKey === "string" ? switchKey.split("/") : null;
  if (!parts || parts.length < 4) return null;
  const model = parts.slice(2, -1).join("/");
  return { account: parts[0], model: model === "-" ? null : model };
}

/**
 * The episode still open at the end of the session's ledger (readLedger, in order), or null. A
 * restart mid-episode rebuilds it: hops, tried and the pause survive. ad only walks the event
 * shapes brief B writes; anything else in the ledger is ignored.
 */
export function episodeFromEvents(events) {
  let ep = null;
  for (const ev of events) {
    if (ev.type === "routeFailure") {
      if (!ev.episode?.id || !ev.episode.from) continue; // not one ad wrote: never invent an episode
      if (!ep || ep.id !== ev.episode.id) ep = startEpisode({ id: ev.episode.id, from: ev.episode.from, at: ev.episode.startedAt });
    } else if (ev.type === "switchCommitted") {
      if (!ep) continue;
      if (ev.reason !== "policy") ep = null; // a switch by hand hands the conversation back
      else {
        const route = routeTargetOf(ev.target);
        // a switch key ad can't read back still costs the hop; it just names no target to avoid
        ep = route ? afterSwitch(ep, route) : { ...ep, hops: ep.hops + 1 };
      }
    } else if (ev.type === "paused") {
      if (ep && ep.id === ev.episodeId) ep = { ...ep, paused: ev.reason }; // open and paused, so a restart shows it
    } else if (ev.type === "turnCompleted") {
      if (ev.status === "completed") ep = null;
    } else if (ev.type === "userMessage") {
      if (ev.via !== "ad") ep = null; // the user's own words end recovery; ad's continuation doesn't
    }
  }
  return ep;
}

/** Automatic switches (reason "policy") in the hour before now, across episodes: the hourly cap. */
export function switchesLastHour(events, now) {
  // A switch whose time can't be read counts: the cap errs towards stopping.
  return events.filter((ev) => {
    if (ev.type !== "switchCommitted" || ev.reason !== "policy") return false;
    const at = Date.parse(ev.at ?? "");
    return Number.isNaN(at) || at > now - HOUR;
  }).length;
}

/**
 * At the turn boundary, after the goal is paused and the engine says idle: wait for something to
 * end, pause because the state is unsafe to leave, or hand the conversation over.
 * @param tools     the failing root turn's tools, its child turns' included: [{ status, effect, background, summary }]
 * @param terminals live background terminals: [{ command }]
 * @returns { wait: "request"|"tool"|"subagent" } | { pause: "mayBeRunning"|"toolCalls"|"background", text }
 *          | { ok: true, keep: [{ command }] } — keep are the allowed long-running commands
 */
export function boundaryCheck({ tools = [], terminals = [], requests = 0, subagents = 0, allowRunningBackground = [], switchAfterToolCalls = SWITCH_AFTER_TOOL_CALLS }) {
  if (requests > 0) return { wait: "request" };
  if (tools.some((t) => t.status === "running" && !t.background)) return { wait: "tool" };
  const unknownTool = tools.find((t) => t.status === "unknown" && t.effect !== "read");
  if (unknownTool) return { pause: "mayBeRunning", text: FALLBACK_RUN_TEXTS.MAY_BE_RUNNING(unknownTool.summary ?? "a command") };
  // S-RECOVERY decides; until then a failed turn that ran a non-read tool pauses.
  if (!switchAfterToolCalls && tools.some((t) => t.effect && t.effect !== "read" && !t.background)) return { pause: "toolCalls", text: FALLBACK_RUN_TEXTS.TOOL_CALLS };
  for (const t of terminals) {
    if (!isReadOnlyCommand(t.command) && !keepRunningMatches(allowRunningBackground, t.command)) {
      return { pause: "background", text: FALLBACK_RUN_TEXTS.BACKGROUND(t.command) };
    }
  }
  if (subagents > 0) return { wait: "subagent" };
  return { ok: true, keep: terminals };
}

/**
 * A prompt is about to start on `current`. Switch first when that target itself ran out (whoever
 * chose it: it can't answer), or when fallback chose it and its provider has been benched since.
 * A target the user picked by hand on a benched provider is respected, with one notice
 * (D09: same-provider moves stay manual).
 * @param current   { account: <account object>, model, label }
 * @param chosenBy  "fallback"|"user"   limit: current's limitState now; benchedUntil: ms or null
 * @returns null | { switch: true, why: "exhausted"|"benched" } | { notice: <text> }
 */
export function beforeDispatch({ current, chosenBy, limit, benchedUntil, now, noticeShown = false }) {
  if (limit === "exhausted") return { switch: true, why: "exhausted" };
  if (benchedUntil > now && chosenBy === "fallback") return { switch: true, why: "benched" };
  if (benchedUntil > now && chosenBy === "user" && !noticeShown) {
    return { notice: FALLBACK_RUN_TEXTS.MANUAL_PICK(providerDisplay(current.account.provider), untilText(benchedUntil), current.label) };
  }
  return null;
}

export const FALLBACK_RUN_TEXTS = Object.freeze({
  SWITCHED: (to, why, hop, maxHops) => `\u{21aa} Switched to ${to}: ${why}. Fallback ${hop} of ${maxHops}.`,
  USING_FOR_PROMPT: (to, why) => `\u{21aa} Using ${to} for this prompt: ${why}.`,
  RETRYING: (provider, seconds, n, of) => `\u{21bb} Rate limited by ${provider}; retrying in ${seconds} s (${n} of ${of}).`,
  PAUSED: (reason) => `\u{23f8} Paused: ${reason}. Your work is saved. /retry tries again \u{b7} /model picks a model \u{b7} /fallback shows the order.`,
  MANUAL_PICK: (provider, until, picked) => `${provider} hit a limit earlier${until}; you picked ${picked}, so ad uses it. Fallback won't move to another ${provider} account by itself.`,
  NONE_LEFT: (why, skipped) => `${why}, and no other target in your order can take over (${skipped})`,
  MAY_BE_RUNNING: (cmd) => `\`${cmd}\` may still be running from the failed turn (ad can't tell whether it finished)`,
  TOOL_CALLS: "the failed turn ran commands or made edits, and ad doesn't move such a turn by itself yet",
  BACKGROUND: (cmd) => `\`${cmd}\` is still running in the background (allow long-running commands in /fallback rules if this is a server)`,
  SUBAGENT: "a subagent is still working",
  BUDGET: (n, minutes) => `the fallback budget is used up (${n} switch${n === 1 ? "" : "es"} in ${minutes} min)`,
  TOO_OFTEN: (n) => `fallback is switching too often (${n} in the last hour)`,
  CHANGED: (name) => `${name} changed since you confirmed the order`,
  RULES: "the fallback order no longer passes its own rules (ad fallback lists why)",
  CONTINUATION: (from, reason) => `${AD_CONTINUATION_PREFIX} The previous attempt on ${from} stopped (${reason}). Continue the user's last request from where it stopped. Tool calls already marked done ran: don't repeat them. Commands listed as still running are kept by ad: don't start them again.`,
});

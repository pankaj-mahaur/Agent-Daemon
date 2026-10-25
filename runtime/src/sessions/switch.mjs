// Moving a conversation to another target at a safe point (P4.2). Pure: the coordinator
// runs the effects. P3.4's engine/switch.mjs is the fork path; this decides when and how.
//
//   switchHow({ from, to, goal, canDefer })   "nextTurn" | "fork" | "continuation" (S-RESUME)
//   safePoint(facts, { mode, anyway, subagentWaitOver })
//        → { ok } | { wait: "turn"|"goal"|"request"|"subagent" } | { decline } | { pause, text }
//   step(state, event) → { state, effects }    the switch, event by event
//   recoverSwitch(events)                      a switch a crash left open → what to write
//
// Targets: { modelProvider, homeKey, provider, model, effort, passthrough, label }.
// passthrough false: the provider is bridged (ad's chat translation); its items never cross.

export const SWITCH_TEXTS = Object.freeze({
  ANSWER_FIRST: "Answer the pending approval first.",
  SUBAGENT: "A subagent is still working. Wait, or stop it in /subagents, then switch again.",
  UNKNOWN: (cmd) => `Not switched yet: \`${cmd}\` may still be running from the last turn (ad can't tell whether it finished). Check it, then choose Switch anyway.`,
  SELF_STARTING: "the conversation kept starting turns by itself (a goal or subagent); stop it and try again",
  TIMEOUT: "the conversation didn't stop in time; stop it and try again",
  BUSY: "A switch is already under way.",
  FINISHING: "The switch is finishing; it can't be cancelled now.",
  ABORT: (target, reason, old) => `Couldn't switch to ${target}: ${reason}. Still on ${old}.`,
  COMMIT: (target, why, history) => `Switched to ${target} (${why}). ${history}`,
  HISTORY_KEPT: "History kept.",
  HISTORY_CARRIED: (turns, left) => `History carried over: ${turns} turn${turns === 1 ? "" : "s"}${left ? `, ${left} left out` : ""}.`,
  REASONS: Object.freeze({
    signIn: (label) => `that account needs signing in again: ad auth login ${label}`,
    model: "that model isn't available on that account",
    engine: "the engine for that account didn't start (details: /warnings)",
    kept: "the engine kept the old provider (details: /warnings)",
    selfStarting: "the conversation kept starting turns by itself (a goal or subagent); stop it and try again",
    timeout: "the conversation didn't stop in time; stop it and try again",
    cancelled: "you cancelled it",
    failed: "the switch failed (details: /warnings)",
  }),
});

const same = (a, b) => (a ?? null) === (b ?? null);

export function switchHow({ from = {}, to = {}, goal = false, canDefer = true } = {}) {
  if (same(to.modelProvider, from.modelProvider) && same(to.homeKey, from.homeKey)) return "nextTurn";
  const direct = from.passthrough !== false && to.passthrough !== false;
  const fork = same(to.homeKey, from.homeKey) && Boolean(to.provider) && to.provider === from.provider && direct && same(to.model ?? from.model, from.model);
  // A fork carries the goal and starts it at once unless its continuation can be deferred.
  if (fork && goal && !canDefer) return "continuation";
  return fork ? "fork" : "continuation";
}

/**
 * facts: { activeTurnId, starting, threadStarting, goal: "active"|"paused"|…|null, requests,
 *   foregroundTools, subagents, unknownNonRead: [command…], idle (thread/read), terminals }
 */
export function safePoint(f, { mode = "wait", anyway = false, subagentWaitOver = false } = {}) {
  // First: a turn waiting on an answer can't end, so the request comes before the turn.
  if (f.requests > 0) return mode === "now" ? { decline: true } : { wait: "request", text: SWITCH_TEXTS.ANSWER_FIRST };
  if (f.activeTurnId || f.starting || f.threadStarting || f.foregroundTools > 0) return { wait: "turn" };
  if (f.goal === "active") return { wait: "goal" };
  if (f.subagents > 0) return subagentWaitOver ? { pause: "subagent", text: SWITCH_TEXTS.SUBAGENT } : { wait: "subagent" };
  if (f.unknownNonRead?.length && !anyway) return { pause: "unknown", text: SWITCH_TEXTS.UNKNOWN(f.unknownNonRead[0]) };
  if (f.idle === false) return { wait: "turn" };
  // Background terminals don't block a manual switch: they stay with the old conversation.
  return { ok: true };
}

const ACTIVE = new Set(["QUIESCING", "SAFE_POINT", "TARGET_READY", "BINDING_STARTED", "PAUSED_NEEDS_USER"]);
const MAX_RESTARTS = 3;

function abort(s, reason) {
  const text = SWITCH_TEXTS.ABORT(s.target?.label ?? "that target", SWITCH_TEXTS.REASONS[reason] ?? reason, s.from?.label ?? "the current one");
  return {
    state: { state: "RUNNING" },
    effects: [
      { type: "ledger", event: { type: "switchAborted", reason, target: s.target?.key ?? null } },
      { type: "releaseTarget" }, // an engine started for the target, unused
      { type: "resumeGoal" }, // the old thread's goal, when ad paused it
      { type: "hold", on: false },
      { type: "notice", level: "warn", text },
    ],
  };
}

function quiesce(s) {
  return [{ type: "pauseGoal" }, ...(s.mode === "now" ? [{ type: "interrupt" }] : []), { type: "checkSafe" }];
}

export function step(s, ev) {
  if (ev.type === "request") {
    if (ACTIVE.has(s.state)) return { state: s, effects: [{ type: "notice", level: "info", text: SWITCH_TEXTS.BUSY }] };
    const next = { state: "QUIESCING", mode: ev.mode ?? "wait", target: ev.target, from: ev.from ?? null, how: ev.how, reason: ev.reason ?? "user", restarts: 0, anyway: false };
    return {
      state: next,
      effects: [
        { type: "ledger", event: { type: "switchRequested", target: ev.target?.key ?? null, how: ev.how, mode: next.mode, reason: next.reason } },
        { type: "hold", on: true },
        ...quiesce(next),
      ],
    };
  }
  if (!ACTIVE.has(s.state)) return { state: s, effects: [] };
  // Once the new thread is being bound the move may already have happened: it finishes.
  if (ev.type === "cancel") return s.state === "BINDING_STARTED" ? { state: s, effects: [{ type: "notice", level: "info", text: SWITCH_TEXTS.FINISHING }] } : abort(s, "cancelled");
  if (ev.type === "fail") return abort(s, ev.reason ?? "failed");
  if (ev.type === "timeout" && s.state === "QUIESCING") return { state: { ...s, state: "PAUSED_NEEDS_USER", reason: "timeout" }, effects: [{ type: "ask", text: SWITCH_TEXTS.TIMEOUT, choices: ["cancel"] }] };
  switch (s.state) {
    case "QUIESCING":
      if (ev.type === "turnCompleted" || ev.type === "goalPaused" || ev.type === "recheck") return { state: s, effects: [{ type: "checkSafe" }] };
      if (ev.type === "safe") {
        const c = ev.check ?? {};
        if (c.ok) return { state: { ...s, state: "SAFE_POINT" }, effects: [{ type: "checkpoint" }, { type: "prepareTarget" }] };
        if (c.decline) return { state: s, effects: [{ type: "declineRequests" }, { type: "checkSafe" }] };
        if (c.pause) return { state: { ...s, state: "PAUSED_NEEDS_USER", reason: c.pause }, effects: [{ type: "ask", text: c.text, choices: c.pause === "unknown" ? ["anyway", "cancel"] : ["cancel"] }] };
        return { state: { ...s, waiting: c.wait ?? null }, effects: c.text && s.waiting !== c.wait ? [{ type: "notice", level: "info", text: c.text }] : [] };
      }
      return { state: s, effects: [] };
    case "SAFE_POINT":
      if (ev.type === "targetReady") return { state: { ...s, state: "TARGET_READY" }, effects: [{ type: "confirmIdle" }] };
      break;
    case "TARGET_READY":
      if (ev.type === "idleConfirmed") return { state: { ...s, state: "BINDING_STARTED" }, effects: [{ type: "bind", how: s.how }] };
      break;
    case "BINDING_STARTED":
      if (ev.type === "bound") {
        const history = s.how === "continuation" ? SWITCH_TEXTS.HISTORY_CARRIED(ev.turns ?? 0, ev.leftOut ?? 0) : SWITCH_TEXTS.HISTORY_KEPT;
        return {
          state: { state: "RUNNING" },
          effects: [
            { type: "commit", how: s.how, threadId: ev.threadId, mode: s.mode },
            { type: "ledger", event: { type: "switchCommitted", target: s.target?.key ?? null, how: s.how, threadId: ev.threadId ?? null, reason: s.reason } },
            { type: "hold", on: false },
            { type: "notice", level: "info", line: true, text: SWITCH_TEXTS.COMMIT(s.target?.label ?? "the new target", s.reason === "user" ? "you asked" : s.reason, history) },
          ],
        };
      }
      break;
    case "PAUSED_NEEDS_USER":
      if (ev.type === "anyway" && s.reason === "unknown") return { state: { ...s, state: "QUIESCING", anyway: true, reason: undefined }, effects: [{ type: "checkSafe" }] };
      return { state: s, effects: [] };
    default:
  }
  // The engine started a turn after the safe point: quiesce again (a goal or a subagent).
  if (ev.type === "turnStarted" && (s.state === "SAFE_POINT" || s.state === "TARGET_READY")) {
    const restarts = (s.restarts ?? 0) + 1;
    if (restarts >= MAX_RESTARTS) return { state: { ...s, state: "PAUSED_NEEDS_USER", reason: "selfStarting", restarts }, effects: [{ type: "ask", text: SWITCH_TEXTS.SELF_STARTING, choices: ["cancel"] }] };
    const next = { ...s, state: "QUIESCING", restarts };
    return { state: next, effects: [{ type: "pauseGoal" }, { type: "interrupt" }, { type: "checkSafe" }] };
  }
  return { state: s, effects: [] };
}

/**
 * A switch a crash left open, from the ledger's events (oldest first): what the next
 * open writes so the record says how it ended.
 *   → null (nothing open) | { abort: reason } | { commit: { gen } }
 */
export function recoverSwitch(events) {
  let open = null;
  let boundGen = null;
  for (const e of events) {
    if (e.type === "switchRequested") {
      open = e;
      boundGen = null;
    } else if (e.type === "switchCommitted" || e.type === "switchAborted") {
      open = null;
      boundGen = null;
    } else if (e.type === "bindingStarted" && open) boundGen = e.gen ?? e.binding?.gen ?? null;
  }
  if (!open) return null;
  // The new binding was written: the work moved there (the old thread was let go first).
  if (boundGen != null) return { commit: { gen: boundGen } };
  return { abort: "crash" };
}

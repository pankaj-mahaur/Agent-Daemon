// Automatic fallback with nobody at the keyboard (P4.7): `ad run --fallback`, `ad loop
// --fallback`, scheduled jobs that opted in, and team workers whose team did. The same
// session, ledger, switch runner and fallback controller as `ad tui`, headless:
//
//   fallbackOptIn({ command, env, policy, routing }) → { ok: true, on } | { ok: false, code: 2, text }
//   createUnattendedRun({ started, cwd, origin, threadOpts, turnOpts, err, store, … }) → {
//     turn(text, { via }) → { status: "completed"|"failed"|"paused", output, error, turnId,
//                             threadId, sessionId, target, fallback: [event], reason?, resetsAt? },
//     session, close() }
//
// What makes it unattended: every request is answered at once (declined), a switch never asks
// ("Switch anyway" is never chosen: an unknown command pauses), every switch is a continuation
// whose new thread gets this run's own settings (threadOpts: sandbox, approval policy,
// developer instructions, unattended config), and a pause returns at once, never waiting for a
// reset. The P4.5 rules apply unchanged.

import { createSession } from "./session.mjs";
import { createCoordinator, ledgerHome, ledgerTarget } from "../sessions/coordinator.mjs";
import { createSwitchRunner } from "../sessions/switch-runner.mjs";
import { createFallbackController } from "../sessions/fallback-controller.mjs";
import { fallbackGate } from "../sessions/fallback.mjs";
import { readLedger } from "../sessions/ledger.mjs";
import { readPolicy } from "../routing/store.mjs";
import { routingContext } from "../routing/context.mjs";
import { accountName } from "../auth/accounts/target.mjs";
import { benchKey, benchProvider } from "../providers/quota.mjs";
import { classifyUpstream } from "../providers/errors.mjs";
import { classifyTurnFailure, lastUpstreamFailureForThread } from "./gateway-runtime.mjs";

export const UNATTENDED_TEXTS = Object.freeze({
  TOOL_SHELL: "Fallback settings can't be changed from the agent's own shell. Run it in your terminal.",
  OFF: (command) => `${command} --fallback: fallback is off in your settings. Turn it on in a terminal: ad fallback enable`,
  CHANGED: (command, name) => `${command} --fallback: ${name} changed since you confirmed the fallback order. Confirm it: ad fallback enable`,
  RULES: (command) => `${command} --fallback: the fallback order no longer passes its own rules (ad fallback lists why). Fix it, then: ad fallback enable`,
  HINT: (how) => `Fallback is on in your settings but not for this run: ${how}.`,
  PAUSED: (reason, sessionId) => `[ad] \u{23f8} Paused: ${reason}. Work so far is saved${sessionId ? ` (session ${sessionId})` : ""}.`,
});

/**
 * May this run fall back? Refused (exit 2) from the agent's own shell when the run itself asks
 * (a granted schedule or team setting is used, not asked: pass grantedElsewhere), when the
 * policy is off, its consent is stale, or it breaks its own rules. AD_FALLBACK=0: allowed but
 * off (the run goes on without fallback).
 */
export function fallbackOptIn({ command = "ad run", env = process.env, grantedElsewhere = false, policy = readPolicy({ lenient: true }), routing = routingContext() } = {}) {
  if (!grantedElsewhere && env.AD_TOOL_SHELL === "1") return { ok: false, code: 2, text: UNATTENDED_TEXTS.TOOL_SHELL };
  const g = fallbackGate({ policy, ...routing, env, windowOn: true });
  if (g.on) return { ok: true, on: true };
  if (g.reason === "env") return { ok: true, on: false };
  if (g.reason === "changed") {
    const name = /^(.*) changed since/.exec(g.text ?? "")?.[1] ?? "an account";
    return { ok: false, code: 2, text: UNATTENDED_TEXTS.CHANGED(command, name) };
  }
  if (g.reason === "rules") return { ok: false, code: 2, text: UNATTENDED_TEXTS.RULES(command) };
  return { ok: false, code: 2, text: UNATTENDED_TEXTS.OFF(command) };
}

/** Whether the saved policy is on (for the one-line hint of a run that didn't opt in). */
export function policyOn({ policy = readPolicy({ lenient: true }), routing = routingContext(), env = process.env } = {}) {
  try {
    return fallbackGate({ policy, ...routing, env, windowOn: true }).on;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIMIT_CLASSES = new Set(["quotaExhausted", "rateLimit"]);
export const isLimitClass = (c) => LIMIT_CLASSES.has(c);

/**
 * started: launchHarness's result (engine, release, target, params, homeKey). accounts: the
 * accounts layer (tui/accounts.mjs createTuiAccounts), or (session) → it, for the switch's targets. threadOpts:
 * { sandbox, approvalPolicy, developerInstructions, config } for every thread; turnOpts: sticky
 * per-turn settings ({ sandboxPolicy, effort }). onRequest(req) → its answer, for ad run's line.
 * onEvent(ev): every session event (ad loop counts file changes, commands and tokens there).
 */
export function createUnattendedRun({ started, accounts, cwd, origin = "run", threadOpts = {}, turnOpts = {}, err = process.stderr, adRoot, env = process.env, lockDir, onRequest = () => "decline", onEvent = null, deps = {} } = {}) {
  const fallback = []; // the switches and pauses, for --json and the loop log
  const ends = []; // [{ turn, status }]: every turn's end, in order
  let session;
  let runner;
  let controller;
  const ledger = createCoordinator({
    cwd,
    origin,
    root: adRoot,
    homeKey: () => ledgerHome(session?.state.config.homeKey),
    targetOf: () => ledgerTarget({ account: accounts.current?.() ?? started.target?.account, model: session?.state.config.model, effort: session?.state.config.effort }),
  });
  const { developerInstructions, config, sandbox, approvalPolicy } = threadOpts;
  const threadExtra = { ...(developerInstructions ? { developerInstructions } : {}), ...(config && Object.keys(config).length ? { config } : {}) };
  session = createSession({
    engine: started.engine,
    cwd,
    model: started.params?.model ?? null,
    modelProvider: started.params?.modelProvider ?? null,
    homeKey: started.homeKey ?? null,
    provider: started.target?.account?.provider ?? null,

    ...(sandbox ? { sandbox } : {}),
    ...(approvalPolicy ? { approvalPolicy } : {}),
    ...(lockDir ? { lockDir } : {}),
    threadExtra: Object.keys(threadExtra).length ? threadExtra : null,
    hooks: {
      turnCompleted: (x) => {
        ends.push({ turn: x.turn, status: x.status });
        controller?.turnCompleted(x);
      },
    },
    observer: (ev) => {
      runner?.onEvent(ev);
      controller?.onEvent(ev);
      try {
        onEvent?.(ev);
      } catch {
        // the caller's own counting
      }
      return ledger.observer(ev);
    },
  });
  // The accounts layer may need the session (createTuiAccounts does): (session) → accounts.
  if (typeof accounts === "function") accounts = accounts(session);
  if (Object.keys(turnOpts).length) session.setNextTurn(turnOpts);
  // Nobody at the keyboard: every request is answered as it arrives.
  session.on("change", () => {
    for (const r of [...session.state.requests]) {
      let answer = "decline";
      try {
        answer = onRequest(r.request) ?? "decline";
      } catch {
        // declined
      }
      session.resolve(r.request.id, answer);
    }
  });
  const line = (text) => err.write(`[ad] ${text}\n`);
  runner = createSwitchRunner({
    session,
    ledger,
    current: () => accounts.currentTarget(),
    prepare: (t) => accounts.prepare(t),
    notify: (level, text, o) => {
      if (o?.line) {
        line(text);
        if (/^\u{21aa}/u.test(text)) fallback.push({ type: "switched", text, at: new Date().toISOString() });
      } else if (level !== "info") line(text);
    },
    // "Switch anyway" is a person's call: unattended, an unknown command pauses.
    ask: () => runner.answer("cancel"),
  });
  const policy = deps.policy ?? (() => readPolicy({ lenient: true }));
  const routing = deps.routing ?? (() => routingContext());
  const ledgerAccount = () => accounts.current?.() ?? started.target?.account ?? null;
  controller = createFallbackController({
    session,
    ledger,
    runner,
    policy,
    routing,
    env,
    current: () => {
      const t = accounts.currentTarget();
      return t?.account ? { account: t.account, model: t.model ?? null, effort: t.effort ?? null, label: t.label } : null;
    },
    // Always a continuation: a new thread gets this run's settings (a fork would keep the old thread's).
    toSwitchTarget: async (rt) => {
      const a = routing().accounts.find((x) => x.id === rt.account);
      return a ? { ...accounts.targetFor(a, rt.model ?? null, rt.effort ?? null), passthrough: false } : null;
    },
    classify: deps.classify ?? (({ error, status, threadId, startedAt, fallbackInterrupt }) => classifyTurnFailure({ error, status, threadId, startedAt, fallbackInterrupt, account: ledgerAccount(), rateLimits: session.state.rateLimits ?? null, rateLimitsAt: session.state.rateLimitsAt ?? null })),
    retryObservation:
      deps.retryObservation ??
      ((threadId, sinceMs) => {
        const o = lastUpstreamFailureForThread(threadId);
        return o && Number.isFinite(sinceMs) && Date.parse(o.at) >= sinceMs ? classifyUpstream(o) : null;
      }),
    bench: deps.bench ?? (({ provider, accountId, until, reason }) => benchProvider(benchKey(provider, accountId), { until, reason, accountId })),
    events: () => (ledger.sessionId() ? readLedger(ledger.sessionId(), adRoot ? { root: adRoot } : {}) : []),
    notify: (level, text, o) => {
      if (o?.line) line(text);
    },
    ...(deps.controller ?? {}),
  });

  const outputOf = (t) =>
    (t?.itemIds ?? [])
      .map((id) => session.state.items.get(id))
      .filter((i) => i?.kind === "agentMessage")
      .map((i) => String(i.text ?? ""))
      .join("\n\n");
  const idle = () => !session.state.activeTurnId && !session.state.starting && !session.state.queue.length && runner.state().state === "RUNNING" && !runner.pending();

  return {
    session,
    ledger,
    controller: () => controller,
    /** One prompt to its end: through switches (ad's continuation), or to a pause. */
    async turn(text, { via = "submit" } = {}) {
      const from = ends.length;
      // Before the prompt: a target fallback chose that is benched since moves first (P4.5).
      controller.beforePrompt?.();
      if (via === "ad") ledger.markAdTurn?.();
      session.submit(text);
      for (;;) {
        await sleep(25);
        const s = controller.state();
        if (s.paused) {
          await controller.settled?.();
          const last = ends.at(-1);
          fallback.push({ type: "paused", reason: s.paused.code, text: s.paused.text, at: new Date().toISOString() });
          return result("paused", last, { reason: s.paused.text, code: s.paused.code });
        }
        const last = ends.length > from ? ends.at(-1) : null;
        if (!last || !idle()) continue;
        // A turn fallback acted on goes on (a switch and ad's continuation, or a retry): once its
        // work settled and nothing runs or waits, the last turn's end is the answer.
        await controller.settled?.();
        if (!idle() || controller.state().paused || ends.at(-1) !== last) continue;
        return result(last.status === "completed" ? "completed" : "failed", last);
      }
    },
    /** The switches and pauses so far. */
    fallback: () => [...fallback],
    target: () => {
      const t = accounts.currentTarget();
      return t?.account ? { account: accountName(t.account), model: t.model ?? null } : null;
    },
    async close() {
      controller.dispose();
      await runner.dispose();
      session.close();
      await ledger.close();
    },
  };

  function result(status, last, extra = {}) {
    const t = last?.turn ?? null;
    return {
      status,
      turnId: t?.id ?? null,
      threadId: session.state.thread?.id ?? null,
      sessionId: ledger.sessionId?.() ?? null,
      output: outputOf(t),
      error: status === "completed" ? null : (t?.error ?? null),
      target: (() => {
        const c = accounts.currentTarget();
        return c?.account ? { account: accountName(c.account), model: c.model ?? null } : null;
      })(),
      fallback: [...fallback],
      ...extra,
    };
  }
}

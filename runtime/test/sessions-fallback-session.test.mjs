// P4.5 B1: automatic fallback end to end on the fake engine: the session, the ledger, the switch
// runner and the fallback controller. Three targets in the user's order:
//   A  OpenRouter · a · fake-model   (this window starts here)
//   B  OpenAI · b · fake-model       (a fork on the same engine)
//   C  OpenRouter · c · fake-model   (another home; same provider as A, so never right after A's limit)

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-fallback-run-"));
const saved = { AD_ROOT: process.env.AD_ROOT, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, AD_FALLBACK: process.env.AD_FALLBACK };
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;
delete process.env.AD_FALLBACK;
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const { createEngine } = await import("../src/engine/index.mjs");
const { createSession } = await import("../src/harness/session.mjs");
const { createCoordinator, ledgerHome, ledgerTarget } = await import("../src/sessions/coordinator.mjs");
const { createSwitchRunner } = await import("../src/sessions/switch-runner.mjs");
const { readLedger } = await import("../src/sessions/ledger.mjs");
const { createFallbackController } = await import("../src/sessions/fallback-controller.mjs");
const { causeText, FALLBACK_RUN_TEXTS: TXT } = await import("../src/sessions/fallback.mjs");
const { classifyTurnError } = await import("../src/providers/errors.mjs");
const { enablePolicy, readPolicy, updatePolicy } = await import("../src/routing/store.mjs");

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, what, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await sleep(15);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const debug = (engine) => engine.testRequest("debug/state", {});

const acct = (o) => ({ owner: "", status: "ready", method: "api-key", credential: { kind: "secret", ref: `ad-account-${o.id}` }, keyHint: "1111", credentialRevision: 1, endpoint: null, defaultModel: null, identity: null, ...o });
const ACCOUNTS = [acct({ id: "acct_a", provider: "openrouter", label: "a" }), acct({ id: "acct_b", provider: "openai", label: "b" }), acct({ id: "acct_c", provider: "openrouter", label: "c" })];
const byId = (id) => ACCOUNTS.find((a) => a.id === id);
const RUNNER = {
  acct_a: { modelProvider: "ad-or-a", homeKey: "api", provider: "openrouter", model: "fake-model", passthrough: true, label: "OpenRouter · a · fake-model", key: "acct_a/openrouter/fake-model/-" },
  acct_b: { modelProvider: "ad-oa-b", homeKey: "api", provider: "openrouter", model: "fake-model", passthrough: true, label: "OpenAI · b · fake-model", key: "acct_b/openai/fake-model/-" },
  acct_c: { modelProvider: "ad-or-c", homeKey: "c/cccc", provider: "openrouter", model: "fake-model", passthrough: true, label: "OpenRouter · c · fake-model", key: "acct_c/openrouter/fake-model/-" },
};
const ORDER = [{ account: "acct_a", model: "fake-model" }, { account: "acct_b", model: "fake-model" }, { account: "acct_c", model: "fake-model" }];

async function withRig(fn, { policyPatch = {}, env = {}, windowOn = () => true, engineEnv = {}, refuse = {}, homes = {}, retryObservation = null } = {}) {
  const root = fs.mkdtempSync(path.join(TMP, "rig-"));
  process.env.AD_ROOT = path.join(root, ".agent-daemon");
  const at = new Date().toISOString();
  const catalog = (id, model) => (byId(id) ? { accountId: id, provider: byId(id).provider, model, caps: { tools: true, contextWindow: 128000 }, price: { input: "0", output: "0", observedAt: at }, billing: "metered", data: {} } : null);
  const routing = () => ({ accounts: ACCOUNTS, catalog, now: Date.now(), root: process.env.AD_ROOT });
  await updatePolicy((p) => Object.assign(p, { targets: ORDER, ...policyPatch }), routing());
  await enablePolicy(routing());

  const engines = [];
  const make = async (home) => {
    const e = await createEngine({ home: path.join(root, home), command, experimental: true, env: engineEnv });
    engines.push(e);
    return e;
  };
  const engine = await make("api");
  const notices = [];
  let clock = Date.now();
  let session;
  let runner;
  let controller;
  const ledger = createCoordinator({ cwd: root, origin: "tui", homeKey: () => ledgerHome(session?.state.config.homeKey), targetOf: () => ledgerTarget({ provider: session.state.config.provider, model: session.state.config.model }) });
  const currentId = () => Object.keys(RUNNER).find((k) => RUNNER[k].modelProvider === session.state.config.modelProvider) ?? "acct_a";
  const deps = () => ({
    session,
    ledger,
    runner,
    policy: () => readPolicy({ root: process.env.AD_ROOT, lenient: true }),
    routing,
    current: () => ({ account: byId(currentId()), model: "fake-model", label: RUNNER[currentId()].label }),
    toSwitchTarget: async (t) => (RUNNER[t.account] ? { ...RUNNER[t.account], ...(homes[t.account] ? { homeKey: homes[t.account] } : {}) } : null),
    classify: ({ error, status, fallbackInterrupt }) => classifyTurnError({ error, status, fallbackInterrupt }),
    ...(retryObservation ? { retryObservation } : {}),
    events: () => (ledger.sessionId() ? readLedger(ledger.sessionId()) : []),
    notify: (level, text, o) => notices.push({ level, text, ...o }),
    env: { ...env },
    windowOn,
    now: () => clock,
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
  });
  session = createSession({
    engine,
    cwd: root,
    lockDir: path.join(root, "locks"),
    modelProvider: RUNNER.acct_a.modelProvider,
    homeKey: "api",
    provider: "openrouter",
    model: "fake-model",
    hooks: { turnCompleted: (x) => controller?.turnCompleted(x) },
    observer: (ev) => {
      runner?.onEvent(ev);
      controller?.onEvent(ev);
      return ledger.observer(ev);
    },
  });
  runner = createSwitchRunner({
    session,
    ledger,
    current: () => ({ ...RUNNER[currentId()], ...session.state.config, passthrough: true, label: RUNNER[currentId()].label }),
    prepare: async (t) => {
      if (refuse[t.key]) throw Object.assign(new Error("refused"), { reason: refuse[t.key] });
      if (t.homeKey === session.state.config.homeKey) return { sameEngine: true };
      const e = await make(t.homeKey.replace("/", "-"));
      await e.startThread({ cwd: root });
      return { engine: e, sameEngine: false, release: async () => {} };
    },
    checkpoint: async () => ({ ref: "cp1", diffStat: "1 file" }),
    git: async () => null,
    notify: (level, text, o) => notices.push({ level, text, ...o }),
    ask: () => {},
    timeouts: { quiesceMs: 3000, subagentMs: 300, pollMs: 30 },
  });
  controller = createFallbackController(deps());
  const events = () => (ledger.sessionId() ? readLedger(ledger.sessionId()) : []);
  const idle = () => runner.state().state === "RUNNING" && !session.state.activeTurnId && !session.state.starting;
  try {
    await session.init?.();
    await fn({
      session,
      runner,
      ledger,
      engine,
      notices,
      events,
      idle,
      controller: () => controller,
      restart: () => {
        controller.dispose();
        controller = createFallbackController(deps());
        return controller;
      },
      advance: (ms) => (clock += ms),
      currentId,
    });
  } finally {
    controller.dispose();
    await runner.dispose();
    session.close();
    for (const e of engines) await e.close().catch(() => {});
    await ledger.close();
  }
}

const userTexts = (evs) => evs.filter((e) => e.type === "userMessage").map((e) => `${e.via}:${e.text}`);
const isContinuation = (t) => t.startsWith("ad:[ad: automatic continuation]");

test("quota error at the end of a turn: one routeFailure, a switch to the next target, ad's continuation runs first and once, queued prompts after it", async () => {
  await withRig(async ({ session, events, notices, controller, currentId }) => {
    session.submit("quota-fail");
    session.submit("early-complete"); // waits behind the failing turn
    await until(() => events().filter((e) => e.type === "turnCompleted" && e.status === "completed").length >= 2, "the continuation and the queued prompt");
    const ev = events();
    assert.equal(ev.filter((e) => e.type === "routeFailure").length, 1);
    assert.equal(currentId(), "acct_b", "next in the order");
    const texts = userTexts(ev);
    assert.equal(texts.filter(isContinuation).length, 1, "ad's continuation once");
    const iCont = texts.findIndex(isContinuation);
    const iQueued = texts.indexOf("queue:early-complete");
    assert.ok(iCont > texts.indexOf("submit:quota-fail") && iCont < iQueued, `continuation first, then the queued prompt: ${JSON.stringify(texts)}`);
    assert.equal(ev.filter((e) => e.type === "turnStarted" && e.trigger === "ad").length, 1, "the continuation turn is ad's");
    const why = causeText({ class: "quotaExhausted", period: null, resetsAt: null }, "openrouter");
    assert.ok(notices.some((n) => n.line && n.text === TXT.SWITCHED("OpenAI · b · fake-model", why, 1, 3)), JSON.stringify(notices));
    assert.equal(controller().state().chosenBy, "fallback");
  });
});

test("a quota error after a completed command switches; the command is not run again", async () => {
  await withRig(async ({ session, events, currentId }) => {
    session.submit("quota-after-command");
    await until(() => events().some((e) => e.type === "turnCompleted" && e.status === "completed"), "the continuation");
    assert.equal(currentId(), "acct_b");
    assert.equal(events().filter((e) => e.type === "toolIntent" && e.summary?.includes("echo done")).length, 1, "the command ran once, never again");
  });
});

test("a quota error while a command's end is unknown pauses with its words; the queue stays held; resume() releases it", async () => {
  await withRig(async ({ session, events, notices, controller, currentId }) => {
    session.submit("quota-command-running");
    session.submit("early-complete");
    await until(() => controller().state().paused, "the pause");
    assert.equal(currentId(), "acct_a", "nothing moved");
    assert.ok(notices.some((n) => n.text === TXT.PAUSED(TXT.MAY_BE_RUNNING("npm run deploy"))), JSON.stringify(notices));
    assert.ok(events().some((e) => e.type === "paused" && e.reason === "mayBeRunning"));
    await sleep(150);
    assert.equal(session.state.queue.length, 1, "the queued prompt waits");
    controller().resume();
    await until(() => events().some((e) => e.type === "userMessage" && e.text === "early-complete"), "the queue released");
  });
});

test("a background command still running pauses unless it is allowed to keep running", async () => {
  await withRig(async ({ session, notices, controller }) => {
    session.submit("quota-background-running");
    await until(() => controller().state().paused, "the pause");
    assert.ok(notices.some((n) => n.text === TXT.PAUSED(TXT.BACKGROUND("./migrate.sh"))), JSON.stringify(notices));
  });
  await withRig(
    async ({ session, events, currentId }) => {
      session.submit("quota-background-running");
      await until(() => events().some((e) => e.type === "switchCommitted"), "the switch");
      assert.equal(currentId(), "acct_b");
    },
    { policyPatch: { allowRunningBackground: ["./migrate.sh"] } },
  );
});

test("a plan error (upgrade to Plus) never switches", async () => {
  await withRig(async ({ session, events, currentId }) => {
    await session.submit("plan-fail").done;
    await sleep(200);
    assert.equal(events().filter((e) => e.type === "routeFailure").length, 0);
    assert.equal(currentId(), "acct_a");
    assert.equal(session.state.held, false);
  });
});

test("fallback off (AD_FALLBACK=0, the window off, consent changed): a quota error changes nothing", async () => {
  for (const opts of [{ env: { AD_FALLBACK: "0" } }, { windowOn: () => false }]) {
    await withRig(async ({ session, events, currentId }) => {
      await session.submit("quota-fail").done;
      await sleep(200);
      assert.equal(events().filter((e) => e.type === "routeFailure").length, 0, JSON.stringify(opts));
      assert.equal(currentId(), "acct_a");
    }, opts);
  }
  await withRig(async ({ session, events, currentId }) => {
    // Re-keyed since the confirmation: the consent no longer matches.
    ACCOUNTS[1].credentialRevision = 2;
    try {
      await session.submit("quota-fail").done;
      await sleep(200);
      assert.equal(events().filter((e) => e.type === "routeFailure").length, 0);
      assert.equal(currentId(), "acct_a");
    } finally {
      ACCOUNTS[1].credentialRevision = 1;
    }
  });
});

test("endless reconnect notices: at the budget end the goal is paused, fallbackInterrupt recorded, then the turn interrupted; then it switches", async () => {
  await withRig(async ({ session, engine, events, controller, advance, currentId }) => {
    await session.submit("early-complete").done;
    const tid = session.state.thread.id;
    await engine.threads.goal.set(tid, "ship it", { status: "active" });
    await until(async () => (await engine.threads.goal.get(session.state.thread.id))?.status === "active", "the goal active");
    session.submit("endless-reconnect");
    await until(() => controller().state().watching, "the watch");
    await sleep(300); // a few retry notices start the clock
    advance(10_500);
    controller().tick();
    await until(() => events().some((e) => e.type === "switchCommitted"), "the switch after the interrupt");
    const ev = events();
    const iPause = ev.findIndex((e) => e.type === "goalPaused" && e.by === "fallback");
    const iInt = ev.findIndex((e) => e.type === "fallbackInterrupt");
    assert.ok(iPause >= 0 && iInt > iPause, `goal paused before the interrupt was recorded: ${ev.map((e) => e.type).join(",")}`);
    assert.equal(ev[iInt].cause.class, "transientNetwork");
    const calls = (await debug(engine)).calls;
    const iSet = calls.lastIndexOf("thread/goal/set", calls.indexOf("turn/interrupt"));
    assert.ok(iSet >= 0 && iSet < calls.indexOf("turn/interrupt"), "goal/set before turn/interrupt");
    assert.equal(currentId(), "acct_b");
  }, { policyPatch: { recoveryBudgetMs: 10_000 } });
});

test("goal set, quota error: no turn starts on either thread before ad's continuation; the goal resumes after the first completed turn", async () => {
  await withRig(async ({ session, engine, events }) => {
    await session.submit("early-complete").done;
    const old = session.state.thread.id;
    await engine.threads.goal.set(old, "ship it", { status: "active" });
    await until(async () => (await engine.threads.goal.get(session.state.thread.id))?.status === "active", "the goal active");
    await session.submit("quota-fail").done;
    await until(() => events().filter((e) => e.type === "turnCompleted" && e.status === "completed").length >= 2, "the continuation");
    const starts = events().filter((e) => e.type === "turnStarted");
    // ("early-complete" ends before the fake announces its start, so it has no turnStarted.)
    assert.deepEqual(starts.map((s) => s.trigger), ["user", "ad"], "the user's failed turn, then ad's continuation: nothing else started");
    const fork = session.state.thread.id;
    assert.notEqual(fork, old);
    await until(async () => (await engine.threads.goal.get(fork))?.status === "active", "the goal back on after the first turn there");
  });
});

test("no target left: pause with the reasons, word for word", async () => {
  await withRig(async ({ session, events, notices, controller, currentId }) => {
    await session.submit("quota-fail").done;
    await until(() => currentId() === "acct_b" && events().some((e) => e.type === "turnCompleted" && e.status === "completed"), "on B");
    await session.submit("quota-fail").done;
    await until(() => controller().state().paused, "the pause");
    const failure = events().filter((e) => e.type === "routeFailure").at(-1).failure;
    const want = TXT.PAUSED(TXT.NONE_LEFT(causeText(failure, "openai"), "OpenRouter · c · fake-model: OpenRouter hit its limit in this session; OpenRouter · a · fake-model: OpenRouter hit its limit in this session"));
    // A new episode started on B (the continuation completed): A is skipped as limited, not as tried.
    assert.ok(notices.some((n) => n.text === want), `${want}\n${JSON.stringify(notices.map((n) => n.text))}`);
  });
});

test("maxHops reached in one episode pauses with the budget words", async () => {
  await withRig(
    async ({ session, events, notices, controller, currentId }) => {
      session.submit("quota-fail"); // on A; ad's continuation on B fails too (FAKE_CONTINUATION_FAIL), in the same episode
      await until(() => controller().state().paused, "the pause");
      assert.equal(currentId(), "acct_b");
      const p = controller().state().paused;
      assert.equal(p.code, "budget");
      assert.ok(notices.some((n) => /^\u{23f8} Paused: the fallback budget is used up \(1 switch in \d+ min\)\./u.test(n.text)), JSON.stringify(notices.map((n) => n.text)));
      assert.equal(events().filter((e) => e.type === "switchCommitted").length, 1);
    },
    { policyPatch: { maxHops: 1 }, engineEnv: { FAKE_CONTINUATION_FAIL: "1" } },
  );
});

test("the episode survives a restart: a new controller rebuilds it from the ledger with its hops, and stays paused", async () => {
  await withRig(async ({ session, controller, restart }) => {
    session.submit("quota-command-running");
    await until(() => controller().state().paused, "the pause");
    const before = controller().state().episode;
    session.hold(false);
    const again = restart();
    assert.equal(again.state().episode.id, before.id);
    assert.equal(again.state().episode.hops, before.hops);
    assert.equal(again.state().paused.code, "mayBeRunning");
    assert.equal(session.state.held, true, "held again after the restart");
  });
});

test("the user's Esc during a turn is never a fallback", async () => {
  await withRig(async ({ session, events, controller, currentId }) => {
    session.submit("endless-reconnect");
    await until(() => controller().state().watching, "the watch");
    await session.interrupt();
    await until(() => events().some((e) => e.type === "turnCompleted" && e.status === "interrupted"), "the interrupt");
    await sleep(200);
    assert.equal(events().filter((e) => e.type === "routeFailure").length, 0);
    assert.equal(currentId(), "acct_a");
    assert.equal(session.state.held, false);
  });
});

test("handled(turnId) is true for a turn fallback acted on, false for others", async () => {
  await withRig(async ({ session, events, controller }) => {
    await session.submit("plan-fail").done;
    await session.submit("quota-fail").done;
    await until(() => events().some((e) => e.type === "switchCommitted"), "the switch");
    const done = events().filter((e) => e.type === "turnCompleted");
    const plan = done.find((e) => e.status === "failed");
    const quota = events().find((e) => e.type === "routeFailure");
    assert.equal(controller().handled(quota.turnId), true);
    assert.equal(controller().handled(plan.turnId), false, "a plan error isn't fallback's to explain");
  });
});

test("retry() after a pause queues ad's continuation once on the current target and releases the queue; it does nothing when not paused", async () => {
  await withRig(async ({ session, events, controller, currentId }) => {
    assert.equal(controller().retry(), false, "nothing to retry");
    session.submit("quota-command-running");
    await until(() => controller().state().paused, "the pause");
    assert.equal(controller().retry(), true);
    assert.equal(controller().state().paused, null);
    await until(() => events().filter((e) => e.type === "userMessage" && e.via === "ad").length === 1, "ad's continuation");
    const ad = events().find((e) => e.type === "userMessage" && e.via === "ad");
    assert.equal(ad.text, TXT.CONTINUATION("OpenRouter · a · fake-model", "you asked to try again"));
    assert.equal(currentId(), "acct_a", "the current target first");
    assert.equal(session.state.held, false);
  });
});

test("state() counts automatic switches and keeps the last one's reason", async () => {
  await withRig(async ({ session, events, controller }) => {
    assert.equal(controller().state().switches, 0);
    session.submit("quota-fail");
    await until(() => events().some((e) => e.type === "switchCommitted"), "the switch");
    await until(() => controller().state().switches === 1, "the count");
    assert.equal(controller().state().lastSwitch.why, causeText({ class: "quotaExhausted", period: null, resetsAt: null }, "openrouter"));
  });
});

test("a window with no account (an engine home ad didn't make) never holds or falls back", () => {
  const holds = [];
  let policyReads = 0;
  const c = createFallbackController({
    session: { state: { thread: { id: "t" }, terminals: new Map(), requests: [] }, hold: (on) => holds.push(on), engine: null },
    ledger: { record: () => assert.fail("nothing recorded") },
    runner: {},
    policy: () => {
      policyReads++;
      return { enabled: true };
    },
    routing: () => ({ accounts: [], catalog: () => null, now: Date.now() }),
    current: () => ({ account: null, model: "m", label: "an engine home ad didn't make" }),
    toSwitchTarget: async () => null,
    classify: () => ({ class: "quotaExhausted" }),
  });
  c.turnCompleted({ turn: { id: "x", status: "failed", error: { message: "Quota exceeded." } }, status: "failed" });
  assert.deepEqual(holds, []);
  assert.equal(policyReads, 0, "it stops before even reading the order");
  c.dispose();
});

// ---- Before a prompt starts (P4.5 B3) ------------------------------------------------------

const { benchProvider, recordObservations } = await import("../src/providers/quota.mjs");
const { readIndex } = await import("../src/sessions/index.mjs");

test("before dispatch: an exhausted current target switches first; the prompt then runs there, once, with the 'for this prompt' line", async () => {
  await withRig(async ({ session, events, notices, controller, currentId }) => {
    await session.submit("early-complete").done;
    await recordObservations([{ accountId: "acct_a", provider: "openrouter", window: "day", usedPercent: 100, resetsAt: new Date(Date.now() + 3_600_000).toISOString(), state: "exhausted", source: "test", observedAt: new Date().toISOString() }]);
    assert.deepEqual(controller().beforePrompt(), { switching: true });
    session.submit("early-complete");
    await until(() => events().filter((e) => e.type === "turnCompleted" && e.status === "completed").length >= 2, "the prompt on the new target");
    assert.equal(currentId(), "acct_b");
    const texts = userTexts(events());
    assert.equal(texts.filter((t) => t === "queue:early-complete").length, 1, "the prompt ran once, after the switch");
    assert.equal(texts.filter(isContinuation).length, 0, "the user's own prompt continues: no continuation of ad's");
    assert.ok(notices.some((n) => n.line && n.text.startsWith("\u{21aa} Using OpenAI · b · fake-model for this prompt: OpenRouter's limit is used up")), JSON.stringify(notices.map((n) => n.text)));
  });
});

test("before dispatch: a target the user picked on a benched provider is used, with one notice", async () => {
  await withRig(async ({ controller, notices }) => {
    const until = Date.now() + 3_600_000;
    await benchProvider("openrouter", { until: new Date(until).toISOString(), reason: "quotaExhausted", accountId: "acct_c" });
    assert.equal(controller().beforePrompt(), null);
    assert.equal(controller().beforePrompt(), null);
    const shown = notices.filter((n) => /hit a limit earlier/.test(n.text));
    assert.equal(shown.length, 1, "once per bench");
    assert.match(shown[0].text, /^OpenRouter hit a limit earlier \(resets \d\d:\d\d\); you picked OpenRouter · a · fake-model, so ad uses it\. Fallback won't move to another OpenRouter account by itself\.$/);
  });
});

test("before dispatch: a target fallback chose, whose provider is benched since, switches before the prompt", async () => {
  await withRig(async ({ session, events, controller, currentId }) => {
    await session.submit("quota-fail").done;
    await until(() => currentId() === "acct_b" && events().some((e) => e.type === "turnCompleted" && e.status === "completed"), "on B, chosen by fallback");
    await benchProvider("openai", { until: new Date(Date.now() + 3_600_000).toISOString(), reason: "quotaExhausted", accountId: "acct_b" });
    assert.deepEqual(controller().beforePrompt(), { switching: true });
    // C and A share OpenRouter, which ran out earlier in this session: nothing is left, so it pauses, held.
    await until(() => controller().state().paused, "the pause");
    assert.equal(controller().state().paused.code, "noneLeft");
    assert.equal(session.state.held, true);
  });
});

test("the session index says paused (and why) while fallback holds the conversation; open again after resume", async () => {
  await withRig(async ({ session, ledger, controller }) => {
    session.submit("quota-command-running");
    await until(() => controller().state().paused, "the pause");
    await ledger.flush();
    const id = ledger.sessionId();
    assert.equal(readIndex().sessions[id].state, "paused");
    assert.equal(readIndex().sessions[id].pausedReason, "mayBeRunning");
    controller().resume();
    await ledger.flush();
    assert.equal(readIndex().sessions[id].state, "open");
    assert.equal(readIndex().sessions[id].pausedReason, undefined);
  });
});

test("a target that refuses for itself (signed out) is skipped: the next one in the order takes over", async () => {
  await withRig(async ({ session, events, notices, controller, currentId }) => {
    session.submit("server-fail");
    await until(() => events().some((e) => e.type === "switchCommitted"), "the switch to C");
    assert.equal(currentId(), "acct_c", "B refused, C took over");
    assert.ok(events().some((e) => e.type === "switchAborted" && e.reason === "signIn"), "B's refusal is recorded");
    assert.ok(notices.some((n) => /^Couldn't switch to OpenAI · b · fake-model: that account needs signing in again/.test(n.text)), JSON.stringify(notices));
    assert.equal(controller().state().paused, null);
    await until(() => events().some((e) => e.type === "turnCompleted" && e.status === "completed"), "ad's continuation on C");
  }, { refuse: { "acct_b/openai/fake-model/-": "signIn" }, homes: { acct_b: "b/bbbb" } });
});

test("a target whose switch fails for another reason pauses (no endless loop through the order)", async () => {
  await withRig(async ({ session, controller, currentId }) => {
    session.submit("server-fail");
    await until(() => controller().state().paused, "the pause");
    assert.equal(controller().state().paused.code, "switchFailed");
    assert.equal(currentId(), "acct_a");
  }, { refuse: { "acct_b/openai/fake-model/-": "engine" }, homes: { acct_b: "b/bbbb" } });
});

test("a retry notice's cause that the gateway reports late is picked up on the next tick: a long Retry-After interrupts early, as a rate limit", async () => {
  let reported = null;
  await withRig(async ({ session, events, controller, currentId }) => {
    session.submit("one-retry-notice");
    await until(() => controller().state().watching, "the watch");
    await sleep(300); // the engine's one notice, with no cause yet
    controller().tick();
    assert.ok(!events().some((e) => e.type === "fallbackInterrupt"), "nothing to act on yet");
    reported = { class: "rateLimit", period: null, retryAfterMs: 3_600_000, resetsAt: null, source: "gateway" };
    controller().tick();
    await until(() => events().some((e) => e.type === "switchCommitted"), "the switch after the interrupt");
    const int = events().find((e) => e.type === "fallbackInterrupt");
    assert.equal(int.cause.class, "rateLimit", "the gateway's cause, not the watchdog's fallback");
    assert.equal(currentId(), "acct_b");
  }, { retryObservation: () => reported });
});

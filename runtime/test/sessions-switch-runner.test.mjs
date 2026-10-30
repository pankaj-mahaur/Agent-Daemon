// P4.2: a switch run end to end on the fake engine: the session, the ledger and the runner.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-switch-run-"));
const saved = { AD_ROOT: process.env.AD_ROOT, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.AD_ROOT = path.join(TMP, ".agent-daemon");
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;
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
const { createSwitchRunner, CONTINUE_TEXT } = await import("../src/sessions/switch-runner.mjs");
const { readLedger } = await import("../src/sessions/ledger.mjs");

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

const A = { modelProvider: "ad-or-a", homeKey: "api", provider: "openrouter", model: "fake-model", passthrough: true, label: "OpenRouter · a · fake-model", key: "a/openrouter/fake-model/-" };
const B_FORK = { ...A, modelProvider: "ad-or-b", label: "OpenRouter · b · fake-model", key: "b/openrouter/fake-model/-" };
const C_HOME = { modelProvider: "ad-oa-c", homeKey: "a/cccc", provider: "openai", model: "gpt-x", passthrough: true, label: "OpenAI · c · gpt-x", key: "c/openai/gpt-x/-" };

async function withRig(fn, { env = {}, targetEnv = {}, wrapTarget = null } = {}) {
  let oldReleased = 0;
  const root = fs.mkdtempSync(path.join(TMP, "rig-"));
  const engines = [];
  const make = async (home, extraEnv = {}) => {
    const e = await createEngine({ home: path.join(root, home), command, experimental: true, env: { ...env, ...extraEnv } });
    engines.push(e);
    return e;
  };
  const engine = await make("api");
  const notices = [];
  const asks = [];
  let session;
  let runner;
  const ledger = createCoordinator({ cwd: root, origin: "tui", homeKey: () => ledgerHome(session?.state.config.homeKey), targetOf: () => ledgerTarget({ provider: session.state.config.provider, model: session.state.config.model }) });
  const prepared = [];
  session = createSession({
    engine,
    cwd: root,
    lockDir: path.join(root, "locks"),
    modelProvider: A.modelProvider,
    homeKey: A.homeKey,
    provider: A.provider,
    model: A.model,
    release: async () => void oldReleased++, // the window's first engine lease
    observer: (ev) => {
      runner?.onEvent(ev);
      return ledger.observer(ev);
    },
  });
  runner = createSwitchRunner({
    session,
    ledger,
    current: () => ({ ...A, ...session.state.config, passthrough: true, label: A.label }),
    prepare: async (t) => {
      if (t.homeKey === session.state.config.homeKey) return { sameEngine: true };
      const real = await make(t.homeKey.replace("/", "-"), targetEnv);
      await real.startThread({ cwd: root }); // each fake numbers its threads from 1: not the old thread's id
      const e = wrapTarget ? wrapTarget(real) : real;
      let released = 0;
      const p = { engine: e, sameEngine: false, release: async () => void released++, released: () => released };
      prepared.push(p);
      return p;
    },
    checkpoint: async () => ({ ref: "cp1", diffStat: "1 file" }),
    git: async () => ({ branch: "main", files: 1, added: 2, deleted: 0 }),
    notify: (level, text, o) => notices.push({ level, text, ...o }),
    ask: (text, choices) => asks.push({ text, choices }),
    timeouts: { quiesceMs: 3000, subagentMs: 300, pollMs: 30 },
  });
  const done = () => runner.state().state === "RUNNING";
  try {
    await session.init?.();
    await fn({ session, runner, ledger, engine, engines, make, notices, asks, prepared, done, root, oldReleased: () => oldReleased });
  } finally {
    await runner.dispose();
    session.close();
    for (const e of engines) await e.close().catch(() => {});
    await ledger.close();
  }
}

const turnStartsOn = (engine, threadId) => {
  const seen = [];
  const off = engine.subscribe(threadId, (ev) => ev.type === "turn.started" && ev.threadId === threadId && seen.push(ev.turnId));
  return { seen, off };
};

test("fork switch with an active goal: the goal pauses first, no turn starts on the old thread or the fork before the queued prompt; the goal comes back after that turn", async () => {
  await withRig(async ({ session, runner, ledger, engine, done, notices }) => {
    await session.submit("fail-turn").done;
    const old = session.state.thread.id;
    await engine.threads.goal.set(old, "ship it", { status: "active" });
    const watchOld = turnStartsOn(engine, old);
    runner.request(B_FORK, { mode: "now" });
    session.submit("fail-turn"); // queued while the switch runs
    await until(done, "the switch");
    const fork = session.state.thread.id;
    assert.notEqual(fork, old);
    assert.equal(session.state.config.modelProvider, "ad-or-b");
    const st = await debug(engine);
    assert.equal(st.lastParams["thread/fork"].deferGoalContinuation, true);
    await until(() => readLedger(ledger.sessionId()).filter((e) => e.type === "turnCompleted").length === 2, "the queued prompt on the fork");
    assert.deepEqual(watchOld.seen, [], "no turn on the old thread");
    const ev = readLedger(ledger.sessionId());
    const starts = ev.filter((e) => e.type === "turnStarted");
    assert.equal(starts.length, 2, "nothing else started");
    assert.equal(starts[1].trigger, "user", "the first turn on the fork is the queued prompt");
    await until(async () => (await engine.threads.goal.get(fork))?.status === "active", "the goal back on, after the first turn");
    assert.ok(ev.some((e) => e.type === "switchCommitted"));
    assert.ok(notices.some((n) => n.line && /Switched to OpenRouter · b · fake-model \(you asked\)\. History kept\./.test(n.text)), JSON.stringify(notices));
    watchOld.off();
  });
});

test("continuation into another home: the capsule seeds the new thread, the goal is recreated paused in one goal/set call, the queue runs once there", async () => {
  await withRig(async ({ session, runner, ledger, engine, engines, done, prepared }) => {
    await session.submit("early-complete").done;
    await engine.threads.goal.set(session.state.thread.id, "finish the list", { status: "paused" });
    runner.request(C_HOME, { mode: "wait" });
    session.submit("early-complete");
    await until(done, "the switch");
    const target = engines.at(-1);
    assert.equal(session.engine, target);
    const st = await debug(target);
    assert.equal(st.calls.filter((c) => c === "thread/goal/set").length, 1, "one call");
    assert.equal(st.lastParams["thread/goal/set"].status, "paused");
    assert.ok(st.calls.includes("thread/inject_items"));
    const injected = st.lastParams["thread/inject_items"].items;
    assert.equal(injected[0].role, "developer");
    assert.match(injected[0].content[0].text, /continues work started with OpenRouter · a · fake-model/);
    assert.ok(!JSON.stringify(injected).includes("encrypted_content"));
    await until(async () => (await debug(target)).calls.filter((c) => c === "turn/start").length === 1, "the queued prompt there");
    await sleep(100);
    assert.equal((await debug(target)).calls.filter((c) => c === "turn/start").length, 1, "once on the new engine");
    const ev = readLedger(ledger.sessionId());
    const bindings = ev.filter((e) => e.type === "bindingStarted");
    assert.deepEqual(bindings.map((e) => e.binding.how), ["new", "continuation"]);
    assert.equal(bindings[1].binding.home, "a/cccc");
    assert.equal(prepared[0].released(), 0, "the new engine's lease is the window's now");
  });
});

test("a fork whose answer keeps the old provider aborts and never commits; still on the old target", async () => {
  await withRig(async ({ session, runner, ledger, done, notices }) => {
    await session.submit("early-complete").done;
    const old = session.state.thread.id;
    runner.request(B_FORK, { mode: "now" });
    await until(done, "the abort");
    assert.equal(session.state.thread.id, old);
    assert.equal(session.state.config.modelProvider, "ad-or-a");
    const ev = readLedger(ledger.sessionId());
    assert.ok(ev.some((e) => e.type === "switchAborted" && e.reason === "kept"), ev.map((e) => e.type).join());
    assert.ok(!ev.some((e) => e.type === "switchCommitted"));
    assert.ok(notices.some((n) => n.text === "Couldn't switch to OpenRouter · b · fake-model: the engine kept the old provider (details: /warnings). Still on OpenRouter · a · fake-model."), JSON.stringify(notices));
    assert.equal(session.state.held, false);
  }, { env: { FAKE_FORK_KEEPS_PROVIDER: "1" } });
});

test("commit doesn't wait for thread/closed: the old thread stays loaded and the continuation completes", async () => {
  await withRig(async ({ session, runner, engine, done }) => {
    await session.submit("early-complete").done;
    const old = session.state.thread.id;
    const t0 = Date.now();
    runner.request(C_HOME, { mode: "now" });
    await until(done, "the switch", 5000);
    assert.ok(Date.now() - t0 < 4000);
    assert.notEqual(session.engine, engine);
    assert.notEqual(session.state.thread.id, old);
    assert.ok((await debug(engine)).calls.includes("thread/unsubscribe"), "let go");
  }, { env: { FAKE_OTHER_SUBSCRIBER: "1" } });
});

test("a turn the old thread starts by itself after commit (its terminal still runs) is interrupted and logged as a violation", async () => {
  await withRig(async ({ session, runner, ledger, engine, done, notices }) => {
    await session.submit("early-complete").done;
    const old = session.state.thread.id;
    session.state.terminals.set("bg@t", { key: "bg@t", itemId: "bg", command: "npm run dev", lines: [] });
    runner.request(C_HOME, { mode: "now" });
    await until(done, "the switch");
    assert.deepEqual(session.state.priorTerminals.map((t) => t.command), ["npm run dev"]);
    const r = await engine.testRequest("test/start-turn", { threadId: old });
    await until(async () => (await debug(engine)).calls.includes("turn/interrupt"), "the interrupt");
    assert.ok((await debug(engine)).lastParams["turn/interrupt"].turnId === r.turnId);
    await until(() => readLedger(ledger.sessionId()).some((e) => e.type === "violation" && e.turnId === r.turnId), "the violation");
    assert.ok(notices.some((n) => /started a turn by itself after the switch/.test(n.text)));
  });
});

test("mode wait commits after the turn ends; the prompt queued meanwhile runs on the new engine, once", async () => {
  await withRig(async ({ session, runner, engines, done }) => {
    const s = session.submit("hang");
    await s.accepted;
    runner.request(C_HOME, { mode: "wait" });
    session.submit("early-complete");
    await sleep(150);
    assert.equal(runner.state().state, "QUIESCING", "waits for the turn");
    await session.interrupt();
    await until(done, "the switch");
    const target = engines.at(-1);
    await until(async () => (await debug(target)).calls.filter((c) => c === "turn/start").length === 1, "the queued prompt there");
    await sleep(100);
    assert.equal((await debug(target)).calls.filter((c) => c === "turn/start").length, 1, "once");
  });
});

test("mode now stops the turn, withdraws an open approval, and ad continues on the new target", async () => {
  await withRig(async ({ session, runner, ledger, engines, done }) => {
    const s = session.submit("edit-file");
    await s.accepted;
    await until(() => session.state.requests.length === 1, "the approval");
    runner.request(C_HOME, { mode: "now" });
    await until(done, "the switch");
    const ev = readLedger(ledger.sessionId());
    assert.ok(ev.some((e) => e.type === "approvalDecision" && e.decision === "withdrawn"), ev.map((e) => `${e.type}:${e.decision ?? ""}`).join());
    const target = engines.at(-1);
    await until(async () => (await debug(target)).calls.includes("turn/start"), "ad's turn there");
    assert.equal((await debug(target)).lastParams["turn/start"].input[0].text, CONTINUE_TEXT);
    await until(() => readLedger(ledger.sessionId()).some((e) => e.type === "turnStarted" && e.trigger === "ad"), "a turn marked ad's");
  });
});

test("an unknown effect in the last turn pauses: Cancel aborts, Switch anyway goes on", async () => {
  await withRig(async ({ session, runner, ledger, done, asks }) => {
    await session.submit("early-complete").done;
    // The ledger says a deploy may still be running from the last turn.
    const tid = session.state.thread.id;
    ledger.observer({ type: "turn.started", threadId: tid, turnId: "tx" });
    ledger.observer({ type: "item.started", threadId: tid, turnId: "tx", item: { type: "commandExecution", id: "d", command: "npm run deploy", commandActions: [], status: "inProgress" } });
    ledger.observer({ type: "turn.completed", threadId: tid, turnId: "tx", status: "interrupted" });
    runner.request(C_HOME, { mode: "now" });
    await until(() => runner.state().state === "PAUSED_NEEDS_USER", "the pause");
    assert.match(asks.at(-1).text, /`npm run deploy` may still be running/);
    await runner.answer("cancel");
    await until(done, "back");
    assert.equal(session.state.config.homeKey, "api");
    runner.request(C_HOME, { mode: "now" });
    await until(() => runner.state().state === "PAUSED_NEEDS_USER", "the pause again");
    await runner.answer("anyway");
    await until(done, "the switch");
    assert.equal(session.state.config.homeKey, "a/cccc");
  });
});

test("two windows switching to the same account at once: both commit, both ledgers and the index stay whole", async () => {
  const { readIndex } = await import("../src/sessions/index.mjs");
  await withRig(async (one) => {
    await withRig(async (two) => {
      await one.session.submit("early-complete").done;
      await two.session.submit("early-complete").done;
      const rev = readIndex().revision;
      one.runner.request(C_HOME, { mode: "now" });
      two.runner.request(C_HOME, { mode: "now" });
      await until(() => one.done() && two.done(), "both switches");
      await one.ledger.flush();
      await two.ledger.flush();
      for (const w of [one, two]) {
        const ev = readLedger(w.ledger.sessionId());
        assert.ok(ev.some((e) => e.type === "switchCommitted"), ev.map((e) => e.type).join());
        assert.deepEqual(ev.map((e) => e.seq), ev.map((_, i) => i + 1), "seq whole");
      }
      const ix = readIndex();
      assert.ok(ix.revision >= rev + 2, `${rev} → ${ix.revision}`);
      assert.notEqual(one.ledger.sessionId(), two.ledger.sessionId());
      for (const w of [one, two]) assert.equal(ix.sessions[w.ledger.sessionId()].binding.threadId, w.session.state.thread.id);
    });
  });
});

// ---- Review P4.2 ----

// A target engine whose thread/start the test can intercept (the real one underneath).
const intercept = (e, startThread) =>
  new Proxy(e, {
    get(target, key) {
      if (key === "startThread") return (o) => startThread(o, (x) => target.startThread(x));
      const v = Reflect.get(target, key, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });

test("a turn the old thread starts while the new one is being bound is stopped; the switch still commits", async () => {
  let wrap = null;
  await withRig(async ({ session, runner, ledger, engine, done }) => {
    await session.submit("early-complete").done;
    const old = session.state.thread.id;
    wrap = (e) =>
      intercept(e, async (o, real) => {
        await engine.testRequest("test/start-turn", { threadId: old });
        await until(() => session.state.activeTurnId, "the self-started turn");
        return real(o);
      });
    runner.request(C_HOME, { mode: "now" });
    await until(done, "the switch");
    const ev = readLedger(ledger.sessionId());
    assert.ok(ev.some((e) => e.type === "switchCommitted"), ev.map((e) => e.type).join());
    assert.ok(!ev.some((e) => e.type === "switchAborted"));
    assert.equal(session.state.config.homeKey, "a/cccc");
    assert.ok((await debug(engine)).calls.includes("turn/interrupt"));
  }, { wrapTarget: (e) => wrap(e) });
});

test("a fork keeps the old live terminals listed and its note names them", async () => {
  await withRig(async ({ session, runner, engine, done }) => {
    await session.submit("early-complete").done;
    session.state.terminals.set("bg@t", { key: "bg@t", itemId: "bg", command: "npm run dev", lines: [] });
    runner.request(B_FORK, { mode: "wait" });
    await until(done, "the switch");
    assert.deepEqual(session.state.priorTerminals.map((t) => t.command), ["npm run dev"]);
    const injected = JSON.stringify((await debug(engine)).lastParams["thread/inject_items"]);
    assert.match(injected, /Still running from before the switch[^"]*npm run dev/);
  });
});

test("an abort after the target's engine started lets that engine go", async () => {
  await withRig(async ({ session, runner, done, prepared }) => {
    await session.submit("early-complete").done;
    runner.request(C_HOME, { mode: "now" });
    await until(done, "the abort");
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0].released(), 1);
    assert.equal(session.state.config.homeKey, "api", "still on the old target");
  }, { wrapTarget: (e) => intercept(e, async () => { throw Object.assign(new Error("no thread"), { reason: "engine" }); }) });
});

test("a continuation whose new thread answers with another provider aborts as 'kept' and archives it", async () => {
  await withRig(async ({ session, runner, ledger, done, notices, prepared }) => {
    await session.submit("early-complete").done;
    runner.request(C_HOME, { mode: "now" });
    await until(done, "the abort");
    assert.ok(readLedger(ledger.sessionId()).some((e) => e.type === "switchAborted" && e.reason === "kept"));
    assert.ok(notices.some((n) => /the engine kept the old provider/.test(n.text)));
    assert.equal(prepared[0].released(), 1);
    assert.ok((await debug(prepared[0].engine)).calls.includes("thread/archive"));
  }, { wrapTarget: (e) => intercept(e, async (o, real) => ({ ...(await real(o)), modelProvider: "someone-else" })) });
});

test("mode wait: a turn that fails to start doesn't leave the switch waiting forever", async () => {
  await withRig(async ({ session, runner, done }) => {
    await session.submit("early-complete").done;
    const s = session.submit("reject-slow");
    assert.equal(session.state.starting, true);
    runner.request(C_HOME, { mode: "wait" });
    await s.accepted.catch(() => {});
    await until(done, "the switch", 5000);
    assert.equal(session.state.config.homeKey, "a/cccc");
    assert.equal(session.state.held, false);
  });
});

test("two quick switches with an active goal: the goal still comes back after the first turn on the last target", async () => {
  await withRig(async ({ session, runner, engines, done }) => {
    await session.submit("fail-turn").done;
    await session.engine.threads.goal.set(session.state.thread.id, "ship it", { status: "active" });
    runner.request(B_FORK, { mode: "wait" });
    await until(done, "the first switch");
    runner.request(C_HOME, { mode: "wait" });
    await until(done, "the second switch");
    const target = engines.at(-1);
    const tid = session.state.thread.id;
    assert.equal((await target.threads.goal.get(tid))?.status, "paused");
    await session.submit("fail-turn").done;
    await until(async () => (await target.threads.goal.get(tid))?.status === "active", "the goal back");
  });
});

test("a request right after a commit waits for its effects: the second switch isn't un-held halfway", async () => {
  await withRig(async ({ session, runner, done }) => {
    await session.submit("early-complete").done;
    runner.request(B_FORK, { mode: "wait" });
    await until(() => runner.state().state === "RUNNING" && session.state.config.modelProvider === "ad-or-b", "the first commit");
    runner.request(C_HOME, { mode: "wait" });
    await until(() => done() && session.state.config.homeKey === "a/cccc", "the second switch");
    assert.equal(session.state.held, false);
  });
});

test("terminals left by an earlier fork keep the old engine: a continuation away from it releases it only when the window closes", async () => {
  await withRig(async ({ session, runner, done, oldReleased }) => {
    await session.submit("early-complete").done;
    session.state.terminals.set("bg@t", { key: "bg@t", itemId: "bg", command: "npm run dev", lines: [] });
    runner.request(B_FORK, { mode: "wait" });
    await until(done, "the fork");
    assert.equal(session.state.priorTerminals.length, 1);
    runner.request(C_HOME, { mode: "wait" });
    await until(() => done() && session.state.config.homeKey === "a/cccc", "the continuation");
    assert.equal(oldReleased(), 0, "the old engine still runs npm run dev");
    await runner.dispose();
    assert.equal(oldReleased(), 1);
  });
});

test("a goal still waiting to come back keeps waiting when the next switch aborts", async () => {
  let failNext = false;
  await withRig(async ({ session, runner, engine, done, notices }) => {
    await session.submit("fail-turn").done;
    await engine.threads.goal.set(session.state.thread.id, "ship it", { status: "active" });
    runner.request(B_FORK, { mode: "wait" });
    await until(done, "the fork");
    const fork = session.state.thread.id;
    assert.equal((await engine.threads.goal.get(fork))?.status, "paused");
    failNext = true;
    runner.request(C_HOME, { mode: "wait" });
    await until(() => done() && notices.some((n) => /Couldn't switch to OpenAI · c · gpt-x/.test(n.text)), "the abort");
    assert.equal(session.state.thread.id, fork, "still on the fork");
    assert.equal((await engine.threads.goal.get(fork))?.status, "paused", "not set active on an idle thread");
    await session.submit("fail-turn").done;
    await until(async () => (await engine.threads.goal.get(fork))?.status === "active", "back after the first turn");
  }, { wrapTarget: (e) => intercept(e, async (o, real) => { if (failNext) throw Object.assign(new Error("no"), { reason: "engine" }); return real(o); }) });
});

// ---- P4.5 B1: the runner's policy path ----

const CONTINUATION = "[ad: automatic continuation] go on";

test("a policy switch shows the fallback line, queues ad's continuation first and once, recorded as ad's", async () => {
  await withRig(async ({ session, runner, ledger, done, notices }) => {
    await session.submit("fail-turn").done;
    runner.request(B_FORK, { reason: "policy", fallback: { line: "\u{21aa} Switched to B: test. Fallback 1 of 3.", continuation: CONTINUATION } });
    session.submit("after"); // queued while the switch holds
    await until(done, "the switch");
    // ad's continuation just answers (the fake's continuation script); "after" asks the fake's
    // approval before completing.
    await until(() => session.state.requests.length === 1, "the approval of the queued prompt");
    session.resolve(session.state.requests[0].request.id, "accept");
    await until(() => readLedger(ledger.sessionId()).some((e) => e.type === "userMessage" && e.text === "after"), "the queued prompt to run on the fork");
    const users = readLedger(ledger.sessionId()).filter((e) => e.type === "userMessage");
    assert.deepEqual(
      users.filter((u) => u.via === "ad" || u.text === "after").map((u) => u.text),
      [CONTINUATION, "after"],
      "the continuation runs first, once",
    );
    assert.equal(users.filter((u) => u.text === CONTINUATION).length, 1, "the continuation queues exactly once");
    assert.ok(users.some((u) => u.via === "ad"), "the continuation is recorded as ad's");
    assert.equal(readLedger(ledger.sessionId()).filter((e) => e.type === "turnStarted" && e.trigger === "ad").length, 1, "its turn is ad's");
    assert.ok(notices.some((n) => n.line && n.text === "\u{21aa} Switched to B: test. Fallback 1 of 3."), JSON.stringify(notices));
    await runner.settled();
    assert.deepEqual(runner.lastOutcome(), { kind: "committed", reason: "policy" });
  });
});

test("a user switch is unchanged: COMMIT words, no continuation unless mode now", async () => {
  await withRig(async ({ session, runner, ledger, done, notices }) => {
    await session.submit("fail-turn").done;
    runner.request(B_FORK, { mode: "wait" }); // the user's own words, no fallback
    session.submit("after");
    await until(done, "the switch");
    await until(() => session.state.requests.length === 1, "the approval of the queued prompt");
    session.resolve(session.state.requests[0].request.id, "accept");
    await until(() => readLedger(ledger.sessionId()).some((e) => e.type === "userMessage" && e.text === "after"), "the queued prompt to run on the fork");
    assert.ok(notices.some((n) => n.line && n.text === "Switched to OpenRouter · b · fake-model (you asked). History kept."), JSON.stringify(notices));
    const ev = readLedger(ledger.sessionId());
    const users = ev.filter((e) => e.type === "userMessage");
    assert.ok(!users.some((u) => u.via === "ad" || (u.text ?? "").includes(CONTINUATION)), "nothing was queued for the user");
    assert.ok(!ev.some((e) => e.type === "turnStarted" && e.trigger === "ad"), "no turn marked as ad's");
    assert.equal(users.filter((u) => u.text === "after").length, 1);
    await runner.settled();
    assert.deepEqual(runner.lastOutcome(), { kind: "committed", reason: "user" });
  });
});

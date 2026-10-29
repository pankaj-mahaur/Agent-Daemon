// P4.5 step 6 on the pinned engine (AD_REAL_ENGINE=1): automatic fallback against providers that
// fail at chosen points (testkit/fault-responses.mjs), through ad's gateway, the session, the
// ledger, the switch runner and the fallback controller, in throwaway homes. Three targets in
// the user's order:
//   A  OpenRouter · a   (this window starts here, home "api")
//   B  OpenAI · b       (another home: a continuation carries ad's capsule)
//   C  OpenRouter · c   (a fork on A's engine; A's provider, so never right after A's limit)
// Each case asserts the ledger, the marker count (a tool never runs twice), switch or pause,
// and what B's request carried.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const skip = process.env.AD_REAL_ENGINE === "1" ? false : "set AD_REAL_ENGINE=1 to run the real engine";
const TIMEOUT = 300_000;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-fallback-real-"));
const saved = { AD_ROOT: process.env.AD_ROOT, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, AD_FALLBACK: process.env.AD_FALLBACK };
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;
delete process.env.AD_FALLBACK;
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

const { resolveCodexCommand } = await import("../src/engine/codex/app-server.mjs");
const { createEngine } = await import("../src/engine/index.mjs");
const { createSession } = await import("../src/harness/session.mjs");
const { createCoordinator, ledgerHome, ledgerTarget } = await import("../src/sessions/coordinator.mjs");
const { createSwitchRunner } = await import("../src/sessions/switch-runner.mjs");
const { readLedger } = await import("../src/sessions/ledger.mjs");
const { createFallbackController } = await import("../src/sessions/fallback-controller.mjs");
const { FALLBACK_RUN_TEXTS: TXT } = await import("../src/sessions/fallback.mjs");
const { classifyTurnError, classifyUpstream } = await import("../src/providers/errors.mjs");
const { benchProvider, benchKey, benchedUntil } = await import("../src/providers/quota.mjs");
const { enablePolicy, readPolicy, updatePolicy } = await import("../src/routing/store.mjs");
const { startGateway } = await import("../src/gateway/client.mjs");
const { TOKEN_HIDDEN_ARGS } = await import("../src/gateway/table.mjs");
const { startFaultProvider, fault, PROBES, refusedUrl } = await import("../testkit/fault-responses.mjs");
const { createUnattendedRun } = await import("../src/harness/unattended-run.mjs");

const KEYS = { acct_a: ["sk", "test", "AAAAaaaa1111AAAAaaaa1111"].join("-"), acct_b: ["sk", "test", "BBBBbbbb2222BBBBbbbb2222"].join("-"), acct_c: ["sk", "test", "CCCCcccc3333CCCCcccc3333"].join("-") };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, what, ms = 150_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const acct = (o) => ({ owner: "", status: "ready", method: "api-key", credential: { kind: "secret", ref: `ad-account-${o.id}` }, keyHint: "1111", credentialRevision: 1, endpoint: null, defaultModel: null, identity: null, ...o });
const ENTRY = { acct_a: "ad-or-a", acct_b: "ad-oa-b", acct_c: "ad-or-c" };
const RUNNER = {
  acct_a: { modelProvider: ENTRY.acct_a, homeKey: "api", provider: "openrouter", model: "mock-model", passthrough: true, label: "OpenRouter · a · mock-model", key: "acct_a/openrouter/mock-model/-" },
  acct_b: { modelProvider: ENTRY.acct_b, homeKey: "b/bbbb", provider: "openai", model: "mock-model", passthrough: true, label: "OpenAI · b · mock-model", key: "acct_b/openai/mock-model/-" },
  acct_c: { modelProvider: ENTRY.acct_c, homeKey: "api", provider: "openrouter", model: "mock-model", passthrough: true, label: "OpenRouter · c · mock-model", key: "acct_c/openrouter/mock-model/-" },
};
const ORDER = [{ account: "acct_a", model: "mock-model" }, { account: "acct_b", model: "mock-model" }, { account: "acct_c", model: "mock-model" }];

// A CODEX_HOME whose providers are ad's gateway routes, with production's bounded retries.
function writeHome(home, gw) {
  fs.mkdirSync(home, { recursive: true });
  const provider = (entry) => [`[model_providers.${entry}]`, `name = "${entry}"`, `base_url = "${gw.baseUrlFor(entry)}"`, 'env_key = "AD_GATEWAY_TOKEN"', 'wire_api = "responses"', "request_max_retries = 1", "stream_max_retries = 1", "supports_websockets = false", ""];
  const lines = ['model = "mock-model"', 'approval_policy = "on-request"', 'sandbox_mode = "workspace-write"', `model_provider = "${ENTRY.acct_a}"`, "check_for_update_on_startup = false", 'cli_auth_credentials_store = "file"', "", "[features]", "plugins = false", "apps = false", "shell_snapshot = false", "unbounded_connection_retries = false", "", ...Object.values(ENTRY).flatMap(provider)];
  if (process.platform === "win32") lines.push("[windows]", 'sandbox = "unelevated"', "");
  fs.writeFileSync(path.join(home, "config.toml"), lines.join("\n"));
}

/**
 * One world: three fault providers, ad's gateway, a policy, and windows on account A.
 * o.accounts: account overrides by id; o.upstream: a provider URL override by id;
 * o.paid: account ids whose catalog price is not free.
 */
async function withWorld(fn, { policyPatch = {}, accounts: accountPatch = {}, upstream = {}, paid = [] } = {}) {
  const root = fs.mkdtempSync(path.join(TMP, "w-"));
  const adRoot = path.join(root, ".agent-daemon");
  process.env.AD_ROOT = adRoot;
  const ACCOUNTS = [acct({ id: "acct_a", provider: "openrouter", label: "a" }), acct({ id: "acct_b", provider: "openai", label: "b" }), acct({ id: "acct_c", provider: "openrouter", label: "c" })].map((a) => ({ ...a, ...(accountPatch[a.id] ?? {}) }));
  const byId = (id) => ACCOUNTS.find((a) => a.id === id);
  const at = new Date().toISOString();
  const free = { input: "0", output: "0", observedAt: at };
  const price = { input: "0.000001", output: "0.000002", observedAt: at };
  const catalog = (id, model) => (byId(id) ? { accountId: id, provider: byId(id).provider, model, caps: { tools: true, contextWindow: 128000 }, price: paid.includes(id) ? price : free, billing: "metered", data: {} } : null);
  const routing = () => ({ accounts: ACCOUNTS, catalog, now: Date.now(), root: adRoot });
  await updatePolicy((p) => Object.assign(p, { targets: ORDER, ...policyPatch }), routing());
  await enablePolicy(routing());

  const P = {
    acct_a: await startFaultProvider({ personality: "openrouter", keys: [KEYS.acct_a] }),
    acct_b: await startFaultProvider({ personality: "openai", keys: [KEYS.acct_b] }),
    acct_c: await startFaultProvider({ personality: "openrouter", keys: [KEYS.acct_c] }),
  };
  const table = new Map(Object.entries(ENTRY).map(([id, entry]) => [entry, { accountId: id, provider: byId(id).provider, upstreamBase: upstream[id] ?? P[id].url, mode: "passthrough", auth: { kind: "static-key", scheme: "bearer" }, headers: {}, allowHttp: true, label: byId(id).label }]));
  const gw = await startGateway({ table, getKeys: async () => KEYS });
  const engines = [];
  const windows = [];

  async function openWindow(name = "w1") {
    const cwd = path.join(root, name, "work");
    fs.mkdirSync(cwd, { recursive: true });
    const engineIn = async (homeKey) => {
      const home = path.join(root, name, homeKey.replace("/", "-"));
      writeHome(home, gw);
      const e = await createEngine({ home, cwd, command: resolveCodexCommand({}), clientVersion: "test", experimental: true, env: { AD_GATEWAY_TOKEN: gw.token }, engineArgs: [...TOKEN_HIDDEN_ARGS] });
      engines.push(e);
      return e;
    };
    const engine = await engineIn("api");
    const notices = [];
    let session;
    let runner;
    let controller;
    const ledger = createCoordinator({ cwd, origin: "tui", homeKey: () => ledgerHome(session?.state.config.homeKey), targetOf: () => ledgerTarget({ provider: session.state.config.provider, model: session.state.config.model }) });
    const currentId = () => Object.keys(RUNNER).find((k) => RUNNER[k].modelProvider === session.state.config.modelProvider) ?? "acct_a";
    const events = () => (ledger.sessionId() ? readLedger(ledger.sessionId()) : []);
    const deps = () => ({
      session,
      ledger,
      runner,
      policy: () => readPolicy({ root: adRoot, lenient: true }),
      routing,
      current: () => ({ account: byId(currentId()), model: "mock-model", label: RUNNER[currentId()].label }),
      toSwitchTarget: async (t) => RUNNER[t.account] ?? null,
      // As main.mjs's classifyTurnFailure: the gateway's last failed answer during the turn.
      classify: ({ error, status, threadId, startedAt, fallbackInterrupt }) => {
        const inTurn = (o) => o && Number.isFinite(startedAt) && Date.parse(o.at) >= startedAt;
        const t = gw.lastFailureForThread(threadId);
        const a = gw.lastFailure(currentId());
        const observation = inTurn(t) ? { ...t, by: "thread" } : inTurn(a) ? { ...a, by: "account" } : null;
        return classifyTurnError({ error, status, observation, accountKind: "api", fallbackInterrupt });
      },
      retryObservation: (threadId, sinceMs) => {
        const o = gw.lastFailureForThread(threadId);
        return o && Number.isFinite(sinceMs) && Date.parse(o.at) >= sinceMs ? classifyUpstream(o) : null;
      },
      bench: ({ provider, accountId, until: u, reason }) => benchProvider(benchKey(provider, accountId), { until: u, reason, accountId }, { root: adRoot }),
      events,
      notify: (level, text, o) => notices.push({ level, text, ...o }),
      env: {},
    });
    session = createSession({
      engine,
      cwd,
      lockDir: path.join(root, name, "locks"),
      modelProvider: ENTRY.acct_a,
      homeKey: "api",
      provider: "openrouter",
      model: "mock-model",
      hooks: { turnCompleted: (x) => controller?.turnCompleted(x) },
      observer: (ev) => {
        runner?.onEvent(ev);
        controller?.onEvent(ev);
        return ledger.observer(ev);
      },
    });
    // Nobody at the keyboard: every approval is accepted as it arrives.
    session.on("change", () => {
      for (const r of [...session.state.requests]) session.resolve(r.request.id, "accept");
    });
    runner = createSwitchRunner({
      session,
      ledger,
      current: () => ({ ...RUNNER[currentId()], ...session.state.config, passthrough: true, label: RUNNER[currentId()].label }),
      prepare: async (t) => (t.homeKey === session.state.config.homeKey ? { sameEngine: true } : { engine: await engineIn(t.homeKey), sameEngine: false, release: async () => {} }),
      notify: (level, text, o) => notices.push({ level, text, ...o }),
      ask: () => runner.answer("anyway"),
    });
    controller = createFallbackController(deps());
    await session.init?.();
    const w = {
      name,
      cwd,
      session,
      runner,
      ledger,
      notices,
      events,
      currentId,
      controller: () => controller,
      restart: () => {
        controller.dispose();
        controller = createFallbackController(deps());
        return controller;
      },
      marker: () => (fs.existsSync(path.join(cwd, "marker.txt")) ? fs.readFileSync(path.join(cwd, "marker.txt"), "utf8").split(/\r?\n/).filter((l) => l.trim()).length : 0),
      // The episode is over: switched and ad's continuation finished, or paused, or nothing to do.
      settled: async () => {
        await until(() => !session.state.activeTurnId && !session.state.starting && runner.state().state === "RUNNING", `${name} idle`);
        await controller.settled?.();
        await until(() => !session.state.activeTurnId && !session.state.starting && runner.state().state === "RUNNING" && !runner.pending?.(), `${name} idle after the episode`);
      },
      close: async () => {
        controller.dispose();
        await runner.dispose();
        session.close();
        await ledger.close();
      },
    };
    windows.push(w);
    return w;
  }

  // P4.7: an unattended run (ad run --fallback's runner) on account A, nobody at the keyboard.
  async function openRun(name = "u1") {
    const cwd = path.join(root, name, "work");
    fs.mkdirSync(cwd, { recursive: true });
    const engineIn = async (homeKey) => {
      const home = path.join(root, name, homeKey.replace("/", "-"));
      writeHome(home, gw);
      const e = await createEngine({ home, cwd, command: resolveCodexCommand({}), clientVersion: "test", experimental: true, env: { AD_GATEWAY_TOKEN: gw.token }, engineArgs: [...TOKEN_HIDDEN_ARGS] });
      engines.push(e);
      return e;
    };
    const engine = await engineIn("api");
    let session;
    const idNow = () => Object.keys(RUNNER).find((k) => RUNNER[k].modelProvider === session.state.config.modelProvider) ?? "acct_a";
    const accounts = {
      current: () => byId(idNow()),
      currentTarget: () => ({ ...RUNNER[idNow()], ...session.state.config, passthrough: false, account: byId(idNow()), label: RUNNER[idNow()].label }),
      targetFor: (a) => ({ ...RUNNER[a.id], account: a }),
      prepare: async (t) => (t.homeKey === session.state.config.homeKey ? { sameEngine: true } : { engine: await engineIn(t.homeKey), sameEngine: false, release: async () => {} }),
    };
    const err = { text: "", write(s) { this.text += s; return true; } };
    const run = createUnattendedRun({
      started: { engine, params: { model: "mock-model", modelProvider: ENTRY.acct_a }, homeKey: "api", target: { account: byId("acct_a") } },
      cwd,
      origin: "run",
      adRoot,
      err,
      env: {},
      accounts: (s) => ((session = s), accounts),
      deps: {
        policy: () => readPolicy({ root: adRoot, lenient: true }),
        routing,
        classify: ({ error, status, threadId, startedAt, fallbackInterrupt }) => {
          const inTurn = (o) => o && Number.isFinite(startedAt) && Date.parse(o.at) >= startedAt;
          const t = gw.lastFailureForThread(threadId);
          const a = gw.lastFailure(idNow());
          const observation = inTurn(t) ? { ...t, by: "thread" } : inTurn(a) ? { ...a, by: "account" } : null;
          return classifyTurnError({ error, status, observation, accountKind: "api", fallbackInterrupt });
        },
        retryObservation: (threadId, sinceMs) => {
          const o = gw.lastFailureForThread(threadId);
          return o && Number.isFinite(sinceMs) && Date.parse(o.at) >= sinceMs ? classifyUpstream(o) : null;
        },
        bench: ({ provider, accountId, until: u, reason }) => benchProvider(benchKey(provider, accountId), { until: u, reason, accountId }, { root: adRoot }),
      },
    });
    windows.push({ close: () => run.close() });
    return { run, cwd, err, marker: () => (fs.existsSync(path.join(cwd, "marker.txt")) ? fs.readFileSync(path.join(cwd, "marker.txt"), "utf8").split(/\r?\n/).filter((l) => l.trim()).length : 0) };
  }

  try {
    await fn({ P, gw, adRoot, openWindow, openRun, routing });
  } finally {
    for (const w of windows) await w.close().catch(() => {});
    for (const e of engines) await e.close().catch(() => {});
    await gw.close();
    for (const p of Object.values(P)) await p.close();
  }
}

const routeFailures = (w) => w.events().filter((e) => e.type === "routeFailure");
const lineTexts = (w) => w.notices.filter((n) => n.line).map((n) => n.text);
const adTurnsDone = (w) => w.events().filter((e) => e.type === "turnCompleted" && e.status === "completed" && e.trigger === "ad").length;
const continuationDone = (w) => {
  const p = w.controller().state().paused;
  if (p) throw new Error(`paused instead (${p.code}): ${p.text}`);
  return w.events().some((e) => e.type === "turnStarted" && e.trigger === "ad") && w.events().filter((e) => e.type === "turnCompleted").length >= 2;
};

async function runTurn(w, text) {
  w.session.submit(text);
  await until(() => w.events().some((e) => e.type === "turnCompleted"), `${text}'s first turn`);
  await w.settled();
}

test("F1 quota before the first byte: switch at the boundary to B; nothing ran", { skip, timeout: TIMEOUT }, async () => {
  await withWorld(async ({ P, openWindow }) => {
    const w = await openWindow();
    P.acct_a.schedule("EXEC F1", [fault.quota()]);
    await runTurn(w, "EXEC F1");
    await until(() => continuationDone(w), "ad's continuation");
    assert.equal(routeFailures(w).length, 1);
    assert.equal(w.currentId(), "acct_b", JSON.stringify(lineTexts(w)));
    assert.ok(P.acct_b.requests.length >= 1, "B served ad's continuation");
    assert.ok(P.acct_b.requests[0].texts.some((t) => t.includes("[ad: automatic continuation]")), "ad's continuation reached B");
    assert.ok(!P.acct_b.requests.some((r) => r.hasEncryptedReasoning), "never A's reasoning on B");
    // A got nothing on the probe, so B runs it, once: the work continues.
    assert.equal(w.marker(), 1);
  });
});

test("F2 a short rate limit with Retry-After: 1: the engine waits, retries once and finishes on A; no switch", { skip, timeout: TIMEOUT }, async () => {
  await withWorld(async ({ P, openWindow }) => {
    const w = await openWindow();
    P.acct_a.schedule("PING F2", [fault.rate(1)]);
    await runTurn(w, "PING F2");
    assert.equal(w.events().filter((e) => e.type === "turnCompleted").at(-1).status, "completed");
    assert.equal(routeFailures(w).length, 0);
    assert.equal(w.currentId(), "acct_a");
    assert.equal(P.acct_a.forMarker("PING F2").length, 2, "the 429, then the retry");
    assert.equal(P.acct_b.requests.length, 0);
  });
});

test("F3 the stream fails mid-text (a retried code), the retry gets a free-per-day 429: switch, and A's provider is benched", { skip, timeout: TIMEOUT }, async () => {
  await withWorld(async ({ P, openWindow, adRoot }) => {
    const w = await openWindow();
    P.acct_a.schedule("PING F3", [fault.sseFailed(undefined, { afterText: "partial ans" }), fault.freePerDay()]);
    await runTurn(w, "PING F3");
    await until(() => continuationDone(w), "ad's continuation");
    assert.equal(w.currentId(), "acct_b");
    assert.equal(P.acct_a.forMarker("PING F3").length, 2, "the cut stream and the engine's one retry");
    assert.ok(benchedUntil(benchKey("openrouter", "acct_a"), { root: adRoot }), "A's provider is benched");
    assert.equal(P.acct_c.requests.length, 0, "never A's provider's other account");
  });
});

test("F4 the stream dies after a tool call is emitted, the retry gets a quota error: the tool ran once, B reads it as done; marker 1, never 2", { skip, timeout: TIMEOUT }, async () => {
  await withWorld(async ({ P, openWindow }) => {
    const w = await openWindow();
    P.acct_a.schedule("EXEC F4", [fault.afterToolCallEmitted(PROBES.EXEC), fault.quota()]);
    await runTurn(w, "EXEC F4");
    await until(() => continuationDone(w), "ad's continuation");
    assert.equal(w.currentId(), "acct_b");
    assert.equal(w.marker(), 1, "the tool ran once");
    const onB = P.acct_b.requests[0];
    assert.ok(onB.texts.some((t) => /\[done\] \$ .*marker\.txt/.test(t)), JSON.stringify(onB.texts));
    assert.ok(P.acct_b.requests.every((r) => !r.emitted.includes(PROBES.EXEC.callId)), "B never ran it again");
  });
});

test("F5 the request carrying a tool's result gets a quota error: switch; B sees the result; marker 1", { skip, timeout: TIMEOUT }, async () => {
  await withWorld(async ({ P, openWindow }) => {
    const w = await openWindow();
    P.acct_a.schedule("EXEC F5", [fault.ok(), fault.quota()]);
    await runTurn(w, "EXEC F5");
    await until(() => continuationDone(w), "ad's continuation");
    assert.equal(w.currentId(), "acct_b");
    assert.equal(w.marker(), 1);
    assert.ok(P.acct_b.requests[0].texts.some((t) => /\[done\] \$ .*marker\.txt/.test(t)));
    assert.ok(P.acct_b.requests.every((r) => !r.emitted.includes(PROBES.EXEC.callId)));
  });
});

test("F6 F4 with the write probe: made.txt is created once", { skip, timeout: TIMEOUT }, async () => {
  await withWorld(async ({ P, openWindow }) => {
    const w = await openWindow();
    P.acct_a.schedule("WRITE F6", [fault.afterToolCallEmitted(PROBES.WRITE), fault.quota()]);
    await runTurn(w, "WRITE F6");
    await until(() => continuationDone(w), "ad's continuation");
    assert.equal(w.currentId(), "acct_b");
    assert.equal(fs.readFileSync(path.join(w.cwd, "made.txt"), "utf8").trim(), "made once");
    assert.ok(P.acct_b.requests.every((r) => !r.emitted.includes(PROBES.WRITE.callId)), "B never wrote it again");
  });
});

test("F7 a 429 with Retry-After: 3600: the gateway's cap fails the turn at once, and fallback switches", { skip, timeout: TIMEOUT }, async () => {
  await withWorld(async ({ P, openWindow }) => {
    const w = await openWindow();
    P.acct_a.schedule("PING F7", [fault.rate(3600)]);
    const t0 = Date.now();
    w.session.submit("PING F7");
    await until(() => routeFailures(w).length === 1, "the route failure", 30_000);
    assert.ok(Date.now() - t0 < 10_000, `no engine sleep: ${Date.now() - t0} ms`);
    await w.settled();
    await until(() => continuationDone(w), "ad's continuation");
    assert.equal(w.currentId(), "acct_b");
    assert.equal(routeFailures(w)[0].failure.class, "rateLimit");
  });
});

// The plan's "B paid under freeOnly" can't be set up: P4.4's rules refuse a paid target in a
// free-only order. The same pause comes from no other target being able to take over.
test("F7 with no other target able to take over: pause, saying when A resets (from the 3600 s header)", { skip, timeout: TIMEOUT }, async () => {
  await withWorld(async ({ P, openWindow }) => {
    const w = await openWindow();
    P.acct_a.schedule("PING F7p", [fault.rate(3600)]);
    const t0 = Date.now();
    await runTurn(w, "PING F7p");
    await until(() => w.controller().state().paused, "the pause");
    assert.ok(Date.now() - t0 < 10_000, `no engine sleep: ${Date.now() - t0} ms`);
    assert.equal(w.currentId(), "acct_a", "nothing moved");
    assert.equal(w.controller().state().paused.code, "noneLeft");
    const paused = w.notices.find((n) => n.text.startsWith("\u{23f8} Paused"));
    assert.match(paused?.text ?? "", /resets \d{2}:\d{2}/, JSON.stringify(w.notices));
    assert.equal(P.acct_b.requests.length, 0);
  }, { accounts: { acct_b: { status: "needs-sign-in" } } });
});

test("F7b a retry notice whose Retry-After (45 s) is past the 20 s budget: ad interrupts the turn, A gets nothing more, and fallback switches", { skip, timeout: TIMEOUT }, async () => {
  await withWorld(async ({ P, openWindow }) => {
    const w = await openWindow();
    P.acct_a.schedule("PING F7b", [fault.rate(45)]);
    const t0 = Date.now();
    w.session.submit("PING F7b");
    await until(() => w.events().some((e) => e.type === "fallbackInterrupt"), "ad's interrupt", 40_000);
    const interruptedAt = Date.now();
    assert.ok(interruptedAt - t0 < 30_000, `inside the budget: ${interruptedAt - t0} ms`);
    await w.settled();
    await until(() => continuationDone(w), "ad's continuation");
    assert.equal(w.currentId(), "acct_b");
    assert.equal(P.acct_a.forMarker("PING F7b").length, 1, "the 429 only: no retry reached A after the interrupt");
    assert.equal(routeFailures(w)[0].failure.class, "rateLimit");
  }, { policyPatch: { recoveryBudgetMs: 20_000 } });
});

test("F8 every target out of quota: pause after maxHops; a restart mid-episode stays paused with its hops", { skip, timeout: TIMEOUT }, async () => {
  await withWorld(async ({ P, openWindow }) => {
    const w = await openWindow();
    P.acct_a.schedule("PING F8", [fault.quota()]);
    P.acct_b.schedule("automatic continuation", [fault.quota(), fault.quota()]);
    await runTurn(w, "PING F8");
    await until(() => w.controller().state().paused, "the pause");
    assert.equal(w.currentId(), "acct_b", "one hop, then the cap");
    const before = w.controller().state().episode;
    assert.equal(before.hops, 1);
    w.session.hold(false);
    const again = w.restart();
    assert.equal(again.state().episode.id, before.id);
    assert.equal(again.state().episode.hops, 1);
    assert.ok(again.state().paused, "still paused");
    assert.equal(P.acct_c.requests.length, 0);
  }, { policyPatch: { maxHops: 1 } });
});

test("F9 B needs sign-in: skipped; C is A's provider; so fallback pauses and A's conversation is intact", { skip, timeout: TIMEOUT }, async () => {
  await withWorld(async ({ P, openWindow }) => {
    const w = await openWindow();
    P.acct_a.schedule("PING F9", [fault.quota()]);
    await runTurn(w, "PING F9");
    await until(() => w.controller().state().paused, "the pause");
    assert.equal(w.currentId(), "acct_a");
    assert.equal(w.controller().state().paused.code, "noneLeft");
    assert.equal(P.acct_b.requests.length + P.acct_c.requests.length, 0);
    assert.ok(w.session.state.thread?.id, "the conversation is still there");
  }, { accounts: { acct_b: { status: "needs-sign-in" } } });
});

test("F10 401: no fallback; the turn fails with the sign-in message", { skip, timeout: TIMEOUT }, async () => {
  await withWorld(async ({ P, openWindow }) => {
    const w = await openWindow();
    P.acct_a.schedule("PING F10", [fault.unauthorized(), fault.unauthorized()]);
    await runTurn(w, "PING F10");
    assert.equal(w.events().filter((e) => e.type === "turnCompleted").at(-1).status, "failed");
    assert.equal(routeFailures(w).length, 0);
    assert.equal(w.currentId(), "acct_a");
    assert.equal(w.controller().state().paused, null);
    assert.equal(P.acct_b.requests.length, 0);
  });
});

test("F11 an allowed background command still runs when the quota error comes: switch; B's request lists it as still running; B doesn't start it", { skip, timeout: TIMEOUT }, async () => {
  await withWorld(async ({ P, openWindow }) => {
    const w = await openWindow();
    P.acct_a.schedule("BGHOLD F11", [fault.ok(), fault.quota()]);
    await runTurn(w, "BGHOLD F11");
    await until(() => continuationDone(w), "ad's continuation");
    assert.equal(w.currentId(), "acct_b", JSON.stringify(w.notices));
    const onB = P.acct_b.requests[0];
    assert.ok(onB.stillRunning.some((l) => l.includes("marker.txt")), JSON.stringify(onB.texts));
    assert.ok(P.acct_b.requests.every((r) => !r.emitted.includes(PROBES.BGHOLD.callId)), "B never started it again");
    assert.equal(w.marker(), 1);
  }, { policyPatch: { allowRunningBackground: [PROBES.BGHOLD.keep] } });
});

test("F11b the same with a command not in the list: pause; no switch", { skip, timeout: TIMEOUT }, async () => {
  await withWorld(async ({ P, openWindow }) => {
    const w = await openWindow();
    P.acct_a.schedule("BGHOLD F11b", [fault.ok(), fault.quota()]);
    await runTurn(w, "BGHOLD F11b");
    await until(() => w.controller().state().paused, "the pause");
    assert.equal(w.controller().state().paused.code, "background");
    assert.equal(w.currentId(), "acct_a");
    assert.equal(P.acct_b.requests.length, 0);
    assert.equal(w.marker(), 1);
  });
});

test("F12 two windows on account A hit a quota error together: both switch to B, A's provider is benched once, neither picks its other account", { skip, timeout: TIMEOUT }, async () => {
  await withWorld(async ({ P, openWindow, adRoot }) => {
    const w1 = await openWindow("w1");
    const w2 = await openWindow("w2");
    P.acct_a.schedule("PING F12", [fault.quota(), fault.quota()]);
    w1.session.submit("PING F12");
    w2.session.submit("PING F12");
    for (const w of [w1, w2]) {
      await until(() => w.events().some((e) => e.type === "turnCompleted"), `${w.name}'s turn`);
      await w.settled();
      await until(() => continuationDone(w), `${w.name}'s continuation`);
      assert.equal(w.currentId(), "acct_b", w.name);
    }
    assert.ok(benchedUntil(benchKey("openrouter", "acct_a"), { root: adRoot }));
    assert.equal(P.acct_c.requests.length, 0, "never A's provider's other account");
  });
});

test("F13 connection refused with unbounded retries off: the turn fails within the retry budget, then fallback switches", { skip, timeout: TIMEOUT }, async () => {
  const refused = await refusedUrl("/api/v1");
  await withWorld(async ({ P, openWindow }) => {
    const w = await openWindow();
    const t0 = Date.now();
    w.session.submit("PING F13");
    await until(() => routeFailures(w).length === 1, "the route failure", 60_000);
    assert.ok(Date.now() - t0 < 60_000, `bounded: ${Date.now() - t0} ms`);
    await w.settled();
    await until(() => continuationDone(w), "ad's continuation");
    assert.equal(w.currentId(), "acct_b");
    assert.ok(["transientNetwork", "provider5xx"].includes(routeFailures(w)[0].failure.class), JSON.stringify(routeFailures(w)[0].failure));
  }, { upstream: { acct_a: refused } });
});

// ---- P4.7: unattended runs on the real engine ----------------------------------------------------

test("U1 ad run --fallback's runner, F1 on A: completes on B with nobody at the keyboard; the tool ran once", { skip, timeout: TIMEOUT }, async () => {
  await withWorld(async ({ P, openRun }) => {
    const u = await openRun();
    P.acct_a.schedule("EXEC U1", [fault.quota()]);
    const r = await u.run.turn("EXEC U1");
    assert.equal(r.status, "completed", u.err.text);
    assert.equal(r.target.account, "OpenAI · b");
    assert.equal(r.fallback.filter((e) => e.type === "switched").length, 1);
    assert.match(u.err.text, /\[ad\] \u{21aa} Switched to OpenAI · b · mock-model/u);
    assert.equal(u.marker(), 1);
  });
});

test("U3 every target exhausted: the run pauses within the budget (under 10 s), never waiting for a reset", { skip, timeout: TIMEOUT }, async () => {
  await withWorld(async ({ P, openRun }) => {
    const u = await openRun();
    P.acct_a.schedule("PING U3", [fault.quota()]);
    P.acct_b.schedule("automatic continuation", [fault.quota(), fault.quota()]);
    const t0 = Date.now();
    const r = await u.run.turn("PING U3");
    assert.equal(r.status, "paused", u.err.text);
    assert.ok(Date.now() - t0 < 10_000, `${Date.now() - t0} ms`);
    assert.match(r.sessionId, /^ses_/);
  }, { policyPatch: { maxHops: 1 } });
});

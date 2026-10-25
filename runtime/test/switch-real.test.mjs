// P4.2 on the pinned engine (AD_REAL_ENGINE=1): a conversation switched mid-task between two
// mock providers behind the gateway prototype, through the session, the ledger and the
// switch runner, in throwaway homes.
//   - a patch on A, then a fork-switch to B: B's first request carries the history; the file stays
//   - a continuation into a second home: B's first request has ad's note and no reasoning item
//   - a goal set on A, then a switch: no turn the user didn't start, on A or on B

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCodexCommand } from "../src/engine/codex/app-server.mjs";
import { writeMockCodexHome } from "../testkit/mock-responses.mjs";
import { startMockProvider } from "../testkit/mock-providers.mjs";
import { startGatewayProto } from "../testkit/gateway-proto.mjs";

const skip = process.env.AD_REAL_ENGINE === "1" ? false : "set AD_REAL_ENGINE=1 to run the real engine";
const TIMEOUT = 600_000;
const KEY_A = ["sk", "test", "AAAAaaaa1111AAAAaaaa1111"].join("-");
const KEY_B = ["sk", "test", "BBBBbbbb2222BBBBbbbb2222"].join("-");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, what, ms = 120_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};

async function withWorld(fn) {
  const root = mkdtempSync(join(tmpdir(), "ad-switch-real-"));
  const cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
  const saved = { AD_ROOT: process.env.AD_ROOT };
  process.env.AD_ROOT = join(root, ".agent-daemon");
  const A = await startMockProvider({ keys: [KEY_A] });
  const B = await startMockProvider({ keys: [KEY_B] });
  const gw = await startGatewayProto({ entries: { "ad-aaaa": { upstream: A.url, key: KEY_A }, "ad-bbbb": { upstream: B.url, key: KEY_B } } });
  const { createEngine } = await import("../src/engine/index.mjs");
  const { createSession } = await import("../src/harness/session.mjs");
  const { createCoordinator, ledgerHome, ledgerTarget } = await import("../src/sessions/coordinator.mjs");
  const { createSwitchRunner } = await import("../src/sessions/switch-runner.mjs");
  const engines = [];
  const engineIn = async (name) => {
    const home = join(root, name);
    writeMockCodexHome(home, { url: A.url, approvalPolicy: "on-request", sandboxMode: "workspace-write" });
    appendFileSync(join(home, "config.toml"), '\n[windows]\nsandbox = "unelevated"\n');
    const e = await createEngine({ home, cwd, command: resolveCodexCommand({}), clientVersion: "test", experimental: true, env: { AD_GATEWAY_TOKEN: gw.token }, engineArgs: ["-c", gw.providerConfig("ad-aaaa"), "-c", gw.providerConfig("ad-bbbb"), "-c", "thread_unload_delay_secs=0"] });
    engines.push(e);
    return e;
  };
  const engine = await engineIn("api");
  let session;
  let runner;
  const notices = [];
  const ledger = createCoordinator({ cwd, origin: "tui", homeKey: () => ledgerHome(session?.state.config.homeKey), targetOf: () => ledgerTarget({ provider: session.state.config.provider, model: session.state.config.model }) });
  session = createSession({
    engine,
    cwd,
    lockDir: join(root, "locks"),
    modelProvider: "ad-aaaa",
    homeKey: "api",
    provider: "openrouter",
    model: "mock-model",
    observer: (ev) => {
      runner?.onEvent(ev);
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
    current: () => ({ ...session.state.config, passthrough: true, label: "A" }),
    prepare: async (t) => (t.homeKey === "api" ? { sameEngine: true } : { engine: await engineIn(t.homeKey), sameEngine: false, release: async () => {} }),
    notify: (level, text, o) => notices.push({ level, text, ...o }),
    ask: () => runner.answer("anyway"),
  });
  try {
    await session.init?.();
    await fn({ A, B, cwd, session, runner, ledger, engine, engines, notices, done: () => runner.state().state === "RUNNING" });
  } finally {
    await runner.dispose();
    session.close();
    for (const e of engines) await e.close().catch(() => {});
    await ledger.close();
    for (const m of [A, B, gw]) await m.close();
    if (saved.AD_ROOT === undefined) delete process.env.AD_ROOT;
    else process.env.AD_ROOT = saved.AD_ROOT;
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

const B_FORK = { modelProvider: "ad-bbbb", homeKey: "api", provider: "openrouter", model: "mock-model", passthrough: true, label: "B", key: "b" };
const B_HOME = { modelProvider: "ad-bbbb", homeKey: "home2", provider: "other", model: "mock-model", passthrough: true, label: "B elsewhere", key: "b2" };

test("a patch on A, then a fork-switch to B: B's first request carries the history and the file stays", { skip, timeout: TIMEOUT }, async () => {
  await withWorld(async ({ A, B, cwd, session, runner, done, notices }) => {
    await session.submit("PATCH please").done;
    await until(() => existsSync(join(cwd, "hello.txt")), "the patch");
    runner.request(B_FORK, { mode: "wait" });
    await until(done, "the switch");
    assert.ok(notices.some((n) => n.line && /History kept\./.test(n.text)), JSON.stringify(notices));
    const before = A.requests.length;
    await session.submit("PING after the switch").done;
    const onB = B.requests.find((r) => r.text === "PING after the switch");
    assert.ok(onB, "B served the turn");
    assert.equal(onB.auth.matchesKey, 0);
    assert.ok(onB.userTexts.some((t) => t.includes("PATCH please")), "the history came along");
    assert.ok(onB.items.some((i) => i.type === "message" && i.role === "developer"), "ad's note");
    assert.equal(A.requests.length, before, "nothing more on A");
    assert.equal(readFileSync(join(cwd, "hello.txt"), "utf8").trim(), "hello from the mock");
  });
});

test("a continuation into a second home: B's first request has ad's note and the history, never a reasoning item", { skip, timeout: TIMEOUT }, async () => {
  await withWorld(async ({ A, B, session, runner, ledger, done, engines }) => {
    await session.submit("PING remember banana").done;
    await session.submit("PING and cherry").done;
    assert.ok(A.requests.some((r) => r.items.some((i) => i.type === "reasoning" && i.encrypted)), "A's own history has reasoning (so its absence on B means something)");
    runner.request(B_HOME, { mode: "wait" });
    await until(done, "the switch");
    assert.equal(session.engine, engines.at(-1));
    await session.submit("PING on the second home").done;
    const onB = B.requests.find((r) => r.text === "PING on the second home");
    assert.ok(onB, "B served the turn");
    assert.ok(!onB.items.some((i) => i.type === "reasoning" || i.encrypted), JSON.stringify(onB.items));
    assert.ok(onB.items.some((i) => i.type === "message" && i.role === "developer"));
    assert.ok(onB.userTexts.some((t) => t.includes("banana")), "the history, as messages");
    const { readLedger } = await import("../src/sessions/ledger.mjs");
    assert.deepEqual(readLedger(ledger.sessionId()).filter((e) => e.type === "bindingStarted").map((e) => e.binding.how), ["new", "continuation"]);
  });
});

test("a goal set on A, then a switch: no turn the user didn't start, on A or on B", { skip, timeout: TIMEOUT }, async () => {
  await withWorld(async ({ A, B, session, runner, engine, done }) => {
    await session.submit("PING base").done;
    const old = session.state.thread.id;
    await engine.threads.goal.set(old, "keep the fruit list", { status: "paused" });
    const a0 = A.requests.length;
    const b0 = B.requests.length;
    runner.request(B_FORK, { mode: "wait" });
    await until(done, "the switch");
    await sleep(3000);
    assert.equal(A.requests.length, a0, "nothing on A");
    assert.equal(B.requests.length, b0, "nothing on B before a prompt");
    assert.equal((await engine.threads.goal.get(session.state.thread.id))?.status, "paused");
  });
});

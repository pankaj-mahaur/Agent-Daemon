// The engine façade's named capabilities (own-harness plan Part 1, §4): every
// request ad makes outside engine/ goes through one of them; the raw server is
// private; features on experimental methods are gated on the protocol snapshot
// the façade is given (D11), tested by taking the method out of the snapshot
// while the fake server still answers it (G5). Against the fake app-server,
// which rejects any request that doesn't fit the pinned protocol.

import { ENGINE, projectConfigFolder } from "../src/engine/attribution.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine, Engine, engineDoctor, engineEvents, engineHome, engineHooks, engineVersion, featureFlags } from "../src/engine/index.mjs";
import { createSession } from "../src/harness/session.mjs";
import { waitFor } from "../testkit/wait.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };
const SNAPSHOT = JSON.parse(readFileSync(new URL("../src/engine/codex/protocol-snapshot.json", import.meta.url), "utf8"));

async function withEngine(opts, fn) {
  const home = mkdtempSync(join(tmpdir(), "ad-facade-"));
  const engine = await createEngine({ home, command, ...opts });
  try {
    await fn(engine, home);
  } finally {
    await engine.close();
    rmSync(home, { recursive: true, force: true });
  }
}

const debug = (engine) => engine.testRequest("debug/state", {});

/** The committed snapshot without one experimental method. */
function snapshotWithout(method) {
  const s = structuredClone(SNAPSHOT);
  s.experimental.methods = s.experimental.methods.filter((m) => m !== method);
  delete s.experimental.params.clientRequests[method];
  return s;
}

test("the raw server is private: no engine.server, and the test door reaches only a test double's own methods", async () => {
  await withEngine({}, async (engine) => {
    assert.equal(engine.server, undefined);
    assert.equal(Object.hasOwn(engine, "server"), false);
    await assert.rejects(engine.testRequest("thread/start", {}), { code: "TEST_DOOR" });
    await assert.rejects(engine.testRequest("initialize", {}), { code: "TEST_DOOR" });
    const st = await debug(engine);
    assert.ok(Array.isArray(st.calls));
    assert.equal(engine.running, true);
    assert.equal(engine.exitError, null);
  });
});

test("threads: start, resume, fork, inject, unsubscribe, list, archive, unarchive, delete, rename, revert, turns, compact send the pinned methods", async () => {
  await withEngine({}, async (engine) => {
    const { threadId } = await engine.threads.start({ cwd: "/work" });
    assert.equal(threadId, "thread-1");
    const resumed = await engine.threads.resume(threadId, { cwd: "/work" });
    assert.equal(resumed.threadId, threadId);
    await engine.turns.start({ threadId, text: "early-complete" });
    await waitFor(async () => (await debug(engine)).notifications.length >= 0 && (await engine.threads.turns(threadId, { limit: 50 })).data.length === 1, { what: "the turn in history" });
    const page = await engine.threads.turns(threadId, { limit: 50 });
    assert.equal(page.data[0].itemsView, "full");
    assert.equal(page.nextCursor, null);
    const forked = await engine.threads.fork(threadId, { lastTurnId: page.data[0].id });
    assert.equal(forked.thread.forkedFromId, threadId);
    const cwdFork = await engine.threads.fork(threadId, { cwd: "/elsewhere", sandbox: "read-only", approvalPolicy: "never", excludeTurns: true });
    assert.ok(cwdFork.thread.id);
    await engine.threads.inject(cwdFork.thread.id, [{ type: "message", role: "developer", content: [{ type: "input_text", text: "hi" }] }]);
    assert.equal((await engine.threads.unsubscribe(cwdFork.thread.id)).status, "unsubscribed");
    assert.equal((await engine.threads.unsubscribe("never-loaded")).status, "notLoaded");
    const listed = await engine.threads.list({ cwd: "/work", limit: 30, modelProviders: [], sourceKinds: ["cli", "vscode", "exec", "appServer"] });
    assert.equal(listed[0].id, "thread-old");
    const archived = await engine.threads.list({ cwd: "/work", limit: 30, modelProviders: [], sourceKinds: ["cli"], archived: true });
    assert.equal(archived[0].id, "thread-archived");
    await engine.threads.rename(threadId, "named");
    await engine.threads.archive(threadId);
    assert.equal((await engine.threads.unarchive(threadId)).thread.id, threadId);
    await engine.threads.revert(threadId, page.data[0].id);
    await assert.rejects(engine.threads.delete("thread-locked"), /thread is running/);
    await engine.threads.delete(threadId);
    await engine.threads.compact(forked.thread.id);
    const { calls, lastParams } = await debug(engine);
    for (const m of ["thread/start", "thread/resume", "thread/fork", "thread/inject_items", "thread/unsubscribe", "thread/list", "thread/archive", "thread/unarchive", "thread/delete", "thread/name/set", "thread/revert", "thread/turns/list", "thread/compact/start"]) {
      assert.ok(calls.includes(m), `${m} sent`);
    }
    assert.deepEqual(lastParams["thread/name/set"], { threadId, name: "named" });
    assert.equal(lastParams["thread/list"].archived, true);
    assert.equal(lastParams["thread/turns/list"].itemsView, "full");
    assert.equal(lastParams["thread/turns/list"].sortDirection, "asc");
    assert.equal(lastParams["thread/fork"].excludeTurns, true);
  });
});

test("turns: start, steer with the client's message id, interrupt; goals set and cleared", async () => {
  await withEngine({}, async (engine) => {
    const { threadId } = await engine.threads.start({});
    const { turnId } = await engine.turns.start({ threadId, text: "hang" });
    const steered = await engine.turns.steer(threadId, turnId, [{ type: "text", text: "more" }], { clientUserMessageId: "cid-1" });
    assert.equal(steered.turnId, turnId);
    const { turnId: t2 } = await engine.turns.start({ threadId, text: "hang" });
    await engine.turns.interrupt(threadId, t2);
    const goal = await engine.threads.goal.set(threadId, "ship it", { tokenBudget: 1000 });
    assert.equal(goal.objective, "ship it");
    await engine.threads.goal.clear(threadId);
    const { lastParams, calls } = await debug(engine);
    assert.equal(lastParams["turn/steer"].clientUserMessageId, "cid-1");
    assert.deepEqual(lastParams["turn/steer"].input, [{ type: "text", text: "more" }]);
    assert.deepEqual(lastParams["turn/interrupt"], { threadId, turnId: t2 });
    assert.equal(lastParams["thread/goal/set"].tokenBudget, 1000);
    assert.ok(calls.includes("thread/goal/clear"));
    await assert.rejects(engine.turns.steer(threadId, "turn-none", "x"), /no active turn/);
  });
});

test("review.start, terminals.run and guardian.approve (which builds the core event from a denial) go through", async () => {
  await withEngine({}, async (engine) => {
    const { threadId } = await engine.threads.start({});
    const r = await engine.review.start(threadId, { type: "uncommittedChanges" });
    assert.equal(r.reviewThreadId, threadId);
    await engine.terminals.run(threadId, "ls -la");
    const denial = { threadId, turnId: "t", reviewId: "review-1", startedAtMs: 1, completedAtMs: 2, decisionSource: "agent", action: { type: "command", source: "shell", command: "rm -rf build", cwd: "/w" }, review: { status: "denied", riskLevel: "high", userAuthorization: "low", rationale: "deletes the build" } };
    await engine.guardian.approve(threadId, denial);
    const { lastParams } = await debug(engine);
    assert.deepEqual(lastParams["review/start"].target, { type: "uncommittedChanges" });
    assert.equal(lastParams["thread/shellCommand"].command, "ls -la");
    const ev = lastParams["thread/approveGuardianDeniedAction"].event;
    assert.equal(ev.id, "review-1");
    assert.equal(ev.status, "denied");
    assert.equal(ev.action.type, "command");
    assert.equal(ev.decision_source, "agent");
  });
});

test("config, models, skills, files, mcp and usage capabilities return the engine's data, not the envelope", async () => {
  await withEngine({}, async (engine) => {
    const read = await engine.config.read({ includeLayers: true, cwd: "/w" });
    assert.ok(Array.isArray(read.layers));
    assert.equal((await engine.config.read()).layers, null);
    assert.equal(await engine.config.requirements(), null);
    await engine.config.write([["model", "gpt-test"]]);
    assert.equal((await engine.readConfig()).model, "gpt-test");
    const models = await engine.models.list();
    assert.equal(models[0].model, "fake-model");
    const skills = await engine.skills.list(["/w"]);
    assert.equal(skills[0].skills[0].name, "debug-triage");
    const files = await engine.files.search("app", ["/w"], { token: "ad-mention" });
    assert.deepEqual(files.map((f) => f.path), ["src/app.mjs"]);
    const mcp = await engine.mcp.status();
    assert.equal(mcp[0].name, "memory");
    const usage = await engine.usage.read();
    assert.equal(usage.summary.lifetimeTokens, 123456);
    await engine.usage.limits().catch(() => null); // the fake has no rate limits
    const { lastParams, calls } = await debug(engine);
    assert.deepEqual(lastParams["config/read"], { includeLayers: false });
    assert.equal(lastParams["fuzzyFileSearch"].cancellationToken, "ad-mention");
    assert.deepEqual(lastParams["skills/list"], { cwds: ["/w"] });
    for (const m of ["configRequirements/read", "model/list", "mcpServerStatus/list", "account/usage/read", "account/rateLimits/read"]) assert.ok(calls.includes(m), `${m} sent`);
  });
});

test("sandbox: readiness, and setup waits for the completion notification", async () => {
  await withEngine({ env: { FAKE_SANDBOX_DELAY_MS: "30" } }, async (engine) => {
    assert.equal(await engine.sandbox.readiness(), "notConfigured");
    const r = await engine.sandbox.setup({ mode: "unelevated", cwd: "/w", timeoutMs: 5000 });
    assert.equal(r.success, true);
    assert.equal(r.mode, "unelevated");
    const { lastParams } = await debug(engine);
    assert.deepEqual(lastParams["windowsSandbox/setupStart"], { mode: "unelevated", cwd: "/w" });
  });
  await withEngine({ env: { FAKE_SANDBOX_FAIL: "1" } }, async (engine) => {
    const r = await engine.sandbox.setup({ mode: "elevated" });
    assert.equal(r.success, false);
    assert.equal(r.error, "denied by policy");
  });
});

test("waitForCompaction resolves for the right thread and times out otherwise", async () => {
  await withEngine({}, async (engine) => {
    const { threadId } = await engine.threads.start({});
    const done = engine.waitForCompaction(threadId, { timeoutMs: 2000 });
    await engine.threads.compact(threadId);
    assert.equal((await done).threadId, threadId);
    await assert.rejects(engine.waitForCompaction("other", { timeoutMs: 50 }), { code: "ENGINE_TIMEOUT" });
  });
});

test("features: with the committed snapshot, plan mode and /stop exist only on an engine that opted into the experimental allowlist", async () => {
  const stable = featureFlags(SNAPSHOT, { experimental: false });
  assert.equal(stable.planMode.available, false);
  assert.equal(stable.stopTerminals.available, false);
  const exp = featureFlags(SNAPSHOT, { experimental: true });
  assert.deepEqual(exp, { planMode: { available: true, reason: null }, stopTerminals: { available: true, reason: null } });
  await withEngine({}, async (engine) => {
    assert.equal(engine.features.planMode.available, false);
    await assert.rejects(engine.modes.list(), { code: "FEATURE_UNAVAILABLE" });
  });
  await withEngine({ experimental: true }, async (engine) => {
    assert.equal(engine.features.planMode.available, true);
    assert.equal(engine.features.stopTerminals.available, true);
    const modes = await engine.modes.list();
    assert.deepEqual(modes.map((m) => m.mode), ["plan", "default"]);
  });
});

test("G5 plan mode: a snapshot without collaborationMode/list turns the feature off although the server still answers; a session falls back to Default with a notice", async () => {
  const protocolSnapshot = snapshotWithout("collaborationMode/list");
  await withEngine({ experimental: true, protocolSnapshot }, async (engine, home) => {
    assert.equal(engine.features.planMode.available, false);
    assert.match(engine.features.planMode.reason, /collaborationMode\/list/);
    assert.equal(engine.features.stopTerminals.available, true, "the other feature is untouched");
    await assert.rejects(engine.modes.list(), { code: "FEATURE_UNAVAILABLE" });
    assert.ok(!(await debug(engine)).calls.includes("collaborationMode/list"), "never asked");
    const session = createSession({ engine, cwd: home, lockDir: join(home, "locks"), modes: true });
    try {
      await session.modesReady;
      assert.deepEqual(session.state.mode, { kind: "default", presets: [] });
      const notice = session.state.notices.find((n) => n.code === "modes.unavailable");
      assert.ok(notice, "a notice says why");
      assert.match(notice.message, /Plan mode is unavailable/);
      assert.doesNotMatch(notice.message, new RegExp(ENGINE.name, "i"));
      assert.deepEqual(session.setMode("plan"), { ok: false, message: "Plan mode unavailable right now." });
      assert.equal(session.cycleMode().ok, false);
      assert.equal(session.modeMask(), null, "no mask is ever sent");
      await session.submit("early-complete").done;
      assert.equal((await debug(engine)).lastParams["turn/start"].collaborationMode, undefined);
    } finally {
      session.close();
    }
  });
});

test("G5 /stop: a snapshot without thread/backgroundTerminals/clean turns it off; the session reports it and still forgets the terminals", async () => {
  const protocolSnapshot = snapshotWithout("thread/backgroundTerminals/clean");
  await withEngine({ experimental: true, protocolSnapshot }, async (engine, home) => {
    assert.equal(engine.features.stopTerminals.available, false);
    assert.equal(engine.features.planMode.available, true);
    await assert.rejects(engine.terminals.clean("thread-1"), { code: "FEATURE_UNAVAILABLE" });
    const session = createSession({ engine, cwd: home, lockDir: join(home, "locks"), modes: true });
    try {
      await session.modesReady;
      await session.submit("bg-terminal").done;
      assert.equal(session.state.terminals.size, 1);
      await assert.rejects(session.stopTerminals(), (err) => err.code === "FEATURE_UNAVAILABLE" && /\/stop is unavailable/.test(err.message) && !new RegExp(ENGINE.name, "i").test(err.message));
      assert.equal(session.state.terminals.size, 0, "forgotten, as after a refused clean");
      assert.ok(!(await debug(engine)).calls.includes("thread/backgroundTerminals/clean"), "never sent");
    } finally {
      session.close();
    }
  });
});

test("errors carry codes: a JSON-RPC error keeps the engine's numeric code, the method and the raw message; a timeout and a never-started engine have string codes", async () => {
  await withEngine({}, async (engine) => {
    const err = await engine.testRequest("test/fail", {}).catch((e) => e);
    assert.equal(err.code, -32000);
    assert.equal(err.method, "test/fail");
    assert.equal(err.raw, "boom");
    assert.deepEqual(err.data, { why: "scripted" });
    assert.match(err.message, /boom/);
    assert.doesNotMatch(err.message, new RegExp(ENGINE.name, "i"));
    const late = await engine.testRequest("test/silent", {}, { timeoutMs: 40 }).catch((e) => e);
    assert.equal(late.code, "ENGINE_TIMEOUT");
    assert.doesNotMatch(late.message, new RegExp(ENGINE.name, "i"));
  });
  const fresh = new Engine({ home: mkdtempSync(join(tmpdir(), "ad-facade-")), command });
  await assert.rejects(fresh.threads.list({}), { code: "ENGINE_NOT_STARTED" });
  assert.equal(fresh.running, false);
});

test("kill() ends the engine: pending requests fail with ENGINE_EXITED, running turns false, exit is announced", async () => {
  await withEngine({}, async (engine) => {
    const exited = new Promise((r) => engine.once("exit", r));
    const pending = engine.testRequest("test/silent", {}, { timeoutMs: 5000 });
    engine.kill();
    const err = await pending.catch((e) => e);
    assert.equal(err.code, "ENGINE_EXITED");
    await exited;
    assert.equal(engine.running, false);
    assert.equal(engine.exitError.code, "ENGINE_EXITED");
    assert.doesNotMatch(engine.exitError.message, new RegExp(ENGINE.name, "i"));
  });
});

test("testNotify feeds a notification through the router; the raw observers see the engine's traffic", async () => {
  await withEngine({}, async (engine) => {
    const seen = [];
    const off = engine.subscribe(null, (ev) => seen.push(ev));
    const raw = [];
    const offRaw = engine.onRawNotification((m) => raw.push(m.method));
    engine.testNotify("account/updated", { authMode: "chatgpt", planType: "go" });
    await waitFor(() => seen.some((e) => e.type === "account"), { what: "the account event" });
    assert.ok(raw.includes("account/updated"));
    off();
    offRaw();
    engine.testNotify("account/updated", { authMode: "chatgpt", planType: "go" });
    assert.equal(raw.filter((m) => m === "account/updated").length, 1, "the observer was removed");
  });
});

test("helper namespaces: home, events, hooks and version delegate to the adapter without naming it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ad-facade-home-"));
  try {
    assert.equal(engineHome.isManaged(dir), false);
    const r = engineHome.ensure(dir);
    assert.equal(r.managed, true);
    assert.equal(engineHome.isManaged(dir), true);
    assert.equal(typeof engineHome.canonical(dir), "string");
    assert.equal(typeof engineHome.defaultPath({ AD_CODEX_HOME: dir }), "string");
    assert.equal(engineHome.env({ home: dir, base: {} }).CODEX_HOME, dir);
    const home = readFileSync(join(dir, "config.toml"), "utf8");
    assert.doesNotMatch(home, new RegExp(ENGINE.name, "i"), "the bootstrap settings file names no engine");
    assert.doesNotMatch(readFileSync(join(dir, engineHome.MANAGED_MARKER), "utf8"), new RegExp(ENGINE.name, "i"), "nor the marker");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(engineEvents.normalizeItem({ type: "agentMessage", id: "m", text: "hi" }).kind, "agentMessage");
  assert.equal(engineEvents.execDisplay({ command: ["ls"] }).command, "ls");
  assert.equal(engineEvents.guardianDenial({ reviewId: "r", review: { status: "denied" }, action: { type: "command" } }).status, "denied");
  const hooks = await engineHooks.forProfile("developer");
  assert.ok(hooks.hooks);
  assert.match(engineVersion.pinned(), /^\d+\.\d+\.\d+/);
  assert.equal(engineVersion.parse(`${ENGINE.processName}-cli 0.160.0`), "0.160.0");
  assert.ok(Array.isArray(engineVersion.compat().tested));
});

test("doctor: the adapter returns codes and data; the façade owns the words, and they never name the engine", () => {
  const env = { AD_CODEX_HOME: "/nonexistent/ad-engine-home" };
  const pinned = engineVersion.pinned();
  const words = engineDoctor.checks({ env, run: () => `${ENGINE.processName}-cli ${pinned}` });
  const by = Object.fromEntries(words.map((c) => [c.name, c]));
  assert.equal(by["Engine version"].ok, true);
  assert.match(by["Engine version"].note, new RegExp(pinned.replace(/\./g, "\\.")));
  assert.match(by["Engine home"].note, /created on the first run/);
  assert.ok(by["Engine compatibility"]);
  for (const c of words) assert.doesNotMatch(`${c.name} ${c.note}`, new RegExp(ENGINE.name, "i"), `${c.name}: ${c.note}`);
  const drift = engineDoctor.checks({ env, run: () => `${ENGINE.processName}-cli 0.0.1` });
  const v = drift.find((c) => c.name === "Engine version");
  assert.equal(v.ok, false);
  assert.match(v.note, /tested with/);
  assert.match(v.note, /npm install/);
  const broken = engineDoctor.checks({ env, run: () => { const e = new Error("spawn ENOENT"); e.code = "ENOENT"; throw e; } });
  assert.equal(broken[0].name, "Engine");
  assert.match(broken[0].note, /not runnable \(ENOENT\)/);
});

test("doctor live checks through the façade: sign-in, hooks and the Windows sandbox as words", async () => {
  const home = mkdtempSync(join(tmpdir(), "ad-facade-doc-"));
  try {
    writeFileSync(join(home, "hooks.json"), "{}");
    const fake = {
      account: async () => ({ account: null, requiresOpenaiAuth: true }),
      readConfig: async () => ({ windows: { sandbox: "unelevated" } }),
      listHooks: async () => [{ sourcePath: join(home, "hooks.json"), trustStatus: "trusted" }, { sourcePath: join(home, "hooks.json"), trustStatus: "modified" }],
      sandbox: { readiness: async () => "ready" },
      close: async () => {},
    };
    const checks = await engineDoctor.liveChecks({ env: { AD_CODEX_HOME: home }, engineFactory: async () => fake, platform: "win32" });
    const by = Object.fromEntries(checks.map((c) => [c.name, c]));
    assert.equal(by["Engine sign-in"].ok, false);
    assert.match(by["Engine sign-in"].note, /ad auth login chatgpt/);
    assert.equal(by["Engine hooks"].note.startsWith("1/2 trusted"), true);
    assert.equal(by["Windows sandbox"].ok, true);
    for (const c of checks) assert.doesNotMatch(`${c.name} ${c.note}`, new RegExp(ENGINE.name, "i"));
    const broken = await engineDoctor.liveChecks({ env: { AD_CODEX_HOME: home }, engineFactory: async () => { throw new Error("boom"); } });
    assert.equal(broken[0].name, "Engine");
    assert.match(broken[0].note, /boom/);
    assert.doesNotMatch(broken[0].note, new RegExp(ENGINE.name, "i"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the engine home refusals come from the attribution module, with codes", async () => {
  const { ownEngineHomeDefaultRefusal, ownEngineHomeStartRefusal } = await import("../src/engine/attribution.mjs");
  const { homedir } = await import("node:os");
  assert.throws(() => engineHome.env({ home: undefined, base: {} }), (e) => e.code === "HOME_REQUIRED" && e.message === ownEngineHomeDefaultRefusal);
  const own = join(homedir(), projectConfigFolder);
  assert.throws(() => engineHome.env({ home: own, base: {} }), (e) => e.code === "HOME_IS_USERS" && e.message === ownEngineHomeStartRefusal(own));
});

test("doctor live checks never throw on a broken setup: conflicts and two folders resolve to []", async () => {
  const conflicted = await engineDoctor.liveChecks({ env: { AD_ENGINE_DIR: "/a", AD_CODEX_HOME: "/b" } });
  assert.deepEqual(conflicted, []);
  const { mkdirSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "ad-facade-two-"));
  try {
    mkdirSync(join(root, "codex-home"), { recursive: true });
    mkdirSync(join(root, "engine"), { recursive: true });
    const two = await engineDoctor.liveChecks({ env: {}, root, engineFactory: async () => { throw new Error("must not start an engine"); } });
    assert.deepEqual(two, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor words for the folder states never name the engine", async () => {
  const { mkdirSync } = await import("node:fs");
  const { createLegacyLink } = await import("../src/engine/codex/home-resolve.mjs");
  const pinned = engineVersion.pinned();
  const run = () => `${ENGINE.processName}-cli ${pinned}`;
  const oldRoot = mkdtempSync(join(tmpdir(), "ad-facade-old-"));
  const newRoot = mkdtempSync(join(tmpdir(), "ad-facade-new-"));
  const twoRoot = mkdtempSync(join(tmpdir(), "ad-facade-two-"));
  try {
    mkdirSync(join(oldRoot, "codex-home"), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(oldRoot, "codex-home", ".agent-daemon-managed"), "Created by Agent Daemon.\n");
    mkdirSync(join(newRoot, "engine"), { recursive: true });
    createLegacyLink(join(newRoot, "engine"), join(newRoot, "codex-home"), { hide: false });
    mkdirSync(join(twoRoot, "codex-home"), { recursive: true });
    mkdirSync(join(twoRoot, "engine"), { recursive: true });
    const words = (root) => engineDoctor.checks({ env: {}, root, run });
    const oldBy = Object.fromEntries(words(oldRoot).map((c) => [c.name, c]));
    assert.match(oldBy["Engine home"].note, /older folder name; nothing is wrong; ad migrate is optional/);
    const newBy = Object.fromEntries(words(newRoot).map((c) => [c.name, c]));
    assert.match(newBy["Engine home link"].note, /a link older versions of ad need/);
    const twoBy = Object.fromEntries(words(twoRoot).map((c) => [c.name, c]));
    assert.match(twoBy["Engine home"].note, /^two engine folders:/);
    const facts = words(twoRoot).filter((c) => c.name.startsWith("Engine folder ("));
    assert.equal(facts.length, 2);
    // The old folder's on-disk name is data, not words: scrub path-like
    // tokens carrying it, then no prose may name the engine.
    const scrubbed = (s) => s.replace(/[^\s]*codex-home[^\s]*/gi, "<path>");
    for (const c of [...words(oldRoot), ...words(newRoot), ...words(twoRoot)]) assert.doesNotMatch(scrubbed(`${c.name} ${c.note}`), new RegExp(ENGINE.name, "i"), `${c.name}: ${c.note}`);
  } finally {
    for (const d of [oldRoot, newRoot, twoRoot]) rmSync(d, { recursive: true, force: true });
  }
});

// The memory scope contract (plan §M): each thread's memory server is bound to
// its folder through a per-thread override, but only when the home configures
// that server — an override for a missing server breaks the thread's config.
test("memory scope: no override in a home without the memory server", async () => {
  await withEngine({}, async (engine) => {
    const { threadId } = await engine.threads.start({ cwd: "/work/a" });
    assert.ok(!JSON.stringify((await debug(engine)).lastParams["thread/start"]?.config ?? {}).includes("AD_MEMORY_PROJECT"));
    await engine.threads.resume(threadId, { cwd: "/work/b" });
    assert.ok(!JSON.stringify((await debug(engine)).lastParams["thread/resume"]?.config ?? {}).includes("AD_MEMORY_PROJECT"));
    await engine.threads.fork(threadId, { cwd: "/work/c" });
    assert.ok(!JSON.stringify((await debug(engine)).lastParams["thread/fork"]?.config ?? {}).includes("AD_MEMORY_PROJECT"));
  });
});

test("memory scope: with the server configured, start/resume/fork bind it to the thread's folder; other overrides stay", async () => {
  await withEngine({}, async (engine) => {
    const KEY = "mcp_servers.agent-daemon-memory.env.AD_MEMORY_PROJECT";
    await engine.threads.start({ cwd: "/work/a" }); // config read before setup: no server yet
    await engine.writeConfig([["mcp_servers.agent-daemon-memory.command", "node"]]);
    const { threadId } = await engine.threads.start({ cwd: "/work/a", config: { "features.x": true } });
    let p = (await debug(engine)).lastParams["thread/start"];
    assert.equal(p.config[KEY], "/work/a", "re-read after setup wrote the server");
    assert.equal(p.config["features.x"], true);
    await engine.threads.resume(threadId, { cwd: "/work/b" });
    assert.equal((await debug(engine)).lastParams["thread/resume"].config[KEY], "/work/b");
    await engine.threads.fork(threadId, { cwd: "/work/c" });
    assert.equal((await debug(engine)).lastParams["thread/fork"].config[KEY], "/work/c");
    // A worker: its memory belongs to the parent repo, not the worktree.
    await engine.threads.start({ cwd: "/home/.agent-daemon/worktrees/w1", memoryProject: "/work/repo" });
    assert.equal((await debug(engine)).lastParams["thread/start"].config[KEY], "/work/repo");
    // A caller's own value wins; null means none.
    await engine.threads.start({ cwd: "/work/a", config: { [KEY]: "/explicit" } });
    assert.equal((await debug(engine)).lastParams["thread/start"].config[KEY], "/explicit");
    await engine.threads.start({ cwd: "/work/a", memoryProject: null });
    assert.ok(!JSON.stringify((await debug(engine)).lastParams["thread/start"].config ?? {}).includes("AD_MEMORY_PROJECT"));
  });
});

// P4.5 part A (docs/plans/post-v3-program/opencode/P4.5-brief.md): the fallback core — every
// decision, as pure functions in src/sessions/fallback.mjs, and their final texts. A
// deterministic clock: plain numbers from a fixed date.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FALLBACK_RUN_TEXTS as TXT, beforeDispatch, boundaryCheck, causeText, detect, episodeFromEvents, episodeOver, fallbackGate, afterRetry, afterSwitch, budgetLeft, retryDecision, routeTargetOf, runInterrupt, SWITCH_AFTER_TOOL_CALLS, startEpisode, switchesLastHour, watchdogStart, watchdogStep } from "../src/sessions/fallback.mjs";
import { DEFAULT_POLICY, FALLBACK_ON, consentHash, consentParts } from "../src/routing/policy.mjs";

const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const T0 = Date.parse("2026-11-02T10:00:00.000Z");
const RESET = T0 + 3 * 3_600_000;
const until = (ms) => ` (resets ${hhmm(ms)})`;
const failure = (o = {}) => ({ class: "unknown", period: null, retryAfterMs: null, resetsAt: null, source: "gateway", reason: "", ...o });

test("texts: each line word for word", () => {
  assert.equal(
    TXT.SWITCHED("Gemini API · personal · gemini-2.5-flash", "OpenRouter's daily limit is used up (resets 05:30)", 1, 3),
    "↪ Switched to Gemini API · personal · gemini-2.5-flash: OpenRouter's daily limit is used up (resets 05:30). Fallback 1 of 3.",
  );
  assert.equal(
    TXT.USING_FOR_PROMPT("Gemini API · personal · gemini-2.5-flash", "OpenRouter is at its limit until 05:30"),
    "↪ Using Gemini API · personal · gemini-2.5-flash for this prompt: OpenRouter is at its limit until 05:30.",
  );
  assert.equal(TXT.RETRYING("OpenRouter", 8, 1, 1), "↻ Rate limited by OpenRouter; retrying in 8 s (1 of 1).");
  assert.equal(
    TXT.PAUSED("OpenRouter's free limit is used up until 05:30, and no other target in your order can take over (Gemini API: daily limit used up; ChatGPT · personal: not free, and your rule is 'free only')"),
    "⏸ Paused: OpenRouter's free limit is used up until 05:30, and no other target in your order can take over (Gemini API: daily limit used up; ChatGPT · personal: not free, and your rule is 'free only'). Your work is saved. /retry tries again · /model picks a model · /fallback shows the order.",
  );
  assert.equal(
    TXT.MANUAL_PICK("OpenRouter", " (resets 05:30)", "OpenRouter · personal"),
    "OpenRouter hit a limit earlier (resets 05:30); you picked OpenRouter · personal, so ad uses it. Fallback won't move to another OpenRouter account by itself.",
  );
  assert.equal(
    TXT.NONE_LEFT("OpenRouter's free limit is used up until 05:30", "Gemini API: daily limit used up; ChatGPT · personal: not free, and your rule is 'free only'"),
    "OpenRouter's free limit is used up until 05:30, and no other target in your order can take over (Gemini API: daily limit used up; ChatGPT · personal: not free, and your rule is 'free only')",
  );
  assert.equal(TXT.MAY_BE_RUNNING("npm run deploy"), "`npm run deploy` may still be running from the failed turn (ad can't tell whether it finished)");
  assert.equal(TXT.TOOL_CALLS, "the failed turn ran commands or made edits, and ad doesn't move such a turn by itself yet");
  assert.equal(TXT.BACKGROUND("./migrate.sh"), "`./migrate.sh` is still running in the background (allow long-running commands in /fallback rules if this is a server)");
  assert.equal(TXT.SUBAGENT, "a subagent is still working");
  assert.equal(TXT.BUDGET(1, 2), "the fallback budget is used up (1 switch in 2 min)");
  assert.equal(TXT.BUDGET(3, 2), "the fallback budget is used up (3 switches in 2 min)");
  assert.equal(TXT.TOO_OFTEN(6), "fallback is switching too often (6 in the last hour)");
  assert.equal(TXT.CHANGED("OpenRouter · work"), "OpenRouter · work changed since you confirmed the order");
  assert.equal(TXT.RULES, "the fallback order no longer passes its own rules (ad fallback lists why)");
  assert.equal(
    TXT.CONTINUATION("OpenRouter · work · q", "OpenRouter's limit is used up (reset time unknown)"),
    "[ad: automatic continuation] The previous attempt on OpenRouter · work · q stopped (OpenRouter's limit is used up (reset time unknown)). Continue the user's last request from where it stopped. Tool calls already marked done ran: don't repeat them. Commands listed as still running are kept by ad: don't start them again.",
  );
  assert.equal(Object.isFrozen(TXT), true, "the texts are frozen");
});

test("causeText: each class, a day period, a known and an unknown reset", () => {
  assert.equal(causeText(failure({ class: "quotaExhausted", period: "day", resetsAt: new Date(RESET).toISOString() }), "openrouter"),
    `OpenRouter's daily limit is used up${until(RESET)}`);
  assert.equal(causeText(failure({ class: "quotaExhausted", period: "minute", resetsAt: RESET }), "gemini"),
    `Gemini API's limit is used up${until(RESET)}`);
  assert.equal(causeText(failure({ class: "quotaExhausted", period: "day", resetsAt: null }), "openrouter"),
    "OpenRouter's daily limit is used up (reset time unknown)");
  assert.equal(causeText(failure({ class: "rateLimit", resetsAt: new Date(RESET).toISOString() }), "gemini"),
    `Gemini API is rate limiting${until(RESET)}`);
  assert.equal(causeText(failure({ class: "rateLimit", resetsAt: null }), "gemini"),
    "Gemini API is rate limiting (reset time unknown)");
  assert.equal(causeText(failure({ class: "transientNetwork" }), "openrouter"), "OpenRouter can't be reached");
  assert.equal(causeText(failure({ class: "provider5xx" }), "openrouter"), "OpenRouter's servers are failing");
  assert.equal(causeText(failure({ class: "cancelled" }), "gemini"), "Gemini API stopped the turn");
  assert.equal(causeText(failure({ class: "somethingNew" }), "openrouter"), "OpenRouter stopped the turn");
});

// The gate runs the real policy through consent and validation: the fixtures follow
// test/routing-policy.test.mjs, and the file lives on a temp ad root like routing-store's.
const GATE_NOW = Date.parse("2026-10-29T10:00:00.000Z");
const fresh = new Date(GATE_NOW - 3 * 60_000).toISOString();
const acct = (o) => ({ status: "ready", method: "api-key", credentialRevision: 1, keyHint: "1111", identity: null, endpoint: null, ...o });
const ACCOUNTS = [
  acct({ id: "acct_or1", provider: "openrouter", label: "work" }),
  acct({ id: "acct_or2", provider: "openrouter", label: "personal", keyHint: "2222" }),
  acct({ id: "acct_gem", provider: "gemini", label: "personal" }),
  acct({ id: "acct_oa", provider: "openai", label: "work" }),
  acct({ id: "acct_gpt", provider: "chatgpt", label: "personal", method: "engine-login", credential: { kind: "engine-home", home: "@default" }, identity: { email: "s***@example.com", plan: "plus" }, keyHint: null }),
  acct({ id: "acct_nv", provider: "nvidia", label: "trial" }),
  acct({ id: "acct_custom", provider: "custom", label: "box", endpoint: "https://llm.example.test/v1" }),
];
const ENTRIES = {
  "acct_or1:qwen/qwen3-coder:free": { caps: { tools: true, contextWindow: 262144 }, price: { input: "0", output: "0", observedAt: fresh }, billing: "metered", data: {} },
  "acct_or2:qwen/qwen3-coder:free": { caps: { tools: true, contextWindow: 262144 }, price: { input: "0", output: "0", observedAt: fresh }, billing: "metered", data: {} },
  "acct_gem:gemini-2.5-flash": { caps: { tools: true, contextWindow: 1048576 }, price: { input: "0", output: "0", observedAt: fresh }, billing: "metered", data: { trainsOnData: "free tier", note: "Google may use free-tier data to improve its products." } },
  "acct_oa:gpt-5": { caps: { tools: true, contextWindow: 400000 }, price: { input: "0.00000125", output: "0.00001", observedAt: fresh }, billing: "metered", data: {} },
  "acct_or1:some/no-tools": { caps: { tools: false }, price: { input: "0", output: "0", observedAt: fresh }, billing: "metered", data: {} },
  "acct_nv:llama-x": { caps: { tools: true, contextWindow: 32768 }, price: null, billing: "metered", data: { trial: true, note: "NVIDIA's hosted models are for trial use." } },
};
const catalog = (accountId, model) => ENTRIES[`${accountId}:${model}`] ?? null;
const OR1 = { account: "acct_or1", model: "qwen/qwen3-coder:free" };
const GPT = { account: "acct_gpt", model: "gpt-5.5" };
const OA = { account: "acct_oa", model: "gpt-5" };

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-fallback-core-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const gateOpts = () => ({ root, accounts: ACCOUNTS, catalog, now: GATE_NOW });
const gate = (policy, o = {}) => fallbackGate({ policy, accounts: ACCOUNTS, catalog, now: GATE_NOW, env: {}, ...o });

test("gate: AD_FALLBACK=0, this window off, the order off: each refuses with its reason", () => {
  const on = { ...DEFAULT_POLICY, enabled: true, targets: [OR1], consent: { hash: "sha256:x", parts: {} } };
  assert.deepEqual(gate(on, { env: { AD_FALLBACK: "0" } }), { on: false, reason: "env" });
  assert.deepEqual(gate(on, { windowOn: false }), { on: false, reason: "window" });
  assert.deepEqual(gate({ ...DEFAULT_POLICY }), { on: false, reason: "off" }, "the order is off");
});

test("gate: an account changed since consent refuses, naming it", async () => {
  const { enablePolicy, readPolicy, updatePolicy } = await import("../src/routing/store.mjs");
  await updatePolicy((p) => {
    p.targets.push(OR1, GPT);
  }, gateOpts());
  await enablePolicy(gateOpts());
  const resigned = ACCOUNTS.map((a) => (a.id === "acct_gpt" ? { ...a, identity: { email: "o***@example.com", plan: "plus" } } : a));
  assert.deepEqual(fallbackGate({ policy: readPolicy({ root }), accounts: resigned, catalog, now: GATE_NOW, env: {} }),
    { on: false, reason: "changed", text: "ChatGPT · personal changed since you confirmed the order" });
});

test("gate: a consented file that breaks the rules is refused", async () => {
  const { fallbackFile, readPolicy } = await import("../src/routing/store.mjs");
  const policy = { ...DEFAULT_POLICY, enabled: true, targets: [OA] };
  const consent = { at: new Date(GATE_NOW).toISOString(), revision: policy.revision, hash: consentHash(policy, ACCOUNTS), parts: consentParts(policy, ACCOUNTS) };
  fs.writeFileSync(fallbackFile(root), JSON.stringify({ ...policy, consent }));
  assert.deepEqual(fallbackGate({ policy: readPolicy({ root }), accounts: ACCOUNTS, catalog, now: GATE_NOW, env: {} }),
    { on: false, reason: "rules", text: TXT.RULES });
});

test("gate: a consented, valid order is on", async () => {
  const { enablePolicy, readPolicy, updatePolicy } = await import("../src/routing/store.mjs");
  await updatePolicy((p) => {
    p.targets.push(OR1);
  }, gateOpts());
  await enablePolicy(gateOpts());
  assert.deepEqual(fallbackGate({ policy: readPolicy({ root }), accounts: ACCOUNTS, catalog, now: GATE_NOW, env: {} }), { on: true });
});

// The watchdog is fed events and ticks with a plain number for a clock.
const notice = (at, f = null) => ({ type: "notice", at, failure: f });

test('watchdog: retry notices every 5 s ("Reconnecting…") with no gateway observation: interrupt at the wall-clock budget end with cause transientNetwork', () => {
  let st = watchdogStart({ turnId: "t1", at: T0 });
  st = watchdogStep(st, notice(T0), { budgetMs: 120_000 }).st;
  for (let s = 1; s < 120; s++) {
    const r = watchdogStep(st, s % 5 === 0 ? notice(T0 + s * 1000) : { type: "tick", at: T0 + s * 1000 }, { budgetMs: 120_000 });
    assert.equal(r.interrupt, null, `no interrupt before the budget ends (at +${s} s)`);
    st = r.st;
  }
  const end = watchdogStep(st, { type: "tick", at: T0 + 120_000 }, { budgetMs: 120_000 });
  assert.deepEqual(end.interrupt, { cause: { class: "transientNetwork", period: null, retryAfterMs: null, resetsAt: null, source: "watchdog", reason: "the provider kept failing" } });
  assert.equal(end.st.done, true, "one interrupt per turn");
});

test("watchdog: a retry notice with Retry-After 45 s and 20 s of budget left interrupts at once, cause rateLimit", () => {
  const f = failure({ class: "rateLimit", retryAfterMs: 45_000 });
  let st = watchdogStart({ turnId: "t1", at: T0 });
  const r = watchdogStep(st, notice(T0, f), { budgetMs: 20_000 });
  assert.deepEqual(r.interrupt, { cause: f });
  assert.equal(r.st.done, true);
});

test("watchdog: a quota observation interrupts at once", () => {
  const f = failure({ class: "quotaExhausted", period: "day" });
  let st = watchdogStart({ turnId: "t1", at: T0 });
  const r = watchdogStep(st, notice(T0 + 5_000, f), { budgetMs: 120_000 });
  assert.deepEqual(r.interrupt, { cause: f });
});

test("watchdog: a Retry-After shorter than the time left doesn't interrupt; the budget end still does", () => {
  const f = failure({ class: "rateLimit", retryAfterMs: 5_000 });
  let st = watchdogStart({ turnId: "t1", at: T0 });
  st = watchdogStep(st, notice(T0, f), { budgetMs: 20_000 }).st;
  for (let s = 1; s < 20; s++) {
    const r = watchdogStep(st, { type: "tick", at: T0 + s * 1000 }, { budgetMs: 20_000 });
    assert.equal(r.interrupt, null, `retry 5 s is under the 20 s budget (at +${s} s)`);
    st = r.st;
  }
  const end = watchdogStep(st, { type: "tick", at: T0 + 20_000 }, { budgetMs: 20_000 });
  assert.deepEqual(end.interrupt, { cause: f }, "the last classified cause");
});

test("watchdog: a retry notice while a child turn's command is in progress never interrupts", () => {
  const f = failure({ class: "quotaExhausted" });
  let st = watchdogStart({ turnId: "t1", at: T0 });
  let r = watchdogStep(st, notice(T0, f), { budgetMs: 20_000, toolsInProgress: true });
  assert.equal(r.interrupt, null);
  assert.equal(r.st.waitingForTool, true);
  r = watchdogStep(r.st, { type: "tick", at: T0 + 1_000 }, { budgetMs: 20_000, toolsInProgress: false });
  assert.deepEqual(r.interrupt, { cause: f });
});

test("watchdog: a WebSocket provider with a suppressed first notice: the clock starts after 90 s of silence", () => {
  let st = watchdogStart({ turnId: "t1", at: T0, websocket: true });
  st = watchdogStep(st, { type: "event", at: T0 }, { budgetMs: 30_000 }).st;
  for (let s = 1; s < 90; s++) {
    const r = watchdogStep(st, { type: "tick", at: T0 + s * 1000 }, { budgetMs: 30_000 });
    assert.equal(r.interrupt, null, `silent until 90 s (tick ${s})`);
    st = r.st;
  }
  st = watchdogStep(st, { type: "tick", at: T0 + 90_000 }, { budgetMs: 30_000 }).st;
  assert.equal(st.clockFrom, T0 + 90_000, "the silence starts the clock");
  for (let s = 91; s < 120; s++) {
    const r = watchdogStep(st, { type: "tick", at: T0 + s * 1000 }, { budgetMs: 30_000 });
    assert.equal(r.interrupt, null, `budget not yet out (tick ${s})`);
    st = r.st;
  }
  const end = watchdogStep(st, { type: "tick", at: T0 + 120_000 }, { budgetMs: 30_000 });
  assert.equal(end.interrupt.cause.class, "transientNetwork");
  // Without websocket the same ticks never start a silence clock.
  let st2 = watchdogStart({ turnId: "t1", at: T0 });
  st2 = watchdogStep(st2, { type: "event", at: T0 }, { budgetMs: 30_000 }).st;
  for (let s = 1; s <= 200; s++) {
    const r = watchdogStep(st2, { type: "tick", at: T0 + s * 1000 }, { budgetMs: 30_000 });
    st2 = r.st;
    assert.equal(r.interrupt, null, `no silence clock for a non-socket provider (tick ${s})`);
  }
  assert.equal(st2.clockFrom, null);
});

test("watchdog: one interrupt per turn; nothing after end", () => {
  let st = watchdogStart({ turnId: "t1", at: T0 });
  const r = watchdogStep(st, notice(T0, failure({ class: "quotaExhausted" })), { budgetMs: 120_000 });
  assert.equal(r.interrupt.cause.class, "quotaExhausted");
  const again = watchdogStep(r.st, notice(T0 + 5_000, failure({ class: "quotaExhausted" })), { budgetMs: 120_000 });
  assert.equal(again.interrupt, null);
  // A watch ended by event answers nothing either.
  let st2 = watchdogStart({ turnId: "t1", at: T0 });
  const end = watchdogStep(st2, { type: "end" }, { budgetMs: 120_000 });
  assert.equal(end.interrupt, null);
  assert.equal(end.st.done, true);
  assert.deepEqual(watchdogStep(end.st, { type: "tick", at: T0 + 600_000 }, { budgetMs: 120_000 }), { st: end.st, interrupt: null });
});

test("interrupt order: goal paused, then fallbackInterrupt recorded, then interrupt; a running tool waits", async () => {
  const cause = failure({ class: "rateLimit", retryAfterMs: 45_000 });
  const log = [];
  let recorded = null;
  const done = await runInterrupt({
    turnId: "t1",
    cause,
    toolsInProgress: () => false,
    pauseGoal: async () => { log.push("pauseGoal"); },
    record: (ev) => { log.push("record"); recorded = ev; },
    interrupt: async () => { log.push("interrupt"); },
  });
  assert.deepEqual(log, ["pauseGoal", "record", "interrupt"]);
  assert.deepEqual(recorded, { type: "fallbackInterrupt", turnId: "t1", cause });
  assert.deepEqual(done, { interrupted: true });
  const log2 = [];
  const waited = await runInterrupt({
    turnId: "t1",
    cause,
    toolsInProgress: () => true,
    pauseGoal: () => { log2.push("pauseGoal"); },
    record: () => { log2.push("record"); },
    interrupt: () => { log2.push("interrupt"); },
  });
  assert.deepEqual(log2, []);
  assert.deepEqual(waited, { waited: "tool" });
  const log3 = [];
  const threw = await runInterrupt({
    turnId: "t1",
    cause,
    toolsInProgress: () => false,
    pauseGoal: () => { log3.push("pauseGoal"); throw new Error("the goal froze"); },
    record: () => { log3.push("record"); },
    interrupt: () => { log3.push("interrupt"); },
  });
  assert.deepEqual(log3, ["pauseGoal", "record", "interrupt"], "a failed goal pause doesn't stop the interrupt");
  assert.deepEqual(threw, { interrupted: true });
});

test("detect: each of the four classes triggers when switched on; off when not in policy.on", () => {
  const policy = { ...DEFAULT_POLICY, enabled: true, on: [...FALLBACK_ON] };
  for (const c of FALLBACK_ON) {
    const f = failure({ class: c });
    const r = detect({ turn: { id: "t1", status: "failed" }, failure: f, policy });
    assert.equal(r.trigger, true, `${c} triggers`);
    assert.deepEqual(r.failure, f);
  }
  const narrow = { ...DEFAULT_POLICY, enabled: true, on: ["rateLimit"] };
  assert.deepEqual(detect({ turn: { id: "t1", status: "failed" }, failure: failure({ class: "quotaExhausted" }), policy: narrow }),
    { trigger: false, why: "quotaExhausted" }, "not in the order's switch-on list");
});

test("detect: unknown, auth, plan (UsageNotIncluded) and context classes never trigger, even when a hand-written policy lists them", () => {
  const hand = { ...DEFAULT_POLICY, enabled: true, on: ["unknown", "authExpired", "authRevoked", "contentPolicy", "contextOverflow", "UsageNotIncluded", "notEligible", ...FALLBACK_ON] };
  for (const c of ["unknown", "authExpired", "authRevoked", "contentPolicy", "contextOverflow", "UsageNotIncluded", "someBrandNewClass"]) {
    assert.deepEqual(detect({ turn: { id: "t1", status: "failed" }, failure: failure({ class: c }), policy: hand }),
      { trigger: false, why: c }, `${c} is never a trigger`);
  }
  assert.deepEqual(detect({ turn: { id: "t1", status: "failed" }, failure: null, policy: hand }), { trigger: false, why: "unknown" });
});

test("detect: an interrupted turn triggers only with ad's own fallbackInterrupt; the user's Esc is cancelled", () => {
  const policy = { ...DEFAULT_POLICY, enabled: true, on: [...FALLBACK_ON] };
  assert.deepEqual(detect({ turn: { id: "t1", status: "interrupted" }, failure: failure({ class: "cancelled" }), policy }),
    { trigger: false, why: "cancelled" }, "no fallbackInterrupt in the ledger: the user pressed Esc");
  const cause = failure({ class: "quotaExhausted", period: "day", source: "chatgpt:rateLimits/read" });
  const recorded = { type: "fallbackInterrupt", turnId: "t1", cause };
  const r = detect({ turn: { id: "t1", status: "interrupted" }, failure: cause, interrupted: recorded, policy });
  assert.equal(r.trigger, true, "ad's own interrupt continues the episode");
  assert.deepEqual(r.failure, cause);
});

test("detect: a completed turn never triggers", () => {
  const policy = { ...DEFAULT_POLICY, enabled: true, on: [...FALLBACK_ON] };
  assert.deepEqual(detect({ turn: { id: "t1", status: "completed" }, failure: failure({ class: "quotaExhausted" }), policy }),
    { trigger: false, why: "completed" });
  assert.deepEqual(detect({ turn: { id: "t1", status: "completed" }, failure: null, policy }),
    { trigger: false, why: "completed" });
});

test("episode: start, a switch, hops and tried; budget left; over by hops, over by time", () => {
  const policy = { ...DEFAULT_POLICY, enabled: true, maxHops: 3, recoveryBudgetMs: 120_000 };
  const FROM = { account: "acct_or1", model: "qwen/qwen3-coder:free" };
  let ep = startEpisode({ id: "ep1", from: FROM, at: T0 });
  assert.deepEqual(ep, { id: "ep1", startedAt: T0, from: FROM, tried: ["acct_or1:qwen/qwen3-coder:free"], hops: 0, retries: {}, paused: null });
  assert.equal(budgetLeft(ep, policy, T0 + 30_000), 90_000);
  assert.equal(budgetLeft(ep, policy, T0 + 121_000), 0, "never under 0");
  ep = afterSwitch(ep, { account: "acct_gem", model: "gemini-2.5-flash" });
  assert.equal(ep.hops, 1);
  assert.deepEqual(ep.tried, ["acct_or1:qwen/qwen3-coder:free", "acct_gem:gemini-2.5-flash"]);
  ep = afterSwitch(ep, FROM);
  assert.equal(ep.hops, 2, "hops count every switch");
  assert.deepEqual(ep.tried, ["acct_or1:qwen/qwen3-coder:free", "acct_gem:gemini-2.5-flash"], "a target is never in tried twice");
  assert.equal(episodeOver(ep, policy, T0), null, "2 hops of 3, budget running");
  assert.equal(episodeOver(ep, { ...policy, maxHops: 2 }, T0), "hops");
  assert.equal(episodeOver({ ...ep, hops: 1 }, policy, T0 + 120_000), "time");
  assert.equal(episodeOver({ ...ep, hops: 3 }, policy, T0 + 121_000), "hops", "hops is checked before time");
});

test("episode: one same-target retry for a short known Retry-After; never for a long or unknown one, or past perTargetRetries", () => {
  const policy = { ...DEFAULT_POLICY, enabled: true, recoveryBudgetMs: 120_000, perTargetRetries: 1 };
  const CURRENT = { account: "acct_or1", model: "qwen/qwen3-coder:free" };
  const ep = startEpisode({ id: "ep1", from: CURRENT, at: T0 });
  assert.deepEqual(retryDecision(ep, { failure: failure({ class: "rateLimit", retryAfterMs: 30_000 }), current: CURRENT, policy, now: T0 }),
    { retryInMs: 30_000 }, "a Retry-After up to 30 s and inside the budget is ad's own wait");
  assert.deepEqual(retryDecision(ep, { failure: failure({ class: "rateLimit", retryAfterMs: 31_000 }), current: CURRENT, policy, now: T0 }),
    null, "longer than 30 s: switch instead");
  assert.deepEqual(retryDecision(ep, { failure: failure({ class: "rateLimit", retryAfterMs: null }), current: CURRENT, policy, now: T0 }),
    null, "no known Retry-After: switch instead");
  assert.deepEqual(retryDecision(ep, { failure: failure({ class: "rateLimit", retryAfterMs: 25_000 }), current: CURRENT, policy, now: T0 + 100_000 }),
    null, "only 20 s of budget left can't cover the 25 s Retry-After");
  assert.deepEqual(retryDecision(ep, { failure: failure({ class: "rateLimit", retryAfterMs: 20_000 }), current: CURRENT, policy, now: T0 + 100_000 }),
    { retryInMs: 20_000 }, "a Retry-After exactly as long as the budget left still fits");
  assert.deepEqual(retryDecision(ep, { failure: failure({ class: "quotaExhausted", retryAfterMs: 8_000 }), current: CURRENT, policy, now: T0 }),
    null, "a quota isn't waited out on the same target");
  const spent = afterRetry(ep, CURRENT);
  assert.deepEqual(spent.retries, { "acct_or1:qwen/qwen3-coder:free": 1 });
  assert.deepEqual(retryDecision(spent, { failure: failure({ class: "rateLimit", retryAfterMs: 8_000 }), current: CURRENT, policy, now: T0 }),
    null, "one same-target retry per the order's perTargetRetries");
});

test("episode: rebuilt from the ledger after a restart: hops and tried kept, paused kept", () => {
  const rf = { type: "routeFailure", episode: { id: "ep1", startedAt: "2026-11-02T10:00:00.000Z", from: { account: "acct_or1", model: "qwen/qwen3-coder:free" } }, turnId: "t1", failure: failure({ class: "quotaExhausted" }) };
  const sw = { type: "switchCommitted", reason: "policy", target: "acct_gem/gemini/gemini-2.5-flash/-", at: "2026-11-02T10:01:00.000Z" };
  const pa = { type: "paused", episodeId: "ep1", reason: "mayBeRunning" };
  const again = { type: "routeFailure", episode: { id: "ep1", startedAt: "2026-11-02T10:00:00.000Z", from: { account: "acct_or1", model: "qwen/qwen3-coder:free" } }, turnId: "t2", failure: failure({ class: "rateLimit" }) };
  const ep = episodeFromEvents([rf, sw, pa, again]);
  assert.equal(ep.id, "ep1");
  assert.equal(ep.startedAt, "2026-11-02T10:00:00.000Z", "the episode keeps its start, so the budget keeps running");
  assert.equal(ep.hops, 1);
  assert.deepEqual(ep.tried, ["acct_or1:qwen/qwen3-coder:free", "acct_gem:gemini-2.5-flash"]);
  assert.equal(ep.paused, "mayBeRunning", "the restart still shows the pause");
  const bad = episodeFromEvents([rf, { type: "switchCommitted", reason: "policy", target: "just-garbage" }]);
  assert.equal(bad.hops, 1, "an unreadable switch key still costs the hop");
  assert.deepEqual(bad.tried, ["acct_or1:qwen/qwen3-coder:free"], "…but names no target to avoid");
});

test("episode: a completed turn, the user's own prompt or a manual switch ends it", () => {
  const rf = { type: "routeFailure", episode: { id: "ep1", startedAt: "2026-11-02T10:00:00.000Z", from: { account: "acct_or1", model: "qwen/qwen3-coder:free" } }, turnId: "t1", failure: failure({ class: "quotaExhausted" }) };
  assert.equal(episodeFromEvents([rf, { type: "turnCompleted", status: "completed" }]), null);
  assert.equal(episodeFromEvents([rf, { type: "userMessage", via: "user" }]), null);
  assert.equal(episodeFromEvents([rf, { type: "switchCommitted", reason: "user", target: "acct_gem/gemini/gemini-2.5-flash/-" }]), null);
  // ad's own continuation prompt isn't the user talking: recovery goes on
  const cont = episodeFromEvents([rf, { type: "userMessage", via: "ad" }, { type: "turnCompleted", status: "failed" }]);
  assert.equal(cont.id, "ep1", "a failed turn and ad's continuation don't end the episode");
  assert.equal(cont.paused, null);
});

test("routeTargetOf: a model with slashes, a missing model, effort ignored, a malformed key", () => {
  assert.deepEqual(routeTargetOf("acct_or1/openrouter/qwen/qwen3-coder:free/-"), { account: "acct_or1", model: "qwen/qwen3-coder:free" });
  assert.deepEqual(routeTargetOf("acct_gem/gemini/gemini-2.5-flash/-"), { account: "acct_gem", model: "gemini-2.5-flash" });
  assert.deepEqual(routeTargetOf("acct_or1/openrouter/-/-"), { account: "acct_or1", model: null }, "a missing model is none");
  assert.deepEqual(routeTargetOf("acct_gem/gemini/gemini-2.5-flash/high"), { account: "acct_gem", model: "gemini-2.5-flash" }, "the effort is not routed on");
  assert.equal(routeTargetOf("acct_or1/openrouter"), null, "too few parts");
  assert.equal(routeTargetOf("acct_or1"), null);
  assert.equal(routeTargetOf(null), null);
});

test("maxSwitchesPerHour across episodes: switches older than an hour don't count", () => {
  const at = (ms) => new Date(ms).toISOString();
  const sw = (n, reason = "policy") => ({ type: "switchCommitted", reason, target: `acct_g${n}/gemini/gemini-2.5-flash/-`, at: at(n) });
  const events = [sw(T0 - 70 * 60_000), sw(T0 - 30 * 60_000), sw(T0 - 5 * 60_000), sw(T0 - 60 * 60_000), sw(T0 - 1 * 60_000, "user")];
  assert.equal(switchesLastHour(events, T0), 2, "70 min and exactly 60 min ago are out, 30 and 5 min are in; a user switch never counts");
});

// boundaryCheck: the failing root turn's tools, its child turns' included: { status, effect, background, summary }.
const tool = (o) => ({ status: "completed", effect: "read", background: false, summary: "git status", ...o });

test("boundary: an open request waits; a running tool waits; a subagent waits", () => {
  assert.deepEqual(boundaryCheck({ requests: 1 }), { wait: "request" });
  assert.deepEqual(boundaryCheck({ requests: 1, tools: [tool({ status: "running", effect: "write" })] }), { wait: "request" }, "the request outranks everything");
  assert.deepEqual(boundaryCheck({ tools: [tool({ status: "running", effect: "write" })] }), { wait: "tool" });
  assert.deepEqual(boundaryCheck({ tools: [tool({ status: "running", effect: null, summary: null })] }), { wait: "tool" }, "an effect ad can't place still runs");
  assert.deepEqual(boundaryCheck({ tools: [tool({ status: "running", effect: "write" }), tool({ status: "unknown", effect: "write" })], subagents: 2 }),
    { wait: "tool" }, "the running tool outranks the unknown stop and the subagent");
  assert.deepEqual(boundaryCheck({ tools: [tool({ status: "running", effect: "write", background: true })], subagents: 2 }),
    { wait: "subagent" }, "a tool in the background doesn't hold the boundary");
});

test("boundary: an unknown non-read tool pauses with its command; an unknown read doesn't", () => {
  assert.deepEqual(boundaryCheck({ tools: [tool({ status: "unknown", effect: "write", summary: "npm run deploy" })] }),
    { pause: "mayBeRunning", text: TXT.MAY_BE_RUNNING("npm run deploy") });
  assert.deepEqual(boundaryCheck({ tools: [tool({ status: "unknown", effect: null, summary: null })] }),
    { pause: "mayBeRunning", text: TXT.MAY_BE_RUNNING("a command") }, "no way to name it");
  assert.deepEqual(boundaryCheck({ tools: [tool({ status: "unknown", effect: "read" })] }),
    { ok: true, keep: [] }, "a read can't have side effects left over");
});

test("boundary: with SWITCH_AFTER_TOOL_CALLS off, a failed turn that ran a non-read tool pauses; read-only tools don't", () => {
  const off = { switchAfterToolCalls: false };
  assert.deepEqual(boundaryCheck({ tools: [tool({ effect: "write", summary: "npm run fix" })], ...off }),
    { pause: "toolCalls", text: TXT.TOOL_CALLS });
  assert.deepEqual(boundaryCheck({ tools: [tool({ effect: "write", background: true, summary: "npm run dev" })], ...off }),
    { ok: true, keep: [] }, "a background write isn't this rule's case");
  assert.deepEqual(boundaryCheck({ tools: [tool({ effect: "read" })], ...off }), { ok: true, keep: [] });
});

test("boundary: by default (S-RECOVERY passed) a turn whose tools all settled moves; an unknown one still pauses", () => {
  assert.equal(SWITCH_AFTER_TOOL_CALLS, true);
  for (const status of ["succeeded", "failed", "declined"]) assert.deepEqual(boundaryCheck({ tools: [tool({ status, effect: "exec", summary: "npm test" })] }), { ok: true, keep: [] }, status);
  assert.equal(boundaryCheck({ tools: [tool({ status: "unknown", effect: "exec", summary: "npm run deploy" })] }).pause, "mayBeRunning");
});

test("review fixes: a routeFailure without an episode is ignored; an unreadable switch time counts toward the cap; causeText without a failure", () => {
  assert.equal(episodeFromEvents([{ type: "routeFailure", turnId: "t1", failure: { class: "rateLimit" } }]), null);
  assert.equal(switchesLastHour([{ type: "switchCommitted", reason: "policy" }, { type: "switchCommitted", reason: "policy", at: "garbage" }], Date.parse("2026-11-02T10:00:00.000Z")), 2);
  assert.equal(causeText(null, "openrouter"), "OpenRouter stopped the turn");
});

test("boundary: a non-allowlisted background command pauses; an allowlisted one switches and is kept", () => {
  assert.deepEqual(boundaryCheck({ terminals: [{ command: "npm run dev -- --port 3000" }], allowRunningBackground: ["npm run dev"] }),
    { ok: true, keep: [{ command: "npm run dev -- --port 3000" }] }, "the confirmed long-runner keeps going into the next capsule");
  assert.deepEqual(boundaryCheck({ terminals: [{ command: "./migrate.sh" }], allowRunningBackground: ["npm run dev"] }),
    { pause: "background", text: TXT.BACKGROUND("./migrate.sh") });
  assert.deepEqual(boundaryCheck({ terminals: [{ command: "git status" }] }),
    { ok: true, keep: [{ command: "git status" }] }, "a read-only terminal needs no allowlist entry");
});

test("boundary: the keep-running list matches the command inside the engine's shell wrapper, and the pause names that command", () => {
  // As the pinned engine reports a command on Windows and elsewhere (F11 on the real engine).
  const ps = `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'npm run dev -- --port 3000'`;
  const sh = "/bin/bash -lc 'npm run dev -- --port 3000'";
  for (const command of [ps, sh]) {
    assert.deepEqual(boundaryCheck({ terminals: [{ command }], allowRunningBackground: ["npm run dev"] }), { ok: true, keep: [{ command }] }, command);
  }
  assert.deepEqual(boundaryCheck({ terminals: [{ command: `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command './migrate.sh'` }], allowRunningBackground: ["npm run dev"] }),
    { pause: "background", text: TXT.BACKGROUND("./migrate.sh") }, "the user's words, not the wrapper");
});

test("boundary: pause reasons word for word", () => {
  assert.equal(boundaryCheck({ tools: [tool({ status: "unknown", effect: "write", summary: "npm run deploy" })] }).text,
    "`npm run deploy` may still be running from the failed turn (ad can't tell whether it finished)");
  assert.equal(boundaryCheck({ tools: [tool({ effect: "write", summary: "npm run fix" })], switchAfterToolCalls: false }).text,
    "the failed turn ran commands or made edits, and ad doesn't move such a turn by itself yet");
  assert.equal(boundaryCheck({ terminals: [{ command: "./migrate.sh" }], allowRunningBackground: ["npm run dev"] }).text,
    "`./migrate.sh` is still running in the background (allow long-running commands in /fallback rules if this is a server)");
});

// beforeDispatch: `current` is the target the next prompt is about to start on.
const OR_ACCOUNT = { id: "acct_or1", provider: "openrouter", label: "work" };
const DISPATCH = { account: OR_ACCOUNT, model: "qwen/qwen3-coder:free", label: "OpenRouter · work · qwen/qwen3-coder:free" };
const BENCHED = T0 + 5 * 60_000;

test("before dispatch: a target fallback chose, whose provider is now benched, switches; a target the user picked by hand on a benched provider is used, with one notice", () => {
  assert.deepEqual(beforeDispatch({ current: DISPATCH, chosenBy: "fallback", limit: "limited", benchedUntil: BENCHED, now: T0 }),
    { switch: true, why: "benched" }, "fallback defers to the bench it caused");
  assert.deepEqual(beforeDispatch({ current: DISPATCH, chosenBy: "fallback", limit: "limited", benchedUntil: null, now: T0 }),
    null, "no bench, no switch");
  const notice = beforeDispatch({ current: DISPATCH, chosenBy: "user", limit: "limited", benchedUntil: BENCHED, now: T0 });
  assert.equal(notice.notice,
    `OpenRouter hit a limit earlier${until(BENCHED)}; you picked OpenRouter · work · qwen/qwen3-coder:free, so ad uses it. Fallback won't move to another OpenRouter account by itself.`);
  assert.deepEqual(beforeDispatch({ current: DISPATCH, chosenBy: "user", limit: "limited", benchedUntil: BENCHED, now: T0, noticeShown: true }),
    null, "the notice shows once per bench");
});

test("before dispatch: an exhausted target switches whoever chose it; ok or unknown limits don't", () => {
  assert.deepEqual(beforeDispatch({ current: DISPATCH, chosenBy: "user", limit: "exhausted", benchedUntil: null, now: T0 }),
    { switch: true, why: "exhausted" }, "the user's own pick can't answer either");
  assert.deepEqual(beforeDispatch({ current: DISPATCH, chosenBy: "fallback", limit: "exhausted", benchedUntil: null, now: T0 }),
    { switch: true, why: "exhausted" });
  assert.deepEqual(beforeDispatch({ current: DISPATCH, chosenBy: "fallback", limit: "ok", benchedUntil: null, now: T0 }), null);
  assert.deepEqual(beforeDispatch({ current: DISPATCH, chosenBy: "fallback", limit: "unknown", benchedUntil: null, now: T0 }), null);
  assert.deepEqual(beforeDispatch({ current: DISPATCH, chosenBy: "fallback", limit: "limited", benchedUntil: T0 - 1, now: T0 }),
    null, "a bench in the past is stale");
});

test("watchdog: the budget running out while a tool runs waits for it, then interrupts on the next tick", () => {
  const T0 = Date.parse("2026-11-02T10:00:00.000Z");
  let st = watchdogStart({ turnId: "t1", at: T0 });
  ({ st } = watchdogStep(st, { type: "notice", at: T0, failure: null }, { budgetMs: 10_000 }));
  const busy = watchdogStep(st, { type: "tick", at: T0 + 11_000 }, { budgetMs: 10_000, toolsInProgress: true });
  assert.equal(busy.interrupt, null, "never while a tool of the root or a child turn runs");
  assert.equal(busy.st.waitingForTool, true);
  const free = watchdogStep(busy.st, { type: "tick", at: T0 + 12_000 }, { budgetMs: 10_000, toolsInProgress: false });
  assert.equal(free.interrupt.cause.class, "transientNetwork");
});

test("detect: the user's Esc stays cancelled even when the gateway saw a rate limit in that turn", () => {
  const failure = { class: "rateLimit", period: "minute", retryAfterMs: 5000, resetsAt: null, source: "gateway", reason: "429" };
  assert.deepEqual(detect({ turn: { id: "t1", status: "interrupted" }, failure, interrupted: null, policy: { on: [...FALLBACK_ON] } }), { trigger: false, why: "cancelled" });
  assert.equal(detect({ turn: { id: "t1", status: "interrupted" }, failure, interrupted: { turnId: "t1", cause: failure }, policy: { on: [...FALLBACK_ON] } }).trigger, true);
});

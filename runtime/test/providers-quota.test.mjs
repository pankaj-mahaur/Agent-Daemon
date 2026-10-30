// P4.3: the QuotaStore: limits as they were last seen, never older than they can be trusted,
// and the provider bench that spans sessions and restarts. In a throwaway AD_ROOT.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-quota-"));
const saved = { AD_ROOT: process.env.AD_ROOT };
process.env.AD_ROOT = path.join(TMP, ".agent-daemon");
after(() => {
  if (saved.AD_ROOT === undefined) delete process.env.AD_ROOT;
  else process.env.AD_ROOT = saved.AD_ROOT;
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const Q = await import("../src/providers/quota.mjs");
const NOW = Date.parse("2026-10-29T10:00:00.000Z");
const H = 3_600_000;

test("mergeRateLimits: a partial update replaces only the windows it carries", () => {
  const prev = { limitId: "lim_main", primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1 }, secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 2 }, planType: "plus" };
  const next = { limitId: "lim_main", primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: 3 } };
  const m = Q.mergeRateLimits(prev, next);
  assert.equal(m.primary.usedPercent, 55);
  assert.deepEqual(m.secondary, prev.secondary, "secondary kept");
  assert.equal(m.planType, "plus");
  assert.deepEqual(Q.mergeRateLimits(null, next), next);
  const other = Q.mergeRateLimits(prev, { limitId: "lim_other", primary: { usedPercent: 1 } });
  assert.equal(other.limitId, "lim_other", "another limit id is another snapshot");
  assert.equal(other.secondary, undefined);
});

test("ChatGPT windows: by duration; exhausted at 100 %, a reached type, a spend control or no ordinary usage; null allowance is unknown", () => {
  const snap = { limitId: "lim_main", primary: { usedPercent: 92, windowDurationMins: 300, resetsAt: NOW / 1000 + 3600 }, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: NOW / 1000 + 86400 } };
  const obs = Q.fromChatgpt(snap, { accountId: "acct_c", now: NOW });
  const by = Object.fromEntries(obs.map((o) => [o.window, o]));
  assert.equal(by["5h"].state, "near");
  assert.equal(by.week.state, "exhausted");
  assert.equal(by.week.resetsAt, new Date(NOW + 86_400_000).toISOString());
  assert.equal(by.week.source, "chatgpt:rateLimits/updated");
  for (const extra of [{ rateLimitReachedType: "rate_limit_reached" }, { spendControlReached: true }, { ordinaryUsageAllowed: false }]) {
    const o = Q.fromChatgpt({ limitId: "lim_main", primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: NOW / 1000 + 60 }, ...extra }, { accountId: "a", now: NOW });
    assert.ok(o.some((x) => x.state === "exhausted"), JSON.stringify(extra));
  }
  const unknown = Q.fromChatgpt({ limitId: "lim_main", primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: NOW / 1000 + 60 }, ordinaryUsageAllowed: null }, { accountId: "a", now: NOW });
  assert.ok(unknown.every((x) => x.state === "unknown"));
});

test("reading rule: past its reset, or 6 h old with no reset → unknown, never ok", () => {
  const base = { v: 1, accountId: "a", provider: "openai", scope: "account", model: null, window: "day", usedPercent: 10, used: null, limit: null, remaining: 90, state: "ok", source: "gateway:headers", confidence: "reported" };
  assert.equal(Q.stateAt({ ...base, resetsAt: new Date(NOW + H).toISOString(), observedAt: new Date(NOW - H).toISOString() }, NOW), "ok");
  assert.equal(Q.stateAt({ ...base, resetsAt: new Date(NOW - 1).toISOString(), observedAt: new Date(NOW - H).toISOString() }, NOW), "unknown");
  assert.equal(Q.stateAt({ ...base, resetsAt: null, observedAt: new Date(NOW - 7 * H).toISOString() }, NOW), "unknown");
  assert.equal(Q.stateAt({ ...base, state: "exhausted", resetsAt: new Date(NOW - 1).toISOString(), observedAt: new Date(NOW - H).toISOString() }, NOW), "unknown", "an exhausted limit past its reset is unknown too");
});

test("headers → windows: OpenAI x-ratelimit-*, OpenRouter's, a Retry-After makes a limited observation", () => {
  const openai = Q.fromHeaders({ "x-ratelimit-limit-requests": "500", "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "12s", "x-ratelimit-limit-tokens": "30000", "x-ratelimit-remaining-tokens": "29000", "x-ratelimit-reset-tokens": "2s" }, { accountId: "a", provider: "openai", now: NOW });
  const req = openai.find((o) => o.window === "minute" && o.limit === 500);
  assert.equal(req.remaining, 0);
  assert.equal(req.state, "limited");
  assert.equal(req.resetsAt, new Date(NOW + 12_000).toISOString());
  const or = Q.fromHeaders({ "x-ratelimit-limit": "50", "x-ratelimit-remaining": "3", "x-ratelimit-reset": String(NOW + 60_000) }, { accountId: "b", provider: "openrouter", now: NOW });
  assert.equal(or[0].remaining, 3);
  assert.equal(or[0].resetsAt, new Date(NOW + 60_000).toISOString());
  const ra = Q.fromHeaders({ "retry-after": "30" }, { accountId: "c", provider: "groq", now: NOW, status: 429 });
  assert.equal(ra[0].state, "limited");
  assert.equal(ra[0].resetsAt, new Date(NOW + 30_000).toISOString());
  assert.deepEqual(Q.fromHeaders({}, { accountId: "d", provider: "x", now: NOW }), []);
});

test("OpenRouter /key: both nestings; the free daily window resets at 00:00 UTC; credits", () => {
  const top = { free_model_daily_requests: { used: 50, limit: 50, remaining: 0 }, limit_remaining: 1.5 };
  for (const j of [top, { data: top }]) {
    const r = Q.fromOpenRouterKey(j, { accountId: "or", now: NOW });
    const day = r.observations.find((o) => o.window === "day");
    assert.equal(day.state, "exhausted");
    assert.equal(day.resetsAt, "2026-10-30T00:00:00.000Z");
    assert.equal(r.freeDaily.remaining, 0);
    assert.equal(r.observations.find((o) => o.window === "credits").remaining, 1.5);
  }
  assert.deepEqual(Q.fromOpenRouterKey({}, { accountId: "or", now: NOW }).observations, []);
});

test("the store: recorded, read back with the reading rule; offline (nothing seen) is unknown", async () => {
  await Q.recordObservations(Q.fromChatgpt({ limitId: "lim_main", primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: NOW / 1000 + 3600 } }, { accountId: "acct_s", now: NOW }), { now: NOW });
  assert.equal(Q.limitState("acct_s", { now: NOW }), "ok");
  assert.equal(Q.limitState("acct_s", { now: NOW + 2 * H }), "unknown", "past the reset");
  assert.equal(Q.limitState("never-seen", { now: NOW }), "unknown");
});

test("benchProvider survives a reopen, expires at until, and defaults to 24 h for a quota, 10 min for a rate limit", async () => {
  await Q.benchProvider("openrouter", { until: new Date(NOW + H).toISOString(), reason: "quotaExhausted", accountId: "or" }, { now: NOW });
  assert.equal(Q.benchedUntil("openrouter", { now: NOW }), NOW + H);
  assert.equal(Q.benchedUntil("openrouter", { now: NOW + H + 1 }), null);
  await Q.benchProvider("groq", { reason: "quotaExhausted", accountId: "g" }, { now: NOW });
  assert.equal(Q.benchedUntil("groq", { now: NOW }), NOW + 24 * H);
  await Q.benchProvider("cerebras", { reason: "rateLimit", accountId: "c" }, { now: NOW });
  assert.equal(Q.benchedUntil("cerebras", { now: NOW }), NOW + 10 * 60_000);
  // A later, shorter bench never shortens a longer one.
  await Q.benchProvider("groq", { reason: "rateLimit", accountId: "g" }, { now: NOW });
  assert.equal(Q.benchedUntil("groq", { now: NOW }), NOW + 24 * H);
  // Another process (a fresh read of the file) sees it.
  const file = path.join(process.env.AD_ROOT, "quota", "observations.json");
  assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).bench.openrouter);
});

test("two processes × 50 writes: nothing lost", async () => {
  const script = path.join(TMP, "writer.mjs");
  fs.writeFileSync(script, `import { recordObservations } from ${JSON.stringify(new URL("../src/providers/quota.mjs", import.meta.url).href)};\nconst tag = process.argv[2];\nfor (let i = 0; i < 50; i++) await recordObservations([{ v: 1, accountId: tag + i, provider: "p", scope: "account", model: null, window: "day", usedPercent: 1, used: null, limit: null, remaining: null, resetsAt: null, state: "ok", source: "gateway:headers", observedAt: new Date().toISOString(), confidence: "reported" }], { waitMs: 30000 });\n`);
  const run = (tag) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [script, tag], { env: process.env, stdio: "ignore" });
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`writer ${tag} exited ${c}`))));
  });
  await Promise.all([run("x"), run("y")]);
  const all = Q.readStore().observations;
  for (const tag of ["x", "y"]) for (let i = 0; i < 50; i++) assert.ok(Object.values(all).some((o) => o.accountId === tag + i), tag + i);
});

// ---- Review P4.3 ----

test("mergeRateLimits takes a cleared flag as it is; another limit id keeps its own snapshot", () => {
  const prev = { limitId: "lim_main", primary: { usedPercent: 100, windowDurationMins: 300 }, rateLimitReachedType: "primary" };
  const m = Q.mergeRateLimits(prev, { limitId: "lim_main", primary: { usedPercent: 3, windowDurationMins: 300 }, rateLimitReachedType: null });
  assert.equal(m.rateLimitReachedType, null);
  assert.ok(Q.fromChatgpt(m, { accountId: "a", now: NOW }).every((o) => o.state !== "exhausted"));
  const both = Q.mergeRateLimits(m, { limitId: "lim_other", primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: NOW / 1000 + 60 } });
  assert.equal(both.byLimit.lim_main.primary.usedPercent, 3, "the first limit kept");
  const obs = Q.fromChatgpt(both, { accountId: "a", now: NOW });
  assert.deepEqual(obs.map((o) => `${o.kind}:${o.state}`).sort(), ["lim_main:ok", "lim_other:exhausted"]);
});

test("requests and tokens windows are kept apart", async () => {
  const obs = Q.fromHeaders({ "x-ratelimit-limit-requests": "10", "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "20s", "x-ratelimit-limit-tokens": "1000", "x-ratelimit-remaining-tokens": "900", "x-ratelimit-reset-tokens": "1s" }, { accountId: "acct_rt", provider: "openai", now: NOW });
  await Q.recordObservations(obs, { now: NOW });
  assert.equal(Q.limitState("acct_rt", { now: NOW }), "limited", "the requests window isn't overwritten by tokens");
});

test("an ok seen more than 6 h ago isn't trusted, even with a reset days away; your own endpoint's bench is its own", async () => {
  const o = { v: 1, accountId: "w", scope: "account", window: "week", state: "ok", resetsAt: new Date(NOW + 5 * 24 * H).toISOString(), observedAt: new Date(NOW - 7 * H).toISOString() };
  assert.equal(Q.stateAt(o, NOW), "unknown");
  assert.equal(Q.stateAt({ ...o, state: "exhausted" }, NOW), "exhausted", "a used-up limit stays used up until its reset");
  assert.equal(Q.benchKey("custom", "acct_x"), "custom:acct_x");
  assert.equal(Q.benchKey("groq", "acct_y"), "groq");
});

test("a limit with no reset time, seen more than 6 h ago, is unknown whatever it said (exhausted included)", () => {
  const o = { v: 1, accountId: "z", scope: "account", window: "unknown", state: "exhausted", resetsAt: null, observedAt: new Date(NOW - 7 * H).toISOString() };
  assert.equal(Q.stateAt(o, NOW), "unknown");
  assert.equal(Q.stateAt({ ...o, observedAt: new Date(NOW - H).toISOString() }, NOW), "exhausted");
});

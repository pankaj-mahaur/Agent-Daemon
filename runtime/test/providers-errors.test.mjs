// P4.3: failure classification. Every row the real engine and gateway recorded
// (fixtures/engine-failures-0.163.json) against Tables A (gateway) and B (engine), plus
// the ChatGPT-only shapes with their texts from the pinned binary.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyEngine, classifyTurnError, classifyUpstream, engineInfo, FALLBACK_CLASSES } from "../src/providers/errors.mjs";
import { ENGINE } from "../src/engine/attribution.mjs";

const raw = JSON.parse(readFileSync(new URL("./fixtures/engine-failures-0.163.json", import.meta.url), "utf8")).scenarios;
// The recorded turn error, as the engine's events module hands it on: { message, info }.
const normalized = ({ message, additionalDetails, misalignment, ...rest }) => ({ message, details: additionalDetails, info: Object.values(rest)[0] ?? null });
const fx = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, { ...v, turnError: normalized(v.turnError) }]));
const AT = "2026-10-29T10:00:00.000Z";
const NOW = Date.parse(AT);
// The last gateway observation with an error (as the coordinator picks it), dated AT.
const obsOf = (name, extra = {}) => ({ ...[...fx[name].gateway].reverse().find((g) => g.error || g.status >= 400), at: AT, accountId: "acct_t", provider: "openai", ...extra });

const EXPECT = {
  // name: [with the gateway's observation, engine error alone (an API account)]
  QUOTA: ["quotaExhausted", "quotaExhausted"],
  RATE1: ["rateLimit", "rateLimit"],
  RATE3600: ["rateLimit", "quotaExhausted"],
  ORFREE: ["quotaExhausted", "rateLimit"],
  OR402: ["quotaExhausted", "unknown"],
  GEMDAY: ["quotaExhausted", "rateLimit"],
  S503: ["provider5xx", "provider5xx"],
  CTX400: ["contextOverflow", "unknown"],
  CTXSSE: ["contextOverflow", "contextOverflow"],
  FAILUNK: ["unknown", "unknown"],
  OVERLOAD: ["provider5xx", "provider5xx"],
  RESET: ["transientNetwork", "provider5xx"],
};

test("every recorded row classifies per Tables A and B", () => {
  for (const [name, [withObs, engineOnly]] of Object.entries(EXPECT)) {
    const row = fx[name];
    assert.ok(row, `the fixture has ${name}`);
    const err = row.turnError;
    const provider = name === "ORFREE" || name === "OR402" ? "openrouter" : name === "GEMDAY" ? "gemini" : "openai";
    assert.equal(classifyTurnError({ error: err, observation: obsOf(name, { provider }), accountKind: "api", now: NOW }).class, withObs, `${name} with the observation`);
    assert.equal(classifyTurnError({ error: err, observation: null, accountKind: "api", now: NOW }).class, engineOnly, `${name} from the engine alone`);
  }
});

test("a capped Retry-After 3600 keeps retryAfterMs 3600 s and resetsAt now+1h", () => {
  const f = classifyUpstream(obsOf("RATE3600"), { now: NOW });
  assert.equal(f.class, "rateLimit");
  assert.equal(f.retryAfterMs, 3_600_000);
  assert.equal(f.resetsAt, new Date(NOW + 3_600_000).toISOString());
});

test("Gemini PerDay with retryDelay 36s is quotaExhausted (gateway), for the day; PerMinute is a rate limit", () => {
  const f = classifyUpstream(obsOf("GEMDAY", { provider: "gemini" }), { now: NOW });
  assert.equal(f.class, "quotaExhausted");
  assert.equal(f.period, "day");
  const minute = classifyUpstream({ status: 429, at: AT, error: { status: 429, statusText: "RESOURCE_EXHAUSTED", quotaIds: ["GenerateRequestsPerMinutePerProjectPerModel"], retryDelay: "36s", message: "" } }, { now: NOW });
  assert.equal(minute.class, "rateLimit");
  assert.equal(minute.retryAfterMs, 36_000);
});

test("OpenRouter 429 with /key remaining 0 is quotaExhausted for the day (to 00:00 UTC); with remaining > 0 it is a rate limit", () => {
  const plain = { status: 429, at: AT, provider: "openrouter", retryAfterS: 20, error: { status: 429, code: "429", message: "Rate limit exceeded" } };
  const out = classifyUpstream(plain, { probe: { freeDaily: { used: 50, limit: 50, remaining: 0 } }, now: NOW });
  assert.equal(out.class, "quotaExhausted");
  assert.equal(out.period, "day");
  assert.equal(out.resetsAt, "2026-10-30T00:00:00.000Z");
  const left = classifyUpstream(plain, { probe: { freeDaily: { used: 3, limit: 50, remaining: 47 } }, now: NOW });
  assert.equal(left.class, "rateLimit");
  assert.equal(left.retryAfterMs, 20_000);
});

test("responseTooManyFailedAttempts{429} with no observation is rateLimit, with an insufficient_quota observation is quotaExhausted", () => {
  const err = fx.RATE1.turnError;
  assert.deepEqual(engineInfo(err.info), { name: "responseTooManyFailedAttempts", status: 429 });
  assert.equal(classifyTurnError({ error: err, accountKind: "api", now: NOW }).class, "rateLimit");
  assert.equal(classifyTurnError({ error: err, observation: obsOf("QUOTA"), accountKind: "api", now: NOW }).class, "quotaExhausted");
});

test("a 400 arrives as other: unknown unless the gateway saw a context error; the engine's text is never parsed", () => {
  const err = fx.CTX400.turnError;
  assert.match(err.message, /context_length_exceeded/, "the body is in the engine's text…");
  assert.equal(classifyEngine({ info: err.info, message: err.message, accountKind: "api" }).class, "unknown", "…and ad doesn't read it there");
  assert.equal(classifyTurnError({ error: err, observation: obsOf("CTX400"), accountKind: "api", now: NOW }).class, "contextOverflow");
});

// ChatGPT accounts never pass the gateway: Table B with the binary's own texts.
// The pinned binary's own text (its product name from attribution.mjs).
const NOT_INCLUDED = `To use ${ENGINE.name} with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.`;
const QUOTA_TEXT = "Quota exceeded. Check your plan and billing details.";

test("UsageNotIncluded is authRevoked and never eligible for a fallback", () => {
  const f = classifyEngine({ info: "usageLimitExceeded", message: NOT_INCLUDED, accountKind: "chatgpt" });
  assert.equal(f.class, "authRevoked");
  assert.ok(!FALLBACK_CLASSES.has(f.class));
});

test("usageLimitExceeded on ChatGPT with rate limits showing nothing exhausted is unknown, with a notice", () => {
  const rateLimits = { limitId: "lim_main", primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1761800000 }, secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1762000000 }, rateLimitReachedType: null };
  const f = classifyEngine({ info: "usageLimitExceeded", message: "You've hit your usage limit.", accountKind: "chatgpt", rateLimits });
  assert.equal(f.class, "unknown");
  assert.match(f.notice, /ChatGPT says the usage limit is reached, but its limits don't show it; switch by hand with \/model if needed\./);
  assert.equal(classifyEngine({ info: "usageLimitExceeded", message: "x", accountKind: "chatgpt", rateLimits: null }).class, "unknown", "no read at all");
});

test("usageLimitExceeded on ChatGPT confirmed by an exhausted window is quotaExhausted, reset from that window", () => {
  const s = Math.floor(NOW / 1000);
  const rateLimits = { limitId: "lim_main", primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: s + 3600 }, secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: s + 86400 } };
  const fresh = { accountKind: "chatgpt", rateLimitsAt: NOW - 1000, now: NOW };
  const f = classifyEngine({ info: "usageLimitExceeded", message: "You've hit your usage limit.", rateLimits, ...fresh });
  assert.equal(f.class, "quotaExhausted");
  assert.equal(f.resetsAt, new Date((s + 3600) * 1000).toISOString());
  assert.equal(classifyEngine({ info: "usageLimitExceeded", message: "x", rateLimits: { primary: { usedPercent: 20 }, rateLimitReachedType: "rate_limit_reached" }, ...fresh }).class, "quotaExhausted");
  // A read older than 2 minutes, or a full window already past its reset, confirms nothing.
  assert.equal(classifyEngine({ info: "usageLimitExceeded", message: "x", rateLimits, accountKind: "chatgpt", rateLimitsAt: NOW - 5 * 60_000, now: NOW }).class, "unknown");
  assert.equal(classifyEngine({ info: "usageLimitExceeded", message: "x", rateLimits: { primary: { usedPercent: 100, resetsAt: s - 60 } }, ...fresh }).class, "unknown");
  assert.equal(classifyEngine({ info: "usageLimitExceeded", message: QUOTA_TEXT, accountKind: "api" }).class, "quotaExhausted", "B2 for API credits");
});

test("Table B: the rest", () => {
  const c = (info, extra = {}) => classifyEngine({ info, message: "m", accountKind: "api", ...extra }).class;
  assert.equal(c("rateLimitExceeded"), "rateLimit");
  for (const i of ["serverOverloaded", "internalServerError", "flexUnavailable"]) assert.equal(c(i), "provider5xx", i);
  assert.equal(c({ httpConnectionFailed: { httpStatusCode: 401 } }), "authExpired");
  assert.equal(c({ httpConnectionFailed: { httpStatusCode: 403 } }), "authRevoked");
  assert.equal(c({ responseStreamConnectionFailed: { httpStatusCode: null } }), "transientNetwork");
  assert.equal(c({ httpConnectionFailed: { httpStatusCode: 429 } }), "rateLimit");
  assert.equal(c("unauthorized"), "authExpired");
  assert.equal(c("contextWindowExceeded"), "contextOverflow");
  for (const i of ["cyberPolicy", "misalignmentPolicyViolation"]) assert.equal(c(i), "contentPolicy", i);
  for (const i of ["other", "badRequest", "sandboxError", "tooManyDenials", "sessionBudgetExceeded", "threadRollbackFailed", "activeTurnNotSteerable", "somethingNew", null]) assert.equal(c(i), "unknown", String(i));
});

test("interrupted with a fallbackInterrupt takes its cause; without one it is cancelled", () => {
  assert.equal(classifyTurnError({ status: "interrupted", accountKind: "api" }).class, "cancelled");
  const cause = { class: "rateLimit", period: null, retryAfterMs: 5000, resetsAt: null, source: "gateway", reason: "429" };
  assert.deepEqual(classifyTurnError({ status: "interrupted", fallbackInterrupt: { cause }, accountKind: "api" }), cause);
});

test("Table A: auth, policy, content, config and the gateway's own network failures", () => {
  const u = (status, error = {}, extra = {}) => classifyUpstream({ status, at: AT, error: { status, ...error }, ...extra }, { now: NOW })?.class ?? null;
  assert.equal(u(401), "authExpired");
  assert.equal(u(403, { code: "subscription_plan_not_eligible" }), "authRevoked");
  assert.equal(u(403, { code: "insufficient_quota" }), "quotaExhausted");
  assert.equal(u(400, { code: "organization_usage_limit_exceeded" }), "quotaExhausted");
  assert.equal(u(429, { type: "FreeUsageLimitError" }), "quotaExhausted");
  assert.equal(u(429, { message: "Limit reached on tokens per day (TPD): Limit 100000" }), "quotaExhausted");
  assert.equal(u(429, { message: "Limit reached on requests per minute (RPM)" }), "rateLimit");
  assert.equal(u(402, { limitSource: "openrouter_in_flight_budget" }), "rateLimit");
  assert.equal(u(400, { code: "content_filter", message: "flagged" }), "contentPolicy");
  assert.equal(u(400, { message: "The model `x` does not exist" }), "invalidConfig");
  assert.equal(u(422, { message: "parallel_tool_calls is not supported" }), "unsupportedFeature");
  for (const s of [500, 502, 503, 504, 529]) assert.equal(u(s), "provider5xx", String(s));
  assert.equal(u(502, { code: "ECONNRESET", message: "couldn't reach api.example.com" }), "transientNetwork");
  assert.equal(u(418), "unknown");
  assert.equal(u(200), null, "a success is no failure");
});

test("a key in a body is redacted in reason", () => {
  const KEY = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz012345"].join("-");
  const f = classifyUpstream({ status: 401, at: AT, error: { status: 401, message: `Incorrect API key provided: ${KEY}` } }, { now: NOW });
  assert.ok(!f.reason.includes(KEY), f.reason);
});

// ---- Review P4.3 ----

test("an account ad can't place never reads a usage limit as an API quota (ad run / ad loop default)", () => {
  assert.equal(classifyEngine({ info: "usageLimitExceeded", message: "You've hit your usage limit.", accountKind: "unknown" }).class, "unknown");
  assert.equal(classifyEngine({ info: "usageLimitExceeded", message: "You've hit your usage limit.", accountKind: "api" }).class, "quotaExhausted");
  assert.equal(classifyTurnError({ error: { message: "x", info: "usageLimitExceeded" } }).class, "unknown", "the default kind is unknown");
});

test("OpenRouter: the body's per-minute counter at 0 is a rate limit; only /key's free day is a day's quota", () => {
  const perMin = { status: 429, at: AT, provider: "openrouter", retryAfterS: 30, error: { status: 429, code: "429", message: "Rate limit exceeded: free-models-per-min." } };
  const f = classifyUpstream(perMin, { now: NOW });
  assert.equal(f.class, "rateLimit");
  assert.equal(f.retryAfterMs, 30_000);
  const perDay = classifyUpstream({ ...perMin, error: { ...perMin.error, message: "Rate limit exceeded: free-models-per-day." } }, { now: NOW });
  assert.equal(perDay.class, "quotaExhausted");
  assert.equal(perDay.resetsAt, null, "no reset ad wasn't told: the bench's default applies");
});

test("no invented resets: Gemini's PerDay quota has none (its day isn't UTC's)", () => {
  const f = classifyUpstream(obsOf("GEMDAY", { provider: "gemini" }), { now: NOW });
  assert.equal(f.class, "quotaExhausted");
  assert.equal(f.resetsAt, null);
});

test("the provider's answer wins only over errors that could have come from it; ad's own refusals never count", () => {
  const quota = obsOf("QUOTA");
  assert.equal(classifyTurnError({ error: { message: "sandbox failed", info: "sandboxError" }, observation: quota, accountKind: "api", now: NOW }).class, "unknown");
  assert.equal(classifyTurnError({ error: { message: "x", info: { httpConnectionFailed: { httpStatusCode: 503 } } }, observation: { status: 503, at: AT, local: true, error: null }, accountKind: "api", now: NOW }).class, "provider5xx", "the engine's own code, not ad's in-flight cap");
  assert.equal(classifyTurnError({ error: { message: "x", info: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } }, observation: quota, accountKind: "api", now: NOW }).class, "quotaExhausted");
});

test("an observation found by account must agree with the engine's status; the engine is sure of a context overflow", () => {
  const sub429 = { ...obsOf("RATE1"), by: "account" };
  assert.equal(classifyTurnError({ error: { message: "x", info: { httpConnectionFailed: { httpStatusCode: 503 } } }, observation: sub429, accountKind: "api", now: NOW }).class, "provider5xx", "a subagent's 429 doesn't relabel the root's 503");
  assert.equal(classifyTurnError({ error: { message: "x", info: "contextWindowExceeded" }, observation: sub429, accountKind: "api", now: NOW }).class, "contextOverflow");
  assert.equal(classifyTurnError({ error: { message: "x", info: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } }, observation: { ...obsOf("QUOTA"), by: "account" }, accountKind: "api", now: NOW }).class, "quotaExhausted", "agreeing: it counts");
});

test("a minute's limit named in the message wins over a word like daily", () => {
  const f = classifyUpstream({ status: 429, at: AT, error: { status: 429, message: "Rate limit reached for tokens per min (TPM). Upgrade for higher daily limits." } }, { now: NOW });
  assert.equal(f.class, "rateLimit");
});

test("one classifier for every window (TUI, ad run, ad loop): the account's kind decides; no gateway, the engine alone", async () => {
  const { classifyTurnFailure } = await import("../src/harness/gateway-runtime.mjs");
  const usage = { message: "You've hit your usage limit.", info: "usageLimitExceeded" };
  assert.equal(classifyTurnFailure({ error: usage, status: "failed", account: null }).class, "unknown");
  assert.equal(classifyTurnFailure({ error: usage, status: "failed", account: { id: "a", method: "api-key" } }).class, "quotaExhausted");
  assert.equal(classifyTurnFailure({ error: usage, status: "failed", account: { id: "c", method: "engine-login" } }).class, "unknown", "ChatGPT: unconfirmed");
});

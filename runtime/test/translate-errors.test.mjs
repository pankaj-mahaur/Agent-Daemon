// P6.1 §6: upstream failures → only codes the engine knows, plus the side-channel class.

import { test } from "node:test";
import assert from "node:assert/strict";
import { httpFailure, streamFailure } from "../src/gateway/translate/errors.mjs";

const j = (o) => JSON.stringify(o);

test("per-minute 429 with Retry-After 7 → rate_limit_exceeded 'try again in 7s'", () => {
  const f = httpFailure(429, j({ error: { message: "Rate limit reached for requests per minute" } }), { retryAfter: "7", label: "Groq" });
  assert.equal(f.http.status, 429);
  assert.equal(f.http.body.error.code, "rate_limit_exceeded");
  assert.match(f.http.body.error.message, /try again in 7s/);
  assert.equal(f.http.headers["retry-after"], "7");
  assert.equal(f.side.kind, "rateLimit");
});

test("a daily limit (Groq TPD) or a Gemini PerDay quota → insufficient_quota, never a rate limit", () => {
  const groq = httpFailure(429, j({ error: { message: "Rate limit reached for model in organization on tokens per day (TPD): Limit 100000. Please try again in 7m12s." } }), { label: "Groq" });
  assert.equal(groq.http.body.error.code, "insufficient_quota");
  assert.equal(groq.side.kind, "quotaExhausted");
  assert.equal(groq.side.period, "day");
  const gemini = httpFailure(429, j([{ error: { code: 429, message: "You exceeded your current quota", status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }, { retryDelay: "36s" }] } }]), { label: "Gemini" });
  assert.equal(gemini.http.body.error.code, "insufficient_quota");
  assert.equal(gemini.side.period, "day");
});

test("real per-minute bodies stay rate limits even when they mention quota or billing", () => {
  const groqTpm = httpFailure(429, j({ error: { message: "Rate limit reached for model `llama-3.3-70b-versatile` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 12000, Used 11000, Requested 2000. Please try again in 7.66s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing", type: "tokens", code: "rate_limit_exceeded" } }), { retryAfter: "8", label: "Groq" });
  assert.equal(groqTpm.http.body.error.code, "rate_limit_exceeded");
  assert.equal(groqTpm.side.retryAfterS, 8);
  const geminiRpm = httpFailure(429, j([{ error: { code: 429, message: "You exceeded your current quota, please check your plan and billing details.", status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }] }, { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "36s" }] } }]), { label: "Gemini" });
  assert.equal(geminiRpm.http.body.error.code, "rate_limit_exceeded");
  assert.equal(geminiRpm.side.retryAfterS, 36);
  const mistral = httpFailure(429, j({ message: "Requests rate limit exceeded" }), { label: "Mistral" });
  assert.equal(mistral.http.body.error.code, "rate_limit_exceeded", "no wait hint: a short default wait, not a quota");
  assert.equal(streamFailure({ message: "Failed to generate a response" }).code, "ad_upstream_disconnected", "'generate' is not a rate limit");
});

test("a wait longer than the cap → an immediate insufficient_quota", () => {
  const f = httpFailure(429, j({ error: { message: "slow down" } }), { retryAfter: "3600", capS: 60 });
  assert.equal(f.http.body.error.code, "insufficient_quota");
  assert.equal(f.http.headers["retry-after"], "0");
});

test("context too long before streaming → the SSE form, never an HTTP 400", () => {
  const f = httpFailure(400, j({ error: { message: "This model's maximum context length is 8192 tokens" } }));
  assert.equal(f.http, null);
  assert.equal(f.sse.code, "context_length_exceeded");
  assert.equal(f.side.kind, "contextOverflow");
});

test("402 credit → insufficient_quota; 5xx → server_is_overloaded; 401/403 pass through redacted", () => {
  assert.equal(httpFailure(402, "{}").http.body.error.code, "insufficient_quota");
  const s = httpFailure(502, "bad gateway");
  assert.deepEqual([s.http.status, s.http.body.error.code, s.side.kind], [503, "server_is_overloaded", "provider5xx"]);
  const key = ["sk", "proj", "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"].join("-");
  const a = httpFailure(401, j({ error: { message: `Incorrect API key provided: ${key}` } }));
  assert.equal(a.http.status, 401);
  assert.equal(a.side.kind, "authExpired");
  assert.ok(!JSON.stringify(a).includes(key), "the key is redacted");
  assert.equal(httpFailure(403, "{}").side.kind, "authRevoked");
});

test("an unclassified 4xx → 400 invalid_request with the provider's message, class unknown", () => {
  const f = httpFailure(404, j({ error: { message: "model not found" } }), { label: "Groq" });
  assert.deepEqual([f.http.status, f.http.body.error.code, f.side.kind], [400, "invalid_request", "unknown"]);
  assert.match(f.http.body.error.message, /model not found/);
});

test("errors inside the stream", () => {
  assert.equal(streamFailure({ message: "monthly quota exceeded" }).code, "insufficient_quota");
  assert.equal(streamFailure({ message: "context length exceeded" }).code, "context_length_exceeded");
  assert.equal(streamFailure({ message: "Rate limit. Please try again in 3s." }).code, "rate_limit_exceeded");
  assert.equal(streamFailure({ message: "upstream reset" }).code, "ad_upstream_disconnected");
});

test("a provider's named usage limit, in type or in code, is a quota with the reset time", () => {
  for (const body of [{ type: "error", error: { type: "GoUsageLimitError", message: "limit" } }, { error: { code: "GoUsageLimitError", message: "limit" } }]) {
    const f = httpFailure(429, JSON.stringify(body), { retryAfter: "120", label: "OpenCode Go", quotaNames: ["GoUsageLimitError"] });
    assert.equal(f.http.body.error.code, "insufficient_quota");
    assert.match(f.http.body.error.message, /^OpenCode Go's usage limit is reached\. It resets at \d\d:\d\d/);
  }
});

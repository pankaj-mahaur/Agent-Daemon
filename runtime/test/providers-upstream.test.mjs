// P4.3: the gateway's observations in ad's process: limits recorded, providers benched, spend
// charged, OpenRouter's /key read after a 429. In a throwaway AD_ROOT.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-upstream-"));
const saved = { AD_ROOT: process.env.AD_ROOT };
process.env.AD_ROOT = path.join(TMP, ".agent-daemon");
after(() => {
  if (saved.AD_ROOT === undefined) delete process.env.AD_ROOT;
  else process.env.AD_ROOT = saved.AD_ROOT;
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const { createUpstreamRecorder, probeOpenRouterKey } = await import("../src/providers/upstream.mjs");
const Q = await import("../src/providers/quota.mjs");
const S = await import("../src/providers/spend.mjs");
const NOW = Date.parse("2026-10-29T10:00:00.000Z");

test("an OpenRouter 429 with /key remaining 0: a quotaExhausted observation until 00:00 UTC and a bench on openrouter", async () => {
  // A local stand-in for openrouter.ai's /key, answering for this key only.
  const KEY = ["sk", "or", "v1", "upstreamupstreamupst"].join("-");
  const srv = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${KEY}`) return void res.writeHead(401).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { label: "x", free_model_daily_requests: { used: 50, limit: 50, remaining: 0 } } }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const failures = [];
  try {
    const url = `http://127.0.0.1:${srv.address().port}/api/v1/key`;
    const record = createUpstreamRecorder({ probeKey: () => probeOpenRouterKey({ key: KEY, url }), onFailure: (_e, f) => failures.push(f), now: () => NOW });
    await record({ accountId: "acct_or", provider: "openrouter", status: 429, at: new Date(NOW).toISOString(), retryAfterS: 20, headers: {}, error: { status: 429, code: "429", message: "Rate limit exceeded" } });
    const day = Object.values(Q.readStore().observations).find((o) => o.accountId === "acct_or" && o.window === "day" && o.source === "gateway:error");
    assert.equal(day.state, "exhausted");
    assert.equal(day.resetsAt, "2026-10-30T00:00:00.000Z");
    assert.equal(Q.benchedUntil("openrouter", { now: NOW }), Date.parse("2026-10-30T00:00:00.000Z"));
    assert.equal(failures[0].class, "quotaExhausted");
    // A second 429 within 30 s doesn't read /key again.
    let probes = 0;
    const again = createUpstreamRecorder({ probeKey: async () => (probes++, null), now: () => NOW });
    await again({ accountId: "acct_or2", provider: "openrouter", status: 429, at: new Date(NOW).toISOString(), headers: {}, error: { status: 429 } });
    await again({ accountId: "acct_or2", provider: "openrouter", status: 429, at: new Date(NOW).toISOString(), headers: {}, error: { status: 429 } });
    assert.equal(probes, 1);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test("headers become windows; a 2xx is charged (usage × the catalog's price); a rejection isn't", async () => {
  fs.mkdirSync(path.join(process.env.AD_ROOT, "catalog"), { recursive: true });
  fs.writeFileSync(path.join(process.env.AD_ROOT, "catalog", "acct_oa.json"), JSON.stringify({ v: 1, accountId: "acct_oa", observedAt: new Date(NOW).toISOString(), entries: [{ model: "gpt-x", price: { input: "0.000001", output: "0.000002", request: null } }] }));
  const record = createUpstreamRecorder({ now: () => NOW });
  await record({ accountId: "acct_oa", provider: "openai", status: 200, model: "gpt-x", requestBytes: 900, headers: { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "5", "x-ratelimit-reset-requests": "30s" }, usage: { input_tokens: 1000, output_tokens: 500 } });
  await record({ accountId: "acct_oa", provider: "openai", status: 200, model: "gpt-x", requestBytes: 300, headers: {}, usage: null });
  await record({ accountId: "acct_oa", provider: "openai", status: 429, model: "gpt-x", requestBytes: 300, headers: {}, error: { status: 429, code: "rate_limit_exceeded" }, retryAfterS: 2 });
  const t = S.today("acct_oa", { now: NOW });
  assert.equal(t.requests, 2, "the rejection isn't charged");
  assert.equal(t.estimated, 1, "the stream with no usage, pessimistically");
  assert.ok(Math.abs(t.usd - (1000 * 0.000001 + 500 * 0.000002 + (100 * 0.000001 + 8192 * 0.000002))) < 1e-12, String(t.usd));
  assert.equal(Q.limitState("acct_oa", { now: NOW }), "limited", "the 429's retry window");
  assert.equal(Q.benchedUntil("openai", { now: NOW }), NOW + 2000);
});

test("ad's own answers (its in-flight cap, a missing key) record nothing and bench nobody", async () => {
  const record = createUpstreamRecorder({ now: () => NOW });
  await record({ accountId: "acct_local", provider: "cerebras", status: 503, local: true, headers: {}, error: null });
  // Even an answer that looks like a provider's limit: ad made it, so it says nothing.
  await record({ accountId: "acct_local", provider: "cerebras", status: 429, local: true, retryAfterS: 600, headers: { "retry-after": "600" }, error: { status: 429, code: "rate_limit_exceeded" } });
  assert.equal(Q.benchedUntil("cerebras", { now: NOW }), null);
  assert.equal(Q.limitState("acct_local", { now: NOW }), "unknown");
});

test("a 429 from your own endpoint benches only that account", async () => {
  const record = createUpstreamRecorder({ now: () => NOW });
  await record({ accountId: "acct_mine", provider: "custom", status: 429, headers: {}, error: { status: 429 }, retryAfterS: 60 });
  assert.equal(Q.benchedUntil("custom:acct_mine", { now: NOW }), NOW + 60_000);
  assert.equal(Q.benchedUntil("custom", { now: NOW }), null);
  assert.equal(Q.benchedUntil("custom:acct_other", { now: NOW }), null);
});

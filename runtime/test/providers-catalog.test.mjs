// P4.3: the catalog: what each account's models can do and cost, as last seen; free only
// from a fresh zero price (D12); eligibility codes. In a throwaway AD_ROOT.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-catalog-"));
const saved = { AD_ROOT: process.env.AD_ROOT };
process.env.AD_ROOT = path.join(TMP, ".agent-daemon");
after(() => {
  if (saved.AD_ROOT === undefined) delete process.env.AD_ROOT;
  else process.env.AD_ROOT = saved.AD_ROOT;
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const C = await import("../src/providers/catalog.mjs");
const Q = await import("../src/providers/quota.mjs");
const S = await import("../src/providers/spend.mjs");
const { presetFor } = await import("../src/providers/registry.mjs");
const NOW = Date.parse("2026-10-29T10:00:00.000Z");
const H = 3_600_000;
const OR = { id: "acct_or", provider: "openrouter", label: "work", status: "ready", method: "api-key" };

test("price strings: \"0\" is free; a tiny price isn't; a missing field is ignored; non-numeric is unknown", () => {
  const f = (pricing, o = {}) => C.freeOf(C.priceOf(pricing, NOW), { now: NOW, billing: "metered", ...o }).value;
  assert.equal(f({ prompt: "0", completion: "0" }), true);
  assert.equal(f({ prompt: "0", completion: "0.0000003" }), false);
  assert.equal(f({ prompt: "0", completion: "0", request: undefined }), true, "a missing field is ignored");
  assert.equal(f({ prompt: "free", completion: "0" }), null, "non-numeric: unknown");
  assert.equal(f(null), null, "no price: unknown");
});

test("a 25 h old zero is unknown, not free; a :free id alone is a hint (unknown)", () => {
  const stale = C.freeOf(C.priceOf({ prompt: "0", completion: "0" }, NOW - 25 * H), { now: NOW, billing: "metered" });
  assert.equal(stale.value, null);
  assert.equal(C.freeOf(null, { now: NOW, billing: "metered", id: "qwen/qwen3-coder:free" }).value, null);
});

test("local is free; a subscription never is", () => {
  assert.deepEqual(C.freeOf(null, { now: NOW, billing: "local" }), { value: true, basis: "local", observedAt: null });
  assert.equal(C.freeOf(C.priceOf({ prompt: "0", completion: "0" }, NOW), { now: NOW, billing: "subscription" }).value, false);
});

test("entries from an OpenRouter list: family, route, caps, context, price", () => {
  const json = {
    data: [
      { id: "qwen/qwen3-coder:free", name: "Qwen3 Coder (free)", context_length: 262144, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools", "tool_choice", "reasoning"], architecture: { input_modalities: ["text"] } },
      { id: "openai/gpt-5", name: "GPT-5", context_length: 400000, pricing: { prompt: "0.00000125", completion: "0.00001" }, supported_parameters: ["tools", "reasoning"], architecture: { input_modalities: ["text", "image"] } },
      { id: "some/no-tools", pricing: { prompt: "0.000001", completion: "0.000001" }, supported_parameters: ["temperature"] },
    ],
  };
  const e = C.entriesFrom(OR, json, { preset: presetFor("openrouter"), now: NOW });
  const q = e.find((x) => x.model === "qwen/qwen3-coder:free");
  assert.equal(q.family, "qwen");
  assert.equal(q.route, "direct");
  assert.equal(q.caps.tools, true);
  assert.equal(q.caps.contextWindow, 262144);
  assert.equal(q.free.value, true);
  assert.equal(q.free.basis, "zeroPrice");
  const g = e.find((x) => x.model === "openai/gpt-5");
  assert.equal(g.family, "gpt");
  assert.equal(g.caps.images, true);
  assert.equal(g.free.value, false);
  assert.equal(e.find((x) => x.model === "some/no-tools").caps.tools, false);
  // A chat-translated preset is bridged; a plain OpenAI-shaped list knows nothing of tools.
  const groq = C.entriesFrom({ id: "acct_g", provider: "groq", status: "ready" }, { data: [{ id: "llama-3.3-70b-versatile" }] }, { preset: presetFor("groq"), now: NOW })[0];
  assert.equal(groq.route, "bridged");
  assert.equal(groq.family, "llama");
  assert.equal(groq.caps.tools, null);
  assert.equal(groq.price, null);
});

test("eligibility codes", async () => {
  const [free, paid] = C.entriesFrom(OR, { data: [{ id: "a/free", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"], context_length: 32000 }, { id: "a/paid", pricing: { prompt: "0.000001", completion: "0.000001" }, supported_parameters: ["tools"] }] }, { preset: presetFor("openrouter"), now: NOW });
  const el = (entry, policy = {}, extra = {}) => C.eligibility({ entry, account: OR, ...extra }, policy, { now: NOW });
  assert.deepEqual(el(free), { eligible: true, reasons: [] });
  assert.deepEqual(el(paid, { freeOnly: true }).reasons, ["not-free"]);
  assert.deepEqual(el(paid, { allowPaid: false }).reasons, ["paid-not-allowed"]);
  assert.deepEqual(el(free, { minContext: 64000 }).reasons, ["context-too-small"]);
  assert.deepEqual(el(null).reasons, ["model-not-listed"]);
  assert.deepEqual(el(free, {}, { account: { ...OR, status: "needs-sign-in" } }).reasons, ["account-needs-sign-in"]);
  assert.deepEqual(el(free, {}, { account: { ...OR, status: "disabled" } }).reasons, ["account-disabled"]);
  const noTools = { ...free, caps: { ...free.caps, tools: false } };
  assert.deepEqual(el(noTools).reasons, ["no-tools"]);
  const unknownPrice = { ...paid, price: null, free: { value: null, basis: null, observedAt: null } };
  assert.deepEqual(el(unknownPrice, { freeOnly: true }).reasons, ["price-unknown"]);
  const stale = C.entriesFrom(OR, { data: [{ id: "a/old", pricing: { prompt: "0", completion: "0" } }] }, { preset: presetFor("openrouter"), now: NOW - 25 * H })[0];
  assert.deepEqual(el(stale, { freeOnly: true }).reasons, ["price-stale"]);
  // Limits, the bench and the budget come from the stores.
  await Q.recordObservations(Q.fromOpenRouterKey({ free_model_daily_requests: { used: 50, limit: 50, remaining: 0 } }, { accountId: OR.id, now: NOW }).observations, { now: NOW });
  assert.ok(el(free).reasons.includes("quota-exhausted-until"));
  await Q.benchProvider("openrouter", { reason: "rateLimit", accountId: OR.id }, { now: NOW });
  assert.ok(el(free).reasons.includes("provider-benched-until"));
  await S.addCharge({ accountId: OR.id, usage: { input_tokens: 1_000_000, output_tokens: 0 }, price: { input: "0.000001", output: "0" } }, { now: NOW });
  assert.ok(el(paid, { dailyBudgetUsd: 0.5 }).reasons.includes("budget-reached"));
  await S.addCharge({ accountId: OR.id, usage: null, price: null }, { now: NOW });
  assert.ok(el(paid, { dailyBudgetUsd: 5 }).reasons.includes("usage-unknown-under-budget"));
  const trial = { ...free, data: { ...free.data, trial: true } };
  assert.ok(el(trial).reasons.includes("trial-endpoint-no-consent"));
  assert.ok(!el(trial, { trialConsent: true }).reasons.includes("trial-endpoint-no-consent"));
});

test("refresh: stored atomically, at most once per 10 minutes; a redirect from /models fails and the key isn't re-sent", async () => {
  const KEY = ["sk", "or", "v1", "catalogcatalogcatalog00"].join("-");
  const seen = [];
  const srv = createServer((req, res) => {
    seen.push({ path: req.url, auth: req.headers.authorization ?? null });
    if (req.url.startsWith("/redirect")) return void res.writeHead(302, { location: `http://127.0.0.1:${srv.address().port}/elsewhere` }).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "x/y", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] }] }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const acct = { id: "acct_custom", provider: "custom", status: "ready", endpoint: `${base}/v1`, insecure: true };
    const preset = { ...presetFor("custom"), modelsPath: "/models" };
    const first = await C.refresh(acct, { key: KEY, preset, now: NOW });
    assert.equal(first.entries[0].model, "x/y");
    assert.ok(fs.existsSync(path.join(process.env.AD_ROOT, "catalog", "acct_custom.json")));
    const again = await C.refresh(acct, { key: KEY, preset, now: NOW + 5 * 60_000 });
    assert.equal(seen.length, 1, "not asked again within 10 minutes");
    assert.equal(again.observedAt, first.observedAt);
    await C.refresh(acct, { key: KEY, preset, now: NOW + 11 * 60_000 });
    assert.equal(seen.length, 2);
    // A redirect: refused, and nothing reaches the redirect's target.
    const bad = { ...acct, id: "acct_redirect", endpoint: `${base}/redirect` };
    await assert.rejects(C.refresh(bad, { key: KEY, preset, now: NOW }), (e) => /redirect/i.test(e.message) && !e.message.includes(KEY));
    assert.ok(!seen.some((s) => s.path === "/elsewhere"), "the redirect isn't followed");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

// ---- Review P4.3 ----

test("an unparseable or missing price stays unknown, also after it is saved and read back", () => {
  for (const pricing of [{ prompt: "variable", completion: "0" }, { prompt: "0" }]) {
    const p = C.priceOf(pricing, NOW);
    assert.equal(C.freeOf(p, { now: NOW, billing: "metered" }).value, null, JSON.stringify(pricing));
    const back = JSON.parse(JSON.stringify(p));
    assert.equal(C.freeOf(back, { now: NOW, billing: "metered" }).value, null, `${JSON.stringify(pricing)} after a save`);
  }
});

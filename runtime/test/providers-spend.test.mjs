// P4.3: what was spent, per account and calendar day, charged per gateway attempt;
// pessimistic when a response says nothing about usage. In a throwaway AD_ROOT.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-spend-"));
const saved = { AD_ROOT: process.env.AD_ROOT };
process.env.AD_ROOT = path.join(TMP, ".agent-daemon");
after(() => {
  if (saved.AD_ROOT === undefined) delete process.env.AD_ROOT;
  else process.env.AD_ROOT = saved.AD_ROOT;
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const S = await import("../src/providers/spend.mjs");
const NOW = new Date(2026, 9, 29, 10, 0, 0).getTime(); // local time: the user's calendar day
const PRICE = { input: "0.000002", output: "0.000008", request: null };

test("usage × price, in USD; Chat and Responses usage shapes", () => {
  assert.equal(S.chargeOf({ usage: { input_tokens: 1000, output_tokens: 500 }, price: PRICE }).usd, 0.002 + 0.004);
  assert.equal(S.chargeOf({ usage: { prompt_tokens: 1000, completion_tokens: 500 }, price: PRICE }).usd, 0.006);
  assert.equal(S.chargeOf({ usage: { input_tokens: 10, output_tokens: 10 }, price: { input: "0", output: "0" } }).usd, 0);
  assert.deepEqual(S.chargeOf({ usage: { input_tokens: 10, output_tokens: 10 }, price: null }), { usd: null, estimated: false }, "no price: unknown, never 0");
});

test("usage null → the pessimistic charge: request bytes / 3 as input, the model's max output (or 8K) as output", () => {
  const c = S.chargeOf({ usage: null, price: PRICE, requestBytes: 3000, maxOutputTokens: null });
  assert.equal(c.estimated, true);
  assert.equal(c.usd, 1000 * 0.000002 + 8192 * 0.000008);
  assert.equal(S.chargeOf({ usage: null, price: PRICE, requestBytes: 3001, maxOutputTokens: 100 }).usd, 1001 * 0.000002 + 100 * 0.000008);
});

test("three retried attempts → three charges; today's totals per account and overall", async () => {
  for (let i = 0; i < 3; i++) await S.addCharge({ accountId: "acct_a", usage: null, price: PRICE, requestBytes: 300, maxOutputTokens: 1000 }, { now: NOW });
  await S.addCharge({ accountId: "acct_b", usage: { input_tokens: 100, output_tokens: 100 }, price: PRICE }, { now: NOW });
  await S.addCharge({ accountId: "acct_b", usage: { input_tokens: 100, output_tokens: 100 }, price: null }, { now: NOW });
  const a = S.today("acct_a", { now: NOW });
  assert.equal(a.requests, 3);
  assert.equal(a.estimated, 3);
  assert.ok(Math.abs(a.usd - 3 * (100 * 0.000002 + 1000 * 0.000008)) < 1e-12);
  const b = S.today("acct_b", { now: NOW });
  assert.equal(b.requests, 2);
  assert.equal(b.unpriced, 1, "a request with no price is counted as unpriced");
  assert.ok(S.todayTotal({ now: NOW }).usd > a.usd);
});

test("day rollover: tomorrow starts at zero; nothing seen is zero requests (not unknown spend)", () => {
  const tomorrow = NOW + 24 * 3_600_000;
  assert.deepEqual(S.today("acct_a", { now: tomorrow }), { usd: 0, requests: 0, estimated: 0, unpriced: 0 });
});

test("two processes × 50 charges: nothing lost", async () => {
  const script = path.join(TMP, "spender.mjs");
  fs.writeFileSync(script, `import { addCharge } from ${JSON.stringify(new URL("../src/providers/spend.mjs", import.meta.url).href)};\nfor (let i = 0; i < 50; i++) await addCharge({ accountId: "shared", usage: { input_tokens: 1, output_tokens: 0 }, price: { input: "1", output: "1" } }, { waitMs: 30000, now: ${NOW} });\n`);
  const run = () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [script], { env: process.env, stdio: "ignore" });
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`exit ${c}`))));
  });
  await Promise.all([run(), run()]);
  const t = S.today("shared", { now: NOW });
  assert.equal(t.requests, 100);
  assert.equal(t.usd, 100);
});

test("a usage object with no field ad knows is charged pessimistically; Gemini's fields are known", () => {
  const p = { input: "0.000002", output: "0.000008" };
  assert.equal(S.chargeOf({ usage: {}, price: p, requestBytes: 300 }).estimated, true);
  assert.equal(S.chargeOf({ usage: { promptTokenCount: 1000, candidatesTokenCount: 10 }, price: p }).usd, 1000 * 0.000002 + 10 * 0.000008);
});

test("half a usage: the half that's there, the other half at its worst (estimated)", () => {
  const p = { input: "0.000002", output: "0.000008" };
  const c = S.chargeOf({ usage: { input_tokens: 100 }, price: p, maxOutputTokens: 1000 });
  assert.equal(c.estimated, true);
  assert.equal(c.usd, 100 * 0.000002 + 1000 * 0.000008);
});

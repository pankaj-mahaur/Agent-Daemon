// P4.4: the preview's exact lines ("what would happen if this target failed now").

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY } from "../src/routing/policy.mjs";
import { explain } from "../src/routing/preview.mjs";
import { benchProvider, recordObservations } from "../src/providers/quota.mjs";

const NOW = Date.parse("2026-10-29T10:00:00.000Z");
const fresh = new Date(NOW - 3 * 60_000).toISOString();
const acct = (o) => ({ status: "ready", method: "api-key", credentialRevision: 1, keyHint: "1111", identity: null, endpoint: null, ...o });
const ACCOUNTS = [
  acct({ id: "acct_or1", provider: "openrouter", label: "work" }),
  acct({ id: "acct_or2", provider: "openrouter", label: "personal" }),
  acct({ id: "acct_gem", provider: "gemini", label: "personal" }),
  acct({ id: "acct_gpt", provider: "chatgpt", label: "personal", method: "engine-login", credential: { kind: "engine-home", home: "@default" }, identity: { email: "s***@example.com", plan: "plus" }, keyHint: null }),
];
const ENTRIES = {
  "acct_or1:qwen/qwen3-coder:free": { caps: { tools: true }, price: { input: "0", output: "0", observedAt: fresh }, billing: "metered" },
  "acct_or2:qwen/qwen3-coder:free": { caps: { tools: true }, price: { input: "0", output: "0", observedAt: fresh }, billing: "metered" },
  "acct_gem:gemini-2.5-flash": { caps: { tools: true }, price: { input: "0", output: "0", observedAt: fresh }, billing: "metered" },
  "acct_gpt:gpt-5.5": { caps: { tools: true }, price: null, billing: "subscription" },
};
const T = { or1: { account: "acct_or1", model: "qwen/qwen3-coder:free" }, or2: { account: "acct_or2", model: "qwen/qwen3-coder:free" }, gem: { account: "acct_gem", model: "gemini-2.5-flash", trialConsent: true }, gpt: { account: "acct_gpt", model: "gpt-5.5", effort: "medium" } };
const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-preview-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const env = { accounts: ACCOUNTS, catalog: (a, m) => ENTRIES[`${a}:${m}`] ?? null, now: NOW };

test("the preview names the next target and why, the one after it, the stop, and what was skipped", async () => {
  const until = NOW + 3_600_000;
  await benchProvider("openrouter", { until: new Date(until).toISOString(), reason: "quotaExhausted", accountId: "acct_or1" }, { root, now: NOW });
  await recordObservations(
    [
      { accountId: "acct_gem", provider: "gemini", window: "day", used: 120, limit: 1500, usedPercent: 8, resetsAt: new Date(NOW + 8 * 3_600_000).toISOString(), state: "ok", source: "test", observedAt: fresh },
      { accountId: "acct_gpt", provider: "chatgpt", window: "secondary", usedPercent: 64, resetsAt: new Date(NOW + 86_400_000).toISOString(), state: "ok", source: "test", observedAt: fresh },
    ],
    { root, now: NOW },
  );
  const policy = { ...DEFAULT_POLICY, targets: [T.or1, T.or2, T.gem, T.gpt] };
  assert.deepEqual(explain(policy, { from: T.or1, failure: "quotaExhausted" }, { ...env, root }), [
    "If OpenRouter · work · qwen/qwen3-coder:free runs out of its limit now, ad would try Gemini API · personal · gemini-2.5-flash next:",
    `it's next in your order (after the skipped ones below), it's free (price checked 3 min ago; "no extra spend" allows it), and its limits look fine (today 120/1500).`,
    "If that fails too: ChatGPT · personal · gpt-5.5 (your plan; weekly 64% used).",
    "Then ad stops and asks you.",
    `Skipped now: OpenRouter · personal · qwen/qwen3-coder:free: OpenRouter hit its limit (until ${hhmm(until)}).`,
  ]);
});

test("a chain never returns to a provider that ran out earlier in it", () => {
  const lines = explain({ ...DEFAULT_POLICY, targets: [T.or1, T.gem, T.or2, T.gpt] }, { from: T.or1, failure: "quotaExhausted" }, { ...env, root });
  assert.equal(lines[2], "If that fails too: ChatGPT · personal · gpt-5.5 (your plan).");
  assert.equal(lines.at(-1), "Skipped now: OpenRouter · personal · qwen/qwen3-coder:free: OpenRouter hit its limit in this session.");
});

test("nothing can continue; a class that isn't switched on; the hop limit ends the chain", () => {
  const policy = { ...DEFAULT_POLICY, cost: "freeOnly", targets: [T.gem, T.gpt] };
  assert.deepEqual(explain(policy, { from: T.gem, failure: "rateLimit" }, { ...env, root }), [
    "If Gemini API · personal · gemini-2.5-flash hits a rate limit now, ad would stop and ask you: no target in your order can continue now.",
    "Skipped now: ChatGPT · personal · gpt-5.5: isn't free.",
  ]);
  assert.deepEqual(explain({ ...policy, on: ["quotaExhausted"] }, { from: T.gem, failure: "provider5xx" }, { ...env, root }), ["If Gemini API · personal · gemini-2.5-flash has a provider error now, ad would stop and ask you: fallback isn't switched on for this kind of error."]);
  const one = explain({ ...DEFAULT_POLICY, maxHops: 1, targets: [T.or1, T.gem, T.gpt] }, { failure: "transientNetwork" }, { ...env, root });
  assert.deepEqual(one, [
    "If OpenRouter · work · qwen/qwen3-coder:free can't be reached now, ad would try Gemini API · personal · gemini-2.5-flash next:",
    `it's next in your order, it's free (price checked 3 min ago; "no extra spend" allows it), and ad hasn't seen its limits yet.`,
    "Then ad stops and asks you.",
  ]);
});

test("the consent names effort, a custom endpoint's host, a billing you set, and a sign-in ad can't identify", async () => {
  const { consentText } = await import("../src/routing/preview.mjs");
  const accounts = [...ACCOUNTS.map((a) => (a.id === "acct_gpt" ? { ...a, identity: null } : a)), acct({ id: "acct_box", provider: "custom", label: "box", endpoint: { baseUrl: "https://llm.example.test/v1" } }), acct({ id: "acct_oa", provider: "openai", label: "work" })];
  const entries = { ...ENTRIES, "acct_box:m": { caps: { tools: true }, price: { input: "0", output: "0", observedAt: fresh }, billing: "metered" }, "acct_oa:gpt-5": { caps: { tools: true }, price: { input: "0.1", output: "0.1", observedAt: fresh }, billing: "metered" } };
  const lines = consentText({ ...DEFAULT_POLICY, targets: [T.gpt, { account: "acct_box", model: "m" }, { account: "acct_oa", model: "gpt-5", billing: "subscription" }] }, { accounts, catalog: (a, m) => entries[`${a}:${m}`] ?? null, now: NOW });
  assert.match(lines[2], /^ {2}1\. ChatGPT · personal · gpt-5\.5 medium: your ChatGPT plan; ad can't tell yet which account is signed in here/);
  assert.match(lines[3], /^ {2}2\. Your own endpoint · box · m \(llm\.example\.test\): free; your prompts and code go to llm\.example\.test$/);
  assert.equal(lines[4], "  3. OpenAI · work · gpt-5: your OpenAI plan; you set it as a plan you pay for");
});

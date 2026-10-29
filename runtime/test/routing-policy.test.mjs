// P4.4: the fallback policy: validation, cost rules, the consent hash. Pure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { consentHash, DEFAULT_POLICY, keepRunningMatches, validatePolicy } from "../src/routing/policy.mjs";

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
const NOW = Date.parse("2026-10-29T10:00:00.000Z");
const fresh = new Date(NOW - 3 * 60_000).toISOString();
const ENTRIES = {
  "acct_or1:qwen/qwen3-coder:free": { caps: { tools: true, contextWindow: 262144 }, price: { input: "0", output: "0", observedAt: fresh }, billing: "metered", data: {} },
  "acct_or2:qwen/qwen3-coder:free": { caps: { tools: true, contextWindow: 262144 }, price: { input: "0", output: "0", observedAt: fresh }, billing: "metered", data: {} },
  "acct_gem:gemini-2.5-flash": { caps: { tools: true, contextWindow: 1048576 }, price: { input: "0", output: "0", observedAt: fresh }, billing: "metered", data: { trainsOnData: "free tier", note: "Google may use free-tier data to improve its products." } },
  "acct_oa:gpt-5": { caps: { tools: true, contextWindow: 400000 }, price: { input: "0.00000125", output: "0.00001", observedAt: fresh }, billing: "metered", data: {} },
  "acct_or1:some/no-tools": { caps: { tools: false }, price: { input: "0", output: "0", observedAt: fresh }, billing: "metered", data: {} },
  "acct_nv:llama-x": { caps: { tools: true, contextWindow: 32768 }, price: null, billing: "metered", data: { trial: true, note: "NVIDIA's hosted models are for trial use." } },
};
const catalog = (accountId, model) => ENTRIES[`${accountId}:${model}`] ?? null;
const ctx = { accounts: ACCOUNTS, catalog, now: NOW };
const policy = (o = {}) => ({ ...DEFAULT_POLICY, ...o });
const codes = (r, kind = "errors") => r[kind].map((e) => e.code);

test("a good order validates; two OpenRouter accounts give the same-provider warning, not an error", () => {
  const p = policy({ targets: [{ account: "acct_or1", model: "qwen/qwen3-coder:free" }, { account: "acct_or2", model: "qwen/qwen3-coder:free" }, { account: "acct_gpt", model: "gpt-5.5", effort: "medium" }] });
  const r = validatePolicy(p, ctx);
  assert.deepEqual(r.errors, []);
  const w = r.warnings.find((x) => x.code === "same-provider-accounts");
  assert.equal(w.index, 1);
  assert.equal(w.text, "Used only while OpenRouter hasn't hit a limit (until it resets).");
});

test("bounds, unknown fields with their path, never-on classes, duplicates, unknown accounts, no tools", () => {
  assert.ok(codes(validatePolicy(policy({ maxHops: 9 }), ctx)).includes("bounds"));
  assert.ok(codes(validatePolicy(policy({ perTargetRetries: 4 }), ctx)).includes("bounds"));
  assert.ok(codes(validatePolicy(policy({ recoveryBudgetMs: 5000 }), ctx)).includes("bounds"));
  const unknown = validatePolicy(policy({ colour: "blue", targets: [{ account: "acct_or1", model: "x", speed: 3 }] }), ctx).errors;
  assert.deepEqual(unknown.filter((e) => e.code === "schema").map((e) => e.text).sort(), ["colour: unknown field.", "targets[0].speed: unknown field."]);
  const never = validatePolicy(policy({ on: ["rateLimit", "authExpired"] }), ctx).errors.find((e) => e.code === "never-on");
  assert.equal(never.text, "ad never switches on sign-in, policy or eligibility problems: those need you (removed: authExpired).");
  const dup = validatePolicy(policy({ targets: [{ account: "acct_or1", model: "qwen/qwen3-coder:free" }, { account: "acct_or1", model: "qwen/qwen3-coder:free" }] }), ctx).errors.find((e) => e.code === "duplicate-target");
  assert.equal(dup.text, "OpenRouter · work · qwen/qwen3-coder:free is listed twice.");
  assert.equal(validatePolicy(policy({ targets: [{ account: "acct_gone", model: "m" }] }), ctx).errors[0].text, "No account acct_gone (removed?). Remove this target.");
  assert.equal(validatePolicy(policy({ targets: [{ account: "acct_or1", model: "some/no-tools" }] }), ctx).errors[0].text, "some/no-tools can't call tools, so it can't continue a coding task.");
});

test("cost: paid targets under free only, metered under no extra spend; only paid targets under freeOnly → no-eligible-target, cannot enable", () => {
  const sub = validatePolicy(policy({ cost: "freeOnly", targets: [{ account: "acct_gpt", model: "gpt-5.5" }] }), ctx).errors;
  assert.ok(sub.some((e) => e.code === "not-free-under-freeOnly" && e.text === "ChatGPT · personal · gpt-5.5 isn't free (it's your plan). With 'free only' ad would always skip it: remove it or choose 'no extra spend'."));
  const metered = validatePolicy(policy({ targets: [{ account: "acct_oa", model: "gpt-5" }] }), ctx).errors.find((e) => e.code === "metered-under-noExtraSpend");
  assert.equal(metered.text, "OpenAI · work · gpt-5 bills per use. 'No extra spend' allows free models and plans you already pay for.");
  const none = validatePolicy(policy({ cost: "freeOnly", targets: [{ account: "acct_oa", model: "gpt-5" }] }), { ...ctx, enabling: true });
  assert.ok(codes(none).includes("no-eligible-target"));
  assert.equal(none.errors.find((e) => e.code === "no-eligible-target").text, "None of these targets fits 'free only' right now, so fallback would never switch. Add a free model or change the cost rule.");
});

test("trial target without consent under ask is refused; with its consent it is kept; never refuses it outright", () => {
  const t = { account: "acct_nv", model: "llama-x" };
  const ask = validatePolicy(policy({ cost: "freeOnly", targets: [t] }), ctx).errors.find((e) => e.code === "trial-no-consent");
  assert.equal(ask.text, "NVIDIA API catalog · trial · llama-x is a trial endpoint: NVIDIA's hosted models are for trial use. Confirm it to keep it in the order.");
  assert.ok(!codes(validatePolicy(policy({ targets: [{ ...t, trialConsent: true }] }), ctx)).includes("trial-no-consent"));
  assert.ok(codes(validatePolicy(policy({ dataRules: { trialEndpoints: "never" }, targets: [{ ...t, trialConsent: true }] }), ctx)).includes("trial-never"));
  // A data-collecting free tier counts too.
  assert.ok(codes(validatePolicy(policy({ targets: [{ account: "acct_gem", model: "gemini-2.5-flash" }] }), ctx)).includes("trial-no-consent"));
});

test("warnings: needs sign-in, a smaller context, the same free daily limit, a price not checked lately", () => {
  const accounts = ACCOUNTS.map((a) => (a.id === "acct_or2" ? { ...a, status: "needs-sign-in" } : a));
  const entries = { ...ENTRIES, "acct_or1:old/free": { caps: { tools: true }, price: { input: "0", output: "0", observedAt: new Date(NOW - 3 * 86_400_000).toISOString() }, billing: "metered", data: {} } };
  const r = validatePolicy(policy({ targets: [{ account: "acct_gem", model: "gemini-2.5-flash", trialConsent: true }, { account: "acct_or1", model: "qwen/qwen3-coder:free" }, { account: "acct_or2", model: "qwen/qwen3-coder:free" }, { account: "acct_or1", model: "old/free" }] }), { accounts, catalog: (a, m) => entries[`${a}:${m}`] ?? null, now: NOW });
  const w = codes(r, "warnings");
  for (const c of ["needs-sign-in", "smaller-context", "same-limit", "free-unknown"]) assert.ok(w.includes(c), `${c}: ${JSON.stringify(r.warnings)}`);
  assert.equal(r.warnings.find((x) => x.code === "smaller-context").text, "1048K vs 262K: long conversations are trimmed when they move here");
  assert.equal(r.warnings.find((x) => x.code === "free-unknown").text, "price not checked in 3 days: skipped until checked");
});

test("keep-running: \"npm\" alone is refused; \"npm run dev\" doesn't match \"npm run deploy\"", () => {
  const r = validatePolicy(policy({ allowRunningBackground: ["npm"] }), ctx).errors.find((e) => e.code === "keep-running-too-broad");
  assert.equal(r.text, "That would allow almost any command. Use the full command, e.g. npm run dev.");
  for (const bad of ["sh", "bash", "pwsh", "cmd", "node", "python", "npx"]) assert.ok(codes(validatePolicy(policy({ allowRunningBackground: [bad] }), ctx)).includes("keep-running-too-broad"), bad);
  assert.equal(keepRunningMatches(["npm run dev"], "npm run dev -- --port 3000"), true);
  assert.equal(keepRunningMatches(["npm run dev"], "npm run deploy"), false);
  assert.equal(keepRunningMatches(["npm run dev"], "npm run devx"), false, "whole tokens");
});

test("the consent hash: a reorder, a re-sign-in to another identity, a re-key and a changed base URL each change it", () => {
  const p = policy({ targets: [{ account: "acct_or1", model: "qwen/qwen3-coder:free" }, { account: "acct_gpt", model: "gpt-5.5" }, { account: "acct_custom", model: "m" }] });
  const h = consentHash(p, ACCOUNTS);
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
  assert.equal(consentHash(structuredClone(p), ACCOUNTS), h, "stable");
  assert.notEqual(consentHash({ ...p, targets: [p.targets[1], p.targets[0], p.targets[2]] }, ACCOUNTS), h, "a reorder");
  const swap = (id, o) => ACCOUNTS.map((a) => (a.id === id ? { ...a, ...o } : a));
  assert.notEqual(consentHash(p, swap("acct_gpt", { identity: { email: "o***@example.com", plan: "plus" } })), h, "re-signed to another identity");
  assert.notEqual(consentHash(p, swap("acct_or1", { credentialRevision: 2 })), h, "re-keyed");
  assert.notEqual(consentHash(p, swap("acct_custom", { endpoint: "https://other.example.test/v1" })), h, "a changed base URL");
  assert.notEqual(consentHash({ ...p, cost: "freeOnly" }, ACCOUNTS), h, "the cost rule");
  assert.notEqual(consentHash({ ...p, allowRunningBackground: ["npm run dev"] }, ACCOUNTS), h);
  assert.equal(consentHash({ ...p, maxHops: 2 }, ACCOUNTS), h, "limits aren't destinations");
});

test("review fixes: unknown billing, a local override, whole numbers, an empty switch-on list, dataRules keys, notes", async () => {
  const { costAllows, targetInfo } = await import("../src/routing/policy.mjs");
  // A fresh zero price with billing nobody reported: never allowed.
  const unknown = { ...ENTRIES["acct_or1:qwen/qwen3-coder:free"], billing: "unknown" };
  const info = targetInfo({ account: "acct_or1", model: "q" }, { ...ctx, catalog: () => unknown });
  assert.equal(costAllows("freeOnly", info), false);
  assert.equal(costAllows("noExtraSpend", info), false);
  const local = validatePolicy(policy({ cost: "freeOnly", targets: [{ account: "acct_oa", model: "gpt-5", billing: "local" }] }), ctx).errors;
  assert.ok(local.some((e) => e.code === "billing-override" && e.text === "OpenAI · work · gpt-5: only a server on your machine can be set as local."));
  assert.ok(codes(validatePolicy(policy({ maxHops: 2.5 }), ctx)).includes("bounds"));
  assert.equal(validatePolicy(policy({ recoveryBudgetMs: 5000 }), ctx).errors[0].text, "Give up after (give-up) must be between 10 and 600 seconds.");
  assert.ok(codes(validatePolicy(policy({ on: [], targets: [{ account: "acct_gpt", model: "gpt-5.5" }] }), { ...ctx, enabling: true })).includes("bounds"));
  assert.deepEqual(validatePolicy(policy({ dataRules: { trialEndpoints: "ask", sneaky: true } }), ctx).errors.map((e) => e.text), ["dataRules.sneaky: unknown field."]);
  const noDot = targetInfo({ account: "acct_nv", model: "llama-x" }, { ...ctx, catalog: () => ({ ...ENTRIES["acct_nv:llama-x"], data: { trial: true, note: "it keeps logs" } }) });
  assert.equal(noDot.note, "it keeps logs");
});

test("keep-running: launchers with inline code, wrappers and bare run commands are refused; a specific command is kept", () => {
  for (const bad of ["bash -c", "python3", "env", "npm run", "sh -c 'x'", "sudo npm run dev", "node -e", "pwsh -Command", "cmd /c", "npx -y", "python -m", "/bin/bash -c x", "C:\\Windows\\System32\\cmd.exe /c x", "npm.cmd run"]) assert.ok(codes(validatePolicy(policy({ allowRunningBackground: [bad] }), ctx)).includes("keep-running-too-broad"), bad);
  for (const ok of ["npm run dev", "npm start", "python -m http.server", "node server.js", "cargo watch -x run"]) assert.deepEqual(codes(validatePolicy(policy({ allowRunningBackground: [ok] }), ctx)), [], ok);
});

test("a sign-in ad can't identify yet is warned about; workspace, home and an object base URL change the hash", () => {
  const anon = ACCOUNTS.map((a) => (a.id === "acct_gpt" ? { ...a, identity: null } : a));
  const w = validatePolicy(policy({ targets: [{ account: "acct_gpt", model: "gpt-5.5" }] }), { ...ctx, accounts: anon }).warnings.find((x) => x.code === "identity-unknown");
  assert.match(w.text, /can't tell yet which account is signed in here/);
  const p = policy({ targets: [{ account: "acct_gpt", model: "gpt-5.5" }, { account: "acct_custom", model: "m" }] });
  const objectUrl = ACCOUNTS.map((a) => (a.id === "acct_custom" ? { ...a, endpoint: { baseUrl: "https://llm.example.test/v1" } } : a));
  const h = consentHash(p, objectUrl);
  const swap = (id, o) => objectUrl.map((a) => (a.id === id ? { ...a, ...o } : a));
  assert.notEqual(consentHash(p, swap("acct_gpt", { identity: { email: "s***@example.com", plan: "plus", workspace: "other" } })), h, "workspace");
  assert.notEqual(consentHash(p, swap("acct_gpt", { credential: { kind: "engine-home", home: "a/h2" } })), h, "another engine home");
  assert.notEqual(consentHash(p, swap("acct_custom", { endpoint: { baseUrl: "https://other.example.test/v1" } })), h, "an object base URL");
});

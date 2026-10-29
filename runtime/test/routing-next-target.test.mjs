// P4.4: which target continues the task next. A deterministic clock and a temp ad root
// (its quota store is the one other windows write to).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY } from "../src/routing/policy.mjs";
import { nextTarget } from "../src/routing/next-target.mjs";
import { benchProvider, recordObservations } from "../src/providers/quota.mjs";

const NOW = Date.parse("2026-10-29T10:00:00.000Z");
const fresh = new Date(NOW - 3 * 60_000).toISOString();
const acct = (o) => ({ status: "ready", method: "api-key", credentialRevision: 1, keyHint: "1111", identity: null, endpoint: null, ...o });
const ACCOUNTS = [
  acct({ id: "acct_or1", provider: "openrouter", label: "work" }),
  acct({ id: "acct_or2", provider: "openrouter", label: "personal" }),
  acct({ id: "acct_gem", provider: "gemini", label: "personal" }),
  acct({ id: "acct_oa", provider: "openai", label: "work" }),
  acct({ id: "acct_gpt", provider: "chatgpt", label: "personal", method: "engine-login", credential: { kind: "engine-home", home: "@default" }, identity: { email: "s***@example.com", plan: "plus" }, keyHint: null }),
];
const zero = (at = fresh) => ({ input: "0", output: "0", observedAt: at });
const ENTRIES = {
  "acct_or1:q": { caps: { tools: true }, price: zero(), billing: "metered" },
  "acct_or2:q": { caps: { tools: true }, price: zero(), billing: "metered" },
  "acct_gem:g": { caps: { tools: true }, price: zero(), billing: "metered" },
  "acct_oa:gpt-5": { caps: { tools: true }, price: { input: "0.00000125", output: "0.00001", observedAt: fresh }, billing: "metered" },
  "acct_gpt:gpt-5.5": { caps: { tools: true }, price: null, billing: "subscription" },
};
const T = { or1: { account: "acct_or1", model: "q" }, or2: { account: "acct_or2", model: "q" }, gem: { account: "acct_gem", model: "g", trialConsent: true }, oa: { account: "acct_oa", model: "gpt-5" }, gpt: { account: "acct_gpt", model: "gpt-5.5" } };

let root;
let entries;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-next-"));
  entries = { ...ENTRIES };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const env = (o = {}) => ({ accounts: ACCOUNTS, catalog: (a, m) => entries[`${a}:${m}`] ?? null, now: NOW, root, ...o });
const policy = (targets, o = {}) => ({ ...DEFAULT_POLICY, enabled: true, targets, ...o });
const pick = (p, ctx, o) => nextTarget(p, { failure: "quotaExhausted", tried: [], hops: 0, switchesLastHour: 0, ...ctx }, env(o));
const reasonsOf = (r, t) => r.skipped.find((s) => s.target.account === t.account && s.target.model === t.model)?.reasons ?? [];

test("order after `from`, wrapping once, never a target already tried", () => {
  const p = policy([T.gem, T.gpt, T.or1]);
  assert.equal(pick(p, { from: T.gem, failure: "transientNetwork" }).target, T.gpt);
  assert.equal(pick(p, { from: T.or1, failure: "transientNetwork" }).target, T.gem, "wraps to the top");
  assert.equal(pick(p, { from: T.gem, failure: "transientNetwork", tried: ["acct_gpt:gpt-5.5"] }).target, T.or1);
  const none = pick(p, { from: T.gem, failure: "transientNetwork", tried: ["acct_gpt:gpt-5.5", "acct_or1:q"] });
  assert.equal(none.none, true);
  assert.deepEqual(reasonsOf(none, T.gpt), ["tried"]);
  assert.equal(pick(p, { from: { account: "acct_oa", model: "gpt-5" }, failure: "transientNetwork" }).target, T.gem, "a start outside the order begins at the top");
  assert.equal(pick(p, { from: T.gem, failure: "transientNetwork" }).index, 1);
});

test("an exhausted target is skipped until its reset", async () => {
  await recordObservations([{ accountId: "acct_gpt", provider: "chatgpt", window: "secondary", usedPercent: 100, resetsAt: new Date(NOW + 3_600_000).toISOString(), state: "exhausted", source: "test" }], { root });
  const p = policy([T.gem, T.gpt, T.or1]);
  const r = pick(p, { from: T.gem, failure: "transientNetwork" });
  assert.equal(r.target, T.or1);
  assert.ok(reasonsOf(r, T.gpt).includes("quota-exhausted-until"));
  // Past the reset the observation is unknown again, not ok, and an unknown limit doesn't skip.
  assert.equal(pick(p, { from: T.gem, failure: "transientNetwork" }, { now: NOW + 2 * 3_600_000 }).target, T.gpt);
});

test("a stale free price under freeOnly is skipped; a paid target under noExtraSpend too, a plan is kept", () => {
  entries["acct_or1:q"] = { ...ENTRIES["acct_or1:q"], price: zero(new Date(NOW - 25 * 3_600_000).toISOString()) };
  const r = pick(policy([T.gem, T.or1], { cost: "freeOnly" }), { from: T.gem, failure: "transientNetwork" });
  assert.equal(r.none, true);
  assert.ok(reasonsOf(r, T.or1).includes("price-stale"));
  const paid = pick(policy([T.gem, T.oa, T.gpt]), { from: T.gem, failure: "transientNetwork" });
  assert.equal(paid.target, T.gpt);
  assert.ok(reasonsOf(paid, T.oa).includes("paid-not-allowed"));
  assert.ok(reasonsOf(pick(policy([T.gem, T.gpt], { cost: "freeOnly" }), { from: T.gem, failure: "transientNetwork" }), T.gpt).includes("not-free"));
});

test("provider benched by another window → its other account is skipped", async () => {
  await benchProvider("openrouter", { until: new Date(NOW + 3_600_000).toISOString(), reason: "quotaExhausted", accountId: "acct_or1" }, { root, now: NOW });
  const r = pick(policy([T.gem, T.or2, T.gpt]), { from: T.gem, failure: "transientNetwork" });
  assert.equal(r.target, T.gpt);
  assert.ok(reasonsOf(r, T.or2).includes("provider-benched-until"));
});

test("two episodes: provider P account 1 limited in episode 1 → episode 2 never selects P account 2", () => {
  const p = policy([T.or1, T.gem, T.or2, T.gpt]);
  // Episode 1: or1 runs out; its provider's other account isn't next even with no bench written yet.
  const e1 = pick(p, { from: T.or1, failure: "quotaExhausted" });
  assert.equal(e1.target, T.gem);
  const e1b = pick(p, { from: T.or1, failure: "quotaExhausted", tried: ["acct_gem:g"] });
  assert.equal(e1b.target, T.gpt);
  assert.ok(reasonsOf(e1b, T.or2).includes("provider-limited-this-session"));
  // Episode 2, later in the same session: gem fails; the session remembers OpenRouter's limit.
  const sessionLimitedProviders = new Map([["openrouter", NOW + 3_600_000]]);
  const e2 = pick(p, { from: T.gem, failure: "rateLimit", sessionLimitedProviders });
  assert.equal(e2.target, T.gpt);
  assert.ok(reasonsOf(e2, T.or2).includes("provider-limited-this-session"));
  // A network error on or1 isn't a limit: its other account may continue.
  assert.equal(pick(p, { from: T.or1, failure: "transientNetwork", tried: ["acct_gem:g"] }).target, T.or2);
});

test("maxSwitchesPerHour reached → none with the reason; maxHops; a class not switched on", () => {
  const p = policy([T.gem, T.gpt], { maxSwitchesPerHour: 3, maxHops: 2 });
  assert.deepEqual(pick(p, { from: T.gem, switchesLastHour: 3 }), { none: true, reason: "too-often", skipped: [] });
  assert.equal(pick(p, { from: T.gem, switchesLastHour: 2 }).target, T.gpt);
  assert.deepEqual(pick(p, { from: T.gem, hops: 2 }), { none: true, reason: "max-hops", skipped: [] });
  assert.equal(pick(p, { from: T.gem, hops: 1 }).target, T.gpt);
  assert.deepEqual(pick(policy([T.gem, T.gpt], { on: ["rateLimit"] }), { from: T.gem, failure: "provider5xx" }), { none: true, reason: "not-on", skipped: [] });
  assert.deepEqual(pick(p, { from: T.gem, failure: "authExpired" }), { none: true, reason: "not-on", skipped: [] }, "never on sign-in problems, whatever the file says");
});

test("needs sign-in, a removed account, no tools and an unconfirmed trial are skipped", () => {
  const accounts = ACCOUNTS.map((a) => (a.id === "acct_or2" ? { ...a, status: "needs-sign-in" } : a));
  entries["acct_gem:g"] = { ...ENTRIES["acct_gem:g"], data: { trial: true } };
  const r = pick(policy([T.oa, T.or2, { account: "acct_gone", model: "x" }, { ...T.gem, trialConsent: undefined }, T.gpt]), { from: T.oa, failure: "transientNetwork" }, { accounts });
  assert.equal(r.target, T.gpt);
  assert.ok(reasonsOf(r, T.or2).includes("account-needs-sign-in"));
  assert.deepEqual(reasonsOf(r, { account: "acct_gone", model: "x" }), ["account-removed"]);
  assert.ok(reasonsOf(r, T.gem).includes("trial-endpoint-no-consent"));
});

test("a session-limited provider with an unknown or unreadable reset stays limited; a past reset frees it", () => {
  const p = policy([T.gem, T.or2, T.gpt]);
  for (const until of [null, undefined, "2026-10-29T11:00:00.000Z", NaN]) {
    const r = pick(p, { from: T.gem, failure: "transientNetwork", sessionLimitedProviders: new Map([["openrouter", until]]) });
    assert.equal(r.target, T.gpt, String(until));
  }
  assert.equal(pick(p, { from: T.gem, failure: "transientNetwork", sessionLimitedProviders: new Map([["openrouter", NOW - 1]]) }).target, T.or2);
});

test("a hand-written file that lists a sign-in class still never switches on it", () => {
  const p = policy([T.gem, T.gpt], { on: ["rateLimit", "authExpired", "authRevoked"] });
  assert.deepEqual(pick(p, { from: T.gem, failure: "authExpired" }), { none: true, reason: "not-on", skipped: [] });
  assert.deepEqual(pick(p, { from: T.gem, failure: "authRevoked" }), { none: true, reason: "not-on", skipped: [] });
});

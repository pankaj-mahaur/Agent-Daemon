// P4.4: ~/.agent-daemon/fallback.json: revisions, the lock, validation before saving, and
// consent that clears itself when a destination changes. A temp ad root.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { consentState, enablePolicy, fallbackFile, readPolicy, updatePolicy } from "../src/routing/store.mjs";

const NOW = Date.parse("2026-10-29T10:00:00.000Z");
const fresh = new Date(NOW - 3 * 60_000).toISOString();
const acct = (o) => ({ status: "ready", method: "api-key", credentialRevision: 1, keyHint: "1111", identity: null, endpoint: null, ...o });
const ACCOUNTS = [
  acct({ id: "acct_or1", provider: "openrouter", label: "work" }),
  acct({ id: "acct_gpt", provider: "chatgpt", label: "personal", method: "engine-login", credential: { kind: "engine-home", home: "@default" }, identity: { email: "s***@example.com", plan: "plus" }, keyHint: null }),
  acct({ id: "acct_oa", provider: "openai", label: "work" }),
];
const ENTRIES = {
  "acct_or1:q": { caps: { tools: true }, price: { input: "0", output: "0", observedAt: fresh }, billing: "metered" },
  "acct_gpt:gpt-5.5": { caps: { tools: true }, price: null, billing: "subscription" },
  "acct_oa:gpt-5": { caps: { tools: true }, price: { input: "0.00000125", output: "0.00001", observedAt: fresh }, billing: "metered" },
};
const OR1 = { account: "acct_or1", model: "q" };
const GPT = { account: "acct_gpt", model: "gpt-5.5" };

let root;
let opts;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-fallback-"));
  opts = { root, accounts: ACCOUNTS, catalog: (a, m) => ENTRIES[`${a}:${m}`] ?? null, now: NOW };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const add = (t) => (p) => {
  p.targets.push(t);
};

test("missing file → the defaults, off; each saved change bumps the revision; a stale revision is refused", async () => {
  const p0 = readPolicy({ root });
  assert.equal(p0.enabled, false);
  assert.equal(p0.revision, 0);
  assert.deepEqual(p0.targets, []);
  const r = await updatePolicy(add(OR1), opts);
  assert.equal(r.policy.revision, 1);
  assert.deepEqual(readPolicy({ root }).targets, [OR1]);
  await assert.rejects(updatePolicy(add(GPT), { ...opts, expectedRevision: 0 }), { code: "FALLBACK_CONFLICT" });
  assert.equal(readPolicy({ root }).revision, 1);
});

test("an invalid change isn't saved and says why; warnings don't block", async () => {
  await assert.rejects(updatePolicy(add({ account: "acct_oa", model: "gpt-5" }), opts), (e) => e.code === "FALLBACK_INVALID" && /bills per use/.test(e.message) && e.errors.length === 1);
  assert.equal(fs.existsSync(fallbackFile(root)), false);
  await assert.rejects(updatePolicy((p) => void (p.maxHops = 9), opts), { code: "FALLBACK_INVALID" });
});

test("enable writes the consent hash; it refuses when no target fits the cost rule", async () => {
  await updatePolicy((p) => {
    p.cost = "freeOnly";
    p.targets.push(OR1);
  }, opts);
  // Two days on, its zero price is no longer fresh: nothing fits "free only".
  await assert.rejects(enablePolicy({ ...opts, now: NOW + 2 * 86_400_000 }), (e) => e.code === "FALLBACK_INVALID" && e.errors.map((x) => x.code).join() === "no-eligible-target");
  assert.equal(readPolicy({ root }).enabled, false);
  const r = await enablePolicy(opts);
  assert.equal(r.policy.enabled, true);
  assert.match(r.policy.consent.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(r.policy.consent.revision, r.policy.revision);
  assert.deepEqual(consentState(readPolicy({ root }), ACCOUNTS), { ok: true });
});

test("a reorder clears consent; a lower max-hops keeps it", async () => {
  await updatePolicy((p) => p.targets.push(OR1, GPT), opts);
  await enablePolicy(opts);
  const kept = await updatePolicy((p) => void (p.maxHops = 2), opts);
  assert.equal(kept.consentCleared, false);
  assert.equal(readPolicy({ root }).enabled, true);
  const moved = await updatePolicy((p) => p.targets.reverse(), opts);
  assert.equal(moved.consentCleared, true);
  const p = readPolicy({ root });
  assert.equal(p.enabled, false);
  assert.equal(p.consent, null);
});

test("re-signing an account to another identity changes the hash and disables fallback, naming the account", async () => {
  await updatePolicy((p) => p.targets.push(OR1, GPT), opts);
  await enablePolicy(opts);
  const resigned = ACCOUNTS.map((a) => (a.id === "acct_gpt" ? { ...a, identity: { email: "o***@example.com", plan: "plus" } } : a));
  const s = consentState(readPolicy({ root }), resigned);
  assert.equal(s.ok, false);
  assert.equal(s.reason, "changed");
  assert.equal(s.text, "Fallback is off: ChatGPT · personal changed since you confirmed the order. /fallback to confirm again.");
  // The next saved change, whatever it is, writes it off.
  const r = await updatePolicy((p) => void (p.maxHops = 2), { ...opts, accounts: resigned });
  assert.equal(r.consentCleared, true);
  assert.equal(readPolicy({ root }).enabled, false);
  assert.deepEqual(consentState(readPolicy({ root }), resigned), { ok: false, reason: "off" });
});

test("two changes at once → both kept, revision +2", async () => {
  await Promise.all([updatePolicy(add(OR1), opts), updatePolicy(add(GPT), opts)]);
  const p = readPolicy({ root });
  assert.equal(p.revision, 2);
  assert.equal(p.targets.length, 2);
});

test("an unreadable file is refused with its path, and reads as off for a run", () => {
  fs.writeFileSync(fallbackFile(root), "{ not json");
  assert.throws(() => readPolicy({ root }), (e) => e.code === "FALLBACK_CORRUPT" && e.message.includes(fallbackFile(root)));
  assert.deepEqual(consentState(readPolicy({ root, lenient: true }), ACCOUNTS), { ok: false, reason: "off" });
});

test("a problem already there (an account removed since) never blocks removing it or turning fallback off", async () => {
  await updatePolicy((p) => p.targets.push(OR1, GPT), opts);
  await enablePolicy(opts);
  const gone = { ...opts, accounts: ACCOUNTS.filter((a) => a.id !== "acct_or1") };
  // Unrelated changes still save; the old problem stays listed, nothing new is added.
  await updatePolicy((p) => void (p.maxHops = 2), gone);
  const off = await updatePolicy((p) => {
    p.enabled = false;
    p.consent = null;
  }, gone);
  assert.equal(off.policy.enabled, false);
  const removed = await updatePolicy((p) => void p.targets.splice(0, 1), gone);
  assert.deepEqual(removed.policy.targets, [GPT]);
  // A new problem is still refused.
  await assert.rejects(updatePolicy((p) => p.targets.push({ account: "acct_or1", model: "q" }), gone), (e) => e.code === "FALLBACK_INVALID" && /No account acct_or1/.test(e.message));
});

test("valid JSON of the wrong shape is unreadable, not a crash; a run reads it as off", () => {
  for (const doc of [{ targets: {} }, { targets: [null] }, { on: "rateLimit" }, { dataRules: [] }]) {
    fs.writeFileSync(fallbackFile(root), JSON.stringify(doc));
    assert.throws(() => readPolicy({ root }), { code: "FALLBACK_CORRUPT" }, JSON.stringify(doc));
    assert.equal(readPolicy({ root, lenient: true }).enabled, false);
  }
});

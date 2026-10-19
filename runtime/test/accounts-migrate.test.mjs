// P3.2: ad 3.0's sign-ins become accounts, idempotently, without touching 3.0's files.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "ad-acct-migrate-"));
after(() => fs.rm(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const { syncLegacyAccounts } = await import("../src/auth/accounts/migrate.mjs");
const reg = await import("../src/auth/accounts/registry.mjs");
const { createSecretStore, fileBackend } = await import("../src/auth/secrets.mjs");
const { providerEnv } = await import("../src/auth/providers.mjs");

const KEY = ["sk", "or", "v1", "cccccccccccccccc3333"].join("-");
const chatgpt = { account: { type: "chatgpt", email: "sam@example.com", planType: "plus" } };
const apiKey = { account: { type: "apiKey" } };
let n = 0;
function fresh({ openrouter = false } = {}) {
  const root = path.join(TMP, `r${++n}`);
  mkdirSync(path.join(root, "secrets"), { recursive: true });
  const store = createSecretStore(fileBackend(path.join(root, "secrets")));
  if (openrouter) store.set("openrouter", KEY);
  return { root, store };
}
const doc = (root) => reg.readRegistry({ root });

test("3.0 ChatGPT + openrouter + model_provider openrouter → two accounts, default target OpenRouter, api home 'api'", async () => {
  const { root, store } = fresh({ openrouter: true });
  const r = await syncLegacyAccounts({ root, store, legacy: { account: chatgpt, config: { model_provider: "openrouter", model: "qwen/qwen3-coder:free" } } });
  assert.equal(r.created, 2);
  const d = doc(root);
  const byProvider = Object.fromEntries(d.accounts.map((a) => [a.provider, a]));
  assert.deepEqual([byProvider.chatgpt.method, byProvider.chatgpt.credential, byProvider.chatgpt.label, byProvider.chatgpt.status], ["engine-login", { kind: "engine-home", home: "@default" }, "default", "ready"]);
  assert.deepEqual([byProvider.openrouter.credential.ref, byProvider.openrouter.keyHint, byProvider.openrouter.defaultModel], ["openrouter", "3333", "qwen/qwen3-coder:free"]);
  assert.equal(d.defaults.target.account, byProvider.openrouter.id);
  assert.equal(d.engines.api.home, "api");
});

test("OpenRouter-only 3.0 → api home '@default'; an OpenAI API key → openai/api-key-engine", async () => {
  const a = fresh({ openrouter: true });
  await syncLegacyAccounts({ ...a, legacy: { account: { account: null }, config: {} } });
  assert.equal(doc(a.root).engines.api.home, "@default");
  const b = fresh();
  await syncLegacyAccounts({ ...b, legacy: { account: apiKey, config: {} } });
  const [x] = doc(b.root).accounts;
  assert.deepEqual([x.provider, x.method], ["openai", "api-key-engine"]);
});

test("3.0 and 3.3 alternating: a ChatGPT sign-in in the default home later moves the api home to 'api' and never back", async () => {
  const { root, store } = fresh({ openrouter: true });
  await syncLegacyAccounts({ root, store, legacy: { account: { account: null }, config: {} } });
  assert.equal(doc(root).engines.api.home, "@default");
  await syncLegacyAccounts({ root, store, legacy: { account: chatgpt, config: {} } });
  assert.equal(doc(root).engines.api.home, "api");
  await syncLegacyAccounts({ root, store, legacy: { account: { account: null }, config: {} } });
  assert.equal(doc(root).engines.api.home, "api", "one way");
});

test("twice → same revision; openrouter adopted in place, providerEnv still finds it", async () => {
  const { root, store } = fresh({ openrouter: true });
  const legacy = { account: chatgpt, config: {} };
  await syncLegacyAccounts({ root, store, legacy });
  const rev = doc(root).revision;
  const again = await syncLegacyAccounts({ root, store, legacy });
  assert.deepEqual([again.created, again.updated, doc(root).revision], [0, 0, rev]);
  assert.equal(providerEnv(store).OPENROUTER_API_KEY, KEY);
  assert.deepEqual(store.list(), ["openrouter"], "no copy made");
});

test("the default home is untouched (the migration reads nothing from it and writes nothing there)", async () => {
  const { root, store } = fresh();
  const home = path.join(root, "engine");
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "auth.json"), "{}");
  writeFileSync(path.join(home, "config.toml"), 'model = "x"\n');
  const before = [readFileSync(path.join(home, "auth.json"), "utf8"), readFileSync(path.join(home, "config.toml"), "utf8")];
  await syncLegacyAccounts({ root, store, legacy: { account: chatgpt, config: { model: "x" } } });
  assert.deepEqual([readFileSync(path.join(home, "auth.json"), "utf8"), readFileSync(path.join(home, "config.toml"), "utf8")], before);
});

test("3.0 logout after migration → needs-sign-in, never deleted; signing in again → ready", async () => {
  const { root, store } = fresh({ openrouter: true });
  await syncLegacyAccounts({ root, store, legacy: { account: chatgpt, config: {} } });
  store.delete("openrouter");
  await syncLegacyAccounts({ root, store, legacy: { account: { account: null }, config: {} } });
  const d = doc(root);
  assert.deepEqual(d.accounts.map((a) => a.status).sort(), ["needs-sign-in", "needs-sign-in"]);
  store.set("openrouter", KEY);
  await syncLegacyAccounts({ root, store, legacy: { account: chatgpt, config: {} } });
  assert.deepEqual(doc(root).accounts.map((a) => a.status), ["ready", "ready"]);
});

test("a chosen default target is never overwritten", async () => {
  const { root, store } = fresh({ openrouter: true });
  await syncLegacyAccounts({ root, store, legacy: { account: chatgpt, config: {} } });
  const chosen = doc(root).accounts.find((a) => a.provider === "openrouter").id;
  await reg.transact((d) => void (d.defaults.target = { account: chosen, model: "m", effort: null }), { root });
  await syncLegacyAccounts({ root, store, legacy: { account: chatgpt, config: { model_provider: "openai", model: "gpt-x" } } });
  assert.deepEqual(doc(root).defaults.target, { account: chosen, model: "m", effort: null });
});

test("the 3.0 key is read only while its account has no hint (on Windows a read starts PowerShell)", async () => {
  const { root, store } = fresh({ openrouter: true });
  let gets = 0;
  const counting = { ...store, has: (n) => store.has(n), get: (n) => (gets++, store.get(n)), list: () => store.list() };
  await syncLegacyAccounts({ root, store: counting, legacy: { account: null, config: {} } });
  assert.equal(gets, 1);
  await syncLegacyAccounts({ root, store: counting, legacy: { account: null, config: {} } });
  await syncLegacyAccounts({ root, store: counting, legacy: { account: null, config: {} } });
  assert.equal(gets, 1, "later syncs don't read it");
});

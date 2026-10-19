// `ad auth` with accounts (P3.5): login for API keys, your own endpoint and local servers,
// `use`, `test` and `status`. A throwaway HOME / AD_ROOT and file store; mock providers.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-auth-acct-"));
const saved = { AD_ROOT: process.env.AD_ROOT, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.AD_ROOT = path.join(TMP, ".agent-daemon");
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const { cmdAuth } = await import("../src/harness/auth.mjs");
const { readRegistry } = await import("../src/auth/accounts/registry.mjs");
const { createSecretStore, fileBackend } = await import("../src/auth/secrets.mjs");
const { startMockProvider } = await import("../testkit/mock-providers.mjs");

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };
const K1 = ["sk", "or", "v1", "9999zzzz9999zzzz9999"].join("-");
const K2 = ["sk", "or", "v1", "8888yyyy8888yyyy8888"].join("-");
fs.mkdirSync(path.join(process.env.AD_ROOT, "secrets"), { recursive: true });
const store = createSecretStore(fileBackend(path.join(process.env.AD_ROOT, "secrets")));
const sink = () => {
  const s = { text: "", write: (c) => ((s.text += c), true) };
  return s;
};
const mock = await startMockProvider({ personality: "openrouter", keys: [K1, K2] });
after(() => mock.close());
const fetch = (url, init) => globalThis.fetch(String(url).replace("https://openrouter.ai/api/v1", mock.url), init);
const auth = async (sub, args = [], extra = {}) => {
  const stdout = sink();
  const stderr = sink();
  const code = await cmdAuth(sub, args, { command, store, fetch, stdout, stderr, clientVersion: "3.1.0", ...extra });
  return { code, out: stdout.text, err: stderr.text };
};

test("login openrouter --model: a ready account, the default; a second with --label sits beside it; use switches", async () => {
  let r = await auth("login", ["openrouter"], { model: "qwen/qwen3-coder:free", readKey: async () => K1 });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^OpenRouter · default is ready \(key …9999\)\. It is your default account\.$/m);
  assert.ok(!r.out.includes(K1) && !r.err.includes(K1));
  let doc = readRegistry();
  const first = doc.accounts.find((a) => a.label === "default");
  assert.equal(first.defaultModel, "qwen/qwen3-coder:free");
  assert.equal(doc.defaults.target.account, first.id);
  r = await auth("login", ["openrouter"], { label: "work", readKey: async () => K2 });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Make it the default: ad auth use openrouter\/work/);
  r = await auth("use", ["openrouter/work"], { model: "m/x" });
  assert.equal(r.code, 0, r.err);
  doc = readRegistry();
  assert.equal(doc.defaults.target.account, doc.accounts.find((a) => a.label === "work").id);
  assert.equal(doc.defaults.target.model, "m/x");
  r = await auth("status");
  assert.match(r.out, /account:\s+OpenRouter · work {2}ready {2}key …8888 {2}\(default\)/);
  assert.ok(!r.out.includes(K2));
});

test("a key typed on the command line is refused and never echoed; an unavailable sign-in names the alternative", async () => {
  const n = readRegistry().accounts.length;
  let r = await auth("login", ["openrouter", K1], { label: "x", readKey: async () => assert.fail("must not prompt") });
  assert.equal(r.code, 1);
  assert.match(r.err, /ad never takes a key on the command line/);
  assert.equal(readRegistry().accounts.length, n, "nothing saved");
  // The key in the provider's place (ad auth login <key>): refused, never quoted.
  const bare = "Q".repeat(36);
  r = await auth("login", [bare]);
  assert.equal(r.code, 1);
  assert.match(r.err, /ad never takes a key on the command line/);
  assert.ok(!r.err.includes(bare) && !r.err.includes(bare.toLowerCase()));
  r = await auth("use", [bare]);
  assert.ok(!r.err.includes(bare) && !r.err.includes(bare.toLowerCase()));
  assert.ok(!r.err.includes(K1));
  r = await auth("login", ["openrouter"], { rawValues: { key: true }, readKey: async () => assert.fail("must not prompt") });
  assert.equal(r.code, 1);
  r = await auth("login", ["claude"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /Claude models work now through OpenRouter/);
});

test("test <account>: a stored key checked again sets its status", async () => {
  const r = await auth("test", ["openrouter/work"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /OpenRouter · work works\./);
});

test("test <account> with its stored key gone says the key is missing, not refused", async () => {
  const a = readRegistry().accounts.find((x) => x.label === "work");
  const saved = store.get(a.credential.ref);
  store.delete(a.credential.ref);
  try {
    const r = await auth("test", ["openrouter/work"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /The stored key for OpenRouter · work is missing\. Add it again: ad auth login openrouter --label work/);
  } finally {
    store.set(a.credential.ref, saved);
    await auth("test", ["openrouter/work"]);
  }
});

test("a new key never becomes the default over another ready account, nor while it isn't ready", async () => {
  const reg = await import("../src/auth/accounts/registry.mjs");
  await reg.transact((doc) => {
    doc.defaults.target = null;
  });
  // Another ready account exists (the OpenRouter keys above): the new one isn't the default.
  const xk = ["xai", "7777xxxx7777xxxx7777xxxx"].join("-");
  const xmock = await startMockProvider({ personality: "generic", keys: [xk] });
  try {
    const r = await auth("login", ["xai"], { readKey: async () => xk, fetch: (url, init) => globalThis.fetch(String(url).replace("https://api.x.ai/v1", xmock.url), init) });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Make it the default: ad auth use xai\/default/);
    assert.equal(readRegistry().defaults.target, null);
  } finally {
    await xmock.close();
  }
});

test("custom with a piped key and no terminal: the one-token test isn't sent unasked", async () => {
  const ck = ["ck", "6666wwww6666wwww6666wwww"].join("-");
  const cmock = await startMockProvider({ personality: "generic", keys: [ck] });
  try {
    const r = await auth("login", ["custom"], { baseUrl: cmock.url, label: "lab", readKey: async () => ck });
    assert.equal(r.code, 0, r.err);
    assert.ok(!cmock.requests.some((x) => x.path.endsWith("/responses")), "no ping without a yes");
  } finally {
    await cmock.close();
  }
});

test("use openai with no OpenAI account goes back to 3.0's sign-in: the default account no longer points elsewhere", async () => {
  const reg = await import("../src/auth/accounts/registry.mjs");
  await reg.transact((doc) => {
    doc.defaults.target = { account: doc.accounts.find((a) => a.label === "work").id, model: null, effort: null };
  });
  const r = await auth("use", ["openai"]);
  assert.equal(r.code, 0, r.err);
  // The default is 3.0's own sign-in (found when the engine started), never the OpenRouter account.
  const doc = readRegistry();
  const target = doc.accounts.find((a) => a.id === doc.defaults.target?.account);
  assert.ok(!target || target.migratedFrom === "3.0-default-home", JSON.stringify(target));
});

test("a failing 3.0 use leaves the default account alone", async () => {
  const reg = await import("../src/auth/accounts/registry.mjs");
  const prev = process.env.AD_ROOT;
  process.env.AD_ROOT = path.join(TMP, "fresh-root");
  try {
    const lab = reg.newAccount({ provider: "custom", label: "lab", method: "none", endpoint: "http://127.0.0.1:9/v1" });
    await reg.transact((doc) => {
      doc.accounts.push({ ...lab, status: "ready", credential: { kind: "none" } });
      doc.defaults.target = { account: lab.id, model: null, effort: null };
    });
    // No OpenRouter account and no 3.0 key: 3.0's use openrouter refuses.
    const r = await auth("use", ["openrouter"], { model: "x/y" });
    assert.equal(r.code, 1);
    assert.match(r.err, /No openrouter key stored/);
    assert.equal(readRegistry().defaults.target.account, lab.id, "unchanged");
  } finally {
    process.env.AD_ROOT = prev;
  }
});

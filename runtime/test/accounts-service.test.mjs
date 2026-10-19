// P3.2: the account service's slow-step protocol. Reserve first, then the secret, so a
// crash never leaves a key no account names; rekey keeps the old key until the new one
// passes; the 3.0 `openrouter` key is rotated in place; credentialRevision moves only
// with the credential.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "ad-acct-svc-"));
after(() => fs.rm(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const { createAccountService } = await import("../src/auth/accounts/service.mjs");
const reg = await import("../src/auth/accounts/registry.mjs");
const { createSecretStore, fileBackend } = await import("../src/auth/secrets.mjs");

const KEY1 = ["sk", "or", "v1", "aaaaaaaaaaaaaaaa1111"].join("-");
const KEY2 = ["sk", "or", "v1", "bbbbbbbbbbbbbbbb2222"].join("-");
let n = 0;
function fresh() {
  const root = path.join(TMP, `r${++n}`);
  const secrets = path.join(root, "secrets");
  mkdirSync(secrets, { recursive: true });
  const store = createSecretStore(fileBackend(secrets));
  return { root, secrets, store, svc: createAccountService({ root, store }) };
}
const SVC = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "auth", "accounts", "service.mjs")).href;
const SEC = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "auth", "secrets.mjs")).href;
// A child that runs `body` and dies (exit 9) at the crash step.
function crashChild(root, secrets, step, body) {
  const code = `const { createAccountService } = await import(${JSON.stringify(SVC)}); const { createSecretStore, fileBackend } = await import(${JSON.stringify(SEC)});
const svc = createAccountService({ root: ${JSON.stringify(root)}, store: createSecretStore(fileBackend(${JSON.stringify(secrets)})), crashAt: (s) => { if (s === ${JSON.stringify(step)}) process.exit(9); } });
${body}`;
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "inherit" });
    c.on("exit", resolve);
  });
}

test("a crash between the secret write and the registry write: pending with its secret, no orphan", async () => {
  const { root, secrets, store } = fresh();
  const code = await crashChild(root, secrets, "afterSecret", `await svc.addApiKey({ provider: "openrouter", label: "work", key: ${JSON.stringify(KEY1)} });`);
  assert.equal(code, 9);
  const [a] = reg.readRegistry({ root }).accounts;
  assert.equal(a.status, "pending");
  assert.ok(a.attempt?.id);
  assert.equal(store.has(a.credential.ref), true, "the secret is named by the pending record");
  assert.deepEqual(store.list(), [a.credential.ref], "no secret without a record");
});

test("a crash after reserve: a pending record and no secret", async () => {
  const { root, secrets, store } = fresh();
  assert.equal(await crashChild(root, secrets, "afterReserve", `await svc.addApiKey({ provider: "openrouter", label: "work", key: ${JSON.stringify(KEY1)} });`), 9);
  const [a] = reg.readRegistry({ root }).accounts;
  assert.equal(a.status, "pending");
  assert.deepEqual(store.list(), []);
});

test("a crash during remove: the record says removing, the secret is gone", async () => {
  const { root, secrets, store, svc } = fresh();
  await svc.addApiKey({ provider: "openrouter", label: "work", key: KEY1 });
  assert.equal(await crashChild(root, secrets, "afterSecretDelete", `await svc.remove("openrouter/work");`), 9);
  const [a] = reg.readRegistry({ root }).accounts;
  assert.equal(a.status, "removing");
  assert.deepEqual(store.list(), []);
});

test("added: ready, keyHint is the last 4 characters and nothing else of the key is stored", async () => {
  const { root, svc, store } = fresh();
  const a = await svc.addApiKey({ provider: "openrouter", label: "work", owner: "Sam's key", key: KEY1 });
  assert.deepEqual([a.status, a.keyHint, a.credentialRevision], ["ready", "1111", 1]);
  const text = await fs.readFile(path.join(root, "accounts", "registry.json"), "utf8");
  assert.ok(!text.includes(KEY1) && !text.includes(KEY1.slice(0, -4)), "the key is not in the registry");
  assert.equal(store.get(a.credential.ref), KEY1);
  // A key that fails its test is not saved, and the record goes.
  await assert.rejects(svc.addApiKey({ provider: "openrouter", label: "bad", key: KEY2, test: async () => { throw new Error("401 from the provider"); } }), (e) => e.code === "KEY_TEST_FAILED");
  assert.deepEqual(reg.readRegistry({ root }).accounts.map((x) => x.label), ["work"]);
  assert.deepEqual(store.list(), [a.credential.ref]);
});

test("superseded attempt refused", async () => {
  const { svc } = fresh();
  const { id } = await svc.reserve({ provider: "chatgpt", label: "default", method: "engine-login" });
  await assert.rejects(svc.finalize(id, "not-the-attempt", {}), (e) => e.code === "ATTEMPT_SUPERSEDED");
});

test("rekey of an acct- ref keeps the old key until the new one passes; it bumps credentialRevision", async () => {
  const { svc, store } = fresh();
  const a = await svc.addApiKey({ provider: "openrouter", label: "work", key: KEY1 });
  await assert.rejects(svc.rekey("openrouter/work", { key: KEY2, test: async () => { throw new Error("nope"); } }));
  assert.equal(store.get(a.credential.ref), KEY1, "old key kept");
  assert.equal(svc.resolve("openrouter/work").credentialRevision, 1);
  const b = await svc.rekey("openrouter/work", { key: KEY2 });
  assert.notEqual(b.credential.ref, a.credential.ref);
  assert.equal(store.get(b.credential.ref), KEY2);
  assert.equal(store.has(a.credential.ref), false, "the old one is deleted after the swap");
  assert.deepEqual([b.keyHint, b.credentialRevision], ["2222", 2]);
  const c = await svc.rekey("openrouter/work", { key: KEY1 });
  assert.equal(c.credential.ref, a.credential.ref, "the two names alternate");
});

test("rekey of the 3.0 openrouter ref overwrites it in place and keeps the ref", async () => {
  const { root, svc, store } = fresh();
  store.set("openrouter", KEY1);
  await reg.transact((d) => {
    const a = reg.newAccount({ provider: "openrouter", label: "default", method: "api-key", credential: { kind: "secret", ref: "openrouter" }, migratedFrom: "3.0-openrouter" });
    a.status = "ready";
    d.accounts.push(a);
  }, { root });
  const b = await svc.rekey("openrouter/default", { key: KEY2 });
  assert.equal(b.credential.ref, "openrouter");
  assert.equal(store.get("openrouter"), KEY2, "3.0 finds the new key under its own name");
  assert.deepEqual(store.list(), ["openrouter"], "no temp left");
});

test("rename and owner changes don't bump credentialRevision; labels stay unique and never a provider", async () => {
  const { svc } = fresh();
  await svc.addApiKey({ provider: "openrouter", label: "work", key: KEY1 });
  await svc.addApiKey({ provider: "openrouter", label: "home", key: KEY2 });
  const r = await svc.rename("openrouter/work", { label: "office", owner: "client:acme" });
  assert.deepEqual([r.label, r.owner, r.credentialRevision], ["office", "client:acme", 1]);
  await assert.rejects(svc.rename("openrouter/office", { label: "HOME" }), (e) => e.code === "LABEL_TAKEN");
  await assert.rejects(svc.rename("openrouter/office", { label: "chatgpt" }), (e) => e.code === "LABEL_RESERVED");
});

test("the lock is not held while the key test runs", async () => {
  const { root, svc } = fresh();
  let during = null;
  await svc.addApiKey({
    provider: "openrouter",
    label: "work",
    key: KEY1,
    test: async () => {
      // Another writer gets through at once.
      const t0 = Date.now();
      await reg.transact((d) => {
        d.defaults.digest = null;
        d.engines.api.home = "@default";
      }, { root, waitMs: 1000 });
      during = Date.now() - t0;
    },
  });
  assert.ok(during !== null && during < 1000, `${during} ms`);
});

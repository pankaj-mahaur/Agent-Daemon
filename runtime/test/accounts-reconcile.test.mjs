// P3.2: ad auth repair finds what an interruption left and fixes it; what deletes a
// user's data asks first; nothing it prints holds a key.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "ad-acct-repair-"));
after(() => fs.rm(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const rec = await import("../src/auth/accounts/reconcile.mjs");
const reg = await import("../src/auth/accounts/registry.mjs");
const { createAccountService } = await import("../src/auth/accounts/service.mjs");
const { createSecretStore, fileBackend } = await import("../src/auth/secrets.mjs");

const KEY = ["sk", "or", "v1", "dddddddddddddddd4444"].join("-");
let n = 0;
function fresh() {
  const root = path.join(TMP, `r${++n}`);
  mkdirSync(path.join(root, "secrets"), { recursive: true });
  const store = createSecretStore(fileBackend(path.join(root, "secrets")));
  return { root, store, svc: createAccountService({ root, store }) };
}

test("orphan acct- secret deleted only after yes; a temp secret goes at once", async () => {
  const { root, store } = fresh();
  store.set("acct-01jabcdefghjkmnpqrstvwxyz0", KEY);
  store.set("acct-01jabcdefghjkmnpqrstvwxyz1-t", KEY);
  const f = rec.inspectAccounts({ root, store });
  assert.deepEqual(f.map((x) => x.kind).sort(), ["orphan-secret", "temp-secret"]);
  await rec.repairAccounts(f, { root, store, confirm: async () => false });
  assert.deepEqual(store.list(), ["acct-01jabcdefghjkmnpqrstvwxyz0"], "the orphan stays without a yes");
  await rec.repairAccounts(rec.inspectAccounts({ root, store }), { root, store, confirm: async () => true });
  assert.deepEqual(store.list(), []);
});

test("ready without its secret → needs sign-in; stale pending without a secret → removed; removing → finished", async () => {
  const { root, store, svc } = fresh();
  const a = await svc.addApiKey({ provider: "openrouter", label: "work", key: KEY });
  store.delete(a.credential.ref);
  await svc.reserve({ provider: "openrouter", label: "half", method: "api-key" });
  await reg.transact((d) => {
    const p = d.accounts.find((x) => x.label === "half");
    p.attempt.at = new Date(Date.now() - 3_600_000).toISOString();
  }, { root });
  const b = await svc.addApiKey({ provider: "openrouter", label: "gone", key: KEY });
  await reg.transact((d) => void (d.accounts.find((x) => x.id === b.id).status = "removing"), { root });
  const findings = rec.inspectAccounts({ root, store });
  assert.deepEqual(findings.map((x) => x.kind).sort(), ["pending-no-secret", "ready-no-secret", "removing"]);
  await rec.repairAccounts(findings, { root, store });
  const d = reg.readRegistry({ root });
  assert.deepEqual(d.accounts.map((x) => [x.label, x.status]), [["work", "needs-sign-in"]]);
  assert.deepEqual(store.list(), []);
});

test("corrupt registry restored from .bak, the damaged file kept", async () => {
  const { root, store, svc } = fresh();
  await svc.addApiKey({ provider: "openrouter", label: "one", key: KEY });
  await svc.addApiKey({ provider: "openrouter", label: "two", key: KEY });
  writeFileSync(path.join(root, "accounts", "registry.json"), "{ broken");
  const f = rec.inspectAccounts({ root, store });
  assert.deepEqual(f.map((x) => [x.kind, x.canRestore]), [["corrupt", true]]);
  await rec.repairAccounts(f, { root, store, confirm: async () => true });
  // The revision before the last write: "two" was still being added then.
  assert.deepEqual(reg.readRegistry({ root }).accounts.map((x) => [x.label, x.status]), [["one", "ready"], ["two", "pending"]], "the last good revision");
  assert.ok(readdirSync(path.join(root, "accounts")).some((x) => x.startsWith("registry.json.corrupt-")));
});

test("doctor rows and repair output never contain a key value", async () => {
  const { root, store, svc } = fresh();
  await svc.addApiKey({ provider: "openrouter", label: "work", key: KEY });
  store.set("acct-01jabcdefghjkmnpqrstvwxyz9", KEY);
  const rows = rec.accountRows({ root, store });
  const text = JSON.stringify(rows) + JSON.stringify(rec.inspectAccounts({ root, store }));
  assert.ok(!text.includes(KEY) && !text.includes(KEY.slice(0, 12)), "no key value");
  assert.match(rows.find((r) => r.name === "Accounts").note, /^1 \(1 ready\)$/);
  assert.equal(rows.find((r) => r.name === "Account repair").ok, false);
  assert.match(rows.find((r) => r.name === "Secret store").note, /^file; tools the agent runs can read/);
});

test("ad auth repair without a terminal and without --yes prints and exits 1; --yes applies", async () => {
  const { cmdAuthRepair } = await import("../src/harness/auth-repair.mjs");
  const { root, store } = fresh();
  store.set("acct-01jabcdefghjkmnpqrstvwxyz5", KEY);
  const lines = [];
  const out = { write: (s) => lines.push(s) };
  assert.equal(await cmdAuthRepair({ root, store, out, err: out, isTTY: () => false, yes: false }), 1);
  assert.ok(existsSync(path.join(root, "secrets", "acct-01jabcdefghjkmnpqrstvwxyz5")));
  assert.match(lines.join(""), /--yes/);
  assert.equal(await cmdAuthRepair({ root, store, out, err: out, isTTY: () => false, yes: true }), 0);
  assert.deepEqual(store.list(), []);
});

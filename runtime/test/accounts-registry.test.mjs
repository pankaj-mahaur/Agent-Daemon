// P3.2: the account registry (~/.agent-daemon/accounts/registry.json). Locked,
// revisioned, atomic, with a .bak of the last good revision; immutable random ids;
// labels unique per provider and never a provider's name; never reset when damaged.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "ad-accounts-"));
after(() => fs.rm(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const reg = await import("../src/auth/accounts/registry.mjs");

let n = 0;
const root = () => path.join(TMP, `r${++n}`);
const add = (doc, o = {}) => {
  const a = reg.newAccount({ provider: "openrouter", label: `k${doc.accounts.length}`, method: "api-key", ...o });
  doc.accounts.push(a);
  return a;
};

test("a missing file reads as empty v1; reading writes nothing", () => {
  const r = root();
  const doc = reg.readRegistry({ root: r });
  assert.deepEqual([doc.schemaVersion, doc.revision, doc.accounts.length], [1, 0, 0]);
  assert.ok(!existsSync(path.join(r, "accounts")));
});

test("transact bumps the revision through a temp file and keeps .bak", async () => {
  const r = root();
  await reg.transact((d) => void add(d), { root: r });
  const first = readFileSync(path.join(r, "accounts", "registry.json"), "utf8");
  await reg.transact((d) => void add(d), { root: r });
  const doc = reg.readRegistry({ root: r });
  assert.equal(doc.revision, 2);
  assert.equal(doc.accounts.length, 2);
  assert.equal(readFileSync(path.join(r, "accounts", "registry.json.bak"), "utf8"), first);
  assert.match(doc.salt, /^b64:/);
  // Unchanged: no write, no new revision.
  await reg.transact(() => {}, { root: r });
  assert.equal(reg.readRegistry({ root: r }).revision, 2);
});

test("concurrent registry writes: 8 child processes add one account each → 8 accounts, revision 8, valid JSON", async () => {
  const r = root();
  const mod = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "auth", "accounts", "registry.mjs")).href;
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      new Promise((resolve, reject) => {
        const code = `const m = await import(${JSON.stringify(mod)}); await m.transact((d) => { d.accounts.push(m.newAccount({ provider: "openrouter", label: "c${i}", method: "api-key" })); }, { root: ${JSON.stringify(r)}, waitMs: 30000 });`;
        const c = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "inherit" });
        c.on("exit", (x) => (x === 0 ? resolve() : reject(new Error(`exit ${x}`))));
      })
    )
  );
  const doc = JSON.parse(readFileSync(path.join(r, "accounts", "registry.json"), "utf8"));
  assert.equal(doc.accounts.length, 8);
  assert.equal(doc.revision, 8);
});

test("corrupt → REGISTRY_CORRUPT, never reset; newer schema → REGISTRY_NEWER, untouched", async () => {
  const r = root();
  mkdirSync(path.join(r, "accounts"), { recursive: true });
  const file = path.join(r, "accounts", "registry.json");
  writeFileSync(file, "{ not json");
  assert.throws(() => reg.readRegistry({ root: r }), (e) => e.code === "REGISTRY_CORRUPT" && /Your keys are untouched/.test(e.message));
  await assert.rejects(reg.transact((d) => void add(d), { root: r }), (e) => e.code === "REGISTRY_CORRUPT");
  assert.equal(readFileSync(file, "utf8"), "{ not json", "never reset");
  writeFileSync(file, JSON.stringify({ schemaVersion: 2, revision: 9, accounts: [] }));
  await assert.rejects(reg.transact((d) => void add(d), { root: r }), (e) => e.code === "REGISTRY_NEWER");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).revision, 9);
});

test("expectedRevision mismatch → REGISTRY_CONFLICT; a throwing mutator changes nothing", async () => {
  const r = root();
  await reg.transact((d) => void add(d), { root: r });
  await assert.rejects(reg.transact((d) => void add(d), { root: r, expectedRevision: 0 }), (e) => e.code === "REGISTRY_CONFLICT");
  await assert.rejects(reg.transact((d) => {
    add(d);
    throw new Error("boom");
  }, { root: r }), /boom/);
  assert.equal(reg.readRegistry({ root: r }).accounts.length, 1);
});

test("ids are random; refs fit the secret-name rule", () => {
  const a = reg.newAccountId();
  const b = reg.newAccountId();
  assert.match(a, /^acct_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.notEqual(a, b);
  assert.equal(reg.shortId(a), a.slice(-8));
  assert.match(reg.secretRef(a), /^acct-[0-9a-hjkmnp-tv-z]{26}$/);
  assert.equal(reg.secretRef(a).length, 31);
  assert.match(reg.secretRef(a, { next: true }), /-n$/);
  for (const ref of [reg.secretRef(a), reg.secretRef(a, { next: true }), reg.secretRef(a, { temp: true })]) assert.match(ref, /^[a-z0-9][a-z0-9_-]{0,63}$/);
  assert.equal(reg.newAccount({ provider: "openrouter", label: "x", method: "api-key" }).providerEntry.startsWith("ad-openrouter-"), true);
});

test("labels: unique per provider ignoring case; provider names and @tokens are reserved; default is a label", () => {
  const doc = reg.emptyRegistry();
  add(doc, { label: "Work" });
  assert.equal(reg.validateRegistry(doc).length, 0);
  add(doc, { label: "work" });
  assert.match(reg.validateRegistry(doc).join("\n"), /LABEL_TAKEN/);
  doc.accounts.pop();
  add(doc, { provider: "chatgpt", label: "work", method: "engine-login" });
  assert.equal(reg.validateRegistry(doc).length, 0, "another provider may use the same label");
  for (const bad of ["chatgpt", "OpenRouter", "openai", "@default", "@x"]) assert.equal(reg.checkLabel(bad), "LABEL_RESERVED", bad);
  for (const bad of ["", "a".repeat(41), "tab\there", "semi;colon"]) assert.equal(reg.checkLabel(bad), "LABEL_INVALID", JSON.stringify(bad));
  for (const ok of ["default", "work 2", "client.acme_x-1"]) assert.equal(reg.checkLabel(ok), null, ok);
});

test("owner accepts free text, refuses control characters and long values", () => {
  assert.equal(reg.checkOwner("Rahul's key"), null);
  assert.equal(reg.checkOwner(""), null);
  assert.equal(reg.checkOwner("client:acme"), null);
  assert.equal(reg.checkOwner("bad\u{1B}[2Jowner"), "OWNER_INVALID");
  assert.equal(reg.checkOwner("x".repeat(41)), "OWNER_INVALID");
});

test("findAccount: by id, by short id, by provider/label, by a unique label; ambiguity is an error", () => {
  const doc = reg.emptyRegistry();
  const a = add(doc, { label: "work" });
  const b = add(doc, { provider: "chatgpt", label: "work", method: "engine-login" });
  assert.equal(reg.findAccount(doc, a.id).id, a.id);
  assert.equal(reg.findAccount(doc, reg.shortId(b.id)).id, b.id);
  assert.equal(reg.findAccount(doc, "chatgpt/work").id, b.id);
  assert.throws(() => reg.findAccount(doc, "work"), (e) => e.code === "ACCOUNT_AMBIGUOUS");
  assert.throws(() => reg.findAccount(doc, "nope"), (e) => e.code === "ACCOUNT_NOT_FOUND");
});

test("the registry lock is invisible to ad migrate (not in the locks folder)", async () => {
  const r = root();
  let seen = null;
  await reg.transact(() => {
    seen = existsSync(path.join(r, "accounts", "registry.lock"));
  }, { root: r });
  assert.equal(seen, true);
  assert.ok(!existsSync(path.join(r, "locks", "registry.lock")));
});

test("win32-style rename retry: a busy rename is retried, then succeeds", async () => {
  const { writeJsonAtomicSync } = await import("../src/atomic-json.mjs");
  const file = path.join(TMP, "retry.json");
  let fails = 2;
  const rename = (a, b) => {
    if (fails-- > 0) {
      const e = new Error("busy");
      e.code = "EPERM";
      throw e;
    }
    return require("node:fs").renameSync(a, b);
  };
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  writeJsonAtomicSync(file, { ok: 1 }, { rename });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { ok: 1 });
});

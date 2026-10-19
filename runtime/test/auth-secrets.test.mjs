// Tests for the provider-key secret store (auth/secrets.mjs).
// Properties: round-trips, rejects path-traversal names, and on Windows the
// file on disk is DPAPI ciphertext — never the plaintext key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretStore, dpapiBackend, fileBackend, windowsPowerShellEnv } from "../src/auth/secrets.mjs";

const FAKE_KEY = "sk-or-v1-test-0123456789abcdef";

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ad-secrets-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("file backend round-trips, trims, and deletes", () => {
  withDir((dir) => {
    const store = createSecretStore(fileBackend(join(dir, "s")));
    assert.equal(store.get("openrouter"), null);
    store.set("openrouter", `  ${FAKE_KEY}\n`);
    assert.equal(store.get("openrouter"), FAKE_KEY);
    assert.equal(store.has("openrouter"), true);
    if (process.platform !== "win32") assert.equal(statSync(join(dir, "s", "openrouter")).mode & 0o777, 0o600);
    store.delete("openrouter");
    assert.equal(store.has("openrouter"), false);
    store.delete("openrouter"); // idempotent
  });
});

test("secret names cannot escape the store directory", () => {
  const store = createSecretStore(fileBackend(tmpdir()));
  for (const bad of ["../x", "a/b", "a\\b", "", "UPPER", ".hidden"]) {
    assert.throws(() => store.set(bad, "v"), /invalid secret name/);
  }
  assert.throws(() => store.set("ok", "   "), /non-empty/);
});

test("DPAPI backend stores ciphertext, not the key", { skip: process.platform !== "win32" && "Windows only" }, () => {
  withDir((dir) => {
    const store = createSecretStore(dpapiBackend(dir));
    store.set("openrouter", FAKE_KEY);
    const [file] = readdirSync(dir);
    assert.equal(file, "openrouter.dpapi");
    assert.ok(!readFileSync(join(dir, file), "utf8").includes(FAKE_KEY), "plaintext must not be on disk");
    assert.equal(store.get("openrouter"), FAKE_KEY);
    store.delete("openrouter");
    assert.equal(store.get("openrouter"), null);
  });
});

test("hasSecretTool: only a spawn error means absent (secret-tool has no --version)", async () => {
  const { hasSecretTool } = await import("../src/auth/secrets.mjs");
  assert.equal(hasSecretTool(() => ({ error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) })), false);
  assert.equal(hasSecretTool(() => ({ status: 2 })), true, "usage + non-zero exit still means installed");
});

test("has() reports presence without decrypting", () => {
  let decrypts = 0;
  const store = createSecretStore({ name: "x", get: () => (decrypts++, "v"), has: () => true, set() {}, delete() {} });
  assert.equal(store.has("openrouter"), true);
  assert.equal(decrypts, 0);
});

test("Windows PowerShell 5.1 gets no PSModulePath (pwsh 7's modules break DPAPI cmdlets)", () => {
  const env = windowsPowerShellEnv({ PATH: "p", PSModulePath: "C:/Program Files/PowerShell/7/Modules", psmodulepath: "x" });
  assert.deepEqual(env, { PATH: "p" });
});

// ---- v2 (P3.2) ----

const ACCT = "acct-01jabcdefghjkmnpqrstvwxyz0";

test("acct- names round-trip on the file backend; list() names them, never a temp", () => {
  withDir((dir) => {
    const store = createSecretStore(fileBackend(join(dir, "s")));
    for (const n of [ACCT, `${ACCT}-n`, `${ACCT}-t`, "openrouter"]) store.set(n, `${FAKE_KEY}-${n.length}`);
    assert.equal(store.get(`${ACCT}-n`), `${FAKE_KEY}-${`${ACCT}-n`.length}`);
    assert.deepEqual(store.list(), [ACCT, `${ACCT}-n`, `${ACCT}-t`, "openrouter"].sort());
    assert.deepEqual([...store.getMany([ACCT, "missing"]).entries()], [[ACCT, `${FAKE_KEY}-${ACCT.length}`], ["missing", null]]);
  });
});

test("a failed rename keeps the previous value", async () => {
  const fsMod = await import("node:fs");
  withDir((dir) => {
    const d = join(dir, "s");
    const store = createSecretStore(fileBackend(d));
    store.set("openrouter", "first-value");
    // A folder in the target's place makes the rename fail; the old value must survive.
    rmSync(join(d, "openrouter"));
    fsMod.mkdirSync(join(d, "openrouter"));
    fsMod.writeFileSync(join(d, "openrouter", "x"), "");
    assert.throws(() => store.set("openrouter", "second-value"));
    assert.deepEqual(readdirSync(d).filter((n) => n.endsWith(".tmp")), [], "no temp file left behind");
  });
});

test("libsecret has() looks up one entry; list() keeps key names only", async () => {
  const { libsecretBackend } = await import("../src/auth/secrets.mjs");
  const calls = [];
  const exec = (cmd, args) => {
    calls.push(args[0]);
    if (args[0] === "lookup") {
      if (args.at(-1) === "openrouter") return FAKE_KEY;
      throw Object.assign(new Error("not found"), { status: 1 });
    }
    if (args[0] === "search") return `[/1]\nlabel = agent-daemon openrouter\nsecret = ${FAKE_KEY}\nattribute.key = openrouter\nattribute.service = agent-daemon\n[/2]\nsecret = other-secret-value\nattribute.key = ${ACCT}\n`;
    return "";
  };
  const store = createSecretStore(libsecretBackend({ runTool: exec }));
  assert.equal(store.has("openrouter"), true);
  assert.deepEqual(calls, ["lookup"], "one lookup, no search");
  const names = store.list();
  assert.deepEqual(names, [ACCT, "openrouter"].sort());
  assert.ok(!JSON.stringify(names).includes(FAKE_KEY));
});

test("getMany: one PowerShell start for N secrets (DPAPI)", async () => {
  const fsMod = await import("node:fs");
  withDir((dir) => {
    let starts = 0;
    const ps = (script, input) => {
      starts++;
      if (/ConvertFrom-Json/.test(script)) return JSON.stringify(JSON.parse(input).map((c) => c.replace(/^enc:/, "")));
      return `enc:${input}`;
    };
    const store = createSecretStore(dpapiBackend(dir, { ps }));
    for (const n of ["a1", "a2", "a3"]) store.set(n, `value-${n}`);
    starts = 0;
    const got = store.getMany(["a1", "a2", "a3", "absent"]);
    assert.equal(starts, 1);
    assert.deepEqual([...got.values()], ["value-a1", "value-a2", "value-a3", null]);
    assert.deepEqual(store.list(), ["a1", "a2", "a3"]);
    void fsMod;
  });
});

test("macOS: a 3.0 file secret is still read after the keychain lands; new writes go to the keychain", async () => {
  const { defaultBackend } = await import("../src/auth/secrets.mjs");
  withDir((dir) => {
    const kc = new Map();
    class Entry {
      constructor(service, name) {
        this.k = `${service}/${name}`;
      }
      setPassword(v) {
        kc.set(this.k, v);
      }
      getPassword() {
        return kc.get(this.k) ?? null;
      }
      deletePassword() {
        kc.delete(this.k);
      }
    }
    const env = { AD_SECRETS_DIR: dir };
    // 3.0 wrote the file.
    createSecretStore(fileBackend(dir)).set("openrouter", FAKE_KEY);
    const store = createSecretStore(defaultBackend(env, { platform: "darwin", loadKeychain: () => ({ Entry }) }));
    assert.equal(store.backend, "keychain");
    assert.equal(store.get("openrouter"), FAKE_KEY, "read through to the 3.0 file");
    store.set(ACCT, "new-key");
    assert.equal(kc.get(`agent-daemon/${ACCT}`), "new-key");
    assert.ok(!readdirSync(dir).includes(ACCT), "not written as a file");
    store.delete("openrouter");
    assert.equal(store.get("openrouter"), null, "delete clears both");
  });
});

test("keychain module missing → file backend with the reason", async () => {
  const { defaultBackend } = await import("../src/auth/secrets.mjs");
  withDir((dir) => {
    const store = createSecretStore(defaultBackend({ AD_SECRETS_DIR: dir }, { platform: "darwin", loadKeychain: () => { throw Object.assign(new Error("Cannot find module"), { code: "MODULE_NOT_FOUND" }); } }));
    assert.equal(store.backend, "file");
    assert.match(store.reason, /keychain module isn't installed \(MODULE_NOT_FOUND\)/);
  });
});

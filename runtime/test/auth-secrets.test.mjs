// Tests for the provider-key secret store (auth/secrets.mjs).
// Properties: round-trips, rejects path-traversal names, and on Windows the
// file on disk is DPAPI ciphertext — never the plaintext key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretStore, dpapiBackend, fileBackend } from "../src/auth/secrets.mjs";

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

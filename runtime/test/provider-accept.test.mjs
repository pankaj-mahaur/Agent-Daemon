// The provider acceptance run (P3.5b). The CI refusal always runs; the run itself goes
// through the real engine against a mock provider (AD_REAL_ENGINE=1). A throwaway HOME /
// AD_ROOT: never the user's own folders.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const skip = process.env.AD_REAL_ENGINE === "1" ? false : "set AD_REAL_ENGINE=1 to run the real engine";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-accept-test-"));
const saved = { AD_ROOT: process.env.AD_ROOT, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.AD_ROOT = path.join(TMP, ".agent-daemon");
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;

const { runAcceptance, ACCEPT_TEXTS } = await import("../src/providers/accept.mjs");
const { closeHarnessEngines } = await import("../src/harness/engines.mjs");
const { closeGateway } = await import("../src/harness/gateway-runtime.mjs");
const reg = await import("../src/auth/accounts/registry.mjs");
const { createSecretStore, fileBackend } = await import("../src/auth/secrets.mjs");
const { startMockProvider } = await import("../testkit/mock-providers.mjs");

after(async () => {
  await closeHarnessEngines();
  await closeGateway();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("refuses under CI: acceptance runs only on your machine, with your own keys", async () => {
  await assert.rejects(runAcceptance({ account: "openrouter/x", env: { CI: "true" } }), (e) => e.code === "ACCEPT_CI" && e.message === ACCEPT_TEXTS.REFUSED_CI);
});

test("against a mock provider: a record with the measured lines, no key, status candidate", { skip, timeout: 600_000 }, async () => {
  const KEY = ["sk", "or", "v1", "acce0000acce0000acce"].join("-");
  const mock = await startMockProvider({ personality: "openrouter", keys: [KEY], models: [{ id: "mock-model" }, { id: "qwen/qwen3-coder:free" }, { id: `echo-${KEY}:free` }] });
  try {
    fs.mkdirSync(path.join(process.env.AD_ROOT, "secrets"), { recursive: true });
    const store = createSecretStore(fileBackend(path.join(process.env.AD_ROOT, "secrets")));
    const a = reg.newAccount({ provider: "openrouter", label: "accept", method: "api-key", endpoint: mock.url, defaultModel: "mock-model" });
    store.set(a.credential.ref, KEY);
    await reg.transact((doc) => {
      doc.accounts.push({ ...a, status: "ready", keyHint: KEY.slice(-4) });
      doc.engines.api.home = "api";
    });
    const out = path.join(TMP, "records");
    const r = await runAcceptance({ account: "openrouter/accept", out, store, env: {}, clientVersion: "test", now: () => new Date("2026-10-19T12:00:00Z") });
    assert.equal(r.file, path.join(out, "openrouter-accept-2026-10-19.md"));
    const text = fs.readFileSync(r.file, "utf8");
    assert.ok(!text.includes(KEY), "no key in the record");
    assert.match(text, /^Status: candidate$/m);
    assert.match(text, /turn completed/);
    // A provider that echoes the key (here in a model id) never puts it in the record.
    assert.match(text, /3 models listed; 2 free \(e\.g\. qwen\/qwen3-coder:free, echo-/);
    assert.match(text, /\(fill in\)/);
  } finally {
    await mock.close();
  }
});

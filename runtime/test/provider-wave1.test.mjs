// Wave-1 providers through ad's gateway and the real engine (P3.5; AD_REAL_ENGINE=1).
// Accounts point at mock providers (their endpoint); everything else is ad's own path:
// launchHarness → the api home's engine → the gateway → the mock, with each account's key.
// A throwaway HOME / AD_ROOT: never the user's own folders.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const skip = process.env.AD_REAL_ENGINE === "1" ? false : "set AD_REAL_ENGINE=1 to run the real engine";
const TIMEOUT = 300_000;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-wave1-"));
const saved = { AD_ROOT: process.env.AD_ROOT, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.AD_ROOT = path.join(TMP, ".agent-daemon");
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;

const { launchHarness, closeHarnessEngines } = await import("../src/harness/engines.mjs");
const { closeGateway } = await import("../src/harness/gateway-runtime.mjs");
const reg = await import("../src/auth/accounts/registry.mjs");
const { createSecretStore, fileBackend } = await import("../src/auth/secrets.mjs");
const { startMockProvider } = await import("../testkit/mock-providers.mjs");

const keys = { a: ["sk", "or", "v1", "aaaa1111aaaa1111aaaa"].join("-"), b: ["sk", "or", "v1", "bbbb2222bbbb2222bbbb"].join("-"), x: ["xai", "cccc3333cccc3333cccc3333"].join("-") };
const mocks = [];
after(async () => {
  await closeHarnessEngines();
  await closeGateway();
  for (const m of mocks) await m.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

let ready = null;
async function setup() {
  if (ready) return ready;
  const orMock = await startMockProvider({ personality: "openrouter", keys: [keys.a, keys.b] });
  const xMock = await startMockProvider({ personality: "generic", keys: [keys.x] });
  mocks.push(orMock, xMock);
  fs.mkdirSync(path.join(process.env.AD_ROOT, "secrets"), { recursive: true });
  const store = createSecretStore(fileBackend(path.join(process.env.AD_ROOT, "secrets")));
  const mk = (provider, label, key, endpoint) => {
    const a = reg.newAccount({ provider, label, method: "api-key", endpoint, defaultModel: "mock-model" });
    store.set(a.credential.ref, key);
    return { ...a, status: "ready", keyHint: key.slice(-4) };
  };
  const A = mk("openrouter", "personal", keys.a, orMock.url);
  const B = mk("openrouter", "work", keys.b, orMock.url);
  const X = mk("xai", "default", keys.x, xMock.url);
  await reg.transact((doc) => {
    doc.accounts.push(A, B, X);
    doc.engines.api.home = "api";
  });
  const cwd = path.join(TMP, "work", "shop-app");
  fs.mkdirSync(cwd, { recursive: true });
  ready = { store, orMock, xMock, A, B, X, cwd };
  return ready;
}

const sink = () => ({ text: "", write(s) { this.text += s; return true; } });

test("two OpenRouter accounts and an xAI account each reach their own provider with their own key", { skip, timeout: TIMEOUT }, async () => {
  const { store, orMock, xMock, cwd } = await setup();
  for (const [ref, mock, keyIndex] of [["openrouter/personal", orMock, 0], ["openrouter/work", orMock, 1], ["xai/default", xMock, 0]]) {
    const err = sink();
    const r = await launchHarness({ cwd, account: ref, store, err, clientVersion: "test" });
    assert.ok(r.engine, `${ref}: ${r.error ?? err.text}`);
    try {
      const { threadId } = await r.engine.startThread({ cwd, modelProvider: r.params.modelProvider, model: r.params.model, approvalPolicy: "never", sandbox: "read-only" });
      const before = mock.requests.length;
      const t = await r.engine.turn({ threadId, text: `PING ${ref}`, timeoutMs: 120_000 });
      assert.equal(t.status, "completed", `${ref}: ${t.error?.message ?? ""}`);
      const mine = mock.requests.slice(before).filter((x) => x.text === `PING ${ref}`);
      assert.ok(mine.length, `${ref} reached its provider`);
      assert.ok(mine.every((x) => x.auth.matchesKey === keyIndex), `${ref} used its own key`);
    } finally {
      await r.release();
    }
  }
});

test("a provider answering 500 ends the turn after bounded retries, not endlessly", { skip, timeout: TIMEOUT }, async () => {
  const { store, xMock: mock, cwd } = await setup();
  mock.setFault({ type: "5xx", status: 500, times: 10 });
  const r = await launchHarness({ cwd, account: "xai/default", store, err: sink(), clientVersion: "test" });
  assert.ok(r.engine, r.error);
  try {
    const { threadId } = await r.engine.startThread({ modelProvider: r.params.modelProvider, model: r.params.model, approvalPolicy: "never", sandbox: "read-only" });
    const before = mock.requests.length;
    const started = Date.now();
    const t = await r.engine.turn({ threadId, text: "PING fails", timeoutMs: 120_000 });
    const sent = mock.requests.slice(before).filter((x) => x.path.endsWith("/responses")).length;
    const took = Date.now() - started;
    assert.notEqual(t.status, "completed");
    // request_max_retries = 1 and stream_max_retries = 1: at most two tries, each retried
    // once by the stream layer (0.163: 4 requests), then the turn ends.
    assert.ok(sent >= 2 && sent <= 4, `bounded retries: ${sent} requests in ${took} ms`);
    assert.ok(took < 90_000, `ended in ${took} ms`);
  } finally {
    mock.setFault(null);
    await r.release();
  }
});

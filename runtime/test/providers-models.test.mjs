// Model lists and free models (P3.5, D12): free only from a fresh zero price.

import { test } from "node:test";
import assert from "node:assert/strict";
import { clearModelCache, FREE_DATA_NOTE, isFree, listModels } from "../src/providers/models.mjs";
import { startMockProvider } from "../testkit/mock-providers.mjs";

const KEY = ["sk", "or", "v1", "eeeeeeeeeeeeeeee5555"].join("-");
const H = 60 * 60_000;

test("a :free id with a fresh zero price is marked free; a stale or non-zero price is not", () => {
  const now = Date.now();
  assert.equal(isFree({ id: "m:free", pricing: { prompt: "0", completion: "0" } }, { observedAt: now - H, now }), true);
  assert.equal(isFree({ id: "m:free", pricing: { prompt: "0", completion: "0" } }, { observedAt: now - 25 * H, now }), false, "stale");
  assert.equal(isFree({ id: "m:free", pricing: { prompt: "0.000001", completion: "0" } }, { observedAt: now, now }), false, "priced");
  assert.equal(isFree({ id: "m:free" }, { observedAt: now, now }), false, "the suffix alone");
  assert.equal(isFree({ id: "m", pricing: { prompt: 0, completion: "0" } }, { observedAt: now, now }), true, "a numeric zero is a zero price");
});

test("OpenRouter's list: free models marked with the data note; others not; ad's own request with the key", async () => {
  clearModelCache();
  const mock = await startMockProvider({ personality: "openrouter", keys: [KEY], models: [{ id: "qwen/qwen3-coder:free" }, { id: "anthropic/claude-sonnet" }] });
  try {
    const account = { id: "acct_x", provider: "openrouter", endpoint: `${mock.url}` };
    const models = await listModels(account, { key: KEY, clientVersion: "3.1.0" });
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    assert.equal(byId["qwen/qwen3-coder:free"].free, true);
    assert.equal(byId["qwen/qwen3-coder:free"].dataNote, FREE_DATA_NOTE);
    assert.equal(byId["anthropic/claude-sonnet"].free, false);
    assert.equal(byId["anthropic/claude-sonnet"].dataNote, null);
    assert.ok(byId["anthropic/claude-sonnet"].priceObservedAt > 0);
    const req = mock.requests.at(-1);
    assert.equal(req.auth.matchesKey, 0);
    assert.equal(req.headers["user-agent"], "ad/3.1.0");
    // Cached: a second call makes no request.
    const n = mock.requests.length;
    await listModels(account, { key: KEY });
    assert.equal(mock.requests.length, n);
  } finally {
    await mock.close();
  }
});

test("a provider without a price source never marks a model free, even one named :free", async () => {
  clearModelCache();
  const mock = await startMockProvider({ personality: "generic", keys: [KEY], models: [{ id: "x:free" }] });
  try {
    const models = await listModels({ id: "acct_y", provider: "xai", endpoint: mock.url }, { key: KEY });
    assert.equal(models[0].free, false);
  } finally {
    await mock.close();
  }
});

// P6.2: what every translated provider shares — a model's context window reaching its
// thread, a custom endpoint that speaks only Chat Completions, the presets' own rules.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-presets-"));
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

const { threadConfigFor, gatewayTable } = await import("../src/gateway/table.mjs");
const { createAccountService } = await import("../src/auth/accounts/service.mjs");
const { createSecretStore, fileBackend } = await import("../src/auth/secrets.mjs");
const { signInCustom } = await import("../src/auth/accounts/signin.mjs");
const { readRegistry } = await import("../src/auth/accounts/registry.mjs");
const { startHarnessEngine } = await import("../src/harness/start.mjs");

fs.mkdirSync(path.join(process.env.AD_ROOT, "secrets"), { recursive: true });
const store = createSecretStore(fileBackend(path.join(process.env.AD_ROOT, "secrets")));
const service = createAccountService({ store });
const FAKE = { cmd: process.execPath, prefix: [fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url))] };

test("a model's context window comes from its route; compaction at 80%; nothing for unknown models or passthrough", () => {
  const table = new Map([
    ["ad-groq-x", { mode: "chat", contextWindows: { "llama-x": 131072 } }],
    ["ad-openai-y", { mode: "passthrough" }],
  ]);
  assert.deepEqual(threadConfigFor(table, { model: "llama-x", modelProvider: "ad-groq-x" }), { model_context_window: 131072, model_auto_compact_token_limit: 104857 });
  assert.equal(threadConfigFor(table, { model: "other", modelProvider: "ad-groq-x" }), null);
  assert.equal(threadConfigFor(table, { model: "llama-x", modelProvider: "ad-openai-y" }), null);
  assert.equal(threadConfigFor(table, { model: undefined, modelProvider: undefined }), null);
});

test("the engine starts a thread with its model's window (a caller's own config still wins)", async () => {
  const home = fs.mkdtempSync(path.join(TMP, "home-"));
  const asked = [];
  const threadConfigFor = (t) => (asked.push(t), t.model === "llama-x" ? { model_context_window: 131072, model_auto_compact_token_limit: 104857 } : null);
  const { engine } = await startHarnessEngine({ home, command: FAKE, setup: false, err: { write: () => true }, gateway: { env: {}, args: [], threadConfigFor } });
  try {
    await engine.startThread({ cwd: TMP, model: "llama-x", modelProvider: "ad-groq-x", config: { model_auto_compact_token_limit: 5 } });
    const { lastParams } = await engine.testRequest("debug/state", {});
    assert.equal(lastParams["thread/start"].config.model_context_window, 131072);
    assert.equal(lastParams["thread/start"].config.model_auto_compact_token_limit, 5, "the caller's own value");
    assert.deepEqual(asked.at(-1), { model: "llama-x", modelProvider: "ad-groq-x" });
  } finally {
    await engine.close();
  }
});

test("a custom endpoint with only Chat Completions is added (wire chat) and routed through the translation", async () => {
  const KEY = ["ck", "test", "5555aaaa5555"].join("-");
  const seen = [];
  const s = createServer((q, res) => {
    let raw = "";
    q.on("data", (c) => (raw += c));
    q.on("end", () => {
      seen.push(`${q.method} ${q.url}`);
      if (q.headers.authorization !== `Bearer ${KEY}`) return res.writeHead(401).end("{}");
      if (q.method === "GET" && q.url === "/v1/models") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "m1" }] }));
      if (q.url === "/v1/chat/completions") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "p" }, finish_reason: "length" }] }));
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    const a = await signInCustom({ service, baseUrl: `http://127.0.0.1:${s.address().port}/v1`, label: "chatty", readKey: async () => KEY, confirmProbe: async () => true });
    assert.equal(a.status, "ready");
    assert.equal(a.wire, "chat");
    assert.deepEqual(seen, ["GET /v1/models", "POST /v1/responses", "POST /v1/chat/completions"]);
    const route = gatewayTable(readRegistry()).get(a.providerEntry);
    assert.equal(route.mode, "chat");
    assert.equal(route.upstreamPath, "/chat/completions");
  } finally {
    s.close();
  }
});

test("NVIDIA's trial notice comes before anything: declined, no key is read and nothing is sent", async () => {
  const { signInApiKey } = await import("../src/auth/accounts/signin.mjs");
  let reads = 0;
  let calls = 0;
  const fetch = async () => {
    calls++;
    return new Response("{}", { status: 400, headers: { "content-type": "application/json" } });
  };
  const shown = [];
  await assert.rejects(
    signInApiKey({ service, provider: "nvidia", label: "trial", readKey: async () => (reads++, "nvapi-test"), fetch, confirmNotice: async (t) => (shown.push(t), false) }),
    { code: "NOTICE_DECLINED" },
  );
  assert.deepEqual(shown, ["NVIDIA's hosted models are for trial use. Don't send personal or confidential code."]);
  assert.equal(reads, 0);
  assert.equal(calls, 0);
  // Accepted: the key is read and tested.
  const KEY = ["nvapi", "0000111122223333aaaa"].join("-");
  const a = await signInApiKey({ service, provider: "nvidia", label: "trial2", readKey: async () => KEY, fetch, confirmNotice: async () => true });
  assert.equal(calls, 1);
  assert.equal(a.status, "ready");
});

test("a resumed thread on a translated model gets its window too", async () => {
  const home = fs.mkdtempSync(path.join(TMP, "home-"));
  const threadConfigFor = (t) => (t.model === "llama-x" && t.modelProvider === "ad-groq-x" ? { model_context_window: 131072, model_auto_compact_token_limit: 104857 } : null);
  const { engine } = await startHarnessEngine({ home, command: FAKE, setup: false, err: { write: () => true }, gateway: { env: {}, args: [], threadConfigFor } });
  try {
    const { threadId } = await engine.startThread({ cwd: TMP });
    await engine.resumeThread(threadId, { model: "llama-x", modelProvider: "ad-groq-x" }).catch(() => {});
    const { lastParams } = await engine.testRequest("debug/state", {});
    assert.equal(lastParams["thread/resume"]?.config?.model_context_window, 131072);
  } finally {
    await engine.close();
  }
});

test("a blocked preset is refused in the sign-in itself, also through another preset's address", async () => {
  const { signInApiKey } = await import("../src/auth/accounts/signin.mjs");
  let reads = 0;
  await assert.rejects(signInApiKey({ service, provider: "zai-coding", label: "x", readKey: async () => (reads++, "k") }), { code: "PROVIDER_BLOCKED" });
  await assert.rejects(signInApiKey({ service, provider: "zai", label: "y", endpoint: "https://api.z.ai/api/coding/paas/v4/", readKey: async () => (reads++, "k") }), { code: "PROVIDER_BLOCKED" });
  assert.equal(reads, 0);
});

test("a plain resume (nothing named) finds the thread's model and gets its window", async () => {
  const home = fs.mkdtempSync(path.join(TMP, "home-"));
  const threadConfigFor = (t) => (t.model === "llama-x" ? { model_context_window: 131072, model_auto_compact_token_limit: 104857 } : null);
  const { engine } = await startHarnessEngine({ home, command: FAKE, setup: false, err: { write: () => true }, gateway: { env: {}, args: [], threadConfigFor } });
  try {
    const { threadId } = await engine.startThread({ cwd: TMP, model: "llama-x" });
    await engine.resumeThread(threadId, {}).catch(() => {});
    const { lastParams } = await engine.testRequest("debug/state", {});
    assert.equal(lastParams["thread/resume"]?.config?.model_context_window, 131072);
  } finally {
    await engine.close();
  }
});

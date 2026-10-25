// P3.6: OpenCode Go with the user's own key — wires per model, the key test, the gateway's
// per-model routing, the session header, ad's own User-Agent and Go's usage limit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGatewayServer } from "../src/gateway/server.mjs";
import { gatewayTable, PRESETS } from "../src/gateway/table.mjs";
import { presetFor } from "../src/providers/registry.mjs";
import { clearModelCache, listModels } from "../src/providers/models.mjs";
import { testKey } from "../src/auth/accounts/signin.mjs";
import { createSseParser } from "../src/gateway/translate/sse.mjs";
import { startMockOpencode } from "../testkit/mock-opencode.mjs";
import { randomBytes } from "node:crypto";
import { seal } from "../src/gateway/translate/seal.mjs";

const KEY = ["go", "test", "key", "0123456789abcdef"].join("-");
const TOKEN = "t".repeat(43);
const ENTRY = "ad-opencode-go-test";

async function withGo(fn) {
  const mock = await startMockOpencode({ keys: [KEY] });
  try {
    await fn(mock);
  } finally {
    await mock.close();
  }
}

/** The real preset, pointed at the mock. */
const goPreset = (mock) => ({ ...presetFor("opencode-go"), upstreamBase: mock.base, modelsUrl: mock.modelsUrl, wires: { "glm-5.3": "chat", "gpt-6-luna": "chat", "claude-haiku-5-5": "messages" } });

async function withGateway(mock, fn, { sessionId } = {}) {
  const doc = { accounts: [{ id: "acct_go", provider: "opencode-go", label: "go", method: "api-key", status: "ready", providerEntry: ENTRY }] };
  const presets = { ...PRESETS, "opencode-go": { ...PRESETS["opencode-go"], baseUrl: mock.base, wires: { "glm-5.3": "chat", "gpt-6-luna": "responses", "claude-haiku-5-5": "messages", "wrong-wire": "chat" } } };
  const table = gatewayTable(doc, { presets });
  for (const r of table.values()) r.allowHttp = true;
  const events = [];
  const gw = createGatewayServer({ token: TOKEN, table, keys: { acct_go: KEY }, onUpstream: (e) => events.push(e), ...(sessionId ? { sessionId } : {}) });
  const port = await gw.listen();
  const post = async (model, text = "PING", thread = "thr-1") => {
    const r = await fetch(`http://127.0.0.1:${port}/p/${ENTRY}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "user-agent": "engine-ua/1.0 opencode-lookalike" }, body: JSON.stringify({ model, input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }], tools: [], stream: true, client_metadata: { thread_id: thread } }) });
    const body = await r.text();
    const sse = [];
    if ((r.headers.get("content-type") ?? "").includes("event-stream")) {
      const p = createSseParser({ onEvent: (e) => sse.push(JSON.parse(e.data)) });
      p.push(body);
      p.end();
    }
    return { status: r.status, body, sse };
  };
  try {
    await fn({ post, events, port, table });
  } finally {
    await gw.close();
  }
}

test("listModels marks each model's wire; messages models are coming later; the public list is used", async () => {
  await withGo(async (mock) => {
    clearModelCache();
    const models = await listModels({ id: "a1", provider: "opencode-go" }, { key: KEY, preset: goPreset(mock), clientVersion: "9.9.9" });
    const by = Object.fromEntries(models.map((m) => [m.id, m]));
    assert.equal(by["glm-5.3"].wire, "chat");
    assert.equal(by["glm-5.3"].available, true);
    assert.equal(by["claude-haiku-5-5"].available, false);
    assert.match(by["claude-haiku-5-5"].dataNote, /coming later/);
    assert.equal(by["new-model"].wire, "unknown");
  });
});

test("the key test: a wrong key is refused, a right one ready; it sends ad's User-Agent and a session id, and spends no tokens", async () => {
  await withGo(async (mock) => {
    const p = goPreset(mock);
    assert.equal((await testKey(p, { key: KEY, clientVersion: "9.9.9", insecure: true })).status, "ready");
    assert.equal((await testKey(p, { key: "wrong", clientVersion: "9.9.9", insecure: true })).status, "refused");
    for (const r of mock.requests) {
      assert.equal(r.userAgent, "ad/9.9.9");
      assert.match(r.session, /^ad-key-test-/);
    }
  });
});

test("the gateway routes Go per model: chat models through the translation, responses models as they are, messages models refused before any call", async () => {
  await withGo(async (mock) => {
    await withGateway(mock, async ({ post }) => {
      const chat = await post("glm-5.3");
      assert.equal(chat.status, 200);
      assert.equal(chat.sse.at(-1).type, "response.completed");
      assert.equal(mock.requests.at(-1).path, "/inference/go/openai/v1/chat/completions");
      const resp = await post("gpt-6-luna");
      assert.equal(resp.status, 200);
      assert.equal(mock.requests.at(-1).path, "/inference/go/openai/v1/responses");
      const n = mock.requests.length;
      const later = await post("claude-haiku-5-5");
      assert.equal(later.status, 400);
      assert.match(JSON.parse(later.body).error.message, /^This OpenCode Go model isn't available to ad yet\. Pick another with \/model\.$/);
      assert.equal(mock.requests.length, n, "nothing sent");
    });
  });
});

test("the session header: the conversation's id, stable across its requests; another conversation, another id; never a User-Agent naming OpenCode", async () => {
  await withGo(async (mock) => {
    await withGateway(mock, async ({ post }) => {
      await post("glm-5.3", "PING", "thr-A");
      await post("gpt-6-luna", "PING", "thr-A");
      await post("glm-5.3", "PING", "thr-B");
      const [a1, a2, b] = mock.requests.slice(-3);
      assert.equal(a1.session, "thr-A");
      assert.equal(a2.session, "thr-A");
      assert.equal(b.session, "thr-B");
      for (const r of mock.requests) {
        assert.match(r.userAgent, /^ad\/\d/);
        assert.doesNotMatch(r.userAgent, /opencode/i);
      }
    });
  });
});

test("outside a conversation the gateway's own session id: stable in one gateway, different in another", async () => {
  await withGo(async (mock) => {
    const ids = [];
    for (let i = 0; i < 2; i++) {
      await withGateway(mock, async ({ port }) => {
        for (let k = 0; k < 2; k++) {
          await fetch(`http://127.0.0.1:${port}/p/${ENTRY}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-6-luna", input: "PING", stream: true }) }).then((r) => r.text());
          ids.push(mock.requests.at(-1).session);
        }
      });
    }
    assert.equal(ids[0], ids[1], "stable within one gateway (one ad session)");
    assert.notEqual(ids[0], ids[2], "another gateway, another id");
  });
});

test("Go's usage limit: one 429 the engine treats as final, with ad's text and the reset time, on both wires", async () => {
  await withGo(async (mock) => {
    mock.setLimit(true, 3600);
    await withGateway(mock, async ({ post, events }) => {
      for (const model of ["gpt-6-luna", "glm-5.3"]) {
        const r = await post(model);
        assert.equal(r.status, 429, model);
        const e = JSON.parse(r.body).error;
        assert.equal(e.code, "insufficient_quota");
        assert.match(e.message, /^OpenCode Go's usage limit is reached\. It resets at \d\d:\d\d; until then pick another account with \/model\.$/);
        assert.equal(events.at(-1).translate.kind, "quotaExhausted");
      }
    });
  });
});

test("a model on the other wire: an unlisted one is moved after the not-yet text; a listed one keeps its wire; a parameter error moves nothing", async () => {
  await withGo(async (mock) => {
    await withGateway(mock, async ({ post, table }) => {
      // Unlisted: tried on chat, served on responses ("Model … is not available on this endpoint").
      const first = await post("mystery");
      assert.equal(first.status, 400);
      assert.match(JSON.parse(first.body).error.message, /isn't available to ad yet/);
      const again = await post("mystery");
      assert.equal(again.status, 200);
      assert.equal(mock.requests.at(-1).path, "/inference/go/openai/v1/responses");
      // Listed as chat in the dated table, served elsewhere: the text, but the wire stays.
      table.get(ENTRY).wires["gpt-6-luna"] = "chat";
      for (let i = 0; i < 2; i++) {
        const r = await post("gpt-6-luna");
        assert.equal(r.status, 400);
        assert.equal(mock.requests.at(-1).path, "/inference/go/openai/v1/chat/completions");
      }
      // A parameter the endpoint doesn't take is the provider's message, never a move.
      for (let i = 0; i < 2; i++) {
        const r = await post("param-err");
        assert.equal(r.status, 400);
        assert.doesNotMatch(JSON.parse(r.body).error.message, /isn't available to ad yet/);
        assert.equal(mock.requests.at(-1).path, "/inference/go/openai/v1/chat/completions");
      }
    });
  });
});

test("the key test is ready only past the door: a moved path or a missing session header is not proof", async () => {
  await withGo(async (mock) => {
    const moved = { ...goPreset(mock), upstreamPath: "/moved/chat" };
    assert.equal((await testKey(moved, { key: KEY, clientVersion: "9.9.9", insecure: true })).status, "unreachable");
    const noSession = { ...goPreset(mock), sessionHeader: null };
    const r = await testKey(noSession, { key: KEY, clientVersion: "9.9.9", insecure: true });
    assert.equal(r.status, "unreachable");
    assert.match(r.detail, /MissingSessionID/);
    // It asks with a chat model (the empty request is a chat one).
    assert.equal(mock.requests.find((q) => q.keyOk)?.model, "glm-5.3");
  });
});

test("Go's DeepSeek models get DeepSeek's rule: reasoning ad can't open in a tool loop is refused before sending", async () => {
  await withGo(async (mock) => {
    await withGateway(mock, async ({ port }) => {
      const n = mock.requests.length;
      const input = [
        { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        // Ad's own envelope for this provider and model, under a key the gateway doesn't have.
        { type: "reasoning", summary: [], encrypted_content: seal(randomBytes(32), { provider: "opencode-go", model: "deepseek-v4-pro" }, "old") },
        { type: "function_call", call_id: "c1", name: "exec_command", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ];
      const r = await fetch(`http://127.0.0.1:${port}/p/${ENTRY}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek-v4-pro", input, tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }], stream: true }) });
      assert.equal(r.status, 400);
      assert.match((await r.json()).error.message, /DeepSeek can't read this chat's earlier reasoning/);
      assert.equal(mock.requests.length, n, "nothing sent");
    });
  });
});

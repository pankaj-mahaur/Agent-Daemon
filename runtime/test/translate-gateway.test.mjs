// P6.1b: a "chat" route through the gateway server — token, key, path, redirect refusal and
// the side channel stay P3.3's; the body and the stream are translated.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createGatewayServer } from "../src/gateway/server.mjs";
import { createSseParser } from "../src/gateway/translate/sse.mjs";
import { chat, startMockChat } from "../testkit/mock-chat.mjs";

const TOKEN = "t".repeat(43);
const KEY = ["gsk", "test", "0000111122223333"].join("_");
const ENTRY = "ad-groq-test";

async function withGateway(fn, { script, opts = {}, route = {} } = {}) {
  const mock = await startMockChat(script ? { script } : {});
  const events = [];
  const table = new Map([[ENTRY, { accountId: "acct_1", provider: "groq", upstreamBase: mock.url, mode: "chat", upstreamPath: "/chat/completions", quirks: [], model: {}, auth: { kind: "static-key", scheme: "bearer" }, headers: {}, allowHttp: true, label: "Groq", ...route }]]);
  const gw = createGatewayServer({ token: TOKEN, table, keys: { acct_1: KEY }, onUpstream: (e) => events.push(e), ...opts });
  const port = await gw.listen();
  const post = async (body, { token = TOKEN } = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}/p/${ENTRY}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await r.text();
    const sse = [];
    if ((r.headers.get("content-type") ?? "").includes("event-stream")) {
      const p = createSseParser({ onEvent: (e) => sse.push(JSON.parse(e.data)) });
      p.push(text);
      p.end();
    }
    return { status: r.status, text, sse, headers: r.headers };
  };
  try {
    await fn({ post, mock, events, port });
  } finally {
    await gw.close();
    await mock.close();
  }
}

const req = (text, extra = {}) => ({ model: "llama-x", input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }], tools: [{ type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } }], tool_choice: "auto", stream: true, store: false, ...extra });

test("a turn: Chat body upstream with the key; Responses events back; usage on the side channel", async () => {
  await withGateway(async ({ post, mock, events }) => {
    const r = await post(req("PING"));
    assert.equal(r.status, 200);
    assert.equal(r.sse.at(-1).type, "response.completed");
    assert.equal(r.sse.filter((e) => e.type === "response.output_item.done").at(-1).item.content[0].text, "pong");
    const up = mock.requests[0];
    assert.equal(up.path, "/v1/chat/completions");
    assert.equal(up.authorization, `Bearer ${KEY}`);
    assert.equal(up.body.messages.at(-1).content, "PING");
    assert.equal(events.length, 1);
    assert.equal(events[0].usage.total_tokens, 16);
    assert.ok(!JSON.stringify(events).includes(KEY) && !JSON.stringify(events).includes(TOKEN));
  });
});

test("a split tool call arrives whole; byte-split chunks change nothing", async () => {
  await withGateway(
    async ({ post }) => {
      const r = await post(req("SHELL"));
      const call = r.sse.find((e) => e.type === "response.output_item.done" && e.item.type === "function_call").item;
      assert.equal(call.name, "exec_command");
      assert.ok(JSON.parse(call.arguments).cmd.includes("hi"));
    },
    { script: (body) => ({ chunks: [chat.call(0, { id: "c", name: "exec_command", args: JSON.stringify({ cmd: "echo hi 😀" }) }), chat.finish("tool_calls"), "[DONE]"], split: 3 }) },
  );
});

test("a refusal never reaches the provider", async () => {
  await withGateway(async ({ post, mock, events }) => {
    const r = await post(req("x", { previous_response_id: "resp_1" }));
    assert.equal(r.status, 400);
    assert.equal(JSON.parse(r.text).error.param, "previous_response_id");
    assert.equal(mock.requests.length, 0);
    assert.equal(events[0].translate.kind, "invalidConfig");
  });
});

test("errors: a daily limit → 429 insufficient_quota; context too long → 200 SSE context_length_exceeded", async () => {
  await withGateway(
    async ({ post, events }) => {
      const q = await post(req("QUOTA"));
      assert.equal(q.status, 429);
      assert.equal(JSON.parse(q.text).error.code, "insufficient_quota");
      assert.equal(events[0].translate.kind, "quotaExhausted");
      assert.equal(events[0].error.class, "quota");
      const c = await post(req("CONTEXT"));
      assert.equal(c.status, 200);
      assert.equal(c.sse.at(-1).response.error.code, "context_length_exceeded");
    },
    {
      script: (body) =>
        JSON.stringify(body).includes("QUOTA")
          ? { status: 429, json: { error: { message: "Rate limit reached on tokens per day (TPD)" } } }
          : { status: 400, json: { error: { message: "Please reduce the length of the messages: maximum context length is 8192 tokens" } } },
    },
  );
});

test("a redirect is refused on the translated path too: its target receives nothing", async () => {
  let hits = 0;
  const target = createServer((q, s) => {
    hits++;
    s.end();
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  try {
    await withGateway(
      async ({ post }) => {
        const r = await post(req("PING"));
        assert.equal(r.status, 502);
        assert.equal(hits, 0);
      },
      { script: () => ({ status: 307, headers: { location: `http://127.0.0.1:${target.address().port}/steal` } }) },
    );
  } finally {
    target.close();
  }
});

test("AD_TRANSLATE=0: translated routes answer 502 with the reason, nothing upstream", async () => {
  await withGateway(
    async ({ post, mock }) => {
      const r = await post(req("PING"));
      assert.equal(r.status, 502);
      assert.match(r.text, /AD_TRANSLATE=0/);
      assert.equal(mock.requests.length, 0);
    },
    { opts: { translate: false } },
  );
});

test("the token is still checked first", async () => {
  await withGateway(async ({ post, mock }) => {
    const r = await post(req("PING"), { token: "wrong" });
    assert.equal(r.status, 401);
    assert.equal(mock.requests.length, 0);
  });
});

test("a provider that ignores stream: true and answers with one JSON completion still works", async () => {
  const s = createServer((q, res) => {
    q.resume();
    q.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "whole" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })));
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    await withGateway(
      async ({ post }) => {
        const r = await post(req("PING"));
        assert.equal(r.sse.at(-1).type, "response.completed");
        assert.equal(r.sse.find((e) => e.type === "response.output_item.done").item.content[0].text, "whole");
      },
      { route: { upstreamBase: `http://127.0.0.1:${s.address().port}/v1` } },
    );
  } finally {
    s.close();
  }
});

test("the gateway's reason: only this conversation's, only since its turn started", async () => {
  const { gatewayReason } = await import("../src/harness/gateway-runtime.mjs");
  const at = new Date().toISOString();
  const ev = { threadId: "thr-1", at, translate: { kind: "quotaExhausted", message: "Groq: the daily limit is used up." } };
  const source = { lastForThread: (id) => (id === "thr-1" ? ev : null) };
  const since = Date.parse(at) - 1000;
  assert.equal(gatewayReason({ threadId: "thr-1", sinceMs: since, source }), "Groq: the daily limit is used up.");
  assert.equal(gatewayReason({ threadId: "thr-1", sinceMs: Date.parse(at) + 1000, source }), null, "an older turn's");
  assert.equal(gatewayReason({ threadId: "thr-2", sinceMs: since, source }), null, "another conversation's");
  assert.equal(gatewayReason({ threadId: null, sinceMs: since, source }), null, "no thread: no guess");
  assert.equal(gatewayReason({ threadId: "thr-1", sinceMs: null, source }), null, "no start: no guess");
  assert.equal(gatewayReason({ threadId: "thr-1", sinceMs: since, source: { lastForThread: () => ({ ...ev, translate: { kind: "truncated", message: "x" } }) } }), null, "a truncation is the engine's to say");
});

test("the observation (with the engine's thread) is out before the engine reads the turn's end", async () => {
  await withGateway(
    async ({ events, port }) => {
      const r = await fetch(`http://127.0.0.1:${port}/p/${ENTRY}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(req("QUOTA", { client_metadata: { thread_id: "thr-9" } })) });
      const reader = r.body.getReader();
      let text = "";
      let seenAtEnd = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString();
        if (seenAtEnd === null && text.includes("response.failed")) seenAtEnd = events.length;
      }
      assert.equal(seenAtEnd, 1, "the event was there when the failure arrived");
      assert.equal(events[0].threadId, "thr-9");
      assert.equal(events[0].translate.kind, "quotaExhausted");
    },
    { script: () => ({ chunks: [chat.text("x"), { error: { message: "tokens per day (TPD) used up" } }] }) },
  );
});

test("a pretty-printed JSON answer (stream ignored) and a malformed one", async () => {
  const answer = (body) =>
    createServer((q, res) => {
      q.resume();
      q.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(body));
    });
  for (const [body, last] of [[JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "pretty" }, finish_reason: "stop" }] }, null, 2), "response.completed"], ["{not json", "response.failed"]]) {
    const s = answer(body);
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    try {
      await withGateway(
        async ({ post }) => {
          const r = await post(req("PING"));
          assert.equal(r.sse.at(-1).type, last);
        },
        { route: { upstreamBase: `http://127.0.0.1:${s.address().port}/v1` } },
      );
    } finally {
      s.close();
    }
  }
});

test("the seal key: kept when it exists; a store that throws leaves it off instead of replacing it", async () => {
  const { sealKeyFrom } = await import("../src/harness/gateway-runtime.mjs");
  const mem = new Map();
  const store = { get: (k) => mem.get(k) ?? null, set: (k, v) => mem.set(k, v) };
  const first = sealKeyFrom(store);
  assert.equal(Buffer.from(first, "base64").length, 32);
  assert.equal(sealKeyFrom(store), first, "the same key next run");
  assert.equal(sealKeyFrom({ get: () => { throw new Error("locked"); }, set: () => assert.fail("never written after a failed read") }), null);
  assert.equal(sealKeyFrom({ get: () => null, set: () => { throw new Error("read-only"); } }), null);
});

test("an engine started with the gateway token hides it from the commands it runs", async () => {
  const { startHarnessEngine } = await import("../src/harness/start.mjs");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const FAKE = { cmd: process.execPath, prefix: [fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url))] };
  const err = { write: () => true };
  for (const [env, hidden] of [[{ AD_GATEWAY_TOKEN: "tok" }, true], [{}, false]]) {
    const home = mkdtempSync(join(tmpdir(), "ad-tok-home-"));
    try {
      const { engine } = await startHarnessEngine({ home, command: FAKE, setup: false, err, gateway: { env, args: [] } });
      try {
        const { argv } = await engine.testRequest("debug/processCwd", {});
        assert.equal(argv.includes('shell_environment_policy.set.AD_GATEWAY_TOKEN=""'), hidden, JSON.stringify(argv));
      } finally {
        await engine?.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
});

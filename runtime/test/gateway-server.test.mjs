// P3.3: the provider gateway's loopback server (runs inside the gateway child; tested
// here in-process on the P3.1 mock providers). Token first, raw-path rules, the
// passthrough route, observation (exactly one event per request), the Retry-After cap,
// no redirects with a key, 502 for an unreachable upstream, caps, token-provider auth.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { createGatewayServer } from "../src/gateway/server.mjs";
import { startMockProvider } from "../testkit/mock-providers.mjs";
import { sse, ev } from "../testkit/mock-responses.mjs";

const KEY = ["sk", "test", "GGGGgggg5555GGGGgggg5555"].join("-");
const KEY2 = ["sk", "test", "HHHHhhhh6666HHHHhhhh6666"].join("-");
const TOKEN = "t".repeat(43);
const closers = [];
after(async () => {
  for (const c of closers.reverse()) await c();
});

async function gateway(routes, opts = {}) {
  const events = [];
  const keys = opts.keys ?? { "acct-a": KEY, "acct-b": KEY2 };
  const g = createGatewayServer({ token: TOKEN, table: routes, keys, onUpstream: (e) => events.push(e), ...opts });
  const port = await g.listen();
  closers.push(() => g.close());
  const base = `http://127.0.0.1:${port}`;
  const call = (p, { method = "POST", body = { model: "m", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "PING" }] }] }, token = TOKEN, headers = {}, signal } = {}) =>
    fetch(`${base}${p}`, { method, signal, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const raw = (rawPath, { method = "GET", token = TOKEN } = {}) =>
    new Promise((resolve, reject) => {
      const req = (require_http).request({ host: "127.0.0.1", port, path: rawPath, method, headers: { authorization: `Bearer ${token}` } }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode, body: b }));
      });
      req.on("error", reject);
      req.end();
    });
  return { g, base, call, raw, events, port };
}
const require_http = await import("node:http");
const route = (upstream, o = {}) => ({ accountId: "acct-a", upstreamBase: upstream.url, mode: "passthrough", auth: { kind: "static-key", scheme: "bearer" }, headers: {}, strip: [], label: "Mock", allowHttp: true, ...o });
const mock = async (o) => {
  const m = await startMockProvider({ keys: [KEY, KEY2], ...o });
  closers.push(() => m.close());
  return m;
};

test("routes /p/<entry>/v1/responses to that account's upstream with its key; the upstream never sees the token", async () => {
  const up = await mock();
  const { call, events } = await gateway(new Map([["ad-mock-aaaa", route(up)]]));
  const r = await call("/p/ad-mock-aaaa/v1/responses");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /pong/);
  assert.equal(up.requests.at(-1).auth.matchesKey, 0);
  assert.ok(!JSON.stringify(up.requests).includes(TOKEN));
  assert.equal(events.length, 1);
});

test("a wrong, missing or wrong-length token → 401 before anything else; an unknown entry without the token is 401, not 404", async () => {
  const up = await mock();
  const { call } = await gateway(new Map([["ad-mock-aaaa", route(up)]]));
  for (const token of ["x".repeat(43), null, "short"]) {
    const r = await call("/p/ad-mock-aaaa/v1/responses", { token });
    assert.equal(r.status, 401);
    assert.equal(await r.text(), "");
  }
  assert.equal((await call("/p/no-such-entry/v1/responses", { token: null })).status, 401);
  assert.equal(up.requests.length, 0);
});

test("dot segments, %2e, %2f, %5c, backslashes and empty segments → 400; a query string only on GET models; paths outside the allowlist → 403", async () => {
  const up = await mock();
  const { raw, call } = await gateway(new Map([["ad-mock-aaaa", route(up)]]));
  for (const p of ["/p/ad-mock-aaaa/v1/../models", "/p/ad-mock-aaaa/v1/%2e%2e/models", "/p/ad-mock-aaaa/v1/a%2fmodels", "/p/ad-mock-aaaa/v1/a%5cmodels", "/p/ad-mock-aaaa/v1/a\\models", "/p/ad-mock-aaaa/v1//models", "/p/ad-mock-aaaa/v1/./models", "/p/ad-mock-aaaa/v1/responses?x=1"]) {
    const r = await raw(p, { method: p.includes("responses") ? "POST" : "GET" });
    assert.equal(r.status, 400, p);
  }
  assert.equal((await raw("/p/ad-mock-aaaa/v1/models?limit=5")).status, 200);
  assert.equal((await call("/p/ad-mock-aaaa/v1/files")).status, 403);
  assert.equal((await call("/p/ad-mock-aaaa/v1/models", { method: "DELETE", body: "" })).status, 403);
  assert.equal((await call("/p/ad-mock-aaaa/v1/responses/compact")).status, 403, "the engine never called it (S-GATEWAY G4)");
});

test("unknown entry with the right token → 404 with ad's text; an unknown mode is refused, never passed through", async () => {
  const up = await mock();
  const { call } = await gateway(new Map([["ad-mock-aaaa", route(up)], ["ad-mock-bbbb", route(up, { mode: "anthropic" })]]));
  const r = await call("/p/ad-mock-zzzz/v1/responses");
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error.message, "ad: this account isn't available any more");
  const m = await call("/p/ad-mock-bbbb/v1/responses");
  assert.equal(m.status, 502);
  assert.match((await m.json()).error.message, /^ad: /);
  assert.equal(up.requests.length, 0);
});

test("a gzip-compressing upstream: /models and a 429 JSON body reach the client complete, without content-encoding", async () => {
  const gz = createServer((req, res) => {
    const send = (status, body) => res.writeHead(status, { "content-type": "application/json", "content-encoding": "gzip" }).end(gzipSync(Buffer.from(body)));
    if (req.url.endsWith("/models")) return send(200, JSON.stringify({ data: [{ id: "gz-model" }] }));
    send(429, JSON.stringify({ error: { code: "rate_limit_exceeded", message: "gz quota" } }));
  });
  await new Promise((r) => gz.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise((r) => gz.close(r)));
  const { call } = await gateway(new Map([["ad-gz-aaaa", route({ url: `http://127.0.0.1:${gz.address().port}/v1` })]]));
  const m = await call("/p/ad-gz-aaaa/v1/models", { method: "GET" });
  assert.equal(m.headers.get("content-encoding"), null);
  assert.equal((await m.json()).data[0].id, "gz-model");
  const q = await call("/p/ad-gz-aaaa/v1/responses");
  assert.equal(q.status, 429);
  assert.equal((await q.json()).error.message, "gz quota");
});

test("an upstream Retry-After of 3600 → an immediate 429 with retry-after: 0 and ad's message; the event keeps 3600", async () => {
  const up = await mock({ personality: "openrouter" });
  up.setQuota({ type: "free-limit", retryAfter: 3600 });
  const { call, events } = await gateway(new Map([["ad-or-aaaa", route(up, { label: "OpenRouter" })]]));
  const t0 = Date.now();
  const r = await call("/p/ad-or-aaaa/v1/responses");
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(r.status, 429);
  assert.equal(r.headers.get("retry-after"), "0");
  const body = await r.json();
  assert.equal(body.error.code, "insufficient_quota");
  assert.match(body.error.message, /^OpenRouter asks to wait 60 min \(until \d\d:\d\d\)\.$/);
  const e = events.at(-1);
  assert.deepEqual([e.status, e.retryAfterS, e.error.class], [429, 3600, "quota"]);
  // Under the cap, the provider's own answer passes through.
  up.setQuota({ type: "rate_limit_exceeded", retryAfter: 7 });
  const r2 = await call("/p/ad-or-aaaa/v1/responses");
  assert.equal(r2.headers.get("retry-after"), "7");
  assert.match((await r2.json()).error.message, /Rate limit/);
});

test("a redirect is never followed with the key", async () => {
  let followed = false;
  const target = createServer((req, res) => {
    followed = true;
    res.end("{}");
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  const redirector = createServer((req, res) => res.writeHead(307, { location: `http://127.0.0.1:${target.address().port}/v1/responses` }).end());
  await new Promise((r) => redirector.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise((r) => target.close(r)), () => new Promise((r) => redirector.close(r)));
  const { call } = await gateway(new Map([["ad-redir-aaaa", route({ url: `http://127.0.0.1:${redirector.address().port}/v1` })]]));
  const r = await call("/p/ad-redir-aaaa/v1/responses");
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error.message, "ad: the provider redirected; ad doesn't send keys across redirects");
  assert.equal(followed, false);
});

test("upstream down → 502 JSON at once; body cap → 413; in-flight cap → 503; plain http refused unless allowed", async () => {
  const dead = createServer();
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const port = dead.address().port;
  await new Promise((r) => dead.close(r));
  const up = await mock();
  const { call } = await gateway(new Map([["ad-dead-aaaa", route({ url: `http://127.0.0.1:${port}/v1` })], ["ad-mock-aaaa", route(up)], ["ad-plain-aaaa", route(up, { allowHttp: false })]]), { maxBodyBytes: 1024, maxInFlight: 1 });
  const d = await call("/p/ad-dead-aaaa/v1/responses");
  assert.equal(d.status, 502);
  assert.match((await d.json()).error.message, /^ad: couldn't reach 127\.0\.0\.1/);
  assert.equal((await call("/p/ad-mock-aaaa/v1/responses", { body: { input: "x".repeat(4000) } })).status, 413);
  const p = await call("/p/ad-plain-aaaa/v1/responses");
  assert.equal(p.status, 502);
  assert.match((await p.json()).error.message, /https/);
  // One request held open: the next one is refused.
  const held = call("/p/ad-mock-aaaa/v1/responses", { body: { model: "m", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "HOLD" }] }] } });
  await up.held();
  const busy = await call("/p/ad-mock-aaaa/v1/responses");
  assert.equal(busy.status, 503);
  up.release();
  await (await held).text();
});

test("client abort aborts upstream; the event says aborted; SSE streamed byte for byte", async () => {
  const up = await mock();
  const { call, events } = await gateway(new Map([["ad-mock-aaaa", route(up)]]));
  const direct = await (await fetch(`${up.url}/responses`, { method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: JSON.stringify({ model: "m", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "PING" }] }] }) })).text();
  const via = await (await call("/p/ad-mock-aaaa/v1/responses")).text();
  assert.equal(via, direct);
  const ac = new AbortController();
  const p = call("/p/ad-mock-aaaa/v1/responses", { signal: ac.signal, body: { model: "m", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "HOLD" }] }] } }).then((r) => r.body.getReader().read()).catch(() => null);
  await up.held();
  ac.abort();
  await p;
  for (let i = 0; i < 100 && up.hangups < 1; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(up.hangups, 1);
  for (let i = 0; i < 100 && !events.some((e) => e.aborted); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(events.some((e) => e.aborted === true));
});

test("every request yields exactly one onUpstream event with its requestId; usage and classified errors are in it; no text, key or token", async () => {
  const up = await mock({ personality: "openrouter" });
  const { call, events } = await gateway(new Map([["ad-or-aaaa", route(up)]]));
  await (await call("/p/ad-or-aaaa/v1/responses")).text();
  up.setQuota({ type: "rate_limit_exceeded", retryAfter: 5 });
  await (await call("/p/ad-or-aaaa/v1/responses")).text();
  up.setQuota(null);
  up.setFault({ type: "5xx", status: 503, times: 1 });
  await (await call("/p/ad-or-aaaa/v1/responses")).text();
  await (await call("/p/ad-or-aaaa/v1/models", { method: "GET" })).text();
  assert.equal(events.length, 4);
  assert.equal(new Set(events.map((e) => e.requestId)).size, 4);
  assert.deepEqual(events[0].usage, { input_tokens: 10, input_tokens_details: null, output_tokens: 5, output_tokens_details: null, total_tokens: 15 });
  assert.deepEqual([events[1].status, events[1].retryAfterS, events[1].error.class], [429, 5, "rate-limit"]);
  assert.deepEqual([events[2].status, events[2].error.class], [503, "server"]);
  const text = JSON.stringify(events);
  for (const s of [KEY, KEY2, TOKEN, "PING"]) assert.ok(!text.includes(s), s.slice(0, 6));
});

test("keys come from the table's accounts; an account that leaves the table loses its route and key", async () => {
  const up = await mock();
  const { g, call } = await gateway(new Map([["ad-mock-aaaa", route(up)], ["ad-mock-bbbb", route(up, { accountId: "acct-b" })]]));
  await (await call("/p/ad-mock-bbbb/v1/responses")).text();
  assert.equal(up.requests.at(-1).auth.matchesKey, 1, "account b's own key");
  g.setTable(new Map([["ad-mock-aaaa", route(up)]]), { "acct-a": KEY });
  assert.equal((await call("/p/ad-mock-bbbb/v1/responses")).status, 404);
  assert.equal(g.keyCount(), 1);
});

test("token-provider auth: a token near expiry is refreshed first; a 401 triggers one refresh and one retry, then the 401 passes through", async () => {
  const up = await mock({ keys: ["tok-1", "tok-2", "tok-3"] });
  let issued = 0;
  let calls = 0;
  const provider = {
    async getToken({ force = false } = {}) {
      calls++;
      if (force || issued === 0) issued++;
      return { token: `tok-${issued}`, expiresAt: Date.now() + (issued === 1 ? 10_000 : 3_600_000) };
    },
  };
  const { call } = await gateway(new Map([["ad-tp-aaaa", route(up, { auth: { kind: "token-provider", provider } })]]), { keys: {} });
  // tok-1 expires in 10 s (under the refresh margin): refreshed before the request.
  await (await call("/p/ad-tp-aaaa/v1/responses")).text();
  assert.equal(up.requests.at(-1).auth.matchesKey, 1, "tok-2 used");
  // The upstream stops accepting: one refresh, one retry, then the 401 passes through.
  const before = up.requests.length;
  const reject = await mock({ keys: [] });
  const { call: call2 } = await gateway(new Map([["ad-tp-bbbb", route(reject, { auth: { kind: "token-provider", provider } })]]), { keys: {} });
  const r = await call2("/p/ad-tp-bbbb/v1/responses");
  assert.equal(r.status, 401);
  assert.equal(reject.requests.length, 2, "exactly one retry");
  void before;
  void calls;
});

test("the strip list removes only the listed fields", async () => {
  const up = await mock();
  const seen = [];
  up.setScript((body) => {
    seen.push(Object.keys(body).sort());
    return [ev.created(), ev.message("ok"), ev.completed()];
  });
  const { call } = await gateway(new Map([["ad-mock-aaaa", route(up, { strip: ["store", "metadata"] })]]));
  await (await call("/p/ad-mock-aaaa/v1/responses", { body: { model: "m", store: false, metadata: { a: 1 }, stream: true, input: [] } })).text();
  assert.deepEqual(seen[0], ["input", "model", "stream"]);
  void sse;
});

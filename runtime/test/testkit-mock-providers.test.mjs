// P3.1: the mock provider kit every M3 test uses. It records what a request carried
// (never the key itself), answers like OpenAI, OpenRouter or a generic provider, and
// can fail on purpose (wrong key, quota, 5xx, Retry-After, a cut stream, a slow one).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { startMockProvider } from "../testkit/mock-providers.mjs";
import { startMockResponses, ev } from "../testkit/mock-responses.mjs";

const KEY = ["sk", "test", "a1B2c3D4e5F6g7H8i9J0k1L2"].join("-");
const OTHER = ["sk", "test", "z9Y8x7W6v5U4t3S2r1Q0p9O8"].join("-");
const opened = [];
after(async () => {
  for (const m of opened) await m.close();
});
const start = async (o) => {
  const m = await startMockProvider(o);
  opened.push(m);
  return m;
};
const post = (url, body, { key = KEY, headers = {} } = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers }, body: JSON.stringify(body) });
const userTurn = (text) => ({ model: "m1", stream: true, store: false, input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }] });

test("captures the bearer as a match index and a short hash, never the value", async () => {
  const m = await start({ keys: [OTHER, KEY] });
  const r = await post(`${m.url}/responses`, userTurn("PING"), { headers: { "x-client": "ad", originator: "agent_daemon" } });
  assert.equal(r.status, 200);
  await r.text();
  const rec = m.requests.at(-1);
  assert.deepEqual(rec.auth, { scheme: "Bearer", matchesKey: 1, sha256: createHash("sha256").update(KEY).digest("hex").slice(0, 12) });
  assert.equal(rec.headers.authorization, undefined);
  assert.equal(rec.headers["x-client"], "ad");
  assert.equal(rec.headers.originator, "agent_daemon");
  assert.ok(!JSON.stringify(m.requests).includes(KEY), "the key never appears in what the kit keeps");
  assert.deepEqual([rec.model, rec.stream, rec.store, rec.text], ["m1", true, false, "PING"]);
});

test("a wrong key gets the personality's 401", async () => {
  const openai = await start({ personality: "openai", keys: [KEY] });
  const r1 = await post(`${openai.url}/responses`, userTurn("x"), { key: OTHER });
  assert.equal(r1.status, 401);
  assert.equal((await r1.json()).error.code, "invalid_api_key");
  assert.equal(openai.requests.at(-1).auth.matchesKey, -1);
  const router = await start({ personality: "openrouter", keys: [KEY] });
  const r2 = await post(`${router.url}/responses`, userTurn("x"), { key: null });
  assert.equal(r2.status, 401);
  assert.match((await r2.json()).error.message, /No auth credentials found/);
});

test("/models lists the configured models with pricing; /api/v1/key reports the free counter", async () => {
  const m = await start({ personality: "openrouter", keys: [KEY], models: [{ id: "vendor/big" }, { id: "vendor/small:free", free: true }] });
  const models = await (await fetch(`${m.url}/models`, { headers: { authorization: `Bearer ${KEY}` } })).json();
  assert.deepEqual(models.data.map((x) => [x.id, x.pricing.prompt]), [["vendor/big", "0.000001"], ["vendor/small:free", "0"]]);
  await (await post(`${m.url}/responses`, { ...userTurn("PING"), model: "vendor/small:free" })).text();
  const key = await (await fetch(`${m.origin}/api/v1/key`, { headers: { authorization: `Bearer ${KEY}` } })).json();
  assert.equal(key.data.is_free_tier, true);
  assert.equal(key.data.free_requests_today, 1);
  const openai = await start({ personality: "openai", keys: [KEY], models: [{ id: "gpt-mock" }] });
  const om = await (await fetch(`${openai.url}/models`, { headers: { authorization: `Bearer ${KEY}` } })).json();
  assert.deepEqual([om.object, om.data[0].id], ["list", "gpt-mock"]);
});

test("429 bodies differ by type and carry Retry-After", async () => {
  const m = await start({ personality: "openai", keys: [KEY] });
  m.setQuota({ type: "insufficient_quota" });
  const a = await post(`${m.url}/responses`, userTurn("x"));
  assert.equal(a.status, 429);
  assert.equal((await a.json()).error.code, "insufficient_quota");
  m.setQuota({ type: "rate_limit_exceeded", retryAfter: 7 });
  const b = await post(`${m.url}/responses`, userTurn("x"));
  assert.equal(b.headers.get("retry-after"), "7");
  assert.equal((await b.json()).error.code, "rate_limit_exceeded");
  const or = await start({ personality: "openrouter", keys: [KEY] });
  or.setQuota({ type: "free-limit", retryAfter: 60 });
  const c = await post(`${or.url}/responses`, userTurn("x"));
  assert.equal(c.status, 429);
  assert.match((await c.json()).error.message, /free-models-per-day/);
  m.setQuota(null);
  assert.equal((await post(`${m.url}/responses`, userTurn("PING"))).status, 200);
});

test("faults: 5xx with Retry-After, a stream cut after the first delta, a slow stream, a reset", async () => {
  const m = await start({ keys: [KEY] });
  m.setFault({ type: "5xx", status: 503, retryAfter: 2, times: 1 });
  const a = await post(`${m.url}/responses`, userTurn("PING"));
  assert.deepEqual([a.status, a.headers.get("retry-after")], [503, "2"]);
  assert.equal((await post(`${m.url}/responses`, userTurn("PING"))).status, 200, "times: 1");
  m.setFault({ type: "midText" });
  const cut = await post(`${m.url}/responses`, userTurn("PING"));
  // Read what arrived before the cut (text() would only report the error).
  let got = "";
  const reader = cut.body.getReader();
  for (;;) {
    const r = await reader.read().catch(() => ({ done: true, failed: true }));
    if (r.value) got += Buffer.from(r.value).toString("utf8");
    if (r.done) break;
  }
  assert.match(got, /response\.output_text\.delta/);
  assert.doesNotMatch(got, /response\.completed/);
  m.setFault({ type: "slow", delayMs: 40 });
  const t0 = Date.now();
  await (await post(`${m.url}/responses`, userTurn("PING"))).text();
  assert.ok(Date.now() - t0 >= 150, "events spaced out");
  m.setFault({ type: "reset" });
  await assert.rejects(post(`${m.url}/responses`, userTurn("PING")));
  m.setFault(null);
});

test("functionOutputs exposes what a tool printed; tool types and previousResponseId are kept", async () => {
  const m = await start({ keys: [KEY] });
  const body = {
    model: "m1",
    previous_response_id: "resp-0",
    tools: [{ type: "function", name: "exec_command" }, { type: "web_search" }],
    input: [{ type: "function_call", call_id: "c1", name: "exec_command", arguments: "{}" }, { type: "function_call_output", call_id: "c1", output: "hello from the tool" }],
  };
  await (await post(`${m.url}/responses`, body)).text();
  const rec = m.requests.at(-1);
  assert.deepEqual(rec.functionOutputs, [{ callId: "c1", output: "hello from the tool" }]);
  assert.deepEqual(rec.toolTypes, ["function", "web_search"]);
  assert.equal(rec.previousResponseId, "resp-0");
});

test("hold and release work as in startMockResponses; a hang-up is counted", async () => {
  const m = await start({ keys: [KEY] });
  const ac = new AbortController();
  const p = post(`${m.url}/responses`, userTurn("HOLD")).catch(() => null);
  await m.held();
  assert.equal(m.release(), true);
  const r = await p;
  assert.match(await r.text(), /waiting, released/);
  const p2 = fetch(`${m.url}/responses`, { method: "POST", signal: ac.signal, headers: { authorization: `Bearer ${KEY}` }, body: JSON.stringify(userTurn("HOLD")) }).then((x) => x.body.getReader().read()).catch(() => null);
  await m.held();
  ac.abort();
  await p2;
  for (let i = 0; i < 50 && m.hangups < 1; i++) await new Promise((res) => setTimeout(res, 20));
  assert.equal(m.hangups, 1);
});

test("startMockResponses keeps its record shape", async () => {
  const m = await startMockResponses({ script: () => [ev.created(), ev.message("ok"), ev.completed()] });
  opened.push(m);
  await (await fetch(`${m.url}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(userTurn("hi")) })).text();
  assert.deepEqual(Object.keys(m.requests[0]).sort(), ["developerTexts", "mode", "model", "path", "text", "tools", "userTexts"]);
});

// Adding accounts (P3.5): API keys, your own endpoint, local servers. Mock providers on
// loopback, a throwaway account root and file secret store (never the user's own).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-signin-"));
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

const { createAccountService } = await import("../src/auth/accounts/service.mjs");
const { readRegistry } = await import("../src/auth/accounts/registry.mjs");
const { createSecretStore, fileBackend } = await import("../src/auth/secrets.mjs");
const { normalizeBaseUrl, refuseKeyArgs, signInApiKey, signInCustom, signInLocal, SIGNIN_TEXTS, testKey } = await import("../src/auth/accounts/signin.mjs");
const { presetFor } = await import("../src/providers/registry.mjs");
const { startMockProvider } = await import("../testkit/mock-providers.mjs");

const K1 = ["sk", "or", "v1", "1111aaaa1111aaaa1111"].join("-");
const K2 = ["sk", "or", "v1", "2222bbbb2222bbbb2222"].join("-");
const XK = ["xai", "3333cccc3333cccc3333cccc"].join("-");
fs.mkdirSync(path.join(process.env.AD_ROOT, "secrets"), { recursive: true });
const store = createSecretStore(fileBackend(path.join(process.env.AD_ROOT, "secrets")));
const service = createAccountService({ store });
const accounts = () => readRegistry().accounts;

// A fetch that sends preset URLs to the mock (the mock stands in for the provider's host).
const routed = (mock, from) => (url, init) => globalThis.fetch(String(url).replace(from, mock.url), init);

test("two OpenRouter keys stay side by side: adding the second never touches the first", async () => {
  const mock = await startMockProvider({ personality: "openrouter", keys: [K1, K2] });
  try {
    const fetch = routed(mock, "https://openrouter.ai/api/v1");
    const a = await signInApiKey({ service, provider: "openrouter", readKey: async () => K1, fetch, clientVersion: "3.1.0" });
    assert.equal(a.label, "default", "the first gets the label default");
    assert.equal(a.status, "ready");
    assert.equal(a.keyHint, "1111");
    const before = structuredClone(accounts().find((x) => x.id === a.id));
    const b = await signInApiKey({ service, provider: "openrouter", label: "work", readKey: async () => K2, fetch });
    assert.equal(b.status, "ready");
    assert.deepEqual(accounts().find((x) => x.id === a.id), before);
    assert.equal(store.get(a.credential.ref), K1);
    assert.equal(store.get(b.credential.ref), K2);
    // A third without a label: asked to name it.
    await assert.rejects(signInApiKey({ service, provider: "openrouter", readKey: async () => K2, fetch }), { code: "LABEL_NEEDED" });
    // OpenRouter's key is tested on its own endpoint, with ad's user agent.
    assert.ok(mock.requests.some((r) => r.path === "/api/v1/key" && r.headers["user-agent"] === "ad/3.1.0"));
  } finally {
    await mock.close();
  }
});

test("a refused key isn't saved and says how to add it again; an unreachable provider keeps the key as error", async () => {
  const mock = await startMockProvider({ personality: "generic", keys: [XK] });
  try {
    const fetch = routed(mock, "https://api.x.ai/v1");
    const n = accounts().length;
    await assert.rejects(signInApiKey({ service, provider: "xai", label: "bad", readKey: async () => ["xai", "wrongwrongwrongwrongwrong"].join("-"), fetch }), (e) => e.code === "KEY_REFUSED" && e.message === SIGNIN_TEXTS.KEY_REFUSED(401, "xai", "bad"));
    assert.equal(accounts().length, n, "nothing left behind");
    assert.equal(store.list().filter((r) => !accounts().some((a) => a.credential?.ref === r)).length, 0, "no orphan secret");
    const down = (url, init) => globalThis.fetch(String(url).replace("https://api.x.ai/v1", "http://127.0.0.1:1/v1"), init);
    const a = await signInApiKey({ service, provider: "xai", label: "later", readKey: async () => XK, fetch: down });
    assert.equal(a.status, "error");
    assert.match(a.statusDetail, /^Couldn't reach api\.x\.ai \(.+\)\. The key is saved; test it later: ad auth test xai\/later$/);
    assert.equal(store.get(a.credential.ref), XK);
  } finally {
    await mock.close();
  }
});

test("--key and key-shaped positionals are refused, never echoed", () => {
  for (const args of [{ values: { key: true }, positionals: ["openrouter"] }, { values: { "api-key": true } }, { values: {}, positionals: ["openrouter", K1] }, { values: {}, positionals: ["xai", XK] }, { values: {}, positionals: ["x", "A".repeat(40)] }]) {
    assert.throws(() => refuseKeyArgs(args, "openrouter"), (e) => e.code === "KEY_ON_COMMAND_LINE" && !e.message.includes(K1) && !e.message.includes(XK) && /--stdin/.test(e.message));
  }
  refuseKeyArgs({ values: { label: "work" }, positionals: ["openrouter"] });
});

test("key tests never follow a redirect with the key, and send keys only over https or loopback", async () => {
  let hits = 0;
  const srv = createServer((req, res) => {
    hits++;
    res.writeHead(302, { location: "https://elsewhere.example/v1/models" }).end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const endpoint = `http://127.0.0.1:${srv.address().port}/v1`;
    await assert.rejects(testKey(presetFor("custom"), { key: K1, endpoint }), { code: "PROVIDER_REDIRECT", message: "The server redirected; ad doesn't send keys across redirects." });
    assert.equal(hits, 1, "one request, the redirect not followed");
    await assert.rejects(testKey(presetFor("custom"), { key: K1, endpoint: "http://llm.example.com/v1" }), { code: "INSECURE_URL" });
  } finally {
    srv.close();
  }
});

test("custom: http off this machine needs --insecure; userinfo, fragments and keys in the query are refused", () => {
  assert.throws(() => normalizeBaseUrl("http://llm.example.com/v1"), { code: "INSECURE_URL" });
  assert.equal(normalizeBaseUrl("http://llm.example.com/v1/", { insecure: true }), "http://llm.example.com/v1");
  assert.equal(normalizeBaseUrl("http://[::1]:8080/v1"), "http://[::1]:8080/v1");
  assert.throws(() => normalizeBaseUrl("https://me:pw@llm.example.com/v1"), { code: "BAD_URL" });
  assert.throws(() => normalizeBaseUrl("https://llm.example.com/v1#x"), { code: "BAD_URL" });
  assert.throws(() => normalizeBaseUrl("https://llm.example.com/v1?api_key=abc"), { code: "BAD_URL" });
  assert.throws(() => normalizeBaseUrl("ftp://llm.example.com/v1"), { code: "BAD_URL" });
});

test("custom: a Responses endpoint becomes a ready account (asked before the one-token test); a chat-only one gets the bridge text", async () => {
  const mock = await startMockProvider({ personality: "generic", keys: [K1], models: [{ id: "local-model" }] });
  try {
    let asked = 0;
    const a = await signInCustom({ service, baseUrl: mock.url, label: "lab", readKey: async () => K1, confirmProbe: async () => (asked++, true) });
    assert.equal(asked, 1);
    assert.equal(a.status, "ready");
    assert.equal(a.endpoint, mock.url);
    assert.ok(mock.requests.some((r) => r.path === "/v1/responses"), "the ping went out");
  } finally {
    await mock.close();
  }
  const chat = createServer((req, res) => {
    if (req.url === "/v1/models") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "m" }] }));
    res.writeHead(404).end();
  });
  await new Promise((r) => chat.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(signInCustom({ service, baseUrl: `http://127.0.0.1:${chat.address().port}/v1`, label: "chatonly", noKey: true, confirmProbe: async () => true }), (e) => e.code === "CHAT_ONLY" && e.message === SIGNIN_TEXTS.CHAT_ONLY);
    assert.ok(!accounts().some((x) => x.label === "chatonly"));
    // Declining the test skips the ping.
    const b = await signInCustom({ service, baseUrl: `http://127.0.0.1:${chat.address().port}/v1`, label: "untested", noKey: true, confirmProbe: async () => false });
    assert.equal(b.method, "none");
    assert.deepEqual(b.credential, { kind: "none" });
    await assert.rejects(signInCustom({ service, baseUrl: "https://llm.example.com/v1", label: "remote-nokey", noKey: true }), { code: "NO_KEY_REMOTE" });
  } finally {
    chat.close();
  }
});

test("local: no key; a server that isn't answering says how to start it", async () => {
  // An Ollama-shaped server: /models for anyone, no key.
  const seen = [];
  const srv = createServer((req, res) => {
    seen.push(req.headers.authorization ?? null);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "llama3" }] }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const fetch = (url, init) => globalThis.fetch(String(url).replace("http://localhost:11434", `http://127.0.0.1:${srv.address().port}`), init);
    const a = await signInLocal({ service, provider: "ollama", fetch });
    assert.equal(a.status, "ready");
    assert.equal(a.method, "none");
    assert.deepEqual(seen, [null], "no key sent");
  } finally {
    srv.close();
  }
  const down = (url, init) => globalThis.fetch(String(url).replace("http://localhost:1234/v1", "http://127.0.0.1:1/v1"), init);
  await assert.rejects(signInLocal({ service, provider: "lmstudio", fetch: down }), (e) => e.code === "LOCAL_DOWN" && e.message === "LM Studio isn't answering on localhost:1234. Start it (lms server start) and try again.");
});

test("review: key flags in any case, a key in the provider's place, and lookalike loopback hosts", async () => {
  for (const values of [{ token: "x" }, { Key: "x" }, { secret: true }, { "access-token": "x" }]) assert.throws(() => refuseKeyArgs({ values, positionals: ["openrouter"] }), { code: "KEY_ON_COMMAND_LINE" });
  assert.throws(() => refuseKeyArgs({ values: {}, positionals: ["Z".repeat(36)] }), (e) => e.code === "KEY_ON_COMMAND_LINE" && !e.message.includes("Z".repeat(36)));
  // Hosts that only look like this machine get no key over http.
  for (const endpoint of ["http://localhost.evil.example/v1", "http://127.0.0.1.nip.io/v1", "http://[::ffff:127.0.0.1]/v1"]) {
    await assert.rejects(testKey(presetFor("custom"), { key: K1, endpoint }), { code: "INSECURE_URL" }, endpoint);
  }
});

test("review: a key with spaces or control characters is refused before any request; errors never quote it", async () => {
  let requests = 0;
  const fetch = async () => (requests++, new Response("{}", { status: 200 }));
  for (const bad of ["sk-or-v1-has space", `sk-or-v1-ctrl${String.fromCharCode(0)}x`, "sk-or-v1-é"]) {
    await assert.rejects(signInApiKey({ service, provider: "openrouter", label: `bad${requests}`, readKey: async () => bad, fetch }), (e) => e.code === "KEY_TEXT" && !e.message.includes(bad));
  }
  assert.equal(requests, 0);
  // A network failure's runtime message (which can quote the header) is never used.
  const leaky = async () => {
    throw Object.assign(new Error(`Headers.append: "Bearer ${K1}" is an invalid header value.`), {});
  };
  const v = await testKey(presetFor("xai"), { key: K1, fetch: leaky });
  assert.equal(v.status, "unreachable");
  assert.ok(!v.detail.includes(K1));
  assert.match(v.detail, /\(network error\)/);
});

test("review: the timeout covers a server that sends headers and then stalls", async () => {
  const srv = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{");
    // never ends
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const { providerRequest } = await import("../src/providers/http.mjs");
    const t0 = Date.now();
    await assert.rejects(providerRequest({ url: `http://127.0.0.1:${srv.address().port}/v1/models`, timeoutMs: 300 }), (e) => e.code === "PROVIDER_UNREACHABLE" && /timed out/.test(e.message));
    assert.ok(Date.now() - t0 < 5000);
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
});

test("review: a custom address with a query is refused; without a test, a model list that isn't 200 isn't ready; both 404 is a wrong address", async () => {
  assert.throws(() => normalizeBaseUrl("https://llm.example.com/v1?api-version=2"), { code: "BAD_URL" });
  assert.throws(() => normalizeBaseUrl("https://llm.example.com/v1?"), { code: "BAD_URL" }, "a bare ?");
  const srv = createServer((req, res) => res.writeHead(404).end());
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const baseUrl = `http://127.0.0.1:${srv.address().port}/v1`;
    await assert.rejects(signInCustom({ service, baseUrl, label: "typo1", noKey: true, confirmProbe: async () => false }), (e) => e.code === "WRONG_ADDRESS" && /check the address/i.test(e.message));
    await assert.rejects(signInCustom({ service, baseUrl, label: "typo2", noKey: true, confirmProbe: async () => true }), (e) => e.code === "WRONG_ADDRESS" && /model list and to a Responses request/.test(e.message));
    assert.ok(!accounts().some((a) => /^typo/.test(a.label)));
  } finally {
    srv.close();
  }
});

test("review: the key is asked for only after the label and address pass", async () => {
  await assert.rejects(signInCustom({ service, baseUrl: "http://llm.example.com/v1", label: "x", readKey: async () => assert.fail("asked too early") }), { code: "INSECURE_URL" });
  await assert.rejects(signInApiKey({ service, provider: "openrouter", label: "work", readKey: async () => assert.fail("asked too early") }), { code: "LABEL_TAKEN" });
});

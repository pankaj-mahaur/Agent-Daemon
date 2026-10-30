// OpenRouter's PKCE sign-in (P3.5b), against a fake OpenRouter: the "browser" follows
// the callback URL ad prints; the exchange endpoint checks the S256 pair. A throwaway
// account root and file store.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-or-oauth-"));
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
const { signInOpenRouter, OAUTH_TEXTS } = await import("../src/auth/accounts/openrouter-oauth.mjs");
const { startMockProvider } = await import("../testkit/mock-providers.mjs");

fs.mkdirSync(path.join(process.env.AD_ROOT, "secrets"), { recursive: true });
const store = createSecretStore(fileBackend(path.join(process.env.AD_ROOT, "secrets")));
const service = createAccountService({ store });
const KEY = ["sk", "or", "v1", "oooo0000oooo0000oooo"].join("-");
const CODE = "code-" + "c".repeat(24);

// A fake OpenRouter: /api/v1/auth/keys checks the verifier against the challenge the browser saw.
async function fakeOpenRouter() {
  const state = { exchanges: [], challenge: null };
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/v1/auth/keys") {
        const body = JSON.parse(raw || "{}");
        state.exchanges.push(body);
        const ok = body.code === CODE && body.code_challenge_method === "S256" && createHash("sha256").update(body.code_verifier).digest("base64url") === state.challenge;
        return void res.writeHead(ok ? 200 : 403, { "content-type": "application/json" }).end(JSON.stringify(ok ? { key: KEY } : { error: "bad" }));
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { state, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}
const sink = () => ({ text: "", write(s) { this.text += s; return true; } });

test("S256 matches the verifier; one exchange; the account is an OpenRouter key; the code never reaches output", async () => {
  const fake = await fakeOpenRouter();
  const keys = await startMockProvider({ personality: "openrouter", keys: [KEY] });
  try {
    const out = sink();
    let opened = null;
    const browser = async (url) => {
      opened = url;
      const u = new URL(url);
      fake.state.challenge = u.searchParams.get("code_challenge");
      assert.equal(u.searchParams.get("code_challenge_method"), "S256");
      assert.match(fake.state.challenge, /^[A-Za-z0-9_-]{43}$/);
      const cb = new URL(u.searchParams.get("callback_url"));
      assert.equal(cb.hostname, "localhost");
      const page = await fetch(cb.href.replace("localhost", "127.0.0.1") + `?code=${CODE}`);
      assert.match(await page.text(), /Signed in to OpenRouter/);
    };
    const fetchRouted = (url, init) => globalThis.fetch(String(url).replace("https://openrouter.ai/api/v1", keys.url), init);
    const a = await signInOpenRouter({ service, openBrowser: browser, out, fetch: fetchRouted, authBase: "https://openrouter.ai", exchangeUrl: `${fake.url}/api/v1/auth/keys` });
    assert.ok(opened.startsWith("https://openrouter.ai/auth?callback_url="));
    assert.ok(out.text.includes(opened), "the URL is always printed");
    assert.equal(fake.state.exchanges.length, 1);
    assert.equal(a.method, "openrouter-oauth");
    assert.equal(a.status, "ready");
    assert.equal(store.get(a.credential.ref), KEY);
    assert.ok(!out.text.includes(CODE) && !out.text.includes(KEY));
  } finally {
    await fake.close();
    await keys.close();
  }
});

test("a wrong nonce path gets 404 and doesn't finish; cancelling closes the server and saves nothing", async () => {
  const fake = await fakeOpenRouter();
  try {
    const ac = new AbortController();
    let cbPort = null;
    const browser = async (url) => {
      const cb = new URL(new URL(url).searchParams.get("callback_url"));
      cbPort = cb.port;
      const wrong = await fetch(`http://127.0.0.1:${cb.port}/callback/not-the-nonce?code=${CODE}`);
      assert.equal(wrong.status, 404);
      const root = await fetch(`http://127.0.0.1:${cb.port}/?code=${CODE}`);
      assert.equal(root.status, 404);
      setTimeout(() => ac.abort(), 50);
    };
    const n = readRegistry().accounts.length;
    await assert.rejects(signInOpenRouter({ service, label: "x", openBrowser: browser, out: sink(), signal: ac.signal, exchangeUrl: `${fake.url}/api/v1/auth/keys` }), (e) => e.code === "OAUTH_CANCELLED" && e.message === OAUTH_TEXTS.CANCELLED);
    assert.equal(fake.state.exchanges.length, 0, "no exchange without the right callback");
    assert.equal(readRegistry().accounts.length, n);
    await assert.rejects(fetch(`http://127.0.0.1:${cbPort}/`), "the server is closed");
  } finally {
    await fake.close();
  }
});

test("10 minutes without a callback ends the sign-in", async () => {
  await assert.rejects(signInOpenRouter({ service, label: "slow", openBrowser: async () => {}, out: sink(), timeoutMs: 50 }), (e) => e.code === "OAUTH_TIMEOUT" && /within 10 minutes/.test(e.message));
});

test("review: the sign-in never waits for the browser opener, and a cancel while it runs is handled", async () => {
  const fake = await fakeOpenRouter();
  const keys = await startMockProvider({ personality: "openrouter", keys: [KEY] });
  const rejections = [];
  const onRej = (e) => rejections.push(e);
  process.on("unhandledRejection", onRej);
  try {
    let releaseOpener;
    const slowOpener = async (url) => {
      const u = new URL(url);
      fake.state.challenge = u.searchParams.get("code_challenge");
      const cb = new URL(u.searchParams.get("callback_url"));
      await fetch(cb.href.replace("localhost", "127.0.0.1") + `?code=${CODE}`);
      await new Promise((r) => (releaseOpener = r)); // like xdg-open waiting for the browser
    };
    const fetchRouted = (url, init) => globalThis.fetch(String(url).replace("https://openrouter.ai/api/v1", keys.url), init);
    const t0 = Date.now();
    const a = await signInOpenRouter({ service, label: "slowopener", openBrowser: slowOpener, out: sink(), fetch: fetchRouted, exchangeUrl: `${fake.url}/api/v1/auth/keys` });
    assert.equal(a.status, "ready");
    assert.ok(Date.now() - t0 < 5000, "done while the opener still runs");
    releaseOpener?.();
    // A cancel while a (hanging) opener runs: the sign-in rejects, nothing is unhandled.
    const ac = new AbortController();
    const p = signInOpenRouter({ service, label: "cancelled", openBrowser: () => new Promise(() => setTimeout(() => ac.abort(), 20)), out: sink(), signal: ac.signal, exchangeUrl: `${fake.url}/api/v1/auth/keys` });
    await assert.rejects(p, { code: "OAUTH_CANCELLED" });
    // An opener that throws at once leaves the printed URL to do its job.
    const ac2 = new AbortController();
    const q = signInOpenRouter({ service, label: "boom", openBrowser: () => {
      setTimeout(() => ac2.abort(), 20);
      throw new Error("boom");
    }, out: sink(), signal: ac2.signal, exchangeUrl: `${fake.url}/api/v1/auth/keys` });
    await assert.rejects(q, { code: "OAUTH_CANCELLED" });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", onRej);
    await fake.close();
    await keys.close();
  }
});

test("review: an error callback ends at once; only GET on the exact path; ::1 answers too where it exists; http exchange refused", async () => {
  const fake = await fakeOpenRouter();
  try {
    let port;
    let postStatus = null; // checked after the sign-in: the opener's own errors are ignored by design
    const browser = async (url) => {
      const cb = new URL(new URL(url).searchParams.get("callback_url"));
      port = cb.port;
      postStatus = (await fetch(`http://127.0.0.1:${port}${cb.pathname}`, { method: "POST" })).status;
      try {
        const v6 = await fetch(`http://[::1]:${port}/nope`);
        assert.equal(v6.status, 404, "the ::1 listener answers");
      } catch {
        // no IPv6 on this machine
      }
      await fetch(`http://127.0.0.1:${port}${cb.pathname}?error=access_denied`);
    };
    const t0 = Date.now();
    await assert.rejects(signInOpenRouter({ service, label: "denied", openBrowser: browser, out: sink(), exchangeUrl: `${fake.url}/api/v1/auth/keys` }), (e) => e.code === "OAUTH_DENIED" && !/access_denied/.test(e.message));
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(postStatus, 404, "POST on the callback path is refused");
    assert.equal(fake.state.exchanges.length, 0);
    await assert.rejects(signInOpenRouter({ service, label: "plain", openBrowser: async () => {}, out: sink(), exchangeUrl: "http://openrouter.example/api/v1/auth/keys" }), { code: "EXCHANGE_INSECURE" });
  } finally {
    await fake.close();
  }
});

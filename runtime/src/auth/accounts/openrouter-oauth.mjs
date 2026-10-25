// OpenRouter's own sign-in (P3.5b): the official PKCE flow, no client secret, no borrowed
// app. ad gets an ordinary OpenRouter key for the user, stored like any other.
//
//   signInOpenRouter({ service, label, owner, openBrowser, out, signal, onWaitEnd, fetch,
//                      clientVersion, authBase, exchangeUrl, timeoutMs }) → the account record
//
// 1. A verifier (64 random bytes, base64url) and its S256 challenge; a random nonce.
// 2. A server on this machine (127.0.0.1, and ::1 on the same port where it exists: the
//    callback says localhost) that answers only GET /callback/<nonce>.
// 3. The browser opens https://openrouter.ai/auth?callback_url=…&code_challenge=…&
//    code_challenge_method=S256 (not waited on: an opener may block until the browser
//    closes); the URL is always printed too.
// 4. One exchange over https: POST /api/v1/auth/keys { code, code_verifier,
//    code_challenge_method } → { key }; then the key is tested and stored
//    (method "openrouter-oauth").
// The server closes on every exit: signed in, denied, Ctrl+C, 10 minutes. The code is a
// secret: registered with the redactor and never printed. onWaitEnd() runs once the wait
// is over (the caller's Ctrl+C handler can go).

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { registerSecret } from "../redact.mjs";
import { isLoopback, providerRequest } from "../../providers/http.mjs";
import { presetFor } from "../../providers/registry.mjs";
import { checkKeyText, keyVerdict, labelOrFail } from "./signin.mjs";

export const OAUTH_TEXTS = Object.freeze({
  OPENING: (url) => `Opening your browser to sign in to OpenRouter. If it doesn't open, go to:\n  ${url}\n`,
  PAGE_OK: "Signed in to OpenRouter. You can close this tab and go back to ad.",
  PAGE_ERROR: "OpenRouter didn't sign you in. Go back to ad and try again.",
  DENIED: "OpenRouter didn't sign you in (the page was cancelled or refused); nothing was saved. Run it again: ad auth login openrouter --oauth",
  TIMED_OUT: "The OpenRouter sign-in wasn't finished within 10 minutes. Run it again: ad auth login openrouter --oauth",
  CANCELLED: "The OpenRouter sign-in was cancelled; nothing was saved.",
  EXCHANGE_FAILED: (http) => `OpenRouter didn't give a key for this sign-in (HTTP ${http}). Run it again: ad auth login openrouter --oauth`,
  EXCHANGE_INSECURE: "ad sends the sign-in code to OpenRouter over https only.",
});

const b64url = (buf) => Buffer.from(buf).toString("base64url");
export const challengeOf = (verifier) => b64url(createHash("sha256").update(verifier).digest());
const fail = (code, message) => Object.assign(new Error(message), { code });

const page = (text) => `<!doctype html><meta charset="utf-8"><title>ad</title><p style="font:16px system-ui;margin:3em">${text}</p>`;

const listen = (server, port, host) =>
  new Promise((resolve, reject) => {
    const onErr = (e) => reject(e);
    server.once("error", onErr);
    server.listen(port, host, () => {
      server.off("error", onErr);
      resolve();
    });
  });
const close = (server) =>
  new Promise((r) => {
    server.closeAllConnections?.();
    server.close(() => r());
  });

export async function signInOpenRouter({ service, label, owner = "", openBrowser, out = process.stdout, signal, onWaitEnd = () => {}, fetch, clientVersion, authBase = "https://openrouter.ai", exchangeUrl = "https://openrouter.ai/api/v1/auth/keys", timeoutMs = 10 * 60_000 }) {
  // The code and verifier go in the body: https only (a test's loopback server aside).
  if (!exchangeUrl.startsWith("https://") && !isLoopback(exchangeUrl)) throw fail("EXCHANGE_INSECURE", OAUTH_TEXTS.EXCHANGE_INSECURE);
  label = labelOrFail("openrouter", label);
  const verifier = b64url(randomBytes(64));
  const challenge = challengeOf(verifier);
  const nonce = randomBytes(16).toString("hex");
  const path = `/callback/${nonce}`;

  let settle;
  const got = new Promise((resolve, reject) => (settle = { resolve, reject }));
  got.catch(() => {}); // settled before anyone waits (a cancel during the opener): never unhandled
  const handler = (req, res) => {
    let u;
    try {
      u = new URL(req.url, "http://localhost");
    } catch {
      return void res.writeHead(400, { "content-type": "text/plain" }).end("Bad request");
    }
    if (req.method !== "GET" || u.pathname !== path) return void res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    const code = u.searchParams.get("code");
    if (!code) {
      // Denied or cancelled on OpenRouter's page: end now (no parameter is quoted anywhere).
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(page(OAUTH_TEXTS.PAGE_ERROR));
      settle.reject(fail("OAUTH_DENIED", OAUTH_TEXTS.DENIED));
      return;
    }
    registerSecret(code, "sign-in code");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page(OAUTH_TEXTS.PAGE_OK));
    settle.resolve(code);
  };
  const v4 = createServer(handler);
  await listen(v4, 0, "127.0.0.1");
  const port = v4.address().port;
  // localhost may resolve to ::1 first: answer there too, on the same port, where IPv6 exists.
  const v6 = createServer(handler);
  const hasV6 = await listen(v6, port, "::1").then(
    () => true,
    () => false,
  );

  const timer = setTimeout(() => settle.reject(fail("OAUTH_TIMEOUT", OAUTH_TEXTS.TIMED_OUT)), timeoutMs);
  timer.unref?.();
  const onAbort = () => settle.reject(fail("OAUTH_CANCELLED", OAUTH_TEXTS.CANCELLED));
  if (signal?.aborted) onAbort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let code;
  try {
    const callback = `http://localhost:${port}${path}`;
    const url = `${authBase}/auth?callback_url=${encodeURIComponent(callback)}&code_challenge=${challenge}&code_challenge_method=S256`;
    out.write(OAUTH_TEXTS.OPENING(url));
    // Not awaited: an opener may run until the browser closes; its failure is the printed URL's job.
    Promise.resolve()
      .then(() => openBrowser?.(url))
      .catch(() => {});
    code = await got;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    await close(v4);
    if (hasV6) await close(v6);
    onWaitEnd();
  }

  // One exchange, never retried: a code works once.
  const r = await providerRequest({ url: exchangeUrl, method: "POST", body: { code, code_verifier: verifier, code_challenge_method: "S256" }, fetch, clientVersion });
  if (r.status !== 200 || typeof r.json?.key !== "string") throw fail("OAUTH_EXCHANGE_FAILED", OAUTH_TEXTS.EXCHANGE_FAILED(r.status));
  const key = checkKeyText(r.json.key);
  const preset = presetFor("openrouter");
  let own = null;
  try {
    return await service.addApiKey({
      provider: "openrouter",
      label,
      owner,
      method: "openrouter-oauth",
      key,
      test: async (k) => {
        try {
          return await keyVerdict(preset, "openrouter", label, { fetch, clientVersion })(k);
        } catch (e) {
          own = e;
          throw e;
        }
      },
    });
  } catch (e) {
    throw own ?? e;
  }
}

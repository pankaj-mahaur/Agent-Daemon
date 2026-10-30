// A mock ChatGPT auth server for sign-in tests (P3.1 S-SHARED, P3.7): token refresh
// with rotation and refresh-token reuse detection, on a random loopback port.
//
//   startMockAuth({ accessTtlS, rotate, rejectReuse })
//     → { tokenUrl, issue({ accountId, email }), refreshCount(token), reuseCount, requests, close }
//
// Tokens are JWT-shaped but unsigned (alg "none"): whether the engine accepts them is
// part of what a spike finds out. A refresh token is good once when `rotate` is on;
// using it again answers 401 { error: { code: "refresh_token_reused" } }, the way two
// processes racing on one home would see it. Request bodies are JSON or form-encoded.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const b64url = (s) => Buffer.from(s).toString("base64url");
export function decodeJwt(token) {
  const part = String(token).split(".")[1];
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

/** @param {{ accessTtlS?: number, rotate?: boolean, rejectReuse?: boolean }} [o] */
export async function startMockAuth({ accessTtlS = 3600, rotate = true, rejectReuse = true } = {}) {
  const live = new Map(); // refresh token → account
  const spent = new Set();
  const counts = new Map();
  const requests = [];
  let reuseCount = 0;
  const jwt = (claims) => `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}.`;
  const tokensFor = (account) => {
    const now = Math.floor(Date.now() / 1000);
    const auth = { chatgpt_account_id: account.accountId, chatgpt_plan_type: "plus" };
    // jti: two tokens issued in the same second still differ.
    const jti = randomBytes(8).toString("hex");
    return {
      access_token: jwt({ sub: account.accountId, exp: now + accessTtlS, iat: now, jti, "https://api.openai.com/auth": auth }),
      id_token: jwt({ sub: account.accountId, email: account.email ?? `${account.accountId}@example.com`, exp: now + accessTtlS, iat: now, "https://api.openai.com/auth": auth }),
      refresh_token: `rt-${randomBytes(12).toString("hex")}`,
      expires_in: accessTtlS,
      token_type: "Bearer",
    };
  };
  const issue = (account) => {
    const t = tokensFor(account);
    live.set(t.refresh_token, account);
    return t;
  };

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const type = String(req.headers["content-type"] ?? "");
      let body = {};
      try {
        body = type.includes("json") ? JSON.parse(raw || "{}") : Object.fromEntries(new URLSearchParams(raw));
      } catch {
        body = {};
      }
      requests.push({ method: req.method, path: req.url, grantType: body.grant_type ?? null });
      const send = (status, obj) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(obj));
      if (req.method !== "POST" || body.grant_type !== "refresh_token") return send(400, { error: { code: "unsupported_grant_type", message: "mock: only refresh_token" } });
      const token = String(body.refresh_token ?? "");
      counts.set(token, (counts.get(token) ?? 0) + 1);
      if (spent.has(token)) {
        reuseCount++;
        if (rejectReuse) return send(401, { error: { code: "refresh_token_reused", message: "Your refresh token has already been used to generate a new access token. Please try signing in again." } });
      }
      const account = live.get(token);
      if (!account) return send(401, { error: { code: "invalid_grant", message: "mock: unknown refresh token" } });
      const next = tokensFor(account);
      if (rotate) {
        live.delete(token);
        spent.add(token);
        live.set(next.refresh_token, account);
      } else next.refresh_token = token;
      return send(200, next);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    tokenUrl: `${origin}/oauth/token`,
    issue,
    refreshCount: (token) => counts.get(token) ?? 0,
    get reuseCount() {
      return reuseCount;
    },
    requests,
    close: () => {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

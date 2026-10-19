// P3.1: the mock auth server for ChatGPT sign-in tests (S-SHARED, P3.7). It issues
// JWT-shaped tokens, rotates refresh tokens, and answers refresh_token_reused when a
// spent refresh token comes back, the way two processes racing on one home would.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { startMockAuth, decodeJwt } from "../testkit/mock-auth.mjs";

const servers = [];
after(async () => {
  for (const s of servers) await s.close();
});
const refresh = (auth, token, form = false) =>
  fetch(auth.tokenUrl, form
    ? { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: "mock" }).toString() }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "refresh_token", refresh_token: token, client_id: "mock" }) });

test("rotation issues a new refresh token each time; tokens are JWT-shaped with an expiry", async () => {
  const auth = await startMockAuth({ accessTtlS: 60 });
  servers.push(auth);
  const first = auth.issue({ accountId: "acct-1", email: "sam@example.com" });
  const claims = decodeJwt(first.access_token);
  assert.equal(claims["https://api.openai.com/auth"].chatgpt_account_id, "acct-1");
  assert.ok(claims.exp - Math.floor(Date.now() / 1000) <= 60);
  const r1 = await (await refresh(auth, first.refresh_token)).json();
  assert.notEqual(r1.refresh_token, first.refresh_token);
  assert.notEqual(r1.access_token, first.access_token);
  const r2 = await (await refresh(auth, r1.refresh_token, true)).json();
  assert.notEqual(r2.refresh_token, r1.refresh_token, "form bodies work too");
  assert.equal(auth.refreshCount(first.refresh_token), 1);
});

test("a reused refresh token gets refresh_token_reused", async () => {
  const auth = await startMockAuth();
  servers.push(auth);
  const t = auth.issue({ accountId: "acct-2" });
  // Two processes refresh with the same token at the same instant.
  const [a, b] = await Promise.all([refresh(auth, t.refresh_token), refresh(auth, t.refresh_token)]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 401]);
  const loser = a.status === 401 ? a : b;
  assert.equal((await loser.json()).error.code, "refresh_token_reused");
  assert.equal(auth.reuseCount, 1);
  const unknown = await refresh(auth, "rt-never-issued");
  assert.equal(unknown.status, 401);
  assert.equal((await unknown.json()).error.code, "invalid_grant");
});

test("rotation and reuse rejection can be turned off", async () => {
  const auth = await startMockAuth({ rotate: false, rejectReuse: false });
  servers.push(auth);
  const t = auth.issue({ accountId: "acct-3" });
  const r1 = await (await refresh(auth, t.refresh_token)).json();
  assert.equal(r1.refresh_token, t.refresh_token);
  assert.equal((await refresh(auth, t.refresh_token)).status, 200);
});

// P3.3: the redactor. Registered values (the keys the gateway loads, its token) and
// key-shaped strings never reach an error line, a notice or a log.

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerSecret, redact, redactDeep, _resetForTests } from "../src/auth/redact.mjs";

const parts = (...p) => p.join("");

test("patterns: provider keys, bearer tokens, JWTs, OAuth query values", () => {
  _resetForTests();
  const samples = [
    parts("sk-", "abcdefghijklmnop1234"),
    parts("sk-or-v1-", "0123456789abcdef0123456789abcdef"),
    parts("xai-", "ABCDEFGHIJKLMNOPQRSTuv"),
    parts("fw_", "abcdefghijklmnop12"),
    parts("Bearer ", "abcdefghijklmnopqrstu"),
    parts("eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"),
  ];
  for (const s of samples) {
    const out = redact(`before ${s} after`);
    assert.ok(!out.includes(s), s.slice(0, 6));
    assert.match(out, /^before \[redacted[^\]]*\] after$/);
  }
  assert.equal(redact("https://x/cb?code=abc123&state=s1"), "https://x/cb?code=[redacted]&state=s1");
  assert.equal(redact("a?code_verifier=zzz&id_token_hint=yyy"), "a?code_verifier=[redacted]&id_token_hint=[redacted]");
  assert.equal(redact("nothing secret here"), "nothing secret here");
});

test("registered values: exact and JSON-escaped forms; deep values", () => {
  _resetForTests();
  const token = "tok/with\"quote\\and-more-chars-123";
  registerSecret(token, "gateway token");
  assert.equal(redact(`x ${token} y`), "x [redacted: gateway token] y");
  assert.equal(redact(JSON.stringify({ t: token })), '{"t":"[redacted: gateway token]"}');
  const deep = redactDeep({ a: [`k ${token}`], b: { c: token }, n: 3 });
  assert.deepEqual(deep, { a: ["k [redacted: gateway token]"], b: { c: "[redacted: gateway token]" }, n: 3 });
  // Short values are never registered (they would redact ordinary words).
  registerSecret("abc", "too short");
  assert.equal(redact("abc"), "abc");
});

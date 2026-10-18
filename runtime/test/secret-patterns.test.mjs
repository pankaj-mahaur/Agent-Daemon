// Tests for runtime/src/security/secret-patterns.mjs: the one secret-pattern
// module (memory capture, later the record tools and the gateway redactor).
// Every value here is made up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { findSecrets, redactSecrets, SECRET_PATTERNS } from "../src/security/secret-patterns.mjs";

const PEM = ["-----BEGIN PRIVATE KEY-----", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "-----END PRIVATE KEY-----"].join("\n");
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";

const CAUGHT = [
  ["sk-test-a1B2c3D4e5F6g7H8i9J0k1L2m3N4", "openai-key", "high"],
  ["ghp_" + "a1".repeat(18), "github-token", "high"],
  ["AKIA" + "ABCDEFGHIJKLMNOP", "aws-access-key", "high"],
  [JWT, "jwt", "high"],
  [PEM, "private-key", "high"],
  ["postgres://u:pw12345@host/db", "url-credentials", "generic"],
  ["DB_PASSWORD=hunter2hunter", "env-assignment", "generic"],
  ["OPENAI_API_KEY=abc123def456ghi789", "env-assignment", "generic"],
  ["the deploy password is Xq7#pL9vR2mK8sT4", "keyword-secret", "generic"],
  ["sk-ant-api03-" + "Ab1".repeat(10), "anthropic-key", "high"],
  ["sk-or-v1-" + "a1b2".repeat(10), "openrouter-key", "high"],
  ["github_pat_" + "A1b2C3d4E5".repeat(3), "github-token", "high"],
  ["glpat-" + "a1B2c3D4e5F6g7H8i9J0", "gitlab-token", "high"],
  ["AIza" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r", "google-api-key", "high"],
  ["xoxb-1234567890-abcdefghij", "slack-token", "high"],
  ["sk_live_" + "a1B2c3D4e5F6g7H8", "stripe-key", "high"],
  ["hf_" + "a1B2c3D4e5".repeat(3), "huggingface-token", "high"],
  ["npm_" + "a1B2c3D4e5F6".repeat(3), "npm-token", "high"],
  ["Authorization: Bearer abcDEF123456ghiJKL789", "bearer-token", "generic"],
  ["export GITHUB_TOKEN=Zx9Yw8Vu7Ts6", "env-assignment", "generic"],
  // Shapes a review found missing (P0.8a round 1).
  ['{"password": "Hunter2Secret99x"}', "keyword-secret", "generic"],
  ['"api_key": "a1b2c3d4e5f6g7h8i9"', "keyword-secret", "generic"],
  ["aws_secret_access_key: wJalrXUtnFEMI7K7MDENGbPxRfiCY", "keyword-secret", "generic"],
  ["DefaultEndpointsProtocol=https;AccountName=x;AccountKey=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==;EndpointSuffix=core", "azure-key", "high"],
  ["-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx7abcdefghij\nAAAABBBBCCCCDDDDEEEEFFFF0123\n", "private-key", "high"],
  ["Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==", "basic-auth", "generic"],
  ["SG." + "a1B2c3D4e5F6g7H8" + "." + "i9J0k1L2m3N4o5P6q7", "sendgrid-key", "high"],
  ["pypi-" + "AgEIcHlwaS5vcmc".repeat(4), "pypi-token", "high"],
  ["whsec_" + "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "webhook-secret", "high"],
  ["https://hooks.slack.com/services/T0000/B0000/XXXXabcd1234", "slack-webhook", "high"],
  ["//registry." + "npmjs.org/:_auth" + "Token=" + ["1b2c3d4e", "5f6a", "7b8c", "9d0e", "1f2a3b4c5d6e"].join("-"), "npm-token", "high"],
  ['setx OPENAI_API_KEY "abc123def456ghi789"', "env-assignment", "generic"],
  ["mysql --password Pa55word42 -u root", "keyword-secret", "generic"],
  // Round 3: a lowercase passphrase under a password name; a short cut-off key line.
  ["db_password=lowercaseonlylong", "env-assignment", "generic"],
  ["-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIBkg\n", "private-key", "high"],
];

const LEFT_ALONE = [
  "task-1234",
  "123e4567-e89b-12d3-a456-426614174000",
  "9fceb02d0ae598e95dc970b74767f19372d61af8",
  "sk-learn-ensemble-classifier-v2",
  "NEXTAUTH_URL=http://localhost:3000",
  "OAUTH_REDIRECT_URI=http://localhost/cb",
  "GIT_AUTHOR_NAME=Jane Doe",
  "PWD=/home/x",
  "API_KEY_PATH=./keys",
  "PASSWORD_MIN_LENGTH=12",
  "TOKEN_TTL=3600",
  "the token refresh fix landed in 9fceb02d0ae598e95dc970b74767f19372d61af8",
  "apiKey: process.env.OPENAI_API_KEY",
  "OPENAI_API_KEY=<your key here>",
  "OPENAI_API_KEY=${OPENAI_API_KEY}",
  "DB_PASSWORD=$DB_PASSWORD",
  "DB_PASSWORD=%DB_PASSWORD%",
  "API_KEY=xxxxxxxxxxxx",
  "SECRET_KEY=changeme",
  "API_KEY=your-key-here",
  "token: [redacted:openai-key]",
  "use the --token flag for auth",
  "password: ***",
  "AUTHOR=someone-else",
  // False positives a review found (P0.8a round 1).
  "PRIMARY_KEY=user_id",
  "SORT_KEY=createdAt2",
  "CACHE_KEY=v2-build-123",
  "AUTH=oauth2",
  "the token was refreshed2024",
  "send Bearer authentication_required_header",
  "use the --token flag for auth",
  "Basic usage: run it twice",
  // Round 2: a mention of a key's first line is prose, not a key.
  "keys start with -----BEGIN PRIVATE KEY----- and the rest of this note explains how to rotate them",
  "Never commit a file containing -----BEGIN RSA PRIVATE KEY-----.\nAlso: run npm test before every push.",
  "TOKEN_TYPE=personal_access",
];

test("each secret kind is caught, with its confidence", () => {
  for (const [text, kind, confidence] of CAUGHT) {
    const hits = findSecrets(`note: ${text} end`);
    assert.ok(hits.some((h) => h.kind === kind && h.confidence === confidence), `${kind} in ${JSON.stringify(text)} → ${JSON.stringify(hits)}`);
    const { text: out, kinds } = redactSecrets(`note: ${text} end`);
    assert.ok(kinds.includes(kind), `${kind} reported`);
    assert.ok(out.includes(`[redacted:${kind}]`), out);
  }
});

test("redaction removes the secret value itself", () => {
  const raw = "a key sk-test-a1B2c3D4e5F6g7H8i9J0k1L2m3N4 and ghp_" + "a1".repeat(18);
  const { text } = redactSecrets(raw);
  assert.ok(!text.includes("sk-test-a1B2"), text);
  assert.ok(!text.includes("ghp_a1"), text);
  // url credentials: only the password goes
  assert.equal(redactSecrets("postgres://u:pw12345@host/db").text, "postgres://u:[redacted:url-credentials]@host/db");
  // env assignment: the name stays, the value goes
  assert.equal(redactSecrets("DB_PASSWORD=hunter2hunter").text, "DB_PASSWORD=[redacted:env-assignment]");
  assert.equal(redactSecrets("the deploy password is Xq7#pL9vR2mK8sT4").text, "the deploy password is [redacted:keyword-secret]");
});

test("ordinary text that looks a bit like a secret is left alone", () => {
  for (const t of LEFT_ALONE) {
    assert.deepEqual(findSecrets(t), [], `${JSON.stringify(t)} → ${JSON.stringify(findSecrets(t))}`);
    assert.equal(redactSecrets(t).text, t);
  }
});

test("redacting twice equals redacting once", () => {
  for (const [text] of CAUGHT) {
    const once = redactSecrets(`x ${text} y`).text;
    assert.equal(redactSecrets(once).text, once);
    assert.deepEqual(redactSecrets(once).kinds, []);
  }
});

test("minConfidence filters generic kinds", () => {
  const t = "DB_PASSWORD=hunter2hunter and sk-test-a1B2c3D4e5F6g7H8i9J0k1L2m3N4";
  assert.deepEqual(findSecrets(t, { minConfidence: "high" }).map((h) => h.kind), ["openai-key"]);
  assert.equal(findSecrets(t).length, 2);
});

test("every pattern has a kind, a regex and a confidence", () => {
  assert.ok(Object.isFrozen(SECRET_PATTERNS));
  for (const p of SECRET_PATTERNS) {
    assert.match(p.kind, /^[a-z-]+$/);
    assert.ok(p.re instanceof RegExp && p.re.global, p.kind);
    assert.ok(["high", "generic"].includes(p.confidence), p.kind);
  }
});

test("long hostile input stays fast (no quadratic backtracking)", () => {
  for (const s of ["a-".repeat(50_000), "a".repeat(100_000), "x:".repeat(50_000), "token: ".repeat(14_000), "Bearer ".repeat(14_000)]) {
    const t0 = Date.now();
    redactSecrets(s);
    assert.ok(Date.now() - t0 < 1500, `${s.slice(0, 6)}… took ${Date.now() - t0} ms`);
  }
});

test("non-string input is returned unchanged", () => {
  assert.deepEqual(redactSecrets(undefined), { text: undefined, kinds: [] });
  assert.deepEqual(redactSecrets(null), { text: null, kinds: [] });
  assert.deepEqual(findSecrets(42), []);
});

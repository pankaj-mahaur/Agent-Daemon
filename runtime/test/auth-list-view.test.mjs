// The account list's layout (P3.8a): pure, measured in columns.

import { test } from "node:test";
import assert from "node:assert/strict";
import { limitOf, listLines, whoOf } from "../src/harness/auth-list-view.mjs";

const acct = (o) => ({ id: `acct_${o.label}`, owner: "", status: "ready", method: "api-key", keyHint: null, identity: null, lastUsedAt: null, ...o });
const accounts = [
  acct({ provider: "chatgpt", label: "personal", method: "engine-login", identity: { email: "sam@example.com", plan: "plus" } }),
  acct({ provider: "chatgpt", label: "work", method: "engine-login", status: "needs-sign-in", identity: { email: "alex@example.com", plan: "team" } }),
  acct({ provider: "openrouter", label: "default", keyHint: "9f3c" }),
  acct({ provider: "openrouter", label: "client-a", owner: "Sam's key", keyHint: "a1b2" }),
  acct({ provider: "openrouter", label: "a-very-long-label-that-goes-on", owner: "an owner tag that is also far too long", keyHint: "0000" }),
  acct({ provider: "ollama", label: "local", method: "none" }),
];
const names = { chatgpt: "ChatGPT", openrouter: "OpenRouter", ollama: "Ollama" };
const view = (o) => listLines(accounts, { providerOrder: ["chatgpt", "openrouter", "ollama"], nameOf: (p) => names[p], defaultId: "acct_personal", ...o });
const width = (s) => [...s].length;

test("every default row fits 80 columns; long labels and owners are cut with …", () => {
  const lines = view({ width: 80 });
  for (const l of lines) assert.ok(width(l) <= 80, `${width(l)}: ${l}`);
  assert.ok(lines.some((l) => l.includes("a-very-long…")));
  assert.ok(lines.some((l) => l.includes("an owner tag…")));
  assert.match(lines[0], /^ {2}label\s+owner\s+who\s+status\s+limits$/);
  assert.deepEqual(lines.filter((l) => /^[A-Z]/.test(l)), ["ChatGPT", "OpenRouter", "Ollama"]);
  assert.match(lines.find((l) => l.includes("personal")), /^● personal/);
  assert.match(lines.at(-1), /● = ad's default for new sessions\. More columns: --wide/);
});

test("owner is blank when equal to the label; keys show key …<last 4>, sign-ins the masked email and plan", () => {
  assert.equal(whoOf(accounts[0]), "s***@example.com · plus");
  assert.equal(whoOf(accounts[2]), "key …9f3c");
  assert.equal(whoOf(accounts[5]), "local");
  const lines = view({ width: 80 });
  assert.ok(!lines.join("\n").includes("sam@example.com"));
  const same = listLines([acct({ provider: "openrouter", label: "work", owner: "work", keyHint: "1111" })], { width: 80 });
  assert.match(same[2], /^ {2}work {9} {14}key …1111/);
});

test("--wide and 120+ columns add method and last use; under 60 the owner becomes a suffix", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  const withUse = [{ ...accounts[2], lastUsedAt: "2026-10-25T10:00:00Z" }];
  for (const o of [{ width: 80, wide: true }, { width: 130 }]) {
    const lines = listLines(withUse, { ...o, now });
    assert.match(lines[0], /method\s+last use/);
    assert.match(lines[2], /api key\s+2 h ago/);
  }
  const narrow = view({ width: 50 });
  for (const l of narrow) assert.ok(width(l) <= 50, l);
  assert.ok(narrow.some((l) => /client-a.*owner: Sam/.test(l) || /owner: Sa/.test(l)));
});

test("a limit observation shows in the limits column", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  assert.match(limitOf({ status: 429, retryAfterS: 1800, at: "2026-10-25T12:00:00Z" }, now), /^429 → \d\d:\d\d$/);
  assert.equal(limitOf({ status: 200 }, now), "");
  const lines = view({ width: 80, now, upstream: (id) => (id === "acct_default" ? { status: 429, retryAfterS: 1800, at: "2026-10-25T12:00:00Z" } : null) });
  assert.match(lines.find((l) => l.includes("key …9f3c")), /429 → \d\d:\d\d$/, "the reset time fits at 80");
});

test("review: neighbouring columns never run together; the header fits every width", () => {
  const exact = [acct({ provider: "openrouter", label: "abcdefghijklm", owner: "Sam key", keyHint: "1111" })];
  const row = listLines(exact, { width: 80 })[2];
  assert.ok(!row.includes("abcdefghijklmSam"), row);
  assert.match(row, /abcdefghijk… Sam key/);
  for (const w of [50, 60, 68, 69, 74, 80, 100, 120, 140]) {
    for (const wide of [false, true]) {
      const lines = view({ width: w, wide });
      for (const l of lines) assert.ok(width(l) <= w, `${w}${wide ? " wide" : ""}: ${width(l)} ${l}`);
    }
  }
  // No default among these accounts: no ● legend.
  assert.ok(!listLines(exact, { width: 80 }).join("\n").includes("● ="));
});

// Regression tests for runtime/scripts/lint-skills.mjs
// Exercises the YAML-safety checks that guard against Claude Code startup warnings.

import { test } from "node:test";
import assert from "node:assert/strict";

// Import the validator directly by reconstructing the minimal surface we need.
// lint-skills.mjs is a standalone script, so we re-export the internal logic
// by re-implementing the small pure function under test here and keeping it in
// sync. The real gate is that the linter must exit 0 on the live skills/ dir.

// ── inline the helpers under test ──────────────────────────────────────────
function isUnsafeUnquotedYaml(rawLine) {
  const colonIdx = rawLine.indexOf(": ");
  if (colonIdx === -1) return false;
  const value = rawLine.slice(colonIdx + 2).trim();
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) return false;
  if (value === "|" || value === ">" || value === "") return false;
  return value.includes(": ");
}

// ── fixtures ────────────────────────────────────────────────────────────────

// Reproduces the original session-close bug: unquoted colon-space inside value.
const FIXTURE_BAD_COLON = `---
name: session-close
description: Use when the user signals end-of-session. Trigger phrases (English + Hinglish, substring-matched): "bye", "session khatam". Runs session log + digest block.
---
body
`;

// The fixed version — colon replaced with em-dash.
const FIXTURE_FIXED_EMDASH = `---
name: session-close
description: Use when the user signals end-of-session. Trigger phrases (English + Hinglish, substring-matched) — "bye", "session khatam". Runs session log + digest block.
---
body
`;

// Double-quoted value containing colon — safe.
const FIXTURE_QUOTED_COLON = `---
name: my-skill
description: "Use when foo: bar happens. Handles edge cases."
---
body
`;

// Simple description with no colon — always safe.
const FIXTURE_NO_COLON = `---
name: my-skill
description: Use when the user asks for seeds.
---
body
`;

// ── unit tests for isUnsafeUnquotedYaml ─────────────────────────────────────

test("isUnsafeUnquotedYaml — detects unquoted colon-space in description value", () => {
  const line = `description: Use when something happens. Trigger phrases (English + Hinglish, substring-matched): "bye", "hello".`;
  assert.ok(isUnsafeUnquotedYaml(line), "should flag unquoted ': ' inside value");
});

test("isUnsafeUnquotedYaml — safe after replacing colon with em-dash", () => {
  const line = `description: Use when something happens. Trigger phrases (English + Hinglish, substring-matched) — "bye", "hello".`;
  assert.ok(!isUnsafeUnquotedYaml(line), "em-dash replacement should be safe");
});

test("isUnsafeUnquotedYaml — double-quoted value with colon is safe", () => {
  const line = `description: "Use when foo: bar happens."`;
  assert.ok(!isUnsafeUnquotedYaml(line), "quoted value should be safe");
});

test("isUnsafeUnquotedYaml — single-quoted value with colon is safe", () => {
  const line = `description: 'Use when foo: bar happens.'`;
  assert.ok(!isUnsafeUnquotedYaml(line), "single-quoted value should be safe");
});

test("isUnsafeUnquotedYaml — value with no colon is safe", () => {
  const line = `description: Use when the user asks for seeds.`;
  assert.ok(!isUnsafeUnquotedYaml(line), "no colon in value is safe");
});

test("isUnsafeUnquotedYaml — block scalar marker is safe", () => {
  assert.ok(!isUnsafeUnquotedYaml("description: |"), "block scalar | is safe");
  assert.ok(!isUnsafeUnquotedYaml("description: >"), "folded scalar > is safe");
});

// ── integration: run linter against live skills/ dir ────────────────────────

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const LINTER = resolve(HERE, "..", "scripts", "lint-skills.mjs");

test("linter exits 0 on the live skills/ dir (no YAML errors in daemon-managed skills)", () => {
  const r = spawnSync(process.execPath, [LINTER], { encoding: "utf8" });
  // Surface linter output on failure for easy diagnosis.
  const errLines = r.stdout.split("\n").filter(l => l.includes("✗")).join("\n");
  assert.equal(r.status, 0, `linter found errors:\n${errLines}\n\nFull output:\n${r.stdout}`);
});

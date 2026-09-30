// Tests for `ad run` (harness/run.mjs) against the fake app-server.
// Property that matters: with nobody at the keyboard, approvals are declined
// and said so on stderr; stdout carries only the agent's text (pipeable).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdRun, describeItem } from "../src/harness/run.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));

function sink() {
  const s = { text: "", write: (chunk) => { s.text += chunk; return true; } };
  return s;
}

async function run(prompt, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), "ad-run-home-"));
  const stdout = sink();
  const stderr = sink();
  try {
    const code = await cmdRun(prompt, { home, command: { cmd: process.execPath, prefix: [FAKE] }, stdout, stderr, ...extra });
    return { code, stdout: stdout.text, stderr: stderr.text };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("ad run streams agent text to stdout and declines approvals on stderr", async () => {
  const r = await run("do the thing");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "pong[decline]\n");
  assert.match(r.stderr, /declined command/);
});

test("ad run --json prints one JSON result line", async () => {
  const r = await run("do the thing", { json: true });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "completed");
  assert.equal(out.output, "pong[decline]");
});

test("ad run exits 1 on a failed turn", async () => {
  const r = await run("fail-turn");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /turn failed: model refused/);
});

test("ad run with no prompt prints usage", async () => {
  const r = await run("   ");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Usage: ad run/);
});

test("describeItem summarizes tool activity", () => {
  assert.equal(describeItem({ type: "commandExecution", command: "npm test" }), "$ npm test");
  assert.equal(describeItem({ type: "fileChange", changes: [{ path: "a.js" }, { path: "b.js" }] }), "~ a.js, b.js");
  assert.equal(describeItem({ type: "mcpToolCall", server: "memory", tool: "search" }), "⚙ memory.search");
  assert.equal(describeItem({ type: "reasoning" }), null);
});

test("ad run prints a message that arrives whole (no deltas)", async () => {
  const r = await run("edit-file");
  assert.equal(r.stdout, "edit[decline]\n");
});

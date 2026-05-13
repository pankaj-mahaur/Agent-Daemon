// Subprocess test for the UserPromptSubmit hook handler.
// Invokes `node src/cli.mjs hook user-prompt-extract`, pipes a fake Claude
// Code hook payload to stdin, and asserts the journal lands the learning.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI = path.resolve(__dirname, "..", "src", "cli.mjs");

async function makeTmp() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ad-uph-"));
}

/** @returns {Promise<{code: number, stdout: string, stderr: string}>} */
function runHook(payload) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, "hook", "user-prompt-extract"], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", c => stdout += c.toString());
    proc.stderr.on("data", c => stderr += c.toString());
    proc.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    proc.stdin.end(JSON.stringify(payload));
  });
}

test("subprocess: 'actually we use X' correction lands in the journal", async () => {
  const cwd = await makeTmp();
  const result = await runHook({
    session_id: "s-test-1",
    cwd,
    prompt: "Actually, we use pnpm here, not npm.",
    hook_event_name: "UserPromptSubmit"
  });
  assert.equal(result.code, 0);

  const journalFile = path.join(cwd, ".agent-daemon", "learning-journal.jsonl");
  const raw = await fs.readFile(journalFile, "utf8");
  const lines = raw.trim().split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length >= 1, "expected at least one journal line");
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.type, "correction");
  assert.match(entry.text.toLowerCase(), /pnpm/);
});

test("subprocess: returns 0 with passthrough output even on empty prompt", async () => {
  const cwd = await makeTmp();
  const result = await runHook({ cwd, prompt: "", hook_event_name: "UserPromptSubmit" });
  assert.equal(result.code, 0);
  // stdout should be the passthrough JSON {}
  assert.equal(result.stdout.trim(), "{}");
});

test("subprocess: malformed stdin doesn't crash the hook", async () => {
  const cwd = await makeTmp();
  // Send raw bytes that aren't valid JSON
  const proc = spawn(process.execPath, [CLI, "hook", "user-prompt-extract"], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  proc.stdin.end("not json {{{");
  await new Promise((res) => proc.on("close", res));
  assert.equal(proc.exitCode, 0);
});

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

test("subprocess: injected daemon protocol examples from assistant are not persisted", async () => {
  const cwd = await makeTmp();
  const transcript = path.join(cwd, "transcript.jsonl");
  const polluted = {
    type: "assistant",
    uuid: "pollution",
    message: {
      role: "assistant",
      content: "SessionStart hook -> UserPromptSubmit. Remember: X\") -> SQLite via learning-journal.jsonl. <agent-daemon-digest>{}</agent-daemon-digest>"
    }
  };
  await fs.writeFile(transcript, JSON.stringify(polluted) + "\n", "utf8");
  const result = await runHook({
    session_id: "s-polluted",
    cwd,
    prompt: "continue",
    transcript_path: transcript,
    hook_event_name: "UserPromptSubmit"
  });
  assert.equal(result.code, 0);
  await assert.rejects(
    fs.readFile(path.join(cwd, ".agent-daemon", "learning-journal.jsonl"), "utf8"),
    /ENOENT/
  );
});

test("subprocess (Codex host): assistant 'remember:' note is read from a rollout transcript", async () => {
  const cwd = await makeTmp();
  const transcript = path.join(cwd, "rollout-2026-10-01T00-00-00-x.jsonl");
  const lines = [
    { type: "session_meta", payload: { id: "s-codex", cwd } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done. Remember: always run npm run lint before committing in this repo." }] } },
  ];
  await fs.writeFile(transcript, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const result = await new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, "hook", "user-prompt-extract", "--host", "codex"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    proc.stdout.on("data", (c) => (stdout += c));
    proc.on("close", (code) => resolve({ code, stdout }));
    proc.stdin.end(JSON.stringify({ session_id: "s-codex", cwd, transcript_path: transcript, prompt: "ok, next task please", hook_event_name: "UserPromptSubmit" }));
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "{}");
  const raw = await fs.readFile(path.join(cwd, ".agent-daemon", "learning-journal.jsonl"), "utf8");
  assert.match(raw, /npm run lint before committing/);
});

test("subprocess: a team worker's prompt (AD_WORKER=1) is not captured as the user's correction", async () => {
  const cwd = await makeTmp();
  const code = await new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, "hook", "user-prompt-extract", "--host", "codex"], { stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, AD_WORKER: "1" } });
    proc.on("close", resolve);
    proc.stdin.end(JSON.stringify({ session_id: "w", cwd, prompt: "Actually, we use pnpm here, not npm.", hook_event_name: "UserPromptSubmit" }));
  });
  assert.equal(code, 0);
  await assert.rejects(fs.readFile(path.join(cwd, ".agent-daemon", "learning-journal.jsonl"), "utf8"), /ENOENT/);
});

test("subprocess: Codex's plan hand-off (a prompt the client wrote) is never captured as the user's words", async () => {
  const { CODEX_PLAN_CLEAR_CONTEXT_PREFIX, isGeneratedPrompt } = await import("../src/hooks/generated-prompts.mjs");
  const plan = ["# Switch the package manager", "", "- Actually, we use pnpm here, not npm."].join("\n");
  const handoff = `${CODEX_PLAN_CLEAR_CONTEXT_PREFIX}\n\n${plan}`;
  assert.equal(isGeneratedPrompt(handoff), true);
  assert.equal(isGeneratedPrompt(`<private>${handoff}</private>`), true, "a /private wrapper doesn't hide it");
  assert.equal(isGeneratedPrompt("Implement the plan."), false, "Codex's short hand-off is a real user message");
  assert.equal(isGeneratedPrompt(plan), false);
  const run = (cwd, prompt) =>
    new Promise((resolve) => {
      const proc = spawn(process.execPath, [CLI, "hook", "user-prompt-extract", "--host", "codex"], { stdio: ["pipe", "ignore", "ignore"] });
      proc.on("close", resolve);
      proc.stdin.end(JSON.stringify({ session_id: "p", cwd, prompt, hook_event_name: "UserPromptSubmit" }));
    });
  const cwd = await makeTmp();
  assert.equal(await run(cwd, handoff), 0);
  await assert.rejects(fs.readFile(path.join(cwd, ".agent-daemon", "learning-journal.jsonl"), "utf8"), /ENOENT/);
  // The same words typed by the user are a correction.
  const typed = await makeTmp();
  assert.equal(await run(typed, "Actually, we use pnpm here, not npm."), 0);
  assert.match(await fs.readFile(path.join(typed, ".agent-daemon", "learning-journal.jsonl"), "utf8"), /pnpm/);
});

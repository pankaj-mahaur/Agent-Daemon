// Tests for runtime/src/hooks/* — exercise each handler via subprocess so we
// observe its actual stdin → stdout → stderr → exit-code behavior.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "..", "src", "cli.mjs");

function runHook(handler, stdinObj) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [CLI, "hook", handler], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => res({ code, out, err }));
    child.stdin.end(JSON.stringify(stdinObj));
  });
}

// -- bash-pre -----------------------------------------------------------------

test("bash-pre blocks `git push --no-verify`", async () => {
  const { code, out } = await runHook("bash-pre", { tool_input: { command: "git push --no-verify" } });
  assert.equal(code, 0);
  const decision = JSON.parse(out);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /--no-verify/);
});

test("bash-pre blocks `git commit --no-verify`", async () => {
  const { out } = await runHook("bash-pre", { tool_input: { command: "git commit -m foo --no-verify" } });
  assert.equal(JSON.parse(out).decision, "block");
});

test("bash-pre approves harmless commands", async () => {
  const { out } = await runHook("bash-pre", { tool_input: { command: "ls -la" } });
  assert.equal(JSON.parse(out).decision, "approve");
});

test("bash-pre approves `git push` but warns on stderr", async () => {
  const { out, err } = await runHook("bash-pre", { tool_input: { command: "git push origin main" } });
  assert.equal(JSON.parse(out).decision, "approve");
  assert.match(err, /review changes first/i);
});

// -- bash-post ----------------------------------------------------------------

test("bash-post surfaces PR URL on stderr after `gh pr create`", async () => {
  const { out, err } = await runHook("bash-post", {
    tool_input: { command: "gh pr create" },
    tool_response: { output: "https://github.com/foo/bar/pull/42" },
  });
  assert.equal(out.trim(), "{}");
  assert.match(err, /PR created.*pull\/42/);
  assert.match(err, /gh pr view 42 --repo foo\/bar/);
});

test("bash-post is silent for unrelated commands", async () => {
  const { err } = await runHook("bash-post", {
    tool_input: { command: "ls" },
    tool_response: { output: "file.txt" },
  });
  assert.equal(err, "");
});

// -- mcp-audit ---------------------------------------------------------------

test("mcp-audit approves trusted servers without warning", async () => {
  const { out, err } = await runHook("mcp-pre", { tool_name: "mcp__qmd__search" });
  assert.equal(JSON.parse(out).decision, "approve");
  assert.equal(err, "");
});

test("mcp-audit warns on untrusted servers", async () => {
  const { out, err } = await runHook("mcp-pre", { tool_name: "mcp__sketchy__exfil" });
  assert.equal(JSON.parse(out).decision, "approve");
  assert.match(err, /non-trusted server 'sketchy'/);
});

test("mcp-audit ignores non-MCP tool names", async () => {
  const { out, err } = await runHook("mcp-pre", { tool_name: "Bash" });
  assert.equal(JSON.parse(out).decision, "approve");
  assert.equal(err, "");
});

// -- edit-post ---------------------------------------------------------------

test("edit-post warns on console.log in just-edited JS", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ad-edit-post-"));
  const file = join(dir, "f.js");
  writeFileSync(file, 'function x() {\n  console.log("debug");\n  return 1;\n}\n');
  try {
    const { out, err } = await runHook("edit-post", { tool_input: { file_path: file } });
    assert.equal(out.trim(), "{}");
    assert.match(err, /console\.log left in/);
    assert.match(err, /2: console\.log/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit-post passes through for non-JS files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ad-edit-post-"));
  const file = join(dir, "README.md");
  writeFileSync(file, "console.log('this is markdown not code')\n");
  try {
    const { err } = await runHook("edit-post", { tool_input: { file_path: file } });
    assert.equal(err, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit-post is quiet when the JS file has no console.log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ad-edit-post-"));
  const file = join(dir, "clean.js");
  writeFileSync(file, "function x() { return 1; }\n");
  try {
    const { err } = await runHook("edit-post", { tool_input: { file_path: file } });
    assert.equal(err, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- mcp-audit rotation ------------------------------------------------------

test("mcp-audit rotates the log when it exceeds ROTATE_BYTES", async () => {
  const { mkdtempSync, writeFileSync, statSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  // Point the hook at a scratch AGENT_DAEMON_HOME and pre-fill the log past
  // the rotation threshold (10 MB).
  const home = mkdtempSync(join(tmpdir(), "ad-mcp-rotate-"));
  const auditDir = join(home, "audit");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(auditDir, { recursive: true });
  const log = join(auditDir, "mcp.jsonl");
  // Write 10.5 MB of placeholder JSONL lines so the rotation trips.
  writeFileSync(log, "x".repeat(11 * 1024 * 1024));
  assert.equal(statSync(log).size >= 10 * 1024 * 1024, true);

  try {
    // Spawn the handler with AGENT_DAEMON_HOME pointing at our scratch.
    await new Promise((res) => {
      const child = spawn(process.execPath, [CLI, "hook", "mcp-pre"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, AGENT_DAEMON_HOME: home },
      });
      child.on("close", () => res());
      child.stdin.end(JSON.stringify({ tool_name: "mcp__qmd__search" }));
    });

    // Old log should have been rotated to .1, new log should be small (~1 line).
    assert.ok(existsSync(`${log}.1`), "expected log.1 after rotation");
    assert.ok(statSync(log).size < 1024, "expected new log to be tiny after rotation");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// -- unknown handler ---------------------------------------------------------

test("unknown hook handler exits non-zero with help text", async () => {
  const { code, err } = await runHook("does-not-exist", {});
  assert.notEqual(code, 0);
  assert.match(err, /unknown handler/);
});

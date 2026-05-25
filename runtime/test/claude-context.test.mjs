import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "../src/memory/sqlite.mjs";
import { projectSlug } from "../src/memory/episodic.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");

function runCli(args, input, home) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    child.stdout.on("data", c => stdout += c.toString());
    child.on("close", code => resolve({ code, stdout }));
    child.stdin.end(input ? JSON.stringify(input) : "");
  });
}

test("SessionStart prioritizes active memory and recent learnings under the 9 KB cap", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ad-session-start-"));
  const project = path.join(root, "project");
  const memory = path.join(project, ".agent-daemon", "memory");
  await fs.mkdir(memory, { recursive: true });
  await fs.writeFile(path.join(memory, "activeContext.md"), "# Active\nACTIVE-SURVIVES\n" + "context ".repeat(1800), "utf8");
  await fs.writeFile(path.join(root, ".claude.json"), JSON.stringify({ mcpServers: { qmd: { command: "qmd" } } }), "utf8");
  const db = await open({ dbPath: path.join(root, ".agent-daemon", "episodic.db") });
  db.run("INSERT INTO learnings (project_slug, category, text, confidence) VALUES (?, 'correction', 'RECENT-SURVIVES use pnpm for this project', 0.9)", [projectSlug(project)]);
  db.close();
  try {
    const result = await runCli(["session-start", "--output-json", "--cwd", project], null, root);
    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
    const context = output.hookSpecificOutput.additionalContext;
    assert.match(context, /ACTIVE-SURVIVES/);
    assert.match(context, /RECENT-SURVIVES/);
    assert.ok(Buffer.byteLength(context, "utf8") <= 9000);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("UserPromptSubmit retrieval reads the prompt payload and uses the official output envelope", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ad-query-retrieve-"));
  const project = path.join(root, "project");
  await fs.mkdir(project);
  const db = await open({ dbPath: path.join(root, ".agent-daemon", "episodic.db") });
  db.run("INSERT INTO learnings (project_slug, category, text, confidence) VALUES (?, 'gotcha', 'pnpm workspace requires frozen lockfile', 0.9)", [projectSlug(project)]);
  db.close();
  try {
    const result = await runCli(
      ["query-retrieve", "--output-json", "--cwd", project],
      { hook_event_name: "UserPromptSubmit", cwd: project, prompt: "Please debug the pnpm workspace lockfile error." },
      root
    );
    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(output.hookSpecificOutput.additionalContext, /frozen lockfile/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

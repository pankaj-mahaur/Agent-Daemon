import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "../src/memory/sqlite.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");

function run(args, payload, home) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    child.stdout.on("data", c => stdout += c.toString());
    child.on("close", code => resolve({ code, stdout }));
    child.stdin.end(payload ? JSON.stringify(payload) : "");
  });
}

test("Claude skill telemetry records unknown invocation, correlates correction, and exports trace metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ad-skill-telemetry-"));
  const project = path.join(root, "project");
  await fs.mkdir(project);
  try {
    let result = await run(["hook", "skill-use"], {
      hook_event_name: "PreToolUse",
      session_id: "telemetry-1",
      cwd: project,
      tool_input: { skill: "debug-triage", prompt: "debug install" }
    }, root);
    assert.equal(result.code, 0);

    let db = await open({ dbPath: path.join(root, ".agent-daemon", "episodic.db") });
    let row = db.get("SELECT * FROM skill_executions WHERE session_id = 'telemetry-1'");
    assert.equal(row.skill_name, "debug-triage");
    assert.equal(row.succeeded, null);
    assert.equal(row.invocation_source, "skill-tool");
    db.close();

    result = await run(["hook", "user-prompt-extract"], {
      hook_event_name: "UserPromptSubmit",
      session_id: "telemetry-1",
      cwd: project,
      prompt: "Actually, we use pnpm here, not npm."
    }, root);
    assert.equal(result.code, 0);

    db = await open({ dbPath: path.join(root, ".agent-daemon", "episodic.db") });
    row = db.get("SELECT * FROM skill_executions WHERE session_id = 'telemetry-1'");
    assert.equal(row.succeeded, 0);
    assert.match(row.outcome_source, /user-prompt/);
    db.close();

    result = await run(["evolve", "debug-triage", "--export-traces", "--json", "--cwd", project], null, root);
    assert.equal(result.code, 0);
    const exported = JSON.parse(result.stdout);
    const trace = JSON.parse((await fs.readFile(exported.path, "utf8")).trim());
    assert.equal(trace.invocation_source, "skill-tool");
    assert.match(trace.outcome_source, /user-prompt/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

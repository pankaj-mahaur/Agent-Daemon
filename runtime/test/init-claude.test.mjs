import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");

async function runInit(cwd, home) {
  return await new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, "init", "--cwd", cwd, "--profile", "minimal", "--skills-mode", "manual"], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    child.stdout.on("data", c => stdout += c.toString());
    child.on("close", code => resolve({ code, stdout }));
  });
}

async function runDoctor(cwd, home) {
  return await new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, "doctor", "--cwd", cwd], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    child.stdout.on("data", c => stdout += c.toString());
    child.on("close", code => resolve({ code, stdout }));
  });
}

test("ad init creates, refreshes, and preserves project CLAUDE.md content", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ad-init-claude-"));
  const project = path.join(root, "project");
  await fs.mkdir(project);
  try {
    let result = await runInit(project, root);
    assert.equal(result.code, 0);
    const created = await fs.readFile(path.join(project, "CLAUDE.md"), "utf8");
    assert.match(created, /<!-- agent-daemon:start -->/);
    assert.match(created, /continuous extraction still runs/i);
    const diagnosis = await runDoctor(project, root);
    assert.notEqual(diagnosis.code, 0, "new templates should require bootstrap");
    assert.match(diagnosis.stdout, /Project CLAUDE\.md instructions/);
    assert.match(diagnosis.stdout, /Prompt retrieval hook/);
    assert.match(diagnosis.stdout, /Skill invocation telemetry/);
    assert.match(diagnosis.stdout, /Project memory bootstrap/);
    assert.match(diagnosis.stdout, /Skill execution traces/);

    const userContent = "# User-owned instructions\n\nKeep this section.\n\n";
    await fs.writeFile(
      path.join(project, "CLAUDE.md"),
      userContent + "<!-- agent-daemon:start -->\nold block\n<!-- agent-daemon:end -->\n",
      "utf8"
    );
    result = await runInit(project, root);
    assert.equal(result.code, 0);
    const refreshed = await fs.readFile(path.join(project, "CLAUDE.md"), "utf8");
    assert.ok(refreshed.startsWith(userContent));
    assert.doesNotMatch(refreshed, /old block/);

    await runInit(project, root);
    const idempotent = await fs.readFile(path.join(project, "CLAUDE.md"), "utf8");
    assert.equal(idempotent, refreshed);

    const memoryDir = path.join(project, ".agent-daemon", "memory");
    for (const file of await fs.readdir(memoryDir)) {
      if (file.endsWith(".md")) {
        await fs.writeFile(path.join(memoryDir, file), "# Grounded\n\nReal project context.\n", "utf8");
      }
    }
    await fs.writeFile(
      path.join(project, "CLAUDE.md"),
      userContent + "<!-- agent-daemon:start -->\nstale again\n<!-- agent-daemon:end -->\n",
      "utf8"
    );
    const grounded = await runInit(project, root);
    assert.match(grounded.stdout, /already contain grounded context/);
    assert.doesNotMatch(grounded.stdout, /contain template placeholders/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

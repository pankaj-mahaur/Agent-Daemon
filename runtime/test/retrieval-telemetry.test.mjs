// Tests for measurement-first retrieval telemetry: session-start budget stats
// (JSONL) and the 9KB output cap staying intact.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "..", "src", "cli.mjs");
const PROJECT_ROOT = path.resolve(HERE, "..", "..");

function run(args, home, extraEnv = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, AGENT_DAEMON_DISABLE_SWEEP: "1", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => stdout += c.toString());
    child.stderr.on("data", c => stderr += c.toString());
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

async function makeProject(root, activeContextBytes) {
  const project = path.join(root, "proj");
  const memDir = path.join(project, ".agent-daemon", "memory");
  await fs.mkdir(memDir, { recursive: true });
  // Build an activeContext of the requested size from dated one-liners
  const line = "- 2026-06-01: a representative activeContext memory line for telemetry sizing tests\n";
  const repeats = Math.ceil(activeContextBytes / line.length);
  await fs.writeFile(path.join(memDir, "activeContext.md"), `# Active context\n\n${line.repeat(repeats)}`, "utf8");
  return project;
}

test("session-start output stays under 9KB and telemetry JSONL records truncation on a large memory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ad-telemetry-"));
  try {
    const project = await makeProject(root, 30 * 1024);  // 30KB — must truncate

    const r = await run(["session-start", "--cwd", project], root);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(Buffer.byteLength(r.stdout, "utf8") <= 9100, `output ${Buffer.byteLength(r.stdout, "utf8")}B exceeds cap`);
    assert.match(r.stdout, /context truncated to fit 9KB hook cap/);

    const telFile = path.join(project, ".agent-daemon", "telemetry", "session-start.jsonl");
    const lines = (await fs.readFile(telFile, "utf8")).trim().split("\n");
    const event = JSON.parse(lines[lines.length - 1]);
    assert.equal(event.truncated, true);
    assert.ok(event.consideredBytes > event.injectedBytes, "considered > injected when truncated");
    const memGroup = event.groups.find(g => g.label === "memory");
    assert.ok(memGroup, "memory group recorded");
    assert.equal(memGroup.truncated, true, "memory group flagged as truncated");
  } finally {
    try { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* tmp */ }
  }
});

test("small memory project: no truncation recorded, output unchanged in shape", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ad-telemetry-small-"));
  try {
    const project = await makeProject(root, 500);
    // Point the runtime root at an empty dir — the real repo's constitution
    // alone overflows the static budget, which would mask this assertion.
    const emptyRoot = path.join(root, "empty-runtime-root");
    await fs.mkdir(emptyRoot, { recursive: true });

    const r = await run(["session-start", "--cwd", project], root, { AGENT_DAEMON_HOME: emptyRoot });
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /context truncated/);
    assert.match(r.stdout, /activeContext/);

    const telFile = path.join(project, ".agent-daemon", "telemetry", "session-start.jsonl");
    const event = JSON.parse((await fs.readFile(telFile, "utf8")).trim().split("\n").pop());
    assert.equal(event.truncated, false);
  } finally {
    try { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* tmp */ }
  }
});

test("ad memory stats runs and reports the episodic store", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ad-memstats-"));
  try {
    const r = await run(["memory", "stats"], root);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Episodic store:/);
    assert.match(r.stdout, /learnings/);
  } finally {
    try { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* tmp */ }
  }
});

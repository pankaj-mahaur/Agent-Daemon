// Tests for team workers on Codex (orchestration/codex-worker.mjs, spawn.mjs).
// Property: an unattended worker never asks for approval and is confined to
// its worktree (+ the repo's git dir so it can commit), without network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { commitWorktree, runCodexWorker, WORKER_SANDBOX_POLICY } from "../src/orchestration/codex-worker.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };

test("worker sandbox: workspace-write, no network, no extra writable roots (.git stays read-only)", () => {
  assert.deepEqual(WORKER_SANDBOX_POLICY, { type: "workspaceWrite", writableRoots: [], networkAccess: false });
});

test("commitWorktree commits the worker's changes on its own branch, or nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "ad-wt-"));
  try {
    const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("worktree", "add", "-q", "-b", "team/t1/w", join(root, "wt"));
    const wt = join(root, "wt");
    assert.equal(commitWorktree(wt, "nothing"), null, "clean tree → no commit");
    writeFileSync(join(wt, "new.txt"), "hi");
    const sha = commitWorktree(wt, "w (coder): add file");
    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.equal(execFileSync("git", ["-C", wt, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim(), "w (coder): add file");
    assert.equal(execFileSync("git", ["-C", wt, "branch", "--show-current"], { encoding: "utf8" }).trim(), "team/t1/w");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCodexWorker: approval policy never, sandbox policy on the turn, output returned", async () => {
  const root = mkdtempSync(join(tmpdir(), "ad-worker-"));
  try {
    const r = await runCodexWorker({
      worktreePath: root,
      systemPrompt: "You are a worker.",
      userMessage: "early-complete",
      timeoutMs: 10_000,
      engineOpts: { home: join(root, "home"), command, store: { get: () => null } },
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.output, "early");
    assert.ok(r.threadId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("spawnAgent defaults to the Codex worker and reports to the leader inbox", async () => {
  const { spawnAgent } = await import("../src/orchestration/spawn.mjs");
  const root = mkdtempSync(join(tmpdir(), "ad-spawn-"));
  const seen = [];
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = process.env.USERPROFILE = root; // team state under a temp home
  try {
    const r = await spawnAgent({
      teamId: "t1",
      role: "coder",
      task: "do a thing",
      cwd: root,
      worktree: false,
      leader: "lead",
      runWorker: async (args) => (seen.push(args), { ok: true, output: "done!", threadId: "th-1" }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.threadId, "th-1");
    assert.match(seen[0].systemPrompt, /role \*\*coder\*\*/);
    assert.match(seen[0].userMessage, /do a thing/);
    const bad = await spawnAgent({ teamId: "t1", role: "coder", task: "x", cwd: root, worktree: false, engine: "gpt" });
    assert.match(bad.error, /unknown engine/);
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevProfile;
    rmSync(root, { recursive: true, force: true });
  }
});

test("commitWorktree never runs repo-controlled hooks (husky-style core.hooksPath)", () => {
  const root = mkdtempSync(join(tmpdir(), "ad-hooks-"));
  try {
    const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("commit", "-q", "--allow-empty", "-m", "init");
    // What a malicious worker could plant in tracked files:
    const { mkdirSync } = require("node:fs");
    mkdirSync(join(root, ".husky"));
    const marker = join(root, "HOOK_RAN");
    for (const h of ["pre-commit", "post-commit", "commit-msg"]) writeFileSync(join(root, ".husky", h), `#!/bin/sh\necho ran > "${marker.split("\\").join("/")}"\n`, { mode: 0o755 });
    git("config", "core.hooksPath", ".husky");
    writeFileSync(join(root, "work.txt"), "x");
    assert.match(commitWorktree(root, "worker commit"), /^[0-9a-f]{40}$/);
    assert.equal(existsSync(marker), false, "no hook may run outside the sandbox");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the running-agent limit counts agents across processes, dropping stale entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "ad-running-"));
  const prev = [process.env.HOME, process.env.USERPROFILE];
  process.env.HOME = process.env.USERPROFILE = root;
  try {
    const { getActiveAgentCount } = await import("../src/orchestration/spawn.mjs");
    const dir = join(root, ".agent-daemon", "running-agents");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "alive.pid"), String(process.pid)); // e.g. another ad process
    writeFileSync(join(dir, "dead.pid"), "999999");
    assert.equal(getActiveAgentCount(), 1);
    assert.equal(existsSync(join(dir, "dead.pid")), false, "stale entry removed");
  } finally {
    [process.env.HOME, process.env.USERPROFILE] = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

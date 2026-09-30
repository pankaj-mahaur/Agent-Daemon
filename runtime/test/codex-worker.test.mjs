// Tests for team workers on Codex (orchestration/codex-worker.mjs, spawn.mjs).
// Property: an unattended worker never asks for approval and is confined to
// its worktree (+ the repo's git dir so it can commit), without network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitCommonDir, runCodexWorker, workerSandboxPolicy } from "../src/orchestration/codex-worker.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };

test("workerSandboxPolicy: workspace-write, no network, git dir writable only when outside", () => {
  const wt = resolve("/repo/.worktrees/a");
  assert.deepEqual(workerSandboxPolicy(wt, resolve("/repo/.git")), { type: "workspaceWrite", writableRoots: [resolve("/repo/.git")], networkAccess: false });
  assert.deepEqual(workerSandboxPolicy(wt, join(wt, ".git")).writableRoots, [], "a git dir inside the worktree needs no extra root");
  assert.deepEqual(workerSandboxPolicy(wt, null).writableRoots, []);
});

test("gitCommonDir resolves a real worktree's shared git dir", () => {
  const root = mkdtempSync(join(tmpdir(), "ad-wt-"));
  try {
    const git = (...a) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    git("worktree", "add", "-q", "-b", "w", join(root, "wt"));
    assert.equal(resolve(gitCommonDir(join(root, "wt"))).toLowerCase(), resolve(root, ".git").toLowerCase());
    assert.equal(gitCommonDir(tmpdir() + "/definitely-not-a-repo-xyz"), null);
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

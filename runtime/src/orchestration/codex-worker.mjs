// One team worker as a Codex thread (replaces `claude --print
// --dangerously-skip-permissions` for workers).
//
// Safety model: the worker runs unattended, so it never asks — approval
// policy "never" — and is confined by the sandbox instead: workspace-write
// rooted at its own worktree, no network, and NO extra writable roots.
// In particular the repo's shared .git dir stays read-only to it: a
// writable .git would let a (prompt-injected) worker plant hooks/ or
// core.fsmonitor that run later outside any sandbox, or move other
// branches. The worker's changes are committed afterwards by us
// (commitWorktree), outside the sandbox, on the worker's own branch only.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHarnessEngine } from "../harness/start.mjs";
import { UNATTENDED_ENV, UNATTENDED_SANDBOX_POLICY, unattendedThreadConfig } from "../harness/unattended.mjs";

export const WORKER_SANDBOX_POLICY = UNATTENDED_SANDBOX_POLICY;
const CLAUDE_ALIASES = new Set(["haiku", "sonnet", "opus"]);

export const WORKER_COMMIT_NOTE = "Do not run git commit or change git config — your changes are committed automatically on your branch when you finish.";

// Commit everything the worker changed in its worktree. Returns the commit
// sha, or null when there was nothing to commit.
//
// This runs OUTSIDE the sandbox, so it must not execute anything the worker
// could have written: tracked hook setups (husky's core.hooksPath=.husky,
// lint-staged, pre-commit configs) live in the worktree the worker edits.
// Every git call gets hooks pointed at an empty directory, fsmonitor off
// and no verification hooks — `--no-verify` alone would still run
// post-commit.
export function commitWorktree(worktreePath, message, run = execFileSync) {
  const noHooks = mkdtempSync(path.join(tmpdir(), "ad-nohooks-"));
  const safe = ["-c", `core.hooksPath=${noHooks}`, "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false"];
  const git = (...args) => run("git", ["-C", worktreePath, ...safe, ...args], { encoding: "utf8", windowsHide: true }).trim();
  try {
    if (!git("status", "--porcelain")) return null;
    git("add", "-A");
    git("commit", "--no-verify", "-m", message);
    return git("rev-parse", "HEAD");
  } finally {
    rmSync(noHooks, { recursive: true, force: true });
  }
}

/**
 * @returns {Promise<{ok: boolean, status?: string, output?: string, threadId?: string, error?: string}>}
 */
export async function runCodexWorker({ worktreePath, systemPrompt, userMessage, model, timeoutMs, engineOpts = {}, onEvent, err = process.stderr }) {
  let engine;
  try {
    const prefixed = { write: (s) => err.write(String(s).replace(/^\[agent-daemon\]/gm, "[agent-daemon worker]")) };
    // AD_WORKER: the prompt is the leader's task, not the user speaking —
    // hooks must not capture it as the user's corrections.
    const started = await startHarnessEngine({ cwd: worktreePath, err: prefixed, requireSandbox: true, ...engineOpts, env: { ...UNATTENDED_ENV, ...(engineOpts.env ?? {}) } });
    if (!started.engine) return { ok: false, error: started.error };
    engine = started.engine;
    const { threadId } = await engine.startThread({
      cwd: worktreePath,
      model: CLAUDE_ALIASES.has(model) ? undefined : model, // `--model sonnet` from Claude-mode habits
      sandbox: "workspace-write",
      approvalPolicy: "never",
      developerInstructions: `${systemPrompt}\n\n${WORKER_COMMIT_NOTE}`,
      config: await unattendedThreadConfig(engine),
    });
    const r = await engine.turn({ threadId, text: userMessage, timeoutMs, sandboxPolicy: WORKER_SANDBOX_POLICY, onEvent });
    return { ok: r.status === "completed", status: r.status, output: r.output, threadId, error: r.status === "completed" ? undefined : r.error?.message ?? `turn ${r.status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    await engine?.close();
  }
}

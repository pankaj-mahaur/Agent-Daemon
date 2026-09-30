// One team worker as a Codex thread (replaces `claude --print
// --dangerously-skip-permissions` for workers).
//
// Safety model: the worker runs unattended, so it never asks — approval
// policy "never" — and is confined by the sandbox instead: workspace-write
// rooted at its own worktree, no network. The one extra writable root is
// the repo's shared git dir, which a worktree needs to commit.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { startHarnessEngine } from "../harness/start.mjs";

// Absolute git common dir for a worktree (where commits are written).
export function gitCommonDir(worktreePath, run = execFileSync) {
  try {
    const out = run("git", ["-C", worktreePath, "rev-parse", "--git-common-dir"], { encoding: "utf8", windowsHide: true }).trim();
    return out ? path.resolve(worktreePath, out) : null;
  } catch {
    return null; // not a git worktree → nothing extra to allow
  }
}

export function workerSandboxPolicy(worktreePath, commonDir) {
  const roots = commonDir && !isInside(commonDir, worktreePath) ? [commonDir] : [];
  return { type: "workspaceWrite", writableRoots: roots, networkAccess: false };
}

const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/**
 * @returns {Promise<{ok: boolean, status?: string, output?: string, threadId?: string, error?: string}>}
 */
export async function runCodexWorker({ worktreePath, systemPrompt, userMessage, model, timeoutMs, engineOpts = {}, onEvent }) {
  let engine;
  try {
    const started = await startHarnessEngine({ cwd: worktreePath, err: { write: () => true }, ...engineOpts });
    if (!started.engine) return { ok: false, error: started.error };
    engine = started.engine;
    const { threadId } = await engine.startThread({
      cwd: worktreePath,
      model,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      developerInstructions: systemPrompt,
    });
    const r = await engine.turn({
      threadId,
      text: userMessage,
      timeoutMs,
      sandboxPolicy: workerSandboxPolicy(worktreePath, gitCommonDir(worktreePath)),
      onEvent,
    });
    return { ok: r.status === "completed", status: r.status, output: r.output, threadId, error: r.status === "completed" ? undefined : r.error?.message ?? `turn ${r.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    await engine?.close();
  }
}

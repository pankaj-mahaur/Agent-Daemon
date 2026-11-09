// Session start's recall part (MCP launch plan L6, design decisions 7, 8, 10): the
// brief, claimed once per session and event, its context job, its local counters.
// session-start.mjs places the block (its own first group) and, for the memory
// product, holds the whole injection to 1,200 tokens.

import { fileURLToPath } from "node:url";
import { buildBrief } from "./recall-brief.mjs";
import { jobKey } from "./recall-context.mjs";
import { recallMode, briefAllowed } from "./recall-mode.mjs";
import { isProjectId } from "./projects.mjs";

export const RECALL_JOB = fileURLToPath(new URL("./recall-context-job.mjs", import.meta.url));
export const JOB_WINDOW_MS = 10 * 60_000;

/** Start the context job for a stale cache (single-flight per root and branch). */
export async function spawnContextJob(ctx) {
  const { spawnDetached } = await import("../hooks/detached.mjs");
  return spawnDetached([RECALL_JOB, ctx.root], { key: jobKey(ctx.root, ctx.branch), windowMs: JOB_WINDOW_MS });
}

/**
 * The brief for this session start, or null (nothing to show, recall off, no store).
 * The caller claims the delivery first (recall-deliver.mjs), for the brief and the
 * profile together.
 * @param {object} handle  an open store
 * @param {{cwd: string, keys: string[], product: string,
 *          review?: string|null, budget?: number, now?: number, spawn?: Function|false}} o
 * @returns {Promise<{text: string, ids: number[], tokens: number, fallback: boolean} | null>}
 */
export async function sessionBrief(handle, { cwd, keys, product, review = null, budget, now = Date.now(), spawn }) {
  if (!handle || !keys?.length) return null;
  const projectId = keys.find(isProjectId) ?? null;
  if (!briefAllowed(recallMode(handle, projectId))) return null;
  const pending = [];
  const b = buildBrief(handle, {
    cwd,
    keys,
    product,
    review,
    ...(budget ? { budget } : {}),
    now,
    // The job starts after the brief is built, never awaited (the hook exits at once).
    spawn: spawn === false ? false : (ctx) => pending.push(ctx),
  });
  for (const ctx of pending) {
    try {
      await (spawn || spawnContextJob)(ctx);
    } catch {
      // the next session start tries again; the brief still goes out
    }
  }
  return b.text ? { text: b.text, ids: b.ids, tokens: b.tokens, fallback: b.fallback } : null;
}

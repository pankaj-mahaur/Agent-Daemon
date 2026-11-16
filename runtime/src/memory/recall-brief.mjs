// The session brief, end to end (MCP launch plan L6, design decisions 5, 8, 9): the
// rows recall may serve (recall.mjs), ranked against the cached repo context
// (recall-context.mjs) by the core (recall-rank.mjs), laid out within the budget
// (recall-render.mjs). The hook and doctor call the same function; doctor passes
// spawn:false so nothing starts and nothing is recorded.

import os from "node:os";
import { readContext, jobAllowed } from "./recall-context.mjs";
import { recallRows } from "./recall.mjs";
import { selectBrief, contextQuery } from "./recall-rank.mjs";
import { renderBrief, BRIEF_BUDGET } from "./recall-render.mjs";
import { expiringSoon } from "./purge.mjs";
import { isStrict } from "./review-mode.mjs";

// The FTS prefilter's query from the context's strongest words (used only for very large stores).
function ftsQueryOf(ctx) {
  const words = [...contextQuery(ctx)].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([t]) => `"${t.replace(/"/g, '""')}"*`);
  return words.length ? words.join(" OR ") : null;
}

/**
 * Build the brief for a folder.
 * @param {object} handle  an open store
 * @param {{cwd: string, keys: string[], product: string, review?: string|null,
 *          budget?: number, now?: number, root?: string, home?: string,
 *          spawn?: ((ctx: object) => void) | false}} o
 *   spawn: start the context job when the cache is stale (the hook passes one, called with the
 *   context; doctor passes false)
 * @returns {{text: string|null, ids: number[], tokens: number, notes: number, fallback: boolean, context: object}}
 */
export function buildBrief(handle, { cwd, keys, product, review = null, budget = BRIEF_BUDGET, now = Date.now(), root, home = os.homedir(), spawn = false }) {
  let ctx = readContext(cwd, { ...(root ? { root } : {}), now });
  // A repository at or above the home folder (a dotfiles repo) is no project's context.
  if (ctx.root && !jobAllowed(ctx.root, { home })) ctx = { root: null, branch: null, paths: [], commits: [], stale: false, at: null, from: null };
  // The job runs only for a bound project, outside the home folder and above it.
  if (spawn && ctx.root && ctx.stale && keys?.length && jobAllowed(ctx.root, { home })) {
    try {
      spawn(ctx);
    } catch {
      // the next session start tries again
    }
  }
  const context = { branch: ctx.branch, paths: ctx.paths, commits: ctx.commits };
  const rows = recallRows(handle, keys, { now, ftsQuery: ftsQueryOf(context) });
  let sel = selectBrief(rows, context, { now });
  // No cache yet (the first session in a repo or on a branch) or a quiet repo (no
  // changed files, no recent commits): the branch alone is a weak signal. When it
  // matches nothing, the freshest notes go instead (decision 5's fallback).
  const weak = !ctx.at || (!ctx.paths.length && !ctx.commits.length);
  if (!sel.fallback && weak && !sel.work.length) {
    // The freshest notes of the whole project, not the branch search's narrowed rows.
    sel = selectBrief(recallRows(handle, keys, { now, ftsQuery: null }), {}, { now });
  }
  const expiring = isStrict(handle) ? 0 : expiringSoon(handle, keys, { days: 7, now });
  const block = renderBrief({ standing: sel.standing.map((r) => r.note), work: sel.work.map((r) => r.note), branch: ctx.branch, fallback: sel.fallback ? (ctx.root ? true : "no-git") : false, expiring, review, product, budget, now });
  return { text: block?.text ?? null, ids: block?.ids ?? [], tokens: block?.tokens ?? 0, notes: rows.length, fallback: sel.fallback, context: ctx };
}

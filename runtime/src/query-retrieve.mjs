// Prompt-time recall for the UserPromptSubmit hook (plan L6, design decision 11).
// The prompt's own words are the query; the recall core (memory/recall-rank.mjs) ranks
// this project's recallable notes and its global ones, and only notes above an
// absolute threshold come back — at most 3, never one this session already received
// since its latest start, never pending text. The block carries the untrusted line and
// the tags (memory/recall-render.mjs).
//
// Usage (from hook):
//   agent-daemon query-retrieve --output-json
//   stdin: the UserPromptSubmit hook JSON payload
//
// Output (--output-json):
//   { "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "additionalContext": "<markdown string>" } }

import { readStdinJson } from "./hooks/io.mjs";

const MAX_PICK = 3;

/**
 * @param {{ cwd?: string, outputJson?: boolean, verbose?: boolean }} opts
 */
export async function runQueryRetrieve(opts = {}) {
  const context = await queryRetrieveContext(await readStdinJson(), opts);
  if (!context) {
    if (opts.outputJson) process.stdout.write("{}");
  } else if (opts.outputJson) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }));
  } else {
    process.stdout.write(context + "\n");
  }
  return 0;
}

/** The learning ids this session already received since its latest session start. */
export function injectedThisSession(handle, sessionId) {
  if (!handle || !sessionId) return new Set();
  try {
    const rows = handle.all(
      `SELECT learning_id FROM injections WHERE capture_ref = ?
         AND ts >= COALESCE((SELECT MAX(ts) FROM injections WHERE capture_ref = ? AND surface = 'session-start'), '')`,
      [sessionId, sessionId]
    );
    return new Set(rows.map((r) => r.learning_id));
  } catch {
    return new Set();
  }
}

/**
 * The notes relevant to one UserPromptSubmit payload, as markdown, or null (the hook
 * dispatcher merges it with the other prompt-time context).
 * @param {object} input  the hook payload
 * @param {{ cwd?: string, verbose?: boolean, now?: number }} [opts]
 */
export async function queryRetrieveContext(input, opts = {}) {
  const prompt = String(input?.prompt || "");
  const cwd = opts.cwd || input?.cwd || process.env.CLAUDE_PROJECT_DIR;
  if (!prompt || prompt.length < 10 || !cwd) return null;
  const { hookProjectKeys } = await import("./memory/scope.mjs");
  // No folder, home, a system folder, or a shared key: no keys, nothing served.
  const projectKeys = await hookProjectKeys(cwd).catch(() => []);
  if (!projectKeys.length) return null;
  const { db } = await import("./memory/episodic.mjs");
  const handle = await db().catch(() => null);
  if (!handle) return null;
  const { isProjectId } = await import("./memory/projects.mjs");
  const { recallMode, promptRecallAllowed } = await import("./memory/recall-mode.mjs");
  if (!promptRecallAllowed(recallMode(handle, projectKeys.find(isProjectId) ?? null))) return null;

  const { recallRows } = await import("./memory/recall.mjs");
  const { selectPrompt, promptQuery, PROMPT } = await import("./memory/recall-rank.mjs");
  const { renderPrompt } = await import("./memory/recall-render.mjs");
  const { ownWords } = await import("./mistakes/classify.mjs");
  const { PRODUCT } = await import("./product.mjs");
  const now = opts.now ?? Date.now();
  const own = ownWords(prompt);
  // The FTS prefilter (very large stores only) on the prompt's own strongest words.
  const words = [...promptQuery(prompt, { own })].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([t]) => `"${t.replace(/"/g, '""')}"*`);
  const rows = recallRows(handle, projectKeys, { now, global: true, ftsQuery: words.length ? words.join(" OR ") : null });
  const sessionId = input?.session_id || null;
  const already = injectedThisSession(handle, sessionId);
  const picked = selectPrompt(rows, prompt, { own, opts: { ...PROMPT, max: MAX_PICK + already.size } })
    .filter((r) => !already.has(r.note.id))
    .slice(0, MAX_PICK);
  const block = renderPrompt({ notes: picked.map((r) => r.note), product: PRODUCT.displayName, now });
  if (!block) return null;
  // Two entries for one prompt (ad's engine entry and the product launcher on one host):
  // the first claims it just before sending (design decision 8); the other sends none.
  const { claimDelivery } = await import("./memory/recall-deliver.mjs");
  if (!claimDelivery({ session: sessionId, event: "prompt.submit", what: prompt })) return null;

  // Local counters: what was sent (the next prompt's dedupe reads them) and retrieval
  // counts. Best-effort: the hook stays fast and fail-safe.
  try {
    const { recordRetrievalEvent, markRetrieved } = await import("./memory/episodic.mjs");
    const bytes = Buffer.byteLength(block.text, "utf8");
    await recordRetrievalEvent({ sessionId, cwd, source: "query-retrieve", consideredBytes: bytes, injectedBytes: bytes, truncated: false, groups: [{ label: "learnings", bytesIn: bytes, bytesKept: bytes, truncated: false }] });
    await markRetrieved(block.ids);
    const { recordInjections } = await import("./memory/metrics.mjs");
    const { hostId } = await import("./memory/host-ids.mjs");
    const { hookHost } = await import("./hooks/io.mjs");
    recordInjections(handle, { captureRef: sessionId, keys: projectKeys, ids: block.ids, surface: "query-retrieve", host: hostId(hookHost()) });
  } catch {
    // counters only
  }
  if (opts.verbose) process.stderr.write(`agent-daemon: query-retrieve sent ${block.ids.length} learning(s)\n`);
  return block.text;
}

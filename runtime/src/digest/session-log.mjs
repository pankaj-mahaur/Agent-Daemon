// Per-project session log writer.
// Appends one JSONL line to <cwd>/.agent-daemon/sessions.jsonl after each digest run.
// Designed for the "is the daemon actually doing anything?" verification ritual.
//
// Fail-safe: any error is swallowed and reported via the returned `ok` flag.
// Never throws — digest must never fail because of audit logging.

import path from "node:path";
import fs from "node:fs/promises";

const MAX_BYTES = 5 * 1024 * 1024;  // 5 MB — rotate before unbounded growth
const KEEP_ROTATIONS = 2;            // keep .1 and .2, discard older

/**
 * Build a session-log entry from digest pipeline state.
 *
 * @param {{
 *   summary: {userTurns: number, assistantTurns: number, toolCalls: number, edits: number, durationMs: number, sessionId?: string, startTime?: Date, endTime?: Date},
 *   adapter: string,
 *   sessionId?: string,
 *   triage: {shouldDigest: boolean, reason: string},
 *   extractResult?: {learnings?: Array<unknown>, source?: string, costUsd?: number, skipReason?: string},
 *   applyResult?: {sqliteInserted?: number, memoryProjectAppended?: number, memoryGlobalAppended?: number, proposalsQueued?: number}
 * }} state
 * @returns {object} JSON-serializable entry
 */
export function buildEntry(state) {
  const { summary, adapter, sessionId, triage, extractResult, applyResult } = state;
  const applied =
    (applyResult?.memoryProjectAppended || 0) +
    (applyResult?.memoryGlobalAppended || 0) +
    (applyResult?.sqliteInserted || 0);

  return {
    ts: new Date().toISOString(),
    session_id: sessionId || summary?.sessionId || null,
    adapter,
    duration_min: summary?.durationMs ? Number((summary.durationMs / 60000).toFixed(2)) : 0,
    user_turns: summary?.userTurns || 0,
    assistant_turns: summary?.assistantTurns || 0,
    tool_calls: summary?.toolCalls || 0,
    edits: summary?.edits || 0,
    triage: triage?.reason || null,
    digested: !!triage?.shouldDigest,
    learnings_extracted: extractResult?.learnings?.length || 0,
    learnings_applied: applied,
    learnings_queued: applyResult?.proposalsQueued || 0,
    extract_source: extractResult?.source || null,
    extract_cost_usd: extractResult?.costUsd || 0
  };
}

/**
 * Append a session-log line to <cwd>/.agent-daemon/sessions.jsonl.
 *
 * @param {{cwd?: string, entry: object}} opts
 * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
 */
export async function appendSessionLog({ cwd, entry }) {
  if (!cwd) return { ok: false, error: "cwd required" };
  try {
    const dir = path.join(cwd, ".agent-daemon");
    await fs.mkdir(dir, { recursive: true });
    const logPath = path.join(dir, "sessions.jsonl");

    // Rotate before write if the existing file is too big.
    await maybeRotate(logPath);

    const line = JSON.stringify(entry) + "\n";
    await fs.appendFile(logPath, line, "utf8");
    return { ok: true, path: logPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function maybeRotate(logPath) {
  try {
    const stat = await fs.stat(logPath);
    if (stat.size < MAX_BYTES) return;
  } catch {
    return; // file doesn't exist yet
  }
  // Shift .1 -> .2, current -> .1. Discard older.
  for (let i = KEEP_ROTATIONS; i >= 1; i--) {
    const src = i === 1 ? logPath : `${logPath}.${i - 1}`;
    const dst = `${logPath}.${i}`;
    try {
      await fs.rename(src, dst);
    } catch { /* missing generation — ok */ }
  }
}

// Adapter dispatcher — picks the right transcript parser by path / shape.
//
// Detection priority:
//   1. Explicit override via opts.adapter ('claude-code' | 'cline' | 'cursor' | 'codex')
//   2. Path-based heuristics (well-known directories)
//   3. Content-based sniff (first JSON line shape)
//   4. Default → claude-code (most common)

import fs from "node:fs/promises";
import * as claudeCode from "./claude-code.mjs";
import * as cline      from "./cline.mjs";
import * as cursor     from "./cursor.mjs";
import * as codex      from "./codex.mjs";

const ADAPTERS = { "claude-code": claudeCode, cline, cursor, codex };

/**
 * @param {string} transcriptPath
 * @param {{adapter?: string, sessionId?: string, verbose?: boolean}} [opts]
 * @returns {Promise<{adapter: string, summary: import("./claude-code.mjs").TranscriptSummary}>}
 */
export async function summarize(transcriptPath, opts = {}) {
  const adapterName = opts.adapter || await detect(transcriptPath);
  const adapter = ADAPTERS[adapterName];
  if (!adapter) {
    throw new Error(`unknown adapter "${adapterName}". Known: ${Object.keys(ADAPTERS).join(", ")}`);
  }
  if (opts.verbose) console.error(`agent-daemon: adapter=${adapterName}`);
  const summary = await adapter.summarize(transcriptPath, { sessionId: opts.sessionId });
  return { adapter: adapterName, summary };
}

/**
 * Pick the most likely adapter for a path.
 *
 * @param {string} transcriptPath
 * @returns {Promise<string>}
 */
export async function detect(transcriptPath) {
  const p = transcriptPath.replace(/\\/g, "/");

  // Path-based heuristics
  if (/[/\\]\.claude[/\\]projects[/\\]/i.test(transcriptPath)) return "claude-code";
  if (/[/\\]\.cline[/\\]/i.test(transcriptPath))               return "cline";
  if (/saoudrizwan\.claude-dev[/\\]tasks/i.test(transcriptPath)) return "cline";  // VS Code Cline extension
  if (/[/\\]\.cursor[/\\]sessions/i.test(transcriptPath))      return "cursor";
  if (/[/\\]\.codex[/\\]sessions/i.test(transcriptPath))       return "codex";

  // Filename heuristics
  const fname = p.split("/").pop() || "";
  if (/^api_conversation_history\.json$/i.test(fname)) return "cline";
  if (/^ui_messages\.json$/i.test(fname))               return "cline";

  // Content sniff — read first non-empty line
  try {
    const stat = await fs.stat(transcriptPath).catch(() => null);
    if (stat?.isFile()) {
      const handle = await fs.open(transcriptPath, "r");
      try {
        const buf = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
        const head = buf.subarray(0, bytesRead).toString("utf8");
        const firstLine = (head.split("\n").find(l => l.trim()) || "").trim();
        return detectFromFirstLine(firstLine);
      } finally {
        await handle.close();
      }
    }
  } catch { /* fall through */ }

  return "claude-code";  // default — works for most JSONL transcripts
}

function detectFromFirstLine(line) {
  if (!line) return "claude-code";
  // JSON array (Cline api_conversation_history.json starts with `[`)
  if (line.startsWith("[")) return "cline";
  // JSONL — sniff well-known fields
  let obj;
  try { obj = JSON.parse(line); } catch { return "claude-code"; }
  if (obj?.type === "session.created" || /^(user|assistant|tool|session)\./i.test(obj?.type || "")) return "codex";
  if (obj?.type === "user_message" || obj?.type === "assistant_message")                            return "cursor";
  if (obj?.say || obj?.ask)                                                                          return "cline";
  return "claude-code";
}

export const adapters = ADAPTERS;

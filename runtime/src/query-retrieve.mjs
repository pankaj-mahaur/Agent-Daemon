// Query-aware retrieval for UserPromptSubmit hook.
// Extracts keywords from the user's prompt, queries SQLite for matching
// learnings, and outputs additional context for injection.
//
// Usage (from hook):
//   agent-daemon query-retrieve --output-json
//   stdin: Claude Code UserPromptSubmit hook JSON payload
//
// Output (--output-json):
//   { "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "additionalContext": "<markdown string>" } }

import { searchLearnings, projectSlug, recordRetrievalEvent, markRetrieved } from "./memory/episodic.mjs";
import { readStdinJson } from "./hooks/io.mjs";
import { neutralizeText } from "./digest/sanitize.mjs";

const MAX_RESULTS = 3;
const MAX_OUTPUT_BYTES = 2000;

/**
 * @param {{ cwd?: string, outputJson?: boolean, verbose?: boolean }} opts
 */
export async function runQueryRetrieve(opts = {}) {
  const input = await readStdinJson();
  const prompt = String(input.prompt || process.env.CLAUDE_USER_PROMPT || "");
  const cwd = opts.cwd || input.cwd || process.env.CLAUDE_PROJECT_DIR;
  if (!prompt || prompt.length < 10) {
    if (opts.outputJson) process.stdout.write("{}");
    return 0;
  }

  const keywords = extractKeywords(prompt);
  if (keywords.length === 0) {
    if (opts.outputJson) process.stdout.write("{}");
    return 0;
  }

  const query = keywords.join(" ");
  const slug = cwd ? projectSlug(cwd) : null;

  let results;
  try {
    results = await searchLearnings(query, {
      projectSlug: slug,
      scope: "any",
      limit: MAX_RESULTS
    });
  } catch {
    if (opts.outputJson) process.stdout.write("{}");
    return 0;
  }

  if (!results || results.length === 0) {
    if (opts.outputJson) process.stdout.write("{}");
    return 0;
  }

  const lines = results.map(r =>
    `- **${r.category}** (conf ${r.confidence.toFixed(2)}): ${neutralizeText(r.text)}`
  );
  let context = `## Relevant past learnings\n\n${lines.join("\n")}`;

  const consideredBytes = Buffer.byteLength(context, "utf8");
  const truncated = consideredBytes > MAX_OUTPUT_BYTES;
  if (truncated) {
    context = context.slice(0, MAX_OUTPUT_BYTES);
  }

  // Retrieval telemetry + write-back (retrieval_count feeds freshness ranking).
  // Fire-and-forget — the hook must stay fast and fail-safe.
  try {
    const sessionId = input.session_id || process.env.CLAUDE_SESSION_ID || null;
    await recordRetrievalEvent({
      sessionId,
      cwd,
      source: "query-retrieve",
      consideredBytes,
      injectedBytes: Buffer.byteLength(context, "utf8"),
      truncated,
      groups: [{ label: "learnings", bytesIn: consideredBytes, bytesKept: Buffer.byteLength(context, "utf8"), truncated }]
    });
    await markRetrieved(results.map(r => r.id).filter(Boolean));
  } catch { /* best-effort */ }

  if (opts.outputJson) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: context
      }
    }));
  } else {
    process.stdout.write(context + "\n");
  }

  if (opts.verbose) {
    process.stderr.write(`agent-daemon: query-retrieve found ${results.length} relevant learning(s) for keywords: ${keywords.join(", ")}\n`);
  }

  return 0;
}

function extractKeywords(text) {
  const tokens = text.match(/[\p{L}\p{N}_/.@-]{3,}/gu) || [];
  // Prioritize file paths, error messages, and technical terms
  const filePathTokens = tokens.filter(t => t.includes("/") || t.includes(".") || t.includes("\\"));
  const techTokens = tokens.filter(t => /[A-Z]/.test(t) || t.includes("_") || t.includes("-"));
  const combined = [...new Set([...filePathTokens, ...techTokens, ...tokens])];
  return combined.slice(0, 8);
}

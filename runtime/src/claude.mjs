// Headless `claude` CLI wrapper.
// Used by the digest pipeline (extract / GEPA reflect / generate) to call
// the user's existing Claude Code installation as a non-interactive worker.
//
// We always pass --bare so the sub-invocation skips hooks (no recursion),
// auto-memory (we manage memory ourselves), and CLAUDE.md discovery (we
// inject context explicitly via --append-system-prompt).

import { spawn } from "node:child_process";
import fs from "node:fs/promises";

/**
 * @typedef {Object} HeadlessOptions
 * @property {string} [systemPromptFile]    - path to a file whose contents are appended to the system prompt
 * @property {string} [systemPromptText]    - inline system-prompt-append text
 * @property {string} userMessage           - the user message body (passed via stdin)
 * @property {string} [model]               - 'opus' | 'sonnet' | 'haiku' | full model id
 * @property {Object} [jsonSchema]          - structured-output schema
 * @property {string[]} [tools]             - allowed tools (default: none — we just want text extraction)
 * @property {number} [maxBudgetUsd=0.50]   - cost cap; spawn fails if exceeded
 * @property {number} [timeoutMs=120000]    - hard timeout
 * @property {boolean} [verbose=false]
 * @property {string} [fallbackModel]       - model to fall back to on overload
 *
 * @typedef {Object} HeadlessResult
 * @property {boolean} ok
 * @property {string} [result]              - assistant response text (when ok)
 * @property {Object} [parsedJson]          - parsed JSON if jsonSchema was provided
 * @property {number} [costUsd]
 * @property {number} [durationMs]
 * @property {string} [sessionId]
 * @property {string} [error]               - error message when not ok
 * @property {string} [stderr]
 */

/**
 * Spawn a non-interactive `claude` CLI process and wait for its JSON result.
 *
 * @param {HeadlessOptions} opts
 * @returns {Promise<HeadlessResult>}
 */
export async function callHeadlessClaude(opts) {
  if (!opts.userMessage) {
    return { ok: false, error: "userMessage is required" };
  }

  // --bare mode (which we always use to prevent hook recursion) requires
  // ANTHROPIC_API_KEY. As of v0.4 the digest pipeline no longer requires this —
  // the agent emits its own digest block (see constitution/ending-protocol.md).
  // This wrapper is now ONLY used by:
  //   - GEPA self-evolution (`agent-daemon evolve <skill>`)
  //   - Optional digest fallback (AGENT_DAEMON_FALLBACK_LLM=1)
  // Both are opt-in / power-user flows. We still require the key here.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.AGENT_DAEMON_NO_BARE) {
    return {
      ok: false,
      error: "ANTHROPIC_API_KEY env var is required for this feature.\n" +
             "(GEPA evolution and the optional digest LLM fallback are the only paths that use it;\n" +
             "default session digesting works without any API key — the agent emits its own digest\n" +
             "block per constitution/ending-protocol.md.)\n\n" +
             "If you want to use this feature, get a key at https://console.anthropic.com/settings/keys and:\n" +
             "  export ANTHROPIC_API_KEY=sk-ant-...   (Linux/macOS)\n" +
             "  setx ANTHROPIC_API_KEY \"sk-ant-...\"  (Windows, then reopen terminal)"
    };
  }

  const args = [
    "--bare",
    "--print",
    "--output-format", "json",
    "--no-session-persistence",
    "--max-budget-usd", String(opts.maxBudgetUsd ?? 0.50),
    "--input-format", "text"
  ];

  // Tool restriction — by default, no tools (text-in/text-out)
  if (opts.tools && opts.tools.length > 0) {
    args.push("--tools", opts.tools.join(","));
  } else {
    args.push("--tools", "");  // disable all tools
  }

  if (opts.model) {
    args.push("--model", opts.model);
  }
  if (opts.fallbackModel) {
    args.push("--fallback-model", opts.fallbackModel);
  }
  let systemPromptText = opts.systemPromptText;
  if (opts.systemPromptFile && !systemPromptText) {
    try {
      systemPromptText = await fs.readFile(opts.systemPromptFile, "utf8");
    } catch (err) {
      return { ok: false, error: `cannot read systemPromptFile ${opts.systemPromptFile}: ${err.message}` };
    }
  }
  if (systemPromptText) {
    args.push("--append-system-prompt", systemPromptText);
  }
  if (opts.jsonSchema) {
    args.push("--json-schema", JSON.stringify(opts.jsonSchema));
  }

  if (opts.verbose) {
    process.stderr.write(`[claude] spawn: claude ${args.map(a => a.length > 80 ? `<${a.length}b>` : JSON.stringify(a)).join(" ")}\n`);
  }

  return await new Promise((resolve) => {
    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32"  // Windows needs shell to find claude.cmd
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, error: `timeout after ${opts.timeoutMs ?? 120000}ms`, stderr });
    }, opts.timeoutMs ?? 120000);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `spawn failed: ${err.message}`, stderr });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, error: `claude exited ${code}`, stderr });
        return;
      }

      let envelope;
      try {
        envelope = JSON.parse(stdout);
      } catch (err) {
        resolve({ ok: false, error: `non-JSON output: ${err.message}`, stderr, result: stdout });
        return;
      }

      // Claude Code's --output-format json envelope:
      //   { "result": "...", "total_cost_usd": 0.012, "duration_ms": 3421, "session_id": "...", ... }
      const result = envelope.result;
      const out = {
        ok: true,
        result,
        costUsd: envelope.total_cost_usd,
        durationMs: envelope.duration_ms,
        sessionId: envelope.session_id
      };

      if (opts.jsonSchema && typeof result === "string") {
        try {
          out.parsedJson = JSON.parse(result);
        } catch (err) {
          out.error = `result was not valid JSON despite jsonSchema: ${err.message}`;
        }
      }

      resolve(out);
    });

    // Write the user message via stdin
    child.stdin.write(opts.userMessage);
    child.stdin.end();
  });
}

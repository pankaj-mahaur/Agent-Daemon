// Shared stdin/stdout helpers for hook handlers.
// Hooks receive a JSON object on stdin describing the event and emit a JSON
// decision on stdout (or a non-zero exit to block).
//
// Decision shape (Claude Code):
//   { decision: "approve" }                 — explicit allow
//   { decision: "block",  reason: "..." }   — block with a message shown to the model
//   {}                                       — pass-through (default allow)
//
// Hosts: handlers are shared between Claude Code and Codex. With
// AD_HOOK_HOST=codex (set by `ad hook … --host codex`) input and output are
// adapted, because Codex differs in ways that silently break hooks:
//   - `{decision:"approve"}` is an unsupported field → Codex marks the hook failed
//   - context must be wrapped in hookSpecificOutput (top-level additionalContext is ignored)
//   - PreToolUse denies via hookSpecificOutput.permissionDecision
//   - apply_patch sends the patch text as tool_input.command, not a file_path

import path from "node:path";

const MAX_STDIN = 1024 * 1024; // 1 MB safety cap

let lastEvent = null;

export const hookHost = () => (process.env.AD_HOOK_HOST === "codex" ? "codex" : "claude");

// Paths touched by a Codex apply_patch body ("*** Update File: x", …),
// resolved against cwd — or as written when resolve is false.
export function patchPaths(patch, cwd = process.cwd(), { resolve = true } = {}) {
  const paths = [];
  for (const m of String(patch ?? "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$|^\*\*\* Move to: (.+?)\s*$/gm)) {
    const p = (m[1] ?? m[2]).trim();
    const out = !resolve || path.isAbsolute(p) ? p : path.resolve(cwd, p);
    if (!paths.includes(out)) paths.push(out);
  }
  return paths;
}

// Codex hook input → the Claude Code shape our handlers read.
export function normalizeCodexInput(input) {
  if (!input || typeof input !== "object") return {};
  const out = { ...input };
  if (input.tool_name === "apply_patch") {
    const files = patchPaths(input.tool_input?.command, input.cwd);
    out.tool_input = { ...(input.tool_input ?? {}), file_path: files[0], file_paths: files };
  }
  if (typeof input.tool_response === "string") out.tool_response = { output: input.tool_response };
  return out;
}

export async function readStdinJson() {
  const input = await new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (raw.length < MAX_STDIN) raw += chunk.slice(0, MAX_STDIN - raw.length);
    });
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
    process.stdin.on("error", () => resolve({}));
  });
  lastEvent = input?.hook_event_name ?? null;
  return hookHost() === "codex" ? normalizeCodexInput(input) : input;
}

// The output a decision takes for the current host/event. Exported for tests.
export function renderDecision(kind, value, { host = hookHost(), event = lastEvent } = {}) {
  if (host !== "codex") {
    if (kind === "approve") return { decision: "approve" };
    if (kind === "block") return { decision: "block", reason: value };
    if (kind === "advise") return { additionalContext: value };
    return {};
  }
  if (kind === "approve" || kind === "pass") return {};
  if (kind === "block") {
    if (event === "PreToolUse") {
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: value } };
    }
    return { decision: "block", reason: value };
  }
  if (kind === "advise") {
    return { hookSpecificOutput: { hookEventName: event ?? "UserPromptSubmit", additionalContext: value } };
  }
  return {};
}

export function approve() {
  process.stdout.write(JSON.stringify(renderDecision("approve")));
}

export function block(reason) {
  process.stdout.write(JSON.stringify(renderDecision("block", reason)));
}

export function passthrough() {
  process.stdout.write("{}");
}

export function warn(message) {
  process.stderr.write(`[agent-daemon] ${message}\n`);
}

/** Inject text into the agent's context without blocking or approving the prompt. */
export function advise(additionalContext) {
  process.stdout.write(JSON.stringify(renderDecision("advise", additionalContext)));
}

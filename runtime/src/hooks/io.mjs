// Shared stdin/stdout helpers for hook handlers.
// Hooks receive a JSON object on stdin describing the event and emit a JSON
// decision on stdout (or a non-zero exit to block).
//
// Decision shape (Claude Code):
//   { decision: "block",  reason: "..." }   — block with a message shown to the model
//   {}                                       — pass-through: no objection, the user's
//                                              own permission rules still decide
// There is deliberately no allow: Claude Code reads `{decision:"approve"}` on
// PreToolUse as allow and skips the user's permission prompt. A hook with no
// objection passes through; one that hits its own error passes through too.
//
// Hosts: handlers are shared between Claude Code and ad's engine. With
// AD_HOOK_HOST=ad (set by `ad hook … --host ad`; the old value is still
// read) input and output are adapted, because the engine differs in ways
// that silently break hooks:
//   - `{decision:"approve"}` is an unsupported field → the engine marks the hook failed
//   - context must be wrapped in hookSpecificOutput (top-level additionalContext is ignored)
//   - PreToolUse denies via hookSpecificOutput.permissionDecision
//   - apply_patch sends the patch text as tool_input.command, not a file_path

import path from "node:path";
// Not product-values.mjs: it imports engine/attribution.mjs, which is in the brand
// zone and must stay out of the memory package and the plugin (MCP launch plan L3).
import { ENGINE_WIRE_HOSTS } from "../memory/host-ids.mjs";

/** "ad" for a host whose hooks speak the engine's wire format; any other value unchanged. */
const wireHost = (v) => (ENGINE_WIRE_HOSTS.includes(v) ? "ad" : v);

const MAX_STDIN = 1024 * 1024; // 1 MB safety cap

let lastEvent = null;

export const hookHost = () => (wireHost(process.env.AD_HOOK_HOST) === "ad" ? "ad" : "claude");

// Paths touched by an apply_patch body ("*** Update File: x", …),
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

// The engine's hook input → the Claude Code shape our handlers read.
export function normalizeEngineInput(input) {
  if (!input || typeof input !== "object") return {};
  const out = { ...input };
  if (input.tool_name === "apply_patch") {
    const files = patchPaths(input.tool_input?.command, input.cwd);
    out.tool_input = { ...(input.tool_input ?? {}), file_path: files[0], file_paths: files };
  }
  if (typeof input.tool_response === "string") out.tool_response = { output: input.tool_response };
  return out;
}

/**
 * tool.before's read (L7 D5): the whole payload up to `max` (a Write of a large file is
 * still checked), and no silent `{}` — a payload over the cap or not JSON comes back as
 * {input: null, raw, why}, so the caller can fail closed while rules exist.
 * @returns {Promise<{input:object|null, raw:string, why:string|null}>}
 */
export async function readStdinWhole({ max = 64 * 1024 * 1024, stream = process.stdin } = {}) {
  const got = await new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let over = false;
    stream.on("data", (chunk) => {
      if (over) return;
      const b = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += b.length;
      if (size > max) {
        over = true;
        return;
      }
      chunks.push(b);
    });
    stream.on("end", () => resolve({ text: Buffer.concat(chunks).toString("utf8"), over }));
    stream.on("error", () => resolve({ text: Buffer.concat(chunks).toString("utf8"), over: true }));
  });
  const head = got.text.slice(0, 64 * 1024);
  if (got.over) return { input: null, raw: head, why: "the call was too large to check" };
  if (!got.text.trim()) return { input: null, raw: "", why: "the call was empty" };
  let input;
  try {
    input = JSON.parse(got.text);
  } catch {
    return { input: null, raw: head, why: "the call couldn't be read" };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return { input: null, raw: head, why: "the call couldn't be read" };
  lastEvent = input.hook_event_name ?? null;
  return { input: hookHost() === "ad" ? normalizeEngineInput(input) : input, raw: "", why: null };
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
  return hookHost() === "ad" ? normalizeEngineInput(input) : input;
}

// The output a decision takes for the current host/event. Exported for tests.
export function renderDecision(kind, value, { host = hookHost(), event = lastEvent } = {}) {
  host = wireHost(host);
  if (host !== "ad") {
    // "approve" renders as pass-through: never an allow (see the header).
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

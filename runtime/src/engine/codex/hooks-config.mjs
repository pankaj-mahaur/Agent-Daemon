// Agent Daemon's hooks, rendered as a Codex hooks.json for the harness
// CODEX_HOME.
//
// The same routes as the Claude Code install (hooks/routes.mjs, from the
// profile in runtime/profiles/profiles.json), all through the hook dispatcher
// (runtime/bin/hook.mjs), with Codex differences applied (verified live
// against 0.163.0 and 0.164.0):
//   - commands run through a shell (PowerShell on Windows) → `commandWindows`
//     with `&` and single-quoted paths; POSIX gets a sh-quoted `command`
//   - apply_patch edits match `Edit|Write` (no MultiEdit tool); no Skill tool,
//     UserPromptExpansion, CronCreate or SubagentStop work → those routes are skipped
//   - SessionEnd is capped at 3 s → session.end only spawns a detached digest
//   - other handlers get ≥ 10 s: node + PowerShell cold start alone can
//     take ~2 s on Windows, and Claude-tuned limits would time out
//   - handlers get `--host ad` so the dispatcher adapts input and output (2.x homes wrote `--host codex`, still read)
//
// Every hook runs the dispatcher by absolute path with the current node binary,
// so it works whether or not `ad` is on PATH; the file is rewritten on every
// ad run/chat, so a moved node heals itself.

import { resolveProfile } from "../../profiles.mjs";
import { HOOK_PATH, routesFor } from "../../hooks/routes.mjs";

const CODEX_EVENTS = new Set(["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "PostCompact", "Stop"]);

export const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// PowerShell also treats the typographic quotes U+2018–U+201B as single
// quotes; each must be doubled inside a single-quoted string.
export const psQuote = (s) => `'${String(s).replace(/['‘-‛]/g, "$&$&")}'`;

// hooks: resolved hook definitions [{id, event, matcher, command, timeout}]: only the ids (steps) matter
export function buildCodexHooksJson({ hooks: defs, node = process.execPath, hook = HOOK_PATH }) {
  const hooks = {};
  for (const route of routesFor(defs.map((d) => d.id), "codex")) {
    if (!CODEX_EVENTS.has(route.hostEvent)) continue;
    const args = [route.event, "--host", "ad"];
    const handler = {
      type: "command",
      command: [shQuote(node), shQuote(hook), ...args].join(" "),
      commandWindows: ["&", psQuote(node), psQuote(hook), ...args].join(" "),
      timeout: route.timeout,
      statusMessage: `agent-daemon: ${route.event}`,
    };
    if (route.hostEvent === "SessionStart") handler.additionalContextLimit = 3000;
    (hooks[route.hostEvent] ??= []).push(route.matcher ? { matcher: route.matcher, hooks: [handler] } : { hooks: [handler] });
  }
  return { description: "Managed by agent-daemon (ad). Regenerated on every ad run/chat; edits are overwritten.", hooks };
}

export async function codexHooksForProfile(profile = "developer", opts = {}) {
  return buildCodexHooksJson({ hooks: (await resolveProfile(profile)).hooks, ...opts });
}

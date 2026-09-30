// Agent Daemon's hooks, rendered as a Codex hooks.json for the harness
// CODEX_HOME.
//
// Same handlers as the Claude Code install (runtime/profiles/profiles.json,
// resolved by profiles.mjs), with Codex differences applied (verified live
// against codex 0.159.2):
//   - commands run through PowerShell on Windows → `commandWindows` with `&`
//     and single-quoted paths; POSIX gets a sh-quoted `command`
//   - apply_patch edits match `Edit|Write` (no MultiEdit tool)
//   - no Skill tool / UserPromptExpansion event → those hooks are skipped
//   - SessionEnd is capped at 3 s → a dependency-free launcher that only
//     spawns a detached digest (hooks/codex-session-end.mjs)
//   - other handlers get ≥ 10 s: node + PowerShell cold start alone can
//     take ~2 s on Windows, and Claude-tuned 3 s limits would time out
//   - handlers get `--host codex` so hooks/io.mjs adapts input and output
//
// Every hook invokes our CLI by absolute path with the current node binary,
// so it works whether or not `ad` is on PATH.

import { fileURLToPath } from "node:url";
import { resolveProfile } from "../../profiles.mjs";

export const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));
export const SESSION_END_SCRIPT = fileURLToPath(new URL("../../hooks/codex-session-end.mjs", import.meta.url));

const SKIP = new Set(["skill-use", "slash-command-use"]);
const CODEX_EVENTS = new Set(["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "PostCompact", "Stop"]);
const MATCHER_MAP = { "Edit|Write|MultiEdit": "Edit|Write" };
const MIN_TIMEOUT_S = 10;

export const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// PowerShell also treats the typographic quotes U+2018–U+201B as single
// quotes; each must be doubled inside a single-quoted string.
export const psQuote = (s) => `'${String(s).replace(/['‘-‛]/g, "$&$&")}'`;

// "ad hook bash-post" → ["hook", "bash-post", "--host", "codex"]
function argsFor(def) {
  const parts = def.command.trim().split(/\s+/);
  if (parts[0] !== "ad") throw new Error(`hook command must start with "ad": ${def.command}`);
  return [...parts.slice(1), "--host", "codex"];
}

// hooks: resolved hook definitions [{id, event, matcher, command, timeout}]
export function buildCodexHooksJson({ hooks: defs, node = process.execPath, cli = CLI_PATH, sessionEndScript = SESSION_END_SCRIPT }) {
  const hooks = {};
  for (const def of defs) {
    if (SKIP.has(def.id) || !CODEX_EVENTS.has(def.event)) continue;
    const sessionEnd = def.event === "SessionEnd";
    const target = sessionEnd ? [sessionEndScript] : [cli];
    const args = sessionEnd ? [] : argsFor(def);
    const handler = {
      type: "command",
      command: [shQuote(node), ...target.map(shQuote), ...args].join(" "),
      commandWindows: ["&", psQuote(node), ...target.map(psQuote), ...args].join(" "),
      timeout: sessionEnd ? 3 : Math.max(def.timeout ?? MIN_TIMEOUT_S, MIN_TIMEOUT_S),
      statusMessage: `agent-daemon: ${def.id}`,
    };
    if (def.event === "SessionStart") handler.additionalContextLimit = 3000;
    const matcher = MATCHER_MAP[def.matcher] ?? def.matcher;
    (hooks[def.event] ??= []).push(matcher ? { matcher, hooks: [handler] } : { hooks: [handler] });
  }
  return { description: "Managed by agent-daemon (ad). Regenerated on every ad run/chat; edits are overwritten.", hooks };
}

export async function codexHooksForProfile(profile = "developer", opts = {}) {
  return buildCodexHooksJson({ hooks: (await resolveProfile(profile)).hooks, ...opts });
}

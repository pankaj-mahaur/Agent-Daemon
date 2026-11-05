// tool.before (plan L2, 02 §3): the check before every Bash, PowerShell,
// Write and Edit call (Codex: its shell and apply_patch). It reads only the
// rules snapshot (guards.json) and the pure matcher: no memory store, no
// project registry, nothing that can be slow or can write. With no rules for
// this project, or rules paused, it prints nothing and the tool runs.
//
// A matching rule answers with its decision (ask by default). An error inside
// the matcher, or a command too long to read whole that names the rule's
// program, is treated as ask: never silently allowed.

import path from "node:path";
import { loadGuards, projectFor } from "./guards.mjs";
import { matchRule } from "../rules/match.mjs";
import { toolDecision, noticeOnly } from "./host-capabilities.mjs";

const OS = { win32: "windows", darwin: "macos" };

/** The hook payload as a matcher call. */
export function callOf(input, { host, platform = process.platform, root = null } = {}) {
  const os = OS[platform] ?? "linux";
  const name = String(input?.tool_name ?? "");
  const tin = input?.tool_input ?? {};
  let tool = name;
  let callInput = tin;
  if (host === "codex") {
    // Codex names its shell tool Bash (it runs PowerShell on Windows) and sends patches in command.
    if (/^(?:bash|shell|exec_command|shell_command|local_shell)$/i.test(name)) tool = "shell";
    else if (name === "apply_patch") callInput = { patch: tin.command ?? tin.patch ?? tin.input };
  }
  const cwd = input?.cwd ?? null;
  return { tool, input: callInput, os, cwd: cwd ?? root, project_root: root ?? cwd };
}

/**
 * Decide one PreToolUse call.
 * @returns {object|null} the JSON to print, or null for no output (the tool runs)
 */
export function toolBefore(input, { host = "claude", env = process.env, root, platform = process.platform, onWarning = null } = {}) {
  // CLAUDE_PROJECT_DIR is Claude Code's; under another host it is an outer session's leftover.
  const dir = (host === "claude" ? env.CLAUDE_PROJECT_DIR : null) || input?.cwd || null;
  const { snapshot, warning } = loadGuards(root ? { root } : undefined);
  if (warning) onWarning?.(warning);
  const found = projectFor(snapshot, dir, { platform });
  if (!found) return warning ? noticeOnly(host, warning) : null;
  const { id: projectId, project } = found;
  if (project.paused || !Array.isArray(project.rules) || !project.rules.length) return null;
  const projectRoot = (project.roots ?? []).find((r) => {
    const a = path.resolve(r).toLowerCase();
    const d = path.resolve(dir).toLowerCase();
    return d === a || d.startsWith(a + path.sep);
  });
  const call = callOf(input, { host, platform, root: projectRoot ?? dir });
  for (const r of project.rules) {
    if (!r || typeof r !== "object" || !r.rule) continue;
    const res = matchRule(r.rule, call);
    if (!res.match && !res.error) continue;
    const decision = res.error || res.incomplete ? "ask" : r.decision === "deny" ? "deny" : "ask";
    const id = r.id ?? "?";
    const why = String(r.reason ?? "").trim() || "a rule you set";
    const reason = `Your rule ${id} (${why}) asks before this ${call.tool === "Write" || call.tool === "Edit" || call.tool === "apply_patch" ? "file change" : "command"}.`;
    const notice = `ad rule ${id}: ${why}. Allow once: \`ad rules allow-once ${id}\` · remove: \`ad rules rm ${id}\``;
    return toolDecision(decision, { host, permissionMode: input?.permission_mode, reason, notice, projectId });
  }
  return null;
}

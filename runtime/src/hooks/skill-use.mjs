// Claude-only skill invocation telemetry for local GEPA feedback.

import { readStdinJson, passthrough } from "./io.mjs";
import { recordSkillExecution, upsertSession, correlateRouteInvocation } from "../memory/episodic.mjs";

export async function skillUse() {
  try {
    const input = await readStdinJson();
    const event = String(input.hook_event_name || "");
    const sessionId = String(input.session_id || process.env.CLAUDE_SESSION_ID || "");
    const cwd = String(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const source = event === "UserPromptExpansion" ? "slash-command" : "skill-tool";
    const triggerText = String(input.prompt || input.tool_input?.prompt || input.tool_input?.args || "");
    const skillName = readSkillName(input, source);

    if (sessionId && skillName) {
      await upsertSession({
        id: sessionId,
        projectPath: cwd,
        startedAt: new Date().toISOString(),
        digestStatus: "pending"
      });
      await recordSkillExecution({
        sessionId,
        skillName,
        triggerText,
        invocationSource: source
      });
      // Close the routing loop: link this invocation back to the route
      // advice that recommended it (followed vs diverged).
      try { await correlateRouteInvocation({ sessionId, skillName }); } catch { /* best-effort */ }
    }
  } catch {
    // Skill telemetry is best-effort and must never block Claude.
  }

  passthrough();
  return 0;
}

function readSkillName(input, source) {
  let value = "";
  if (source === "slash-command") {
    value = input.command_name || input.slash_command || String(input.prompt || "").match(/\/([a-z0-9._-]+)/i)?.[1] || "";
  } else {
    value = input.tool_input?.skill || input.tool_input?.name || input.tool_input?.command || "";
  }
  const normalized = String(value).replace(/^\//, "").trim().split(/\s+/)[0];
  return /^[a-z0-9._-]+$/i.test(normalized) ? normalized : "";
}

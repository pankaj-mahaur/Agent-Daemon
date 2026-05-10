// PreToolUse hook for MCP tool calls — appends an audit-log line and warns
// on calls to MCP servers that aren't on the trusted-list.
// Ported from everything-claude-code/.cursor/hooks/before-mcp-execution.js.
//
// Trusted servers can be configured via env: AGENT_DAEMON_TRUSTED_MCP="server1,server2".
// Default trusted list covers the daemon's own first-party servers.
//
// Audit log: $AGENT_DAEMON_HOME/audit/mcp.jsonl  (or ~/.agent-daemon/audit/mcp.jsonl)

import { mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readStdinJson, approve, warn } from "./io.mjs";

const DEFAULT_TRUSTED = new Set([
  "qmd",
  "graphify",
  "context-mode",
  "repomix",
  "ccd_session",
  "ccd_session_mgmt",
  "ccd_directory",
  "scheduled-tasks",
  "mcp-registry",
]);

function trustedSet() {
  const extra = process.env.AGENT_DAEMON_TRUSTED_MCP;
  if (!extra) return DEFAULT_TRUSTED;
  const set = new Set(DEFAULT_TRUSTED);
  for (const s of extra.split(",").map((x) => x.trim()).filter(Boolean)) set.add(s);
  return set;
}

function auditPath() {
  const root = process.env.AGENT_DAEMON_HOME || join(homedir(), ".agent-daemon");
  return join(root, "audit", "mcp.jsonl");
}

export async function mcpAudit() {
  const input = await readStdinJson();
  const toolName = String(input?.tool_name || input?.name || "");

  // Tool name shape: mcp__<server>__<tool>
  const m = toolName.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
  if (!m) {
    approve();
    return;
  }
  const server = m[1];
  const tool = m[2];

  try {
    const path = auditPath();
    mkdirSync(dirname(path), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      server,
      tool,
      session: process.env.CLAUDE_SESSION_ID || null,
      project: process.env.CLAUDE_PROJECT_DIR || null,
    });
    appendFileSync(path, line + "\n");
  } catch {
    /* best-effort audit; never block on log errors */
  }

  if (!trustedSet().has(server)) {
    warn(`MCP call to non-trusted server '${server}' (tool ${tool}). Add to AGENT_DAEMON_TRUSTED_MCP to silence.`);
  }

  approve();
}

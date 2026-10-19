// The hosts ad's memory runs in (P5.2). One id per host, used by the memory
// server's --host, the capture heartbeats the hooks write, and the installer.
// The hooks' own name for Claude Code ("claude", hooks/io.mjs hookHost) maps
// to "claude-code".

export const HOST_IDS = Object.freeze(["ad", "claude-code", "codex", "cursor", "vscode", "gemini", "opencode", "windsurf", "agent-plugins"]);

/** A known host id, or null. */
export function hostId(name) {
  const n = String(name ?? "").trim().toLowerCase();
  if (n === "claude") return "claude-code";
  return HOST_IDS.includes(n) ? n : null;
}

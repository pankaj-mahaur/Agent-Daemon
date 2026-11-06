// The memory product's names, in one place (MCP launch plan L3, Decision 1).
// Builders, the installer, doctor and every generated text read them here, so a
// rename is one change here plus an alias package (owner checkpoint C-L3-NAME:
// L3 keeps today's names).
//
// Generated text names tools by their bare names (memory_search): a plugin's
// tools are mcp__plugin_<plugin>_<server>__<tool> and an installed server's are
// mcp__<server>__<tool>, so a prefixed name is wrong on one route or the other.

export const PRODUCT = Object.freeze({
  /** The npm package and its bin. */
  package: "agent-daemon-memory",
  bin: "agent-daemon-memory",
  /** The Claude Code plugin: its name namespaces the commands (/agent-daemon-memory:remember). */
  plugin: "agent-daemon-memory",
  marketplace: "agent-daemon",
  /** The key of the MCP server entry in each host's settings. */
  mcpServerKey: "agent-daemon-memory",
  /** The memory skill shipped in the plugin (skills/daemon/<skill>/SKILL.md in the repo). */
  skill: "agent-daemon-memory",
  /** The MCP registry name (server.json). */
  mcpName: "io.github.pankaj-mahaur/agent-daemon-memory",
  displayName: "agent-daemon memory",
});

/** What a user types for a verb, pinned to the installed version (no version skew, offline once cached). */
export const pinnedCommand = (verb, version) => `npx -y ${PRODUCT.package}@${version} ${verb}`;

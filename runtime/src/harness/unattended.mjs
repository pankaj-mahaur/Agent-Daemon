// Settings shared by every unattended run (ad loop, team workers).
//
// Nobody approves anything there, so everything that could act outside the
// sandbox is switched off for those threads:
//   - MCP servers run outside Codex's sandbox → all disabled except our
//     own memory server (read-mostly, local SQLite)
//   - live web search → back to "cached" (OpenAI's index, no live fetches)
//   - every turn: workspace-write, no extra writable roots, no network
// These are per-thread overrides (dotted keys, verified on codex 0.159.2);
// the user's config is not changed.

import { MEMORY_SERVER_ID } from "./setup.mjs";

export const UNATTENDED_SANDBOX_POLICY = Object.freeze({ type: "workspaceWrite", writableRoots: [], networkAccess: false });

// Env for unattended engines: the prompts are ours / the leader's, not the
// user's — hooks must not capture them as the user's corrections.
export const UNATTENDED_ENV = Object.freeze({ AD_WORKER: "1" });

export async function unattendedThreadConfig(engine) {
  const config = {};
  let cfg = {};
  try {
    cfg = await engine.readConfig();
  } catch (e) {
    engine.emit?.("warning", `could not read config for unattended overrides: ${e.message}`);
  }
  for (const id of Object.keys(cfg.mcp_servers ?? {})) {
    if (id !== MEMORY_SERVER_ID) config[`mcp_servers.${id}.enabled`] = false;
  }
  if (cfg.web_search && cfg.web_search !== "cached" && cfg.web_search !== "disabled") config.web_search = "cached";
  return config;
}

// The harness's own CODEX_HOME — config, auth, sessions and logs for Codex
// runs started by Agent Daemon, isolated from the user's ~/.codex.
//
// Kept short on purpose: the app-server control socket path must fit in
// 108 bytes on Windows, so it lives directly under the user's home.
//
// Only the bootstrap file is written here. Everything else goes through the
// app-server's own `config/batchWrite`, so we never hand-edit TOML that
// Codex also writes (hook trust, login state).

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const BOOTSTRAP_CONFIG = `# Agent Daemon harness config (CODEX_HOME).
# Managed settings are written by \`ad\` through codex app-server; edit freely.

# Keep credentials inside this folder instead of the OS keyring, so the
# harness login never collides with the user's own \`codex\` login.
cli_auth_credentials_store = "file"
`;

const managedHome = () => join(homedir(), ".agent-daemon", "codex-home");

export function defaultCodexHome(env = process.env) {
  return env.AD_CODEX_HOME ? resolve(env.AD_CODEX_HOME) : managedHome();
}

export const MANAGED_MARKER = ".agent-daemon-managed";

// True only for a folder Agent Daemon created. A pre-existing CODEX_HOME
// (AD_CODEX_HOME pointing at the user's real ~/.codex, say) never gets the
// marker, so it is never auto-modified.
export function isManagedHome(dir) {
  return existsSync(join(dir, MANAGED_MARKER));
}

// Bootstraps (config + marker) only a folder that did not exist or was
// empty. A folder with anything in it — even just auth.json — is the
// user's, and is used as-is.
export function ensureCodexHome(dir = defaultCodexHome()) {
  if (existsSync(dir) && !statSync(dir).isDirectory()) throw new Error(`CODEX_HOME ${dir} exists but is not a directory`);
  const fresh = !existsSync(dir) || readdirSync(dir).length === 0;
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "config.toml");
  let created = false;
  if (fresh) {
    writeFileSync(configPath, BOOTSTRAP_CONFIG, { encoding: "utf8", flag: "wx" });
    writeFileSync(join(dir, MANAGED_MARKER), "Created by Agent Daemon. Delete to stop ad from managing this CODEX_HOME.\n");
    created = true;
  }
  return { dir, configPath, created, managed: isManagedHome(dir) };
}

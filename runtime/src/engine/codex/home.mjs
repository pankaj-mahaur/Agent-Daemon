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

const samePath = (a, b) => {
  const x = resolve(a);
  const y = resolve(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
};

// The user's own Codex homes: ~/.codex, plus a CODEX_HOME inherited from
// their shell unless it is ad's own home (hooks that Codex runs for us
// inherit our CODEX_HOME, and must still be able to start an engine).
export function userCodexHomes(env = process.env) {
  const homes = [join(homedir(), ".codex")];
  if (env.CODEX_HOME && !samePath(env.CODEX_HOME, defaultCodexHome(env))) homes.push(resolve(env.CODEX_HOME));
  return homes;
}

// Every real Codex process ad starts must run in its own home. Codex's
// default home is the user's own install — their login, sessions, daemon and
// config — and ad never reads or writes it.
export function assertIsolatedHome(home, env = process.env) {
  if (!home) {
    throw new Error("refusing to start Codex without an explicit CODEX_HOME: the default (~/.codex) belongs to your own Codex");
  }
  if (userCodexHomes(env).some((h) => samePath(h, home))) {
    throw new Error(`refusing to run Codex in ${resolve(home)}: that is your own Codex home. Point AD_CODEX_HOME somewhere else.`);
  }
}

export const MANAGED_MARKER = ".agent-daemon-managed";

// True only for a folder Agent Daemon created. A pre-existing CODEX_HOME
// never gets the marker, so it is never auto-modified (and the user's own
// ~/.codex is refused outright by assertIsolatedHome).
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

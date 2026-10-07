// The harness's own CODEX_HOME — config, auth, sessions and logs for Codex
// runs started by Agent Daemon, isolated from the user's ~/.codex.
//
// Kept short on purpose: the app-server control socket path must fit in
// 108 bytes on Windows, so it lives directly under the user's home.
//
// Only the bootstrap file is written here. Everything else goes through the
// app-server's own `config/batchWrite`, so we never hand-edit TOML that
// Codex also writes (hook trust, login state).

import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

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

const WIN = process.platform === "win32";

// Win32 path rules drop trailing dots and spaces from every segment, so
// `.codex.` and `.codex ` open the real `.codex` in most programs (Codex
// included) — while Node's \\?\-prefixed fs calls treat them as other names.
const trailingDotOrSpace = (p) => WIN && resolve(p).split(/[\\/]/).slice(1).some((seg) => seg !== "" && /[. ]$/.test(seg));
const win32Segments = (p) => (WIN ? p.split(/([\\/])/).map((s) => (/^[\\/]$/.test(s) ? s : s.replace(/[. ]+$/, "") || s)).join("") : p);

// A path's identity for "is this the same folder?": the real path of its
// nearest existing ancestor — so junctions, symlinks, 8.3 short names, subst
// drives and the \\?\ prefix all collapse — plus the part that doesn't exist
// yet, case-folded where filesystems are case-insensitive by default.
export function canonicalPath(p, base = process.cwd()) {
  let current = win32Segments(resolve(base, p));
  const missing = [];
  for (;;) {
    try {
      current = realpathSync.native(current);
      break;
    } catch {
      const parent = dirname(current);
      if (parent === current) break;
      missing.unshift(basename(current));
      current = parent;
    }
  }
  let out = join(current, ...missing).replace(/^\\\\\?\\(UNC\\)?/, (_, unc) => (unc ? "\\\\" : ""));
  out = out.replace(/[\\/]+$/, "") || out;
  return process.platform === "win32" || process.platform === "darwin" ? out.toLowerCase() : out;
}

// The user's own Codex homes: ~/.codex (for both the current HOME and the OS
// account's home), plus a CODEX_HOME inherited from their shell — unless ad
// started that Codex. Codex runs our hooks with our CODEX_HOME, and they must
// still be able to start an engine: codexEnv() stamps AD_ENGINE_HOME on every
// Codex it starts, and a home ad created carries the managed marker.
export function userCodexHomes(env = process.env) {
  const homes = new Set([join(homedir(), ".codex")]);
  try {
    homes.add(join(userInfo().homedir, ".codex"));
  } catch {
    // no OS account info (rare containers) — HOME's ~/.codex is still covered
  }
  if (env.CODEX_HOME) {
    const inherited = resolve(env.CODEX_HOME);
    const startedByAd = env.AD_ENGINE_HOME && canonicalPath(inherited) === env.AD_ENGINE_HOME;
    if (!startedByAd && !isManagedHome(inherited)) homes.add(inherited);
  }
  return [...homes];
}

// Every real Codex process ad starts must run in its own home. Codex's
// default home is the user's own install — their login, sessions, daemon and
// config — and ad never runs Codex in it or writes to it. A relative home is
// resolved against `base`, the directory Codex will be started in.
export function assertIsolatedHome(home, env = process.env, base = process.cwd()) {
  if (!home) {
    throw new Error("refusing to start Codex without an explicit CODEX_HOME: the default (~/.codex) belongs to your own Codex");
  }
  const full = resolve(base, home);
  if (trailingDotOrSpace(full)) {
    throw new Error(`refusing CODEX_HOME ${JSON.stringify(full)}: Windows ignores a trailing dot or space in a folder name, so it could open another folder`);
  }
  const target = canonicalPath(full);
  if (WIN && target.startsWith("\\\\")) {
    throw new Error(`refusing CODEX_HOME ${full}: network (UNC) paths are not supported`);
  }
  if (userCodexHomes(env).some((h) => canonicalPath(h) === target)) {
    throw new Error(`refusing to run Codex in ${full}: that is your own Codex home. Point AD_CODEX_HOME somewhere else.`);
  }
}

// Inherited CODEX_* variables that only configure trust, not state: kept.
const CODEX_ENV_ALLOWED = new Set(["CODEX_CA_CERTIFICATE"]);
const dropCodexVars = (vars) =>
  Object.fromEntries(Object.entries(vars).filter(([key]) => !/^codex_/i.test(key) || CODEX_ENV_ALLOWED.has(key.toUpperCase())));

// The environment for every real Codex process ad starts. CODEX_* variables
// are dropped from both the inherited and the passed-in environment —
// CODEX_SQLITE_HOME, CODEX_EXEC_SERVER_URL, CODEX_API_KEY and friends override
// config and would point ad's Codex at the user's own state, executor or
// credentials (CODEX_CA_CERTIFICATE stays: TLS trust behind proxies). Then an
// absolute, isolated CODEX_HOME, and AD_ENGINE_HOME so ad processes Codex
// starts (hooks) recognise the home as ad's.
export function codexEnv({ home, base = process.env, extra = {}, cwd = process.cwd() } = {}) {
  assertIsolatedHome(home, base, cwd);
  const full = resolve(cwd, home);
  return { ...dropCodexVars(base), ...dropCodexVars(extra), CODEX_HOME: full, AD_ENGINE_HOME: canonicalPath(full) };
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
export function ensureCodexHome(dir = defaultCodexHome(), { env = process.env } = {}) {
  // Before anything is written: a marker in the user's own home would make it look like ours.
  assertIsolatedHome(dir, env);
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

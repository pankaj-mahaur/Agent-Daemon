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
import { ownEngineHomeDefaultRefusal, ownEngineHomeStartRefusal, envConflictRefusal } from "../attribution.mjs";
import { engineError } from "./errors.mjs";
import { createLegacyLink, defaultRoot, entryKind, OLD_HOME_NAME, resolveHomeState } from "./home-resolve.mjs";

export const BOOTSTRAP_CONFIG = `# Agent Daemon's engine settings.
# ad writes the settings it manages through the engine; edit freely.

# Keep the sign-in inside this folder instead of the OS keyring, so ad's
# sign-in stays separate from any other sign-in on this machine.
cli_auth_credentials_store = "file"
`;

/**
 * The engine's folder chosen by the user's environment, or null:
 * AD_ENGINE_DIR, else the older AD_CODEX_HOME (read forever). Both set to
 * different folders → refused. A stray AD_ENGINE_HOME (an internal stamp of
 * ad 2.x, a natural wrong guess) outside the engine's own processes → refused.
 */
export function homeOverride(env = process.env) {
  const a = env.AD_ENGINE_DIR ? resolve(env.AD_ENGINE_DIR) : null;
  const b = env.AD_CODEX_HOME ? resolve(env.AD_CODEX_HOME) : null;
  if (a && b && canonicalPath(a) !== canonicalPath(b)) {
    throw engineError("HOME_CONFLICT", envConflictRefusal({ newName: "AD_ENGINE_DIR", oldName: "AD_CODEX_HOME", newValue: a, oldValue: b }));
  }
  if (!a && !b && env.AD_ENGINE_HOME && !env.CODEX_HOME) {
    throw engineError("HOME_STRAY_STAMP", "AD_ENGINE_HOME is not a setting. To choose the engine's folder, set AD_ENGINE_DIR.");
  }
  return a ?? b;
}

/** The engine's folder: the user's override, else the resolved default (read-only; never writes). */
export function defaultCodexHome(env = process.env, { root } = {}) {
  return homeOverride(env) ?? resolveHomeState({ root }).path;
}

/**
 * Resolves the default folder (write mode) and bootstraps a fresh install:
 * engine/ plus the codex-home link. A missing link next to engine/ is made
 * again (a crash or a failed first start can leave none, and without it a
 * rolled-back 2.x would start an empty folder). The link is best effort: the
 * engine works without it. Call it under the `migrate` lock.
 * `onEvent` hears {type: "setAside", path} and {type: "linkFailed", link, error}.
 * → the folder's path.
 */
export function prepareDefaultHome({ root = defaultRoot(), autoPickEmpty = false, env = process.env, onEvent = () => {} } = {}) {
  const r = resolveHomeState({ root, write: true, autoPickEmpty });
  if (r.setAside) onEvent({ type: "setAside", path: r.setAside });
  ensureCodexHome(r.path, { env });
  const link = join(root, OLD_HOME_NAME);
  if (r.linkError) onEvent({ type: "linkFailed", link, error: r.linkError });
  else if ((r.state === "fresh" || r.state === "new") && entryKind(link) === "missing") {
    try {
      createLegacyLink(r.path, link);
    } catch (err) {
      onEvent({ type: "linkFailed", link, error: err.message });
    }
  }
  return r.path;
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
// still be able to start an engine: codexEnv() stamps AD_INTERNAL_ENGINE_HOME
// on every Codex it starts (the old AD_ENGINE_HOME name is still read), and a
// home ad created carries the managed marker.
export function userCodexHomes(env = process.env) {
  const homes = new Set([join(homedir(), ".codex")]);
  try {
    homes.add(join(userInfo().homedir, ".codex"));
  } catch {
    // no OS account info (rare containers) — HOME's ~/.codex is still covered
  }
  if (env.CODEX_HOME) {
    const inherited = resolve(env.CODEX_HOME);
    const stamp = env.AD_INTERNAL_ENGINE_HOME ?? env.AD_ENGINE_HOME; // the old name: hooks of an engine ad 2.x started
    const startedByAd = stamp && canonicalPath(inherited) === stamp;
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
    throw engineError("HOME_REQUIRED", ownEngineHomeDefaultRefusal);
  }
  const full = resolve(base, home);
  if (trailingDotOrSpace(full)) {
    throw engineError("HOME_TRAILING", `refusing the engine home ${JSON.stringify(full)}: Windows ignores a trailing dot or space in a folder name, so it could open another folder`);
  }
  const target = canonicalPath(full);
  if (WIN && target.startsWith("\\\\")) {
    throw engineError("HOME_UNC", `refusing the engine home ${full}: network (UNC) paths are not supported`);
  }
  if (userCodexHomes(env).some((h) => canonicalPath(h) === target)) {
    throw engineError("HOME_IS_USERS", ownEngineHomeStartRefusal(full));
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
// absolute, isolated CODEX_HOME, and AD_INTERNAL_ENGINE_HOME so ad processes Codex
// starts (hooks) recognise the home as ad's.
export function codexEnv({ home, base = process.env, extra = {}, cwd = process.cwd() } = {}) {
  assertIsolatedHome(home, base, cwd);
  const full = resolve(cwd, home);
  const env = { ...dropCodexVars(base), ...dropCodexVars(extra), CODEX_HOME: full, AD_INTERNAL_ENGINE_HOME: canonicalPath(full) };
  delete env.AD_ENGINE_HOME; // ad 2.x's name for the stamp: never passed on
  return env;
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
  if (existsSync(dir) && !statSync(dir).isDirectory()) throw engineError("HOME_NOT_DIR", `the engine home ${dir} exists but is not a directory`);
  const fresh = !existsSync(dir) || readdirSync(dir).length === 0;
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "config.toml");
  let created = false;
  if (fresh) {
    writeFileSync(configPath, BOOTSTRAP_CONFIG, { encoding: "utf8", flag: "wx" });
    writeFileSync(join(dir, MANAGED_MARKER), "Created by Agent Daemon. Delete this file to stop ad from managing this folder.\n");
    created = true;
  }
  return { dir, configPath, created, managed: isManagedHome(dir) };
}

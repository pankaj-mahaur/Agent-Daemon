// Zero-dep secret store for provider API keys (OpenRouter, …).
//
// Secrets never travel in argv (visible in process listings) and are never
// logged. Backends, picked per platform:
//   win32  → DPAPI (current-user encryption) via PowerShell, secret on stdin,
//            ciphertext in ~/.agent-daemon/secrets/<name>.dpapi
//   linux  → libsecret via `secret-tool` (secret on stdin), else file
//   other  → file ~/.agent-daemon/secrets/<name> with mode 0600
//
// ChatGPT / OpenAI logins are NOT stored here — Codex owns those tokens in
// the harness CODEX_HOME and refreshes them itself.

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SERVICE = "agent-daemon";
const TIMEOUT_MS = 15_000; // a locked keyring must not hang the CLI

export const secretsDir = (env = process.env) => env.AD_SECRETS_DIR ?? join(homedir(), ".agent-daemon", "secrets");

function checkName(name) {
  if (!NAME_RE.test(name)) throw new Error(`invalid secret name: ${JSON.stringify(name)}`);
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
}

const run = (cmd, args, input, env) =>
  execFileSync(cmd, args, { input, env, encoding: "utf8", windowsHide: true, timeout: TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"] });

// Launched from pwsh 7, PSModulePath points Windows PowerShell 5.1 at the 7.x
// Microsoft.PowerShell.Security module, which it cannot load
// (CouldNotAutoloadMatchingModule). Without the variable, 5.1 uses its defaults.
export const windowsPowerShellEnv = (env = process.env) =>
  Object.fromEntries(Object.entries(env).filter(([k]) => k.toUpperCase() !== "PSMODULEPATH"));

// PowerShell scripts read the secret / ciphertext from stdin, never argv.
// $ErrorActionPreference=Stop turns non-terminating errors into exit 1.
const PS_PROTECT =
  "$ErrorActionPreference='Stop'; $s=[Console]::In.ReadToEnd(); $ss=ConvertTo-SecureString -String $s -AsPlainText -Force; ConvertFrom-SecureString -SecureString $ss";
const PS_UNPROTECT =
  "$ErrorActionPreference='Stop'; $c=[Console]::In.ReadToEnd().Trim(); $ss=ConvertTo-SecureString -String $c; " +
  "$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss); try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }";
const powershell = (script, input) =>
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], input, windowsPowerShellEnv());

// Write a file that is 0600 from its first byte (an existing, wider file is
// removed first rather than overwritten in place).
function writePrivate(path, value) {
  rmSync(path, { force: true });
  writeFileSync(path, value, { mode: 0o600, flag: "wx" });
}

export const fileBackend = (dir) => ({
  name: "file",
  set(name, value) {
    ensureDir(dir);
    writePrivate(join(dir, name), value);
  },
  get(name) {
    const p = join(dir, name);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  },
  has: (name) => existsSync(join(dir, name)),
  delete(name) {
    rmSync(join(dir, name), { force: true });
  },
});

export const dpapiBackend = (dir) => ({
  name: "dpapi",
  set(name, value) {
    const cipher = powershell(PS_PROTECT, value).trim();
    if (!cipher) throw new Error("DPAPI encryption returned nothing");
    ensureDir(dir);
    writePrivate(join(dir, `${name}.dpapi`), cipher);
  },
  get(name) {
    const p = join(dir, `${name}.dpapi`);
    if (!existsSync(p)) return null;
    const value = powershell(PS_UNPROTECT, readFileSync(p, "utf8"));
    if (!value) throw new Error(`stored secret ${name} decrypted to nothing`);
    return value;
  },
  has: (name) => existsSync(join(dir, `${name}.dpapi`)),
  delete(name) {
    rmSync(join(dir, `${name}.dpapi`), { force: true });
  },
});

export const libsecretBackend = () => ({
  name: "libsecret",
  set(name, value) {
    run("secret-tool", ["store", "--label", `${SERVICE} ${name}`, "service", SERVICE, "key", name], value);
  },
  get(name) {
    try {
      return run("secret-tool", ["lookup", "service", SERVICE, "key", name]) || null;
    } catch (err) {
      if (err.status === 1) return null; // not found
      throw err;
    }
  },
  has(name) {
    return this.get(name) != null;
  },
  delete(name) {
    try {
      run("secret-tool", ["clear", "service", SERVICE, "key", name]);
    } catch (err) {
      if (err.status !== 1) throw err;
    }
  },
});

// secret-tool has no --version; running it bare prints usage and exits
// non-zero. Only a spawn error (ENOENT) means it is absent.
export function hasSecretTool(spawn = spawnSync) {
  const r = spawn("secret-tool", [], { stdio: "ignore", timeout: 5000 });
  return !r.error;
}

export function defaultBackend(env = process.env) {
  const dir = secretsDir(env);
  if (env.AD_SECRETS_BACKEND === "file") return fileBackend(dir);
  if (process.platform === "win32") return dpapiBackend(dir);
  if (process.platform === "linux" && hasSecretTool()) return withFileFallback(libsecretBackend(), fileBackend(dir));
  return fileBackend(dir);
}

// Headless Linux (no D-Bus / locked keyring): fall back to the 0600 file.
function withFileFallback(primary, fallback) {
  let active = primary;
  const call = (op, ...args) => {
    try {
      return active[op](...args);
    } catch (err) {
      if (active === fallback) throw err;
      process.stderr.write(`[agent-daemon] ${primary.name} unavailable (${err.message.split("\n")[0]}); using ${fallback.name} secret store\n`);
      active = fallback;
      return active[op](...args);
    }
  };
  return {
    get name() {
      return active.name;
    },
    set: (n, v) => call("set", n, v),
    get: (n) => call("get", n),
    has: (n) => call("has", n),
    delete: (n) => call("delete", n),
  };
}

export function createSecretStore(backend = defaultBackend()) {
  return {
    get backend() {
      return backend.name;
    },
    set(name, value) {
      checkName(name);
      if (typeof value !== "string" || !value.trim()) throw new Error("secret value must be a non-empty string");
      backend.set(name, value.trim());
    },
    get(name) {
      checkName(name);
      return backend.get(name);
    },
    // Presence only — never decrypts, so a damaged secret can still be
    // listed and deleted.
    has(name) {
      checkName(name);
      return backend.has ? backend.has(name) : backend.get(name) != null;
    },
    delete(name) {
      checkName(name);
      backend.delete(name);
    },
  };
}

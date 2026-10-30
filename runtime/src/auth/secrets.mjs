// Zero-dep secret store for provider API keys (OpenRouter, …).
//
// Secrets never travel in argv (visible in process listings) and are never
// logged. Backends, picked per platform:
//   win32  → DPAPI (current-user encryption) via PowerShell, secret on stdin,
//            ciphertext in ~/.agent-daemon/secrets/<name>.dpapi
//   linux  → libsecret via `secret-tool` (secret on stdin), else file
//   other  → file ~/.agent-daemon/secrets/<name> with mode 0600
//
//   darwin → the macOS keychain through the optional @napi-rs/keyring (P3.2, D06);
//            a 3.0 file secret is still read; without the module, the file
//
// ChatGPT / OpenAI logins are NOT stored here — the engine owns those tokens in
// the engine home and refreshes them itself.
//
// v2 (P3.2): writes are atomic (a temp file renamed over, so a crash keeps the old
// value); getMany(names) reads several at once (DPAPI: one PowerShell start);
// list() names what is stored (ad auth repair only; libsecret keeps key names, never
// values).

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { systemTool } from "../safe-spawn.mjs";
import { adRoot } from "../ad-root.mjs";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SERVICE = "agent-daemon";
const TIMEOUT_MS = 15_000; // a locked keyring must not hang the CLI

// Under ad's one state root (P7.1a): AD_ROOT, else ~/.agent-daemon.
export const secretsDir = (env = process.env) => env.AD_SECRETS_DIR ?? join(adRoot({ env }), "secrets");

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
// Several ciphertexts in, their plaintexts out, in one PowerShell start (a JSON array
// each way on stdin/stdout; an entry that can't be read comes back null).
const PS_UNPROTECT_MANY =
  "$ErrorActionPreference='Stop'; $in=[Console]::In.ReadToEnd() | ConvertFrom-Json; $out=@(); foreach ($c in $in) { try { $ss=ConvertTo-SecureString -String ([string]$c).Trim(); " +
  "$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss); try { $out += ,[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) } } catch { $out += ,$null } }; " +
  "[Console]::Out.Write((ConvertTo-Json -InputObject @($out) -Compress))";
// By absolute path: it receives secret values on stdin, so a powershell.exe
// planted in the folder `ad auth` runs from must never be the one started.
const powershell = (script, input) => {
  const exe = systemTool("powershell.exe");
  if (!exe) throw new Error("Windows PowerShell isn't in %SystemRoot%\\System32, so ad can't encrypt or read the secret.");
  return run(exe, ["-NoProfile", "-NonInteractive", "-Command", script], input, windowsPowerShellEnv());
};

// Write a file that is 0600 from its first byte: a new temp file, renamed over the
// old one, so a crash in between keeps the previous value (P3.2).
function writePrivate(path, value) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, value, { mode: 0o600, flag: "wx" });
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
const isTemp = (n) => /\.\d+\.[0-9a-f]{8}\.tmp$/.test(n);

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
  list() {
    try {
      return readdirSync(dir).filter((n) => !isTemp(n) && !n.endsWith(".dpapi")).sort();
    } catch {
      return [];
    }
  },
});

export const dpapiBackend = (dir, { ps = powershell } = {}) => ({
  name: "dpapi",
  set(name, value) {
    const cipher = ps(PS_PROTECT, value).trim();
    if (!cipher) throw new Error("DPAPI encryption returned nothing");
    ensureDir(dir);
    writePrivate(join(dir, `${name}.dpapi`), cipher);
  },
  get(name) {
    const p = join(dir, `${name}.dpapi`);
    if (!existsSync(p)) return null;
    const value = ps(PS_UNPROTECT, readFileSync(p, "utf8"));
    if (!value) throw new Error(`stored secret ${name} decrypted to nothing`);
    return value;
  },
  // One PowerShell start for all of them (the gateway reads every account's key).
  getMany(names) {
    const present = names.filter((n) => existsSync(join(dir, `${n}.dpapi`)));
    const out = new Map(names.map((n) => [n, null]));
    if (!present.length) return out;
    const values = JSON.parse(ps(PS_UNPROTECT_MANY, JSON.stringify(present.map((n) => readFileSync(join(dir, `${n}.dpapi`), "utf8")))) || "[]");
    present.forEach((n, i) => out.set(n, values[i] || null));
    return out;
  },
  has: (name) => existsSync(join(dir, `${name}.dpapi`)),
  delete(name) {
    rmSync(join(dir, `${name}.dpapi`), { force: true });
  },
  list() {
    try {
      return readdirSync(dir).filter((n) => n.endsWith(".dpapi") && !isTemp(n)).map((n) => n.slice(0, -".dpapi".length)).sort();
    } catch {
      return [];
    }
  },
});

export const libsecretBackend = ({ runTool = run } = {}) => ({
  name: "libsecret",
  set(name, value) {
    runTool("secret-tool", ["store", "--label", `${SERVICE} ${name}`, "service", SERVICE, "key", name], value);
  },
  get(name) {
    try {
      return runTool("secret-tool", ["lookup", "service", SERVICE, "key", name]) || null;
    } catch (err) {
      if (err.status === 1) return null; // not found
      throw err;
    }
  },
  // Presence: libsecret looks the one entry up (accurate and cheap for one name).
  has(name) {
    return this.get(name) != null;
  },
  delete(name) {
    try {
      runTool("secret-tool", ["clear", "service", SERVICE, "key", name]);
    } catch (err) {
      if (err.status !== 1) throw err;
    }
  },
  // ad auth repair only: the names stored, from "attribute.key = <name>" lines. The
  // parser keeps nothing else (`search --all` prints the secrets too).
  list() {
    let text = "";
    try {
      text = runTool("secret-tool", ["search", "--all", "service", SERVICE]);
    } catch (err) {
      if (err.status === 1) return [];
      throw err;
    }
    const names = [];
    for (const line of String(text).split(/\r?\n/)) {
      const m = /^attribute\.key = ([a-z0-9][a-z0-9_-]{0,63})$/.exec(line.trim());
      if (m) names.push(m[1]);
    }
    return [...new Set(names)].sort();
  },
});

// macOS keychain (D06) through the optional @napi-rs/keyring, loaded only when used.
// load() → the module, or throws when it isn't installed.
const require_ = createRequire(import.meta.url);
export const keychainBackend = ({ load = () => require_("@napi-rs/keyring") } = {}) => {
  const { Entry } = load();
  const entry = (name) => new Entry(SERVICE, name);
  return {
    name: "keychain",
    set: (name, value) => entry(name).setPassword(value),
    get(name) {
      try {
        return entry(name).getPassword() ?? null;
      } catch {
        return null;
      }
    },
    has(name) {
      return this.get(name) != null;
    },
    delete(name) {
      try {
        entry(name).deletePassword();
      } catch {
        // not there
      }
    },
  };
};

// Reads fall back to the 3.0 file; delete clears both; writes go to the keychain.
export function withLegacyRead(primary, legacy) {
  return {
    name: primary.name,
    set: (n, v) => primary.set(n, v),
    get: (n) => primary.get(n) ?? legacy.get(n),
    has: (n) => primary.has(n) || legacy.has(n),
    delete(n) {
      primary.delete(n);
      legacy.delete(n);
    },
    list: () => [...new Set([...(primary.list?.() ?? []), ...(legacy.list?.() ?? [])])].sort(),
  };
}

// secret-tool has no --version; running it bare prints usage and exits
// non-zero. Only a spawn error (ENOENT) means it is absent.
export function hasSecretTool(spawn = spawnSync) {
  const r = spawn("secret-tool", [], { stdio: "ignore", timeout: 5000 });
  return !r.error;
}

export function defaultBackend(env = process.env, { platform = process.platform, loadKeychain } = {}) {
  const dir = secretsDir(env);
  if (env.AD_SECRETS_BACKEND === "file") return fileBackend(dir);
  if (platform === "win32") return dpapiBackend(dir);
  if (platform === "linux" && hasSecretTool()) return withFileFallback(libsecretBackend(), fileBackend(dir));
  if (platform === "darwin") {
    try {
      return withLegacyRead(keychainBackend(loadKeychain ? { load: loadKeychain } : {}), fileBackend(dir));
    } catch (e) {
      // The optional module isn't installed: the 0600 file, and doctor says why.
      return Object.assign(fileBackend(dir), { reason: `the keychain module isn't installed (${String(e.code ?? e.message).split("\n")[0]})` });
    }
  }
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
    list: () => call("list"),
  };
}

export function createSecretStore(backend = defaultBackend()) {
  return {
    get backend() {
      return backend.name;
    },
    /** Why the store isn't the platform's best one (null when it is). */
    get reason() {
      return backend.reason ?? null;
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
    /** Several at once → Map name → value | null (DPAPI: one PowerShell start). */
    getMany(names) {
      for (const n of names) checkName(n);
      if (backend.getMany) return backend.getMany(names);
      return new Map(names.map((n) => [n, backend.get(n)]));
    },
    // Presence: files and DPAPI check the file (never decrypt, so a damaged secret can
    // still be listed and deleted); libsecret and the keychain look the one entry up.
    has(name) {
      checkName(name);
      return backend.has ? backend.has(name) : backend.get(name) != null;
    },
    /** The names stored. For ad auth repair (an explicit user action) only. */
    list() {
      return backend.list ? backend.list() : [];
    },
    delete(name) {
      checkName(name);
      backend.delete(name);
    },
  };
}

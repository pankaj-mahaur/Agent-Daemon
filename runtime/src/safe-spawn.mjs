// Child processes without a shell and without bare program names.
//
// Two Windows holes this closes:
//   - A shell (`shell: true`, cmd.exe) parses its command line, so task text
//     containing `&`, `|` or `%VAR%` runs as commands on the host.
//   - Without a shell, Node still lets Windows look a bare name ("git") up in
//     the child's working folder (the parent's, when no cwd is given) before
//     PATH, unless NoDefaultCurrentDirectoryInExePath is set, which it usually
//     isn't. A repo holding a git.exe would run it.
//
// So on Windows every program is resolved here to an absolute path: PATH only
// (absolute entries, PATHEXT limited to .COM .EXE .BAT .CMD), and an npm
// .cmd shim is read to find the script it starts, which then runs with our
// own node. There is never a cmd.exe fallback. On POSIX the bare name is fine:
// execvp searches PATH only.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const W = path.win32;
const RUNNABLE_EXTS = [".COM", ".EXE", ".BAT", ".CMD"];
const SHIM_MAX_BYTES = 64 * 1024;

const realFs = {
  isFile: (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
  readFile: (p) => {
    const fd = fs.openSync(p, "r");
    try {
      const buf = Buffer.alloc(SHIM_MAX_BYTES);
      const n = fs.readSync(fd, buf, 0, SHIM_MAX_BYTES, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  },
};

// A copied env object is case-sensitive, Windows' own isn't: find the key.
function envGet(env, name) {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

// Drive-absolute (C:\x) or UNC (\\srv\share). Not "C:x" or "\x".
const winAbsolute = (p) => /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);

// The script or exe an npm cmd-shim starts: the last "%dp0%\…" or "%~dp0\…"
// target ending .js/.cjs/.mjs/.exe that isn't node.exe.
function shimTarget(shimFile, text) {
  const dir = W.dirname(shimFile);
  const re = /"%(?:~dp0|dp0%)\\?([^"%]+?\.(?:js|cjs|mjs|exe))"/gi;
  let target = null;
  for (const m of text.replace(/^\uFEFF/, "").matchAll(re)) {
    if (W.basename(m[1]).toLowerCase() === "node.exe") continue;
    target = W.resolve(dir, m[1]);
  }
  return target;
}

function classifyWin(file, { fsx, execPath, via }) {
  const ext = W.extname(file).toLowerCase();
  if (ext === ".exe" || ext === ".com") return { cmd: file, prefix: [], via, file };
  if (ext === ".js" || ext === ".cjs" || ext === ".mjs") return { cmd: execPath, prefix: [file], via, file };
  if (ext === ".cmd" || ext === ".bat") {
    let text = "";
    try {
      text = fsx.readFile(file);
    } catch {
      return { cmd: null, via: "unreadable-shim", file };
    }
    const target = shimTarget(file, text);
    if (!target || !fsx.isFile(target)) return { cmd: null, via: "unreadable-shim", file };
    const inner = classifyWin(target, { fsx, execPath, via: "npm-shim" });
    return { ...inner, via: "npm-shim", file };
  }
  return { cmd: null, via: "unreadable-shim", file };
}

/**
 * Resolve a program name to something spawn can start without a shell.
 *
 * @returns {{cmd:string, prefix:string[], via:"env"|"exe"|"npm-shim"|"posix", file:string} | {cmd:null, via:"missing"|"unreadable-shim", file?:string}}
 */
export function resolveCommand(name, { env = process.env, platform = process.platform, overrideVar, fsx = realFs, execPath = process.execPath } = {}) {
  const override = overrideVar ? envGet(env, overrideVar) : undefined;
  if (platform !== "win32") {
    if (override) {
      if (!path.posix.isAbsolute(override) || !fsx.isFile(override)) return { cmd: null, via: "missing", file: override };
      return /\.(c|m)?js$/i.test(override) ? { cmd: execPath, prefix: [override], via: "env", file: override } : { cmd: override, prefix: [], via: "env", file: override };
    }
    return { cmd: name, prefix: [], via: "posix", file: name };
  }

  if (override) {
    if (!winAbsolute(override) || !fsx.isFile(override)) return { cmd: null, via: "missing", file: override };
    const r = classifyWin(override, { fsx, execPath, via: "env" });
    return r.cmd ? { ...r, via: "env" } : r;
  }

  const pathext = String(envGet(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim().toUpperCase())
    .filter((e) => RUNNABLE_EXTS.includes(e));
  const exts = pathext.length ? pathext : RUNNABLE_EXTS;
  const own = W.extname(name).toUpperCase();
  const candidates = RUNNABLE_EXTS.includes(own) ? [name] : exts.map((e) => name + e.toLowerCase());

  const dirs = String(envGet(env, "PATH") || "")
    .split(";")
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter((d) => d && winAbsolute(d));
  for (const dir of dirs) {
    for (const c of candidates) {
      const file = W.join(dir, c);
      if (fsx.isFile(file)) return classifyWin(file, { fsx, execPath, via: "exe" });
    }
  }
  return { cmd: null, via: "missing" };
}

/**
 * A Windows system tool by absolute path under %SystemRoot%\System32, or null
 * when it isn't there (callers report it missing; never a bare-name fallback).
 * Not used on POSIX.
 */
export function systemTool(name, { env = process.env, platform = process.platform, fsx = realFs } = {}) {
  if (platform !== "win32") return null;
  const root = envGet(env, "SystemRoot");
  if (!root || !winAbsolute(root)) return null;
  const exe = W.extname(name) ? name : `${name}.exe`;
  const file = exe.toLowerCase() === "powershell.exe"
    ? W.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : W.join(root, "System32", exe);
  return fsx.isFile(file) ? file : null;
}

function checkResolved(resolved, opts) {
  if (!resolved?.cmd) throw new Error(`spawnResolved: command ${resolved?.via ?? "missing"}${resolved?.file ? ` (${resolved.file})` : ""}`);
  if (opts.shell) throw new Error("spawnResolved: a shell is never used");
  if (process.platform === "win32" && !winAbsolute(resolved.cmd)) throw new Error(`spawnResolved: ${resolved.cmd} isn't an absolute path`);
}

/** spawn() a resolved command: no shell, no window, prefix args first. */
export function spawnResolved(resolved, args, opts = {}) {
  checkResolved(resolved, opts);
  return spawn(resolved.cmd, [...(resolved.prefix ?? []), ...args], { ...opts, shell: false, windowsHide: true });
}

/** The argv for an execFile-style call of a resolved command (same checks). */
export function resolvedArgv(resolved, args, opts = {}) {
  checkResolved(resolved, opts);
  return [resolved.cmd, [...(resolved.prefix ?? []), ...args]];
}

/** execFileSync without a shell, for argv from resolvedArgv(). */
export function execFileSyncNoShell(cmd, args, opts = {}) {
  if (opts.shell) throw new Error("execFileSyncNoShell: a shell is never used");
  if (process.platform === "win32" && !winAbsolute(cmd)) throw new Error(`execFileSyncNoShell: ${cmd} isn't an absolute path`);
  return execFileSync(cmd, args, { ...opts, shell: false, windowsHide: true });
}

/**
 * Write text to a private temp file, run fn(file), and remove the folder
 * afterwards whatever happens. Used for system prompts, which must not go
 * into argv.
 */
export async function withPromptFile(text, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ad-prompt-"));
  const file = path.join(dir, "system-prompt.md");
  try {
    await fsp.writeFile(file, text, { mode: 0o600 });
    return await fn(file);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch((e) => {
      process.stderr.write(`[agent-daemon] couldn't remove the temp prompt folder ${dir}: ${e.message}\n`);
    });
  }
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

/** A team, role or agent name that becomes part of a git branch and a path. */
export function checkName(value, label) {
  const ok = typeof value === "string" && NAME_RE.test(value) && !value.endsWith(".") && !value.toLowerCase().endsWith(".lock") && !value.includes("..");
  if (!ok) {
    throw new Error(`${label} ${JSON.stringify(String(value ?? "").slice(0, 40))} can only use letters, digits, ".", "_" and "-" (max 64).`);
  }
  return value;
}

/** A model id passed on to a worker as --model. */
export function checkModel(value) {
  if (typeof value !== "string" || !MODEL_RE.test(value)) {
    throw new Error(`--model ${JSON.stringify(String(value ?? "").slice(0, 40))} isn't a model name ad can pass on.`);
  }
  return value;
}

// User-facing texts shared by the callers.
export const CLAUDE_MISSING = "claude isn't on PATH. Install Claude Code, or set AD_CLAUDE_BIN to its path.";
export const GIT_MISSING = "git isn't on PATH.";
export const claudeUnreadableShim = (file) =>
  `Found ${file}, but ad can't tell what it runs without a shell. Install Claude Code's native build, or set AD_CLAUDE_BIN to claude.exe or to the cli.js it starts.`;
export const CLAUDE_TOO_OLD = "Your Claude Code doesn't know --append-system-prompt-file. Update it (claude update), then retry.";

/** Resolve Claude Code, or return the text saying why it can't start. */
export function resolveClaude(opts = {}) {
  const r = resolveCommand("claude", { overrideVar: "AD_CLAUDE_BIN", ...opts });
  if (r.cmd) return { resolved: r };
  return { error: r.via === "unreadable-shim" ? claudeUnreadableShim(r.file) : CLAUDE_MISSING };
}

/** Resolve git, or throw why it can't start. */
export function resolveGit(opts = {}) {
  const r = resolveCommand("git", opts);
  if (!r.cmd) throw new Error(r.via === "unreadable-shim" ? `Found ${r.file}, but ad can't tell what it runs without a shell. Put git.exe's folder on PATH.` : GIT_MISSING);
  return r;
}

/** True when Claude Code's stderr says it doesn't know the -file flag. */
export const claudeLacksPromptFile = (stderr) => /unknown option[^\n]*--append-system-prompt-file/i.test(String(stderr ?? ""));

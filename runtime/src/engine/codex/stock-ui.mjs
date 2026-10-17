// The engine's own UI on ad's engine home, never the user's own install. For
// maintainers (`ad engine ui --debug`, Part 3); ad's users don't get it.
// Mirrors ~/.claude/skills into the home's skills folder (copy-sync), as
// before.

import { spawn } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

function isBrokenLink(p) {
  try {
    return lstatSync(p).isSymbolicLink() && !existsSync(p);
  } catch {
    return true;
  }
}
import { homedir } from "node:os";
import path from "node:path";
import { providerEnv } from "../../auth/providers.mjs";
import { CODEX_MISSING, resolveCodexCommand, withoutStoreAliases } from "./app-server.mjs";
import { codexEnv, defaultCodexHome, ensureCodexHome } from "./home.mjs";

export const MIRROR_MARKER = ".ad-mirror";
export const MIRRORED_FLAG = ".ad-mirrored-claude-skills";

function newestMtime(dir) {
  let newest = statSync(dir).mtimeMs;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    try {
      newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
    } catch {
      // A broken link: it can't be copied either; ignore it.
    }
  }
  return newest;
}

/**
 * Mirrors skill folders from `from` into `<home>/skills`. A folder the user
 * put there themselves (no marker) is never touched. Returns {copied, removed}.
 */
export function syncSkills({ home, from = path.join(homedir(), ".claude", "skills") } = {}) {
  const dest = path.join(home, "skills");
  const out = { copied: 0, removed: 0 };
  mkdirSync(dest, { recursive: true });
  // statSync follows a linked (symlink / junction) skill folder like a real one.
  const isDir = (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const sources = existsSync(from) ? readdirSync(from, { withFileTypes: true }).filter((e) => isDir(path.join(from, e.name)) && existsSync(path.join(from, e.name, "SKILL.md"))) : [];
  const names = new Set(sources.map((e) => e.name));
  for (const e of sources) {
    const src = path.join(from, e.name);
    const dst = path.join(dest, e.name);
    if (existsSync(dst) && !existsSync(path.join(dst, MIRROR_MARKER))) continue; // the user's own
    if (existsSync(dst) && newestMtime(src) <= statSync(path.join(dst, MIRROR_MARKER)).mtimeMs) continue;
    // Copied next to the mirror first and swapped in only when complete, so a
    // failed copy (no symlink rights on Windows, a broken link) never loses
    // the mirrored copy that was there.
    const tmp = `${dst}.ad-tmp-${process.pid}`;
    try {
      rmSync(tmp, { recursive: true, force: true });
      // The folder itself is resolved; links inside are kept as links (never followed into big trees).
      cpSync(realpathSync(src), tmp, { recursive: true, verbatimSymlinks: true, filter: (from) => !isBrokenLink(from) });
      writeFileSync(path.join(tmp, MIRROR_MARKER), "mirrored from ~/.claude/skills by ad; edits here are overwritten\n");
      rmSync(dst, { recursive: true, force: true });
      renameSync(tmp, dst);
      out.copied++;
    } catch {
      rmSync(tmp, { recursive: true, force: true });
      out.failed = (out.failed ?? 0) + 1;
    }
  }
  for (const e of readdirSync(dest, { withFileTypes: true })) {
    if (!e.isDirectory() || names.has(e.name)) continue;
    const dst = path.join(dest, e.name);
    if (existsSync(path.join(dst, MIRROR_MARKER))) {
      rmSync(dst, { recursive: true, force: true });
      out.removed++;
    }
  }
  writeFileSync(path.join(dest, MIRRORED_FLAG), String(from));
  return out;
}

/** The argv for the stock UI: `--no-daemon` always; `resume <id>` to continue a thread. */
export function stockUiArgs({ args = [], threadId = null, cwd = null } = {}) {
  const out = threadId ? ["resume", threadId] : [...args];
  if (!out.includes("--no-daemon")) out.push("--no-daemon");
  if (cwd && !out.includes("-C") && !out.includes("--cd")) out.push("-C", cwd);
  return out;
}

/**
 * Runs the stock UI in the foreground and resolves with its exit code. The
 * caller owns the terminal handoff (io.handoff in the TUI).
 */
export function runStockUi({ args = [], threadId = null, cwd = process.cwd(), home = defaultCodexHome(), store, env = process.env, spawnFn = spawn, skillsFrom } = {}) {
  const cmd = resolveCodexCommand(env);
  if (!cmd.cmd) return Promise.reject(new Error(CODEX_MISSING));
  ensureCodexHome(home, { env });
  try {
    syncSkills({ home, from: skillsFrom });
  } catch (err) {
    process.stderr.write(`[agent-daemon] skills not mirrored: ${err.message}\n`);
  }
  const childEnv = withoutStoreAliases(codexEnv({ home, base: env, extra: providerEnv(store), cwd }));
  return new Promise((resolve, reject) => {
    const child = spawnFn(cmd.cmd, [...cmd.prefix, ...stockUiArgs({ args, threadId, cwd })], { stdio: "inherit", env: childEnv, cwd });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

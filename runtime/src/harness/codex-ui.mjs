// `ad codex [args…]` (plan Part 6, D6, spike S3): the pinned stock Codex UI
// on ad's own Codex home, never the user's ~/.codex.
//
//   - CODEX_HOME is the harness home (codexEnv drops every CODEX_* variable
//     and refuses the user's own home); provider keys come from ad's secret
//     store; `--no-daemon`, so it never talks to the user's Codex daemon.
//   - Skills: Codex reads $CODEX_HOME/skills, so ~/.claude/skills is mirrored
//     there (copy-sync). Only folders ad created (marked) are ever replaced or
//     removed. Once mirrored, ad's engine stops passing that folder as an
//     extra root (setup.mjs skillRoots), so skills don't appear twice.
//     Project .claude/skills are a known gap in `ad codex`.

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { providerEnv } from "../auth/providers.mjs";
import { CODEX_MISSING, resolveCodexCommand, withoutStoreAliases } from "../engine/codex/app-server.mjs";
import { codexEnv, defaultCodexHome, ensureCodexHome } from "../engine/codex/home.mjs";

export const MIRROR_MARKER = ".ad-mirror";
export const MIRRORED_FLAG = ".ad-mirrored-claude-skills";

function newestMtime(dir) {
  let newest = statSync(dir).mtimeMs;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
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
  const sources = existsSync(from) ? readdirSync(from, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(path.join(from, e.name, "SKILL.md"))) : [];
  const names = new Set(sources.map((e) => e.name));
  for (const e of sources) {
    const src = path.join(from, e.name);
    const dst = path.join(dest, e.name);
    if (existsSync(dst) && !existsSync(path.join(dst, MIRROR_MARKER))) continue; // the user's own
    if (existsSync(dst) && newestMtime(src) <= statSync(path.join(dst, MIRROR_MARKER)).mtimeMs) continue;
    rmSync(dst, { recursive: true, force: true });
    cpSync(src, dst, { recursive: true, dereference: true });
    writeFileSync(path.join(dst, MIRROR_MARKER), "mirrored from ~/.claude/skills by ad codex; edits here are overwritten\n");
    out.copied++;
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
export function codexArgs({ args = [], threadId = null, cwd = null } = {}) {
  const out = threadId ? ["resume", threadId] : [...args];
  if (!out.includes("--no-daemon")) out.push("--no-daemon");
  if (cwd && !out.includes("-C") && !out.includes("--cd")) out.push("-C", cwd);
  return out;
}

/**
 * Runs the stock UI in the foreground and resolves with its exit code. The
 * caller owns the terminal handoff (io.handoff in the TUI).
 */
export function runStockCodex({ args = [], threadId = null, cwd = process.cwd(), home = defaultCodexHome(), store, env = process.env, spawnFn = spawn, skillsFrom } = {}) {
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
    const child = spawnFn(cmd.cmd, [...cmd.prefix, ...codexArgs({ args, threadId, cwd })], { stdio: "inherit", env: childEnv, cwd });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

export async function cmdCodex(args = [], opts = {}) {
  try {
    return await runStockCodex({ args, cwd: opts.cwd ?? process.cwd(), home: opts.home, store: opts.store });
  } catch (err) {
    (opts.stderr ?? process.stderr).write(`ad codex: ${err.message}\n`);
    return 1;
  }
}

// Spawn-and-exit jobs for hooks (plan L2): the hook starts the job detached
// and returns at once. S-HOOKS: the children of a hook that exits normally
// survive on both hosts, but a hook killed at its timeout takes its children
// with it on Claude Code, so the hook must never wait.
//
// Single-flight: a job key holds an exclusive marker file while it starts; a
// second start within `windowMs` is skipped. The marker is a throttle, not a
// lock on the job's work (the job takes its own locks).

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { adRoot } from "../ad-root.mjs";

/**
 * The environment for a job a hook starts: without the hook-only variables
 * (a job runs outside the hook's time limit, so it may open and upgrade the
 * memory store) and any others named in `drop`.
 */
export function jobEnv(env = process.env, drop = []) {
  const out = { ...env };
  for (const k of ["AD_HOOK_NO_MIGRATE", "AD_HOOK_EVENT", ...drop]) delete out[k];
  return out;
}

/**
 * Start `node <args…>` detached unless the same key started within windowMs.
 * onSpawn(child): called with the started child before the hook goes on (its pid).
 * @returns {boolean} whether it started
 */
export function spawnDetached(args, { key, windowMs = 60_000, root = adRoot(), now = Date.now(), spawnFn = spawn, env = jobEnv(), onSpawn } = {}) {
  if (key) {
    const dir = path.join(root, "hooks", "jobs");
    const file = path.join(dir, `${String(key).replace(/[^A-Za-z0-9_.-]/g, "_")}.started`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const st = fs.statSync(file, { throwIfNoEntry: false });
      if (st && now - st.mtimeMs < windowMs) return false;
      if (st) fs.rmSync(file, { force: true });
      fs.writeFileSync(file, String(process.pid), { flag: "wx" }); // exclusive: one of two racing hooks wins
    } catch {
      return false;
    }
  }
  // Started in node's own folder, not the hook's: on Windows a running process pins
  // its working folder (the user's project could not be moved or deleted meanwhile).
  // Jobs take every path they need as an argument.
  const child = spawnFn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true, env, cwd: path.dirname(process.execPath) });
  child.on?.("error", () => {}); // a failed start (EACCES, EAGAIN) must not crash the hook
  child.unref?.();
  try {
    onSpawn?.(child);
  } catch {
    // the caller's bookkeeping must not undo a started job
  }
  return true;
}

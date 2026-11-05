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
 * Start `node <args…>` detached unless the same key started within windowMs.
 * @returns {boolean} whether it started
 */
export function spawnDetached(args, { key, windowMs = 60_000, root = adRoot(), now = Date.now(), spawnFn = spawn, env = process.env } = {}) {
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
  const child = spawnFn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true, env });
  child.unref?.();
  return true;
}

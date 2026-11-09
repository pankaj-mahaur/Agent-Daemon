// Waiting for recall's detached context jobs (L6) before a test removes its temp
// folders. A job's git runs inside the repository; on Windows a folder a running
// process uses can't be deleted (EBUSY), so cleanup must wait for the job, not retry.
// The hook records each job's pid in <ad root>/recall/jobs/<pid> as it starts it;
// the job removes it as it exits. A marker whose process is gone counts as done.

import fs from "node:fs";
import path from "node:path";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
};

/** Wait until no context job started under this ad root is running (or the timeout). → whether they all ended */
export async function waitForRecallJobs(adRoot, { timeoutMs = 30_000 } = {}) {
  const dir = path.join(adRoot, "recall", "jobs");
  const until = Date.now() + timeoutMs;
  for (;;) {
    let running = [];
    try {
      running = fs.readdirSync(dir).map(Number).filter((pid) => Number.isInteger(pid) && alive(pid));
    } catch {
      return true; // no job ever started here
    }
    if (!running.length) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Processes whose working folder is under `dir` (Linux, from /proc; [] elsewhere). On
 * Windows such a folder can't be deleted (EBUSY): this lets a Linux run see the same trap.
 */
export function cwdsUnder(dir) {
  if (process.platform !== "linux") return [];
  let real;
  try {
    real = fs.realpathSync.native(dir);
  } catch {
    return [];
  }
  const out = [];
  let pids = [];
  try {
    pids = fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  } catch {
    return [];
  }
  for (const pid of pids) {
    try {
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      if (cwd === real || cwd.startsWith(real + path.sep)) out.push(`${pid}:${cwd}`);
    } catch {
      // gone, or not ours to read
    }
  }
  return out;
}

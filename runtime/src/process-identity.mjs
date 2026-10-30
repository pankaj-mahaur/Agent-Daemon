// Is the process holding a lock still the one that took it?
//
// `process.kill(pid, 0)` only says *some* process has that pid. After a crash
// the OS may hand the pid to another program, and a lock would look held
// forever (or until its heartbeat aged out). So a lock records when its
// holder started, and here we ask the OS when the process now owning that pid
// started:
//   - Linux:   /proc/<pid>/stat field 22 (start ticks since boot) + the boot id
//              → an exact startId, and startedAt from btime + ticks / CLK_TCK;
//   - macOS:   /bin/ps -o lstart= (1 s resolution, read in UTC);
//   - Windows: Get-Process StartTime through Windows PowerShell, by full path.
// Lookups are rare (only when a lock file exists and its pid is alive); a
// lookup that fails or times out is "unknown", and callers fall back to the
// heartbeat rule.
//
// One-sided rule: the same process always has OS start ≤ the time it wrote
// (Node starts after the OS creates the process), so "OS start more than 2 s
// after the recorded start" means the pid was reused. Slow start-up can't
// misfire, and lock files from 3.0 (startedAt only) are covered on every OS.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { systemTool } from "./safe-spawn.mjs";

export const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);
const REUSE_MARGIN_MS = 2000;
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

const validPid = (pid) => Number.isSafeInteger(pid) && pid > 0;

let clkTck; // cached; null when unknown
function linuxClkTck(run) {
  if (clkTck !== undefined) return clkTck;
  try {
    const n = Number(String(run("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 2000 })).trim());
    clkTck = n > 0 ? n : null;
  } catch {
    clkTck = null;
  }
  return clkTck;
}

/** "Mon Oct 19 10:00:00 2026" (ps lstart, LC_ALL=C TZ=UTC) → ms since epoch, or null. */
export function parseLstart(text) {
  const m = /^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(String(text));
  if (!m || MONTHS[m[1]] === undefined) return null;
  return Date.UTC(Number(m[6]), MONTHS[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

/**
 * When the process now owning `pid` started. A lookup slower than `timeoutMs`
 * (PowerShell on a busy Windows machine) is "unknown", and the caller falls back
 * to the lock's heartbeat.
 * @returns {{startedAt?: number, startId?: string} | {unknown: string}}
 */
export function identityOf(pid, { platform = process.platform, run = execFileSync, readFile = readFileSync, env = process.env, timeoutMs } = {}) {
  if (!validPid(pid)) return { unknown: "not a pid" };
  try {
    if (platform === "linux") {
      const stat = String(readFile(`/proc/${pid}/stat`, "utf8"));
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = Number(fields[19]); // field 22 overall; fields[0] is field 3
      if (!Number.isFinite(ticks)) return { unknown: "unreadable /proc stat" };
      const bootId = String(readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      const out = { startId: `linux:${bootId}:${ticks}` };
      const hz = linuxClkTck(run);
      const btime = Number(/^btime (\d+)$/m.exec(String(readFile("/proc/stat", "utf8")))?.[1]);
      if (hz && Number.isFinite(btime)) out.startedAt = Math.round((btime + ticks / hz) * 1000);
      return out;
    }
    if (platform === "darwin") {
      const t = parseLstart(run("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: timeoutMs ?? 2000, env: { ...env, LC_ALL: "C", TZ: "UTC" } }));
      return t === null ? { unknown: "unreadable ps lstart" } : { startedAt: t };
    }
    if (platform === "win32") {
      const ps = systemTool("powershell.exe", { env, platform });
      if (!ps) return { unknown: "Windows PowerShell not found" };
      const out = String(run(ps, ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], { encoding: "utf8", timeout: timeoutMs ?? 3000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })).trim();
      const t = Date.parse(out);
      return Number.isFinite(t) ? { startedAt: t } : { unknown: "unreadable StartTime" };
    }
    return { unknown: `no lookup on ${platform}` };
  } catch (e) {
    return { unknown: e.code === "ETIMEDOUT" ? "lookup timed out" : "lookup failed" };
  }
}

/** This process's identity, for writing into a lock (cheap: no lookup off Linux). */
export function selfIdentity({ platform = process.platform } = {}) {
  const out = { startedAt: PROCESS_STARTED_AT };
  if (platform === "linux") {
    const id = identityOf(process.pid, { platform });
    if (id.startId) out.startId = id.startId;
  }
  return out;
}

/**
 * Classify a recorded holder ({pid, startedAt?, startId?}).
 * @returns {"live"|"dead"|"reused"|"unknown"}
 */
export function classifyHolder(holder, { isAlive, identityOf: lookup = identityOf, selfPid = process.pid, selfStartedAt = PROCESS_STARTED_AT }) {
  if (!holder || !validPid(holder.pid)) return "unknown";
  if (!isAlive(holder.pid)) return "dead";
  // Our own pid: no lookup. This process wrote exactly selfStartedAt; any
  // other value is an earlier process that had our pid.
  if (holder.pid === selfPid && Number.isFinite(holder.startedAt)) return holder.startedAt === selfStartedAt ? "live" : "reused";
  const os = lookup(holder.pid);
  if (!os || os.unknown) return "unknown";
  if (holder.startId && os.startId) return holder.startId === os.startId ? "live" : "reused";
  if (Number.isFinite(holder.startedAt) && Number.isFinite(os.startedAt)) {
    return os.startedAt > holder.startedAt + REUSE_MARGIN_MS ? "reused" : "live";
  }
  return "unknown";
}

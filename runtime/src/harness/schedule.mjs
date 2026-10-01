// `ad schedule` — recurring harness jobs (an `ad run` or `ad loop` on a
// cron schedule), executed by the existing `ad watch` daemon (which the
// `ad service install` OS service keeps alive).
//
//   ad schedule add "<cron>" run|loop "<prompt>" [--cwd dir]
//   ad schedule list | remove <id> | enable <id> | disable <id> | run <id> | tick
//
// Jobs live in ~/.agent-daemon/schedules.json (atomic writes). Each due job
// runs as a child `ad run`/`ad loop` process with output appended to
// ~/.agent-daemon/schedule-logs/<id>.log. A job never overlaps itself; if
// the daemon was down past a run time, the job runs once on the next tick
// (missed runs are not replayed one by one).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const running = new Map(); // job id → child process (this daemon only)

// ---------------------------------------------------------------- cron --

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 6 },
];
const ALIASES = { "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *" };

// Standard 5-field cron: numbers, *, ranges a-b, steps */n and a-b/n, lists.
export function parseCron(expr) {
  const src = ALIASES[String(expr).trim()] ?? String(expr).trim();
  const parts = src.split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron needs 5 fields (minute hour day month weekday), got "${expr}"`);
  const sets = parts.map((part, i) => {
    const { name, min, max } = FIELDS[i];
    const set = new Set();
    for (const item of part.split(",")) {
      const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
      if (!m) throw new Error(`bad ${name} field "${item}" in "${expr}"`);
      const lo = m[1] === "*" ? min : Number(m[2]);
      const hi = m[1] === "*" ? max : m[3] !== undefined ? Number(m[3]) : m[4] ? max : lo;
      const step = m[4] ? Number(m[4]) : 1;
      const top = i === 4 ? 7 : max; // weekday 7 is Sunday, like 0
      if (lo < min || hi > top || lo > hi || step < 1) throw new Error(`${name} out of range in "${expr}"`);
      for (let v = lo; v <= hi; v += step) set.add(i === 4 && v === 7 ? 0 : v);
    }
    return set;
  });
  const [minute, hour, dom, month, dow] = sets;
  // Vixie cron: when both day fields are restricted either may match; a
  // field starting with "*" (incl. "*/2") counts as unrestricted.
  const domAny = parts[2].startsWith("*");
  const dowAny = parts[4].startsWith("*");
  return { minute, hour, dom, month, dow, domAny, dowAny };
}

function dayMatches(cron, d) {
  if (!cron.month.has(d.getMonth() + 1)) return false;
  const domOk = cron.dom.has(d.getDate());
  const dowOk = cron.dow.has(d.getDay());
  if (cron.domAny && cron.dowAny) return true;
  if (cron.domAny) return dowOk;
  if (cron.dowAny) return domOk;
  return domOk || dowOk;
}

export function cronMatches(cron, d) {
  return cron.minute.has(d.getMinutes()) && cron.hour.has(d.getHours()) && dayMatches(cron, d);
}

// Next matching minute strictly after `from` (local time). Skips whole days
// and hours that can't match, so rare schedules (Feb 29) are found fast.
export function nextRun(expr, from = new Date()) {
  const cron = parseCron(expr);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = new Date(from);
  limit.setFullYear(limit.getFullYear() + 8); // covers leap-day schedules
  while (d <= limit) {
    if (!dayMatches(cron, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
    } else if (!cron.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
    } else if (!cron.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1);
    } else {
      return d;
    }
  }
  throw new Error(`cron "${expr}" never matches`);
}

// --------------------------------------------------------------- store --

export const scheduleDir = (home = homedir()) => path.join(home, ".agent-daemon");
const storeFile = (home) => path.join(scheduleDir(home), "schedules.json");

export function loadJobs(home) {
  const f = storeFile(home);
  if (!existsSync(f)) return [];
  const data = JSON.parse(readFileSync(f, "utf8"));
  return Array.isArray(data.jobs) ? data.jobs : [];
}

export function saveJobs(jobs, home) {
  mkdirSync(scheduleDir(home), { recursive: true });
  const f = storeFile(home);
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ jobs }, null, 2) + "\n");
  renameSync(tmp, f);
}

export function addJob({ cron, kind, prompt, cwd, now = new Date() }, home) {
  if (!["run", "loop"].includes(kind)) throw new Error(`job kind must be run or loop, got "${kind}"`);
  if (!prompt?.trim()) throw new Error("job needs a prompt");
  const job = {
    id: randomBytes(3).toString("hex"),
    cron,
    kind,
    prompt,
    cwd: path.resolve(cwd ?? process.cwd()),
    enabled: true,
    createdAt: now.toISOString(),
    nextRun: nextRun(cron, now).toISOString(), // validates the cron too
    lastRun: null,
    lastStatus: null,
  };
  saveJobs([...loadJobs(home), job], home);
  return job;
}

// ---------------------------------------------------------------- run --

// "--" ends option parsing: a prompt like "--sandbox=danger-full-access"
// stays a prompt instead of becoming a flag.
export function jobArgs(job) {
  return [CLI, job.kind === "loop" ? "loop" : "run", "--cwd", job.cwd, "--", job.prompt];
}

// Cross-process "running" lock: a job must not overlap itself even across
// two daemons, a restart, or `ad schedule run` while the daemon runs it.
const lockFile = (id, home) => path.join(scheduleDir(home), "schedule-locks", `${id}.pid`);
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
export function jobLocked(id, home) {
  const f = lockFile(id, home);
  if (!existsSync(f)) return false;
  const pid = Number(readFileSync(f, "utf8"));
  if (pid && pidAlive(pid)) return true;
  rmSync(f, { force: true }); // stale lock from a dead process
  return false;
}

function runJob(job, { home, spawnFn = spawn, onExit } = {}) {
  let finished = false;
  const finish = (code, note) => {
    if (finished) return; // 'error' and 'close' can both fire
    finished = true;
    running.delete(job.id);
    rmSync(lockFile(job.id, home), { force: true });
    log.end(`=== ${note}\n`);
    onExit?.(code);
  };
  const logDir = path.join(scheduleDir(home), "schedule-logs");
  mkdirSync(logDir, { recursive: true });
  const log = createWriteStream(path.join(logDir, `${job.id}.log`), { flags: "a" });
  // A log problem must never take the daemon down.
  log.on("error", (err) => process.stderr.write(`agent-daemon: schedule log for ${job.id}: ${err.message}\n`));
  log.write(`\n=== ${new Date().toISOString()} ${job.kind}: ${job.prompt}\n`);
  if (!existsSync(job.cwd)) {
    queueMicrotask(() => finish(-1, `folder no longer exists: ${job.cwd}`));
    return null;
  }
  const child = spawnFn(process.execPath, jobArgs(job), { cwd: job.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  mkdirSync(path.dirname(lockFile(job.id, home)), { recursive: true });
  writeFileSync(lockFile(job.id, home), String(child.pid ?? process.pid));
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  running.set(job.id, child);
  child.on("close", (code) => finish(code, `exit ${code}`));
  child.on("error", (err) => finish(-1, `failed to start: ${err.message}`));
  return child;
}

function recordExit(id, code, home) {
  const jobs = loadJobs(home);
  const j = jobs.find((x) => x.id === id);
  if (!j) return;
  j.lastStatus = code === 0 ? "ok" : typeof code === "string" ? code : `exit ${code}`;
  saveJobs(jobs, home);
}

// Start every enabled job whose nextRun has passed. Returns started ids.
// Each job is handled on its own: one broken job can't stop the others or
// leave them without a new nextRun (which would re-run them every tick).
export function tick({ home, now = new Date(), spawnFn, log = () => {} } = {}) {
  const jobs = loadJobs(home);
  const due = [];
  for (const job of jobs) {
    if (!job.enabled || new Date(job.nextRun) > now) continue;
    try {
      // A missed window runs once, not once per missed occurrence.
      job.nextRun = nextRun(job.cron, now).toISOString();
    } catch (err) {
      job.enabled = false;
      job.lastStatus = `disabled: ${err.message}`;
      log(`schedule: disabled ${job.id}: ${err.message}`);
      continue;
    }
    if (running.has(job.id) || jobLocked(job.id, home)) continue; // never overlap a job with itself
    job.lastRun = now.toISOString();
    job.lastStatus = "running";
    due.push(job);
  }
  saveJobs(jobs, home); // persist every nextRun BEFORE anything is spawned
  const started = [];
  for (const job of due) {
    try {
      runJob(job, { home, spawnFn, onExit: (code) => recordExit(job.id, code, home) });
      started.push(job.id);
    } catch (err) {
      log(`schedule: could not start ${job.id}: ${err.message}`);
      recordExit(job.id, -1, home);
    }
  }
  return started;
}

// Jobs marked "running" by a daemon that died: mark them aborted.
export function resetStaleRuns(home) {
  const jobs = loadJobs(home);
  let changed = false;
  for (const j of jobs) {
    if (j.lastStatus === "running" && !running.has(j.id) && !jobLocked(j.id, home)) {
      j.lastStatus = "aborted";
      changed = true;
    }
  }
  if (changed) saveJobs(jobs, home);
}

export function startScheduler({ home, intervalMs = 30_000, log = () => {} } = {}) {
  resetStaleRuns(home);
  const t = setInterval(() => {
    try {
      const ids = tick({ home, log });
      if (ids.length) log(`schedule: started ${ids.join(", ")}`);
    } catch (err) {
      log(`schedule: tick failed: ${err.message}`);
    }
  }, intervalMs);
  t.unref?.();
  // On stop: kill running jobs (tree on Windows) so no child is orphaned
  // mid-turn, and record them as aborted.
  return () => {
    clearInterval(t);
    for (const [id, child] of running) {
      if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
      else child.kill();
      recordExit(id, "aborted", home);
    }
  };
}

// ---------------------------------------------------------------- cli --

export async function cmdSchedule(sub, args = [], opts = {}) {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const home = opts.userHome;
  try {
    switch (sub) {
      case "add": {
        const [cron, kind, ...rest] = args;
        const job = addJob({ cron, kind, prompt: rest.join(" "), cwd: opts.cwd }, home);
        out.write(`added ${job.id}: ${job.kind} "${job.prompt}" at "${job.cron}" (next ${new Date(job.nextRun).toLocaleString()})\n`);
        out.write("Jobs run while the daemon is up: ad watch  (or keep it running: ad service install)\n");
        return 0;
      }
      case undefined:
      case "list": {
        const jobs = loadJobs(home);
        if (!jobs.length) out.write("no scheduled jobs\n");
        for (const j of jobs) {
          out.write(`${j.id}  ${j.enabled ? "on " : "off"}  ${j.cron.padEnd(14)} ${j.kind.padEnd(4)} next ${new Date(j.nextRun).toLocaleString()}  last ${j.lastStatus ?? "-"}  ${j.prompt.slice(0, 50)}\n`);
        }
        return 0;
      }
      case "remove":
      case "enable":
      case "disable": {
        const jobs = loadJobs(home);
        const j = jobs.find((x) => x.id === args[0]);
        if (!j) throw new Error(`no job ${args[0] ?? "(missing id)"}`);
        if (sub === "remove") jobs.splice(jobs.indexOf(j), 1);
        else {
          j.enabled = sub === "enable";
          if (j.enabled) j.nextRun = nextRun(j.cron).toISOString();
        }
        saveJobs(jobs, home);
        out.write(`${sub}d ${j.id}\n`);
        return 0;
      }
      case "run": {
        const j = loadJobs(home).find((x) => x.id === args[0]);
        if (!j) throw new Error(`no job ${args[0] ?? "(missing id)"}`);
        if (running.has(j.id) || jobLocked(j.id, home)) throw new Error(`job ${j.id} is already running`);
        const code = await new Promise((resolve) => runJob(j, { home, spawnFn: opts.spawnFn, onExit: resolve }));
        recordExit(j.id, code, home);
        out.write(`${j.id} finished: exit ${code} (log: ${path.join(scheduleDir(home), "schedule-logs", `${j.id}.log`)})\n`);
        return code === 0 ? 0 : 1;
      }
      case "tick": {
        const ids = tick({ home, spawnFn: opts.spawnFn });
        out.write(ids.length ? `started ${ids.join(", ")}\n` : "nothing due\n");
        return 0;
      }
      default:
        err.write('Usage: ad schedule add "<cron>" run|loop "<prompt>" | list | remove|enable|disable|run <id> | tick\n');
        return 1;
    }
  } catch (e) {
    err.write(`ad schedule: ${e.message}\n`);
    return 1;
  }
}

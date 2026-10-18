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
import { systemTool } from "../safe-spawn.mjs";
import { acquireLock, liveLocks } from "../lock.mjs";
import { engineHome } from "../engine/index.mjs";
import { homeFolderRefusal, homeJobNote } from "../engine/attribution.mjs";
import { noteOnce } from "./notes.mjs";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  // Once, for a store an older ad wrote (P0.2a): jobs whose folder would load
  // the user's own engine home keep running, marked "grandfathered". Every store
  // ad writes from now on is marked reviewed, so new jobs are never marked.
  if (data.homeFolderReviewed !== true) {
    for (const j of jobs) if (j.cwd && j.allowHomeFolder === undefined && engineHome.homeLayerRisk(j.cwd)) j.allowHomeFolder = "grandfathered";
    saveJobs(jobs, home);
  }
  return jobs;
}

export function saveJobs(jobs, home) {
  mkdirSync(scheduleDir(home), { recursive: true });
  const f = storeFile(home);
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ homeFolderReviewed: true, jobs }, null, 2) + "\n");
  renameSync(tmp, f);
}

/** Jobs that run in a folder loading the user's own engine home: [{id, cwd, allowHomeFolder}] (ad doctor). */
export function homeFolderJobs(home) {
  return loadJobs(home).filter((j) => j.allowHomeFolder).map((j) => ({ id: j.id, cwd: j.cwd, allowHomeFolder: j.allowHomeFolder }));
}

export function addJob({ cron, kind, prompt, cwd, now = new Date(), allowHomeFolder = false }, home) {
  if (!["run", "loop"].includes(kind)) throw new Error(`job kind must be run or loop, got "${kind}"`);
  if (!prompt?.trim()) throw new Error("job needs a prompt");
  const risk = engineHome.homeLayerRisk(path.resolve(cwd ?? process.cwd()));
  if (risk && !allowHomeFolder) throw new Error(homeFolderRefusal(risk));
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
    ...(risk ? { allowHomeFolder: true } : {}),
  };
  saveJobs([...loadJobs(home), job], home);
  return job;
}

// ---------------------------------------------------------------- run --

// "--" ends option parsing: a prompt like "--sandbox=danger-full-access"
// stays a prompt instead of becoming a flag.
export function jobArgs(job) {
  return [CLI, job.kind === "loop" ? "loop" : "run", "--cwd", job.cwd, ...(job.allowHomeFolder ? ["--allow-home-folder"] : []), "--", job.prompt];
}

// Cross-process "running" lock: a job must not overlap itself even across
// two daemons, a restart, or `ad schedule run` while the daemon runs it. A
// lease (lock.mjs, kind "schedule"): the daemon holds it and records the
// job's child, so a job still running after the daemon died or restarted
// keeps its lock, and a reused pid never blocks a job.
const lockDirOf = (home) => path.join(scheduleDir(home), "schedule-locks");
const leaseName = (id) => `schedule-${id}`;
const legacyLockFile = (id, home) => path.join(lockDirOf(home), `${id}.pid`);
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
export function jobLocked(id, home) {
  // A 3.0 .pid file: busy while its pid lives and the file is recent, else gone.
  const legacy = legacyLockFile(id, home);
  if (existsSync(legacy)) {
    const pid = Number(readFileSync(legacy, "utf8"));
    let fresh = false;
    try {
      fresh = Date.now() - statSync(legacy).mtimeMs < 120_000;
    } catch { /* gone */ }
    if (pid && pidAlive(pid) && fresh) return true;
    rmSync(legacy, { force: true });
  }
  return liveLocks({ dir: lockDirOf(home) }).some((h) => h.name === leaseName(id));
}

function runJob(job, { home, spawnFn = spawn, onExit } = {}) {
  let finished = false;
  let lease = null;
  const finish = (code, note) => {
    if (finished) return; // 'error' and 'close' can both fire
    finished = true;
    running.delete(job.id);
    lease?.();
    log.end(`=== ${note}\n`);
    onExit?.(code);
  };
  const logDir = path.join(scheduleDir(home), "schedule-logs");
  mkdirSync(logDir, { recursive: true });
  const log = createWriteStream(path.join(logDir, `${job.id}.log`), { flags: "a" });
  // A log problem must never take the daemon down.
  log.on("error", (err) => process.stderr.write(`agent-daemon: schedule log for ${job.id}: ${err.message}\n`));
  log.write(`\n=== ${new Date().toISOString()} ${job.kind}: ${job.prompt}\n`);
  // A 3.0 job in the home folder keeps running (P0.2a): said in its log every
  // run, and once in the daemon's output.
  if (job.allowHomeFolder === "grandfathered") {
    log.write(`=== note: ${homeJobNote(job.id)}\n`);
    noteOnce(`home.job.${job.id}`, homeJobNote(job.id), { file: path.join(scheduleDir(home), "notes.json") });
  }
  if (!existsSync(job.cwd)) {
    queueMicrotask(() => finish(-1, `folder no longer exists: ${job.cwd}`));
    return null;
  }
  // O_EXCL: of two runners for one job, exactly one gets the lease.
  try {
    lease = acquireLock(leaseName(job.id), { dir: lockDirOf(home), meta: { kind: "schedule" } });
  } catch (err) {
    if (err.code !== "LOCK_BUSY") throw err;
    queueMicrotask(() => { finished = true; log.end(`=== skipped: already running elsewhere (pid ${err.holder?.pid})\n`); });
    return null;
  }
  const child = spawnFn(process.execPath, jobArgs(job), { cwd: job.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  if (child.pid) lease.updateMeta({ child: { pid: child.pid, startedAt: Date.now() } });
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
      const taskkill = process.platform === "win32" && child.pid ? systemTool("taskkill.exe") : null;
      if (taskkill) spawn(taskkill, ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
      else if (process.platform === "win32") child.kill();
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
        const job = addJob({ cron, kind, prompt: rest.join(" "), cwd: opts.cwd, allowHomeFolder: opts.allowHomeFolder === true }, home);
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

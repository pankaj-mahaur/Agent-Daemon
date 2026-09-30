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
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  // Classic cron: when both day fields are restricted, either may match.
  const domAny = parts[2] === "*";
  const dowAny = parts[4] === "*";
  return { minute, hour, dom, month, dow, domAny, dowAny };
}

export function cronMatches(cron, d) {
  if (!cron.minute.has(d.getMinutes()) || !cron.hour.has(d.getHours()) || !cron.month.has(d.getMonth() + 1)) return false;
  const domOk = cron.dom.has(d.getDate());
  const dowOk = cron.dow.has(d.getDay());
  if (cron.domAny && cron.dowAny) return true;
  if (cron.domAny) return dowOk;
  if (cron.dowAny) return domOk;
  return domOk || dowOk;
}

// Next matching minute strictly after `from` (local time).
export function nextRun(expr, from = new Date()) {
  const cron = parseCron(expr);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (cronMatches(cron, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  throw new Error(`cron "${expr}" never matches within a year`);
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

export function jobArgs(job) {
  return job.kind === "loop" ? [CLI, "loop", job.prompt, "--cwd", job.cwd] : [CLI, "run", job.prompt, "--cwd", job.cwd];
}

function runJob(job, { home, spawnFn = spawn, onExit } = {}) {
  const logDir = path.join(scheduleDir(home), "schedule-logs");
  mkdirSync(logDir, { recursive: true });
  const log = createWriteStream(path.join(logDir, `${job.id}.log`), { flags: "a" });
  // A log problem must never take the daemon down.
  log.on("error", (err) => process.stderr.write(`agent-daemon: schedule log for ${job.id}: ${err.message}\n`));
  log.write(`\n=== ${new Date().toISOString()} ${job.kind}: ${job.prompt}\n`);
  const child = spawnFn(process.execPath, jobArgs(job), { cwd: job.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  running.set(job.id, child);
  child.on("close", (code) => {
    running.delete(job.id);
    log.end(`=== exit ${code}\n`);
    onExit?.(code);
  });
  child.on("error", (err) => {
    running.delete(job.id);
    log.end(`=== failed to start: ${err.message}\n`);
    onExit?.(-1);
  });
  return child;
}

function recordExit(id, code, home) {
  const jobs = loadJobs(home);
  const j = jobs.find((x) => x.id === id);
  if (!j) return;
  j.lastStatus = code === 0 ? "ok" : `exit ${code}`;
  saveJobs(jobs, home);
}

// Start every enabled job whose nextRun has passed. Returns started ids.
export function tick({ home, now = new Date(), spawnFn } = {}) {
  const jobs = loadJobs(home);
  const started = [];
  for (const job of jobs) {
    if (!job.enabled || new Date(job.nextRun) > now) continue;
    // Whatever happens, schedule the next run after now: a missed window
    // runs once, not once per missed occurrence.
    job.nextRun = nextRun(job.cron, now).toISOString();
    if (running.has(job.id)) continue; // never overlap a job with itself
    job.lastRun = now.toISOString();
    job.lastStatus = "running";
    runJob(job, { home, spawnFn, onExit: (code) => recordExit(job.id, code, home) });
    started.push(job.id);
  }
  saveJobs(jobs, home);
  return started;
}

export function startScheduler({ home, intervalMs = 30_000, log = () => {} } = {}) {
  const t = setInterval(() => {
    try {
      const ids = tick({ home });
      if (ids.length) log(`schedule: started ${ids.join(", ")}`);
    } catch (err) {
      log(`schedule: tick failed: ${err.message}`);
    }
  }, intervalMs);
  t.unref?.();
  return () => clearInterval(t);
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

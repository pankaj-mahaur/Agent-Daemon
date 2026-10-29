// Tests for `ad schedule` (harness/schedule.mjs): cron parsing, due-job
// selection, missed-run policy, no self-overlap, and the job command line.

import { test } from "node:test";
import { projectConfigFolder } from "../src/engine/attribution.mjs";
const DOT = projectConfigFolder; // the engine's per-project folder name
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addJob, cmdSchedule, cronMatches, jobArgs, loadJobs, nextRun, parseCron, saveJobs, tick } from "../src/harness/schedule.mjs";

const at = (s) => new Date(s); // local time strings
const sink = () => ({ text: "", write(c) { this.text += c; return true; } });

test("parseCron: ranges, steps, lists, aliases, Sunday as 7", () => {
  const c = parseCron("*/15 9-17 * * 1-5");
  assert.deepEqual([...c.minute], [0, 15, 30, 45]);
  assert.deepEqual([...c.hour], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual([...c.dow].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron("0 0 * * 7").dow], [0], "a bare 7 is Sunday only");
  assert.deepEqual([...parseCron("0 0 * * 5-7").dow].sort(), [0, 5, 6]);
  assert.deepEqual([...parseCron("@daily").hour], [0]);
  for (const bad of ["* * * *", "60 * * * *", "* 24 * * *", "5-1 * * * *", "*/0 * * * *", "a * * * *"]) assert.throws(() => parseCron(bad), /cron|field|range/);
});

test("nextRun and day-field semantics", () => {
  assert.equal(nextRun("30 9 * * *", at("2026-10-01T09:29:10")).toString(), at("2026-10-01T09:30:00").toString());
  assert.equal(nextRun("30 9 * * *", at("2026-10-01T09:30:00")).toString(), at("2026-10-02T09:30:00").toString(), "strictly after");
  // 2026-10-01 is a Thursday (4). Both day fields restricted → either matches.
  assert.ok(cronMatches(parseCron("0 0 13 * 4"), at("2026-10-01T00:00:00")));
  assert.ok(!cronMatches(parseCron("0 0 13 * *"), at("2026-10-01T00:00:00")));
});

test("tick runs due jobs once, never overlaps, and skips missed windows", async () => {
  const home = mkdtempSync(join(tmpdir(), "ad-sched-"));
  const spawned = [];
  const children = [];
  const spawnFn = (cmd, args) => {
    const c = new EventEmitter();
    c.stdout = null;
    c.stderr = null;
    spawned.push(args);
    children.push(c);
    return c;
  };
  try {
    const job = addJob({ cron: "0 * * * *", kind: "run", prompt: "check the build", cwd: home, now: at("2026-10-01T08:10:00") }, home);
    assert.deepEqual(tick({ home, now: at("2026-10-01T08:59:00"), spawnFn }), [], "not due yet");
    // Daemon was down 08:00→11:30: three windows missed, runs once.
    assert.deepEqual(tick({ home, now: at("2026-10-01T11:30:00"), spawnFn }), [job.id]);
    assert.equal(spawned.length, 1);
    assert.equal(new Date(loadJobs(home)[0].nextRun).toString(), at("2026-10-01T12:00:00").toString());
    // Still running at noon → skipped, not doubled.
    assert.deepEqual(tick({ home, now: at("2026-10-01T12:00:30"), spawnFn }), []);
    children[0].emit("close", 0);
    assert.equal(loadJobs(home)[0].lastStatus, "ok");
    assert.deepEqual(tick({ home, now: at("2026-10-01T13:00:30"), spawnFn }), [job.id]);
    children[1].emit("close", 1);
    assert.equal(loadJobs(home)[0].lastStatus, "exit 1");
    await new Promise((r) => setTimeout(r, 50)); // let log streams flush before cleanup
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("job command lines: -- guards the prompt against option injection", async () => {
  assert.deepEqual(jobArgs({ kind: "loop", prompt: "keep tests green", cwd: "/w" }).slice(1), ["loop", "--cwd", "/w", "--", "keep tests green"]);
  const args = jobArgs({ kind: "run", prompt: "--sandbox=danger-full-access", cwd: "/w" }).slice(2);
  const { parseArgs } = await import("node:util");
  const parsed = parseArgs({ args, options: { sandbox: { type: "string" }, cwd: { type: "string" } }, allowPositionals: true, strict: false });
  assert.equal(parsed.values.sandbox, undefined, "the prompt must not become a flag");
  assert.deepEqual(parsed.positionals, ["--sandbox=danger-full-access"]);
});

test("rare schedules (Feb 29) are found quickly; impossible ones throw", () => {
  const t0 = Date.now();
  assert.equal(nextRun("0 0 29 2 *", at("2026-10-01T00:00:00")).toString(), at("2028-02-29T00:00:00").toString());
  assert.ok(Date.now() - t0 < 200);
  assert.throws(() => nextRun("0 0 31 2 *", at("2026-10-01T00:00:00")), /never matches/);
  assert.ok(parseCron("0 0 */2 * 1").domAny, "*/2 day-of-month counts as unrestricted (vixie)");
});

test("a broken job is disabled; other due jobs still get their nextRun saved", () => {
  const home = mkdtempSync(join(tmpdir(), "ad-sched-bad-"));
  const spawnFn = () => Object.assign(new EventEmitter(), { stdout: null, stderr: null });
  try {
    const good = addJob({ cron: "0 * * * *", kind: "run", prompt: "ok", cwd: home, now: at("2026-10-01T08:10:00") }, home);
    const jobs = loadJobs(home);
    jobs.push({ ...jobs[0], id: "broken", cron: "0 0 31 2 *", nextRun: at("2026-10-01T08:00:00").toISOString() });
    saveJobs(jobs, home);
    assert.deepEqual(tick({ home, now: at("2026-10-01T09:30:00"), spawnFn }), [good.id]);
    const after = loadJobs(home);
    assert.equal(new Date(after.find((j) => j.id === good.id).nextRun).toString(), at("2026-10-01T10:00:00").toString());
    const broken = after.find((j) => j.id === "broken");
    assert.equal(broken.enabled, false);
    assert.match(broken.lastStatus, /disabled: .*never matches/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a job whose folder was deleted fails once with a clear message", async () => {
  const home = mkdtempSync(join(tmpdir(), "ad-sched-gone-"));
  try {
    const job = addJob({ cron: "@daily", kind: "run", prompt: "x", cwd: join(home, "gone"), now: at("2026-10-01T08:00:00") }, home);
    const out = sink();
    const err = sink();
    assert.equal(await cmdSchedule("run", [job.id], { userHome: home, stdout: out, stderr: err }), 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.match(readFileSync(join(home, ".agent-daemon", "schedule-logs", job.id + ".log"), "utf8"), /folder no longer exists/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cmdSchedule add / list / disable / remove", async () => {
  const home = mkdtempSync(join(tmpdir(), "ad-sched-cli-"));
  const run = async (sub, args) => {
    const out = sink();
    const err = sink();
    const code = await cmdSchedule(sub, args, { userHome: home, cwd: home, stdout: out, stderr: err });
    return { code, out: out.text, err: err.text };
  };
  try {
    const added = await run("add", ["@daily", "run", "summarize", "yesterday's", "commits"]);
    assert.equal(added.code, 0, added.err);
    const id = added.out.match(/added (\w+)/)[1];
    assert.match((await run("list")).out, new RegExp(`${id}  on .*summarize yesterday's commits`));
    await run("disable", [id]);
    assert.match((await run("list")).out, /off/);
    assert.equal((await run("add", ["* * *", "run", "x"])).code, 1);
    assert.equal((await run("add", ["@daily", "deploy", "x"])).code, 1, "only run|loop jobs");
    await run("remove", [id]);
    assert.match((await run("list")).out, /no scheduled jobs/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------- P0.3b: schedule locks are leases ----------
import { spawn as spawnProc } from "node:child_process";
import { mkdirSync as mkdirP, utimesSync as setTimes, writeFileSync as writeF } from "node:fs";
import { jobLocked } from "../src/harness/schedule.mjs";
import { acquireLock as takeLock } from "../src/lock.mjs";

const lockDirFor = (home) => join(home, ".agent-daemon", "schedule-locks");
const aged = (file) => { const t = new Date(Date.now() - 600_000); setTimes(file, t, t); };

test("P0.3b: a job lock whose pid was reused doesn't block the job", async () => {
  const home = mkdtempSync(join(tmpdir(), "ad-sched-lease-"));
  const other = spawnProc(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    await new Promise((r) => other.once("spawn", r));
    mkdirP(lockDirFor(home), { recursive: true });
    // A lease that names a live pid which started long after the lease was written: reused.
    writeF(join(lockDirFor(home), "schedule-j1.lock"), JSON.stringify({ pid: other.pid, startedAt: Date.now() - 3_600_000, threadId: "schedule-j1", token: "t", kind: "schedule" }));
    assert.equal(jobLocked("j1", home), false);
  } finally {
    other.kill();
    rmSync(home, { recursive: true, force: true });
  }
});

test("P0.3b: a held lease blocks the job; two runners can't both hold it", () => {
  const home = mkdtempSync(join(tmpdir(), "ad-sched-lease-"));
  try {
    const release = takeLock("schedule-j2", { dir: lockDirFor(home), meta: { kind: "schedule" } });
    try {
      assert.equal(jobLocked("j2", home), true);
      assert.throws(() => takeLock("schedule-j2", { dir: lockDirFor(home), meta: { kind: "schedule" } }), (e) => e.code === "LOCK_BUSY");
    } finally {
      release();
    }
    assert.equal(jobLocked("j2", home), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("P0.3b: the daemon died while the job's child still runs: the job stays locked", async () => {
  const home = mkdtempSync(join(tmpdir(), "ad-sched-lease-"));
  const child = spawnProc(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    await new Promise((r) => child.once("spawn", r));
    mkdirP(lockDirFor(home), { recursive: true });
    const f = join(lockDirFor(home), "schedule-j3.lock");
    writeF(f, JSON.stringify({ pid: 2_000_000_000, startedAt: Date.now() - 60_000, threadId: "schedule-j3", token: "t", kind: "schedule", child: { pid: child.pid, startedAt: Date.now() } }));
    aged(f); // the dead daemon's heartbeat stopped
    assert.equal(jobLocked("j3", home), true, "the live child keeps it");
    child.kill();
    await new Promise((r) => child.once("exit", r));
    assert.equal(jobLocked("j3", home), false);
  } finally {
    try { child.kill(); } catch { /* gone */ }
    rmSync(home, { recursive: true, force: true });
  }
});

test("P0.3b: a 3.0 .pid file with a live pid blocks while recent, and is dropped once stale", () => {
  const home = mkdtempSync(join(tmpdir(), "ad-sched-lease-"));
  try {
    mkdirP(lockDirFor(home), { recursive: true });
    const f = join(lockDirFor(home), "j4.pid");
    writeF(f, String(process.pid));
    assert.equal(jobLocked("j4", home), true);
    aged(f);
    assert.equal(jobLocked("j4", home), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// P0.2a: jobs in a folder that would load the user's own ~/.codex.
async function inFakeUserHome(fn) {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const home = mkdtempSync(join(tmpdir(), "ad-sched-userhome-"));
  mkdirSync(join(home, DOT, "skills", "mine"), { recursive: true });
  writeFileSync(join(home, DOT, "skills", "mine", "SKILL.md"), "---\nname: mine\ndescription: x\n---\n");
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn(home);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test("P0.2a: a 3.0 job whose folder is home is grandfathered once: it runs with the override, logs the note, and is listed", async () => {
  const { homeFolderJobs } = await import("../src/harness/schedule.mjs");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  await inFakeUserHome(async (home) => {
    // A store 3.0 wrote: no homeFolderReviewed mark.
    mkdirSync(join(home, ".agent-daemon"), { recursive: true });
    const old = { id: "j30", cron: "0 * * * *", kind: "run", prompt: "nightly", cwd: home, enabled: true, createdAt: "2026-10-01T00:00:00Z", nextRun: "2026-10-01T08:00:00.000Z", lastRun: null, lastStatus: null };
    writeFileSync(join(home, ".agent-daemon", "schedules.json"), JSON.stringify({ jobs: [old] }));
    assert.equal(loadJobs(home)[0].allowHomeFolder, "grandfathered");
    assert.equal(JSON.parse(readFileSync(join(home, ".agent-daemon", "schedules.json"), "utf8")).homeFolderReviewed, true, "written once");
    assert.ok(jobArgs(loadJobs(home)[0]).includes("--allow-home-folder"));
    assert.deepEqual(homeFolderJobs(home), [{ id: "j30", cwd: home, allowHomeFolder: "grandfathered" }]);
    const spawned = [];
    const spawnFn = (cmd, args) => {
      const c = new EventEmitter();
      spawned.push(args);
      return c;
    };
    const errWrite = process.stderr.write;
    let said = "";
    process.stderr.write = (s) => ((said += s), true);
    try {
      tick({ home, now: new Date("2026-10-01T09:00:00Z"), spawnFn });
    } finally {
      process.stderr.write = errWrite;
    }
    assert.ok(spawned[0].includes("--allow-home-folder"));
    assert.match(said, /Scheduled job j30 runs in your home folder/);
    await new Promise((r) => setTimeout(r, 50));
    assert.match(readFileSync(join(home, ".agent-daemon", "schedule-logs", "j30.log"), "utf8"), /note: Scheduled job j30 runs in your home folder/);
  });
});

test("P0.2a: a new schedule add in home without the flag is refused; with it the job is marked, never grandfathered", async () => {
  await inFakeUserHome(async (home) => {
    assert.throws(() => addJob({ cron: "0 * * * *", kind: "run", prompt: "x", cwd: home }, home), /Run this in a project folder/);
    const job = addJob({ cron: "0 * * * *", kind: "run", prompt: "x", cwd: home, allowHomeFolder: true }, home);
    assert.equal(job.allowHomeFolder, true);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, "proj", ".git"), { recursive: true });
    const plain = addJob({ cron: "0 * * * *", kind: "run", prompt: "y", cwd: join(home, "proj") }, home);
    assert.equal(plain.allowHomeFolder, undefined, "a project folder needs nothing");
  });
});

// ---- P4.7: fallback in scheduled jobs ----------------------------------------------------------
const { jobGrantsFallback, reasonFrom } = await import("../src/harness/schedule.mjs");
const { existsSync } = await import("node:fs");
// A child that prints ad's lines and exits with `code`, as `ad run|loop --fallback` would.
const childSaying = (lines, code, seen = {}) => (cmd, args, o) => {
  seen.args = args;
  seen.env = o?.env;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  stdout.pipe = stderr.pipe = () => {};
  const c = Object.assign(new EventEmitter(), { pid: 0, stdout, stderr });
  setTimeout(() => {
    stderr.emit("data", Buffer.from(lines.join("\n") + "\n"));
    c.emit("close", code);
  }, 10);
  return c;
};

test("schedule: a job with fallback passes --fallback (before --), and its child is named in AD_SCHEDULE_JOB; a paused run writes status.json and list says why", async () => {
  const home = mkdtempSync(join(tmpdir(), "ad-sched-fb-"));
  try {
    const out = sink();
    assert.equal(await cmdSchedule("add", ["@daily", "run", "ship it"], { userHome: home, cwd: home, stdout: out, stderr: sink(), fallback: true }), 0);
    const job = loadJobs(home)[0];
    assert.equal(job.fallback, true);
    assert.deepEqual(jobArgs(job).slice(-3), ["--fallback", "--", "ship it"]);
    const seen = {};
    const code = await cmdSchedule("run", [job.id], { userHome: home, stdout: sink(), stderr: sink(), spawnFn: childSaying(["[ad] \u{23f8} Paused: OpenRouter's free limit is used up until 05:30, and no other target in your order can take over. Work so far is saved (session ses_1)."], 4, seen) });
    assert.equal(code, 1, "ad schedule run: the job didn't complete");
    assert.equal(seen.env.AD_SCHEDULE_JOB, job.id);
    const st = JSON.parse(readFileSync(join(home, ".agent-daemon", "schedule-logs", `${job.id}.status.json`), "utf8"));
    assert.deepEqual([st.exitCode, st.status], [4, "paused"]);
    assert.match(st.reason, /^OpenRouter's free limit is used up until 05:30/);
    const list = sink();
    await cmdSchedule("list", [], { userHome: home, stdout: list, stderr: sink() });
    assert.match(list.text, /run +\(fallback\).*last paused: OpenRouter's free limit is used up until 05:30/);
    assert.equal(jobGrantsFallback({ AD_SCHEDULE_JOB: job.id }, home), true);
    assert.equal(jobGrantsFallback({ AD_SCHEDULE_JOB: "nope" }, home), false, "only a job that granted it");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("schedule: a loop job stopped by its brakes writes status stopped (exit 3); a switched run says where it went", async () => {
  const home = mkdtempSync(join(tmpdir(), "ad-sched-st-"));
  try {
    const job = addJob({ cron: "@daily", kind: "loop", prompt: "x", cwd: home, fallback: true }, home);
    await cmdSchedule("run", [job.id], { userHome: home, stdout: sink(), stderr: sink(), spawnFn: childSaying(["ad loop stopped: no progress in 3 turns (circuit breaker) (3 iteration(s), ~0 tokens)."], 3) });
    const st = JSON.parse(readFileSync(join(home, ".agent-daemon", "schedule-logs", `${job.id}.status.json`), "utf8"));
    assert.deepEqual([st.exitCode, st.status, st.reason], [3, "stopped", "no progress in 3 turns (circuit breaker)"]);
    await cmdSchedule("run", [job.id], { userHome: home, stdout: sink(), stderr: sink(), spawnFn: childSaying(["[ad] \u{21aa} Switched to Gemini API · gemini-2.5-flash: OpenRouter's free daily limit is used up. Fallback 1 of 3."], 0) });
    assert.equal(loadJobs(home)[0].lastStatus, "ok, last run switched to Gemini API · gemini-2.5-flash");
    assert.deepEqual(reasonFrom(["nothing of ad's"]), { reason: null, switchedTo: null });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("AD_TOOL_SHELL=1: ad schedule add --fallback and ad schedule edit each exit 2 with the guard text; edit toggles it from a terminal", async () => {
  const home = mkdtempSync(join(tmpdir(), "ad-sched-shell-"));
  const guard = "Fallback settings can't be changed from the agent's own shell. Run it in your terminal.\n";
  try {
    const shell = { ...process.env, AD_TOOL_SHELL: "1" };
    let err = sink();
    assert.equal(await cmdSchedule("add", ["@daily", "run", "x"], { userHome: home, cwd: home, stdout: sink(), stderr: err, fallback: true, env: shell }), 2);
    assert.equal(err.text, guard);
    assert.equal(loadJobs(home).length, 0);
    assert.equal(await cmdSchedule("add", ["@daily", "run", "x"], { userHome: home, cwd: home, stdout: sink(), stderr: sink(), env: shell }), 0, "a job without fallback is fine");
    const id = loadJobs(home)[0].id;
    err = sink();
    assert.equal(await cmdSchedule("edit", [id], { userHome: home, stdout: sink(), stderr: err, fallback: true, env: shell }), 2);
    assert.equal(err.text, guard);
    assert.equal(loadJobs(home)[0].fallback, undefined);
    assert.equal(await cmdSchedule("edit", [id], { userHome: home, stdout: sink(), stderr: sink(), fallback: true, env: {} }), 0);
    assert.equal(loadJobs(home)[0].fallback, true);
    assert.equal(await cmdSchedule("edit", [id], { userHome: home, stdout: sink(), stderr: sink(), fallback: false, env: {} }), 0);
    assert.equal(loadJobs(home)[0].fallback, undefined);
    assert.equal(existsSync(home), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

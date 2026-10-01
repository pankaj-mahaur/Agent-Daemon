// Tests for `ad schedule` (harness/schedule.mjs): cron parsing, due-job
// selection, missed-run policy, no self-overlap, and the job command line.

import { test } from "node:test";
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

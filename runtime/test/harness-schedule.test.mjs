// Tests for `ad schedule` (harness/schedule.mjs): cron parsing, due-job
// selection, missed-run policy, no self-overlap, and the job command line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addJob, cmdSchedule, cronMatches, jobArgs, loadJobs, nextRun, parseCron, tick } from "../src/harness/schedule.mjs";

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

test("job command lines run the harness with the job's folder", () => {
  const args = jobArgs({ kind: "loop", prompt: "keep tests green", cwd: "/w" });
  assert.deepEqual(args.slice(1), ["loop", "keep tests green", "--cwd", "/w"]);
  assert.deepEqual(jobArgs({ kind: "run", prompt: "p", cwd: "/w" }).slice(1), ["run", "p", "--cwd", "/w"]);
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

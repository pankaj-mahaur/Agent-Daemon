// Tests for runtime/src/orchestration/team.mjs — WS-7b retry/rollback.
//
// Covers markTaskFailed (exponential backoff + transition to error after
// max retries) and retryTask (manual reset to pending or blocked).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import {
  createTeam, addTask, updateTaskStatus,
  markTaskFailed, retryTask, listTasks
} from "../src/orchestration/team.mjs";

const HOME_ENV = process.env.HOME || process.env.USERPROFILE;

async function setupTempHome() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ad-team-test-"));
  process.env.HOME = tmp;
  if (process.platform === "win32") process.env.USERPROFILE = tmp;
  return tmp;
}

async function tearDown(tmp) {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  if (HOME_ENV) {
    process.env.HOME = HOME_ENV;
    if (process.platform === "win32") process.env.USERPROFILE = HOME_ENV;
  }
}

test("markTaskFailed schedules retry under max_retries", async () => {
  const tmp = await setupTempHome();
  try {
    const team = await createTeam({ description: "retry test" });
    const task = await addTask(team.id, { title: "do thing", max_retries: 2 });

    const r = await markTaskFailed(team.id, task.id, "boom");
    assert.equal(r.willRetry, true);
    assert.equal(r.task.attempts, 1);
    assert.equal(r.task.status, "retrying");
    assert.ok(r.task.next_retry_at, "next_retry_at should be set");
    assert.equal(r.task.last_error, "boom");
  } finally {
    await tearDown(tmp);
  }
});

test("markTaskFailed moves to error after exhausting retries", async () => {
  const tmp = await setupTempHome();
  try {
    const team = await createTeam({ description: "retry exhaustion" });
    const task = await addTask(team.id, { title: "doomed task", max_retries: 2 });

    // 3 failures = 1 attempt + 2 retries — should land in "error"
    await markTaskFailed(team.id, task.id, "first fail");
    await markTaskFailed(team.id, task.id, "second fail");
    const r = await markTaskFailed(team.id, task.id, "third fail");

    assert.equal(r.willRetry, false);
    assert.equal(r.task.status, "error");
    assert.equal(r.task.attempts, 3);
    assert.equal(r.task.next_retry_at, null);
    assert.equal(r.task.last_error, "third fail");
  } finally {
    await tearDown(tmp);
  }
});

test("retryTask resets to pending if no blockers", async () => {
  const tmp = await setupTempHome();
  try {
    const team = await createTeam({ description: "manual retry" });
    const task = await addTask(team.id, { title: "thing", max_retries: 2 });
    await markTaskFailed(team.id, task.id, "boom");

    const r = await retryTask(team.id, task.id);
    assert.equal(r.reset, true);
    assert.equal(r.task.status, "pending");
    assert.equal(r.task.next_retry_at, null);
    assert.equal(r.task.last_error, "boom", "last_error preserved as audit trail");
  } finally {
    await tearDown(tmp);
  }
});

test("retryTask resets to blocked if blockers incomplete", async () => {
  const tmp = await setupTempHome();
  try {
    const team = await createTeam({ description: "blocked retry" });
    const blocker = await addTask(team.id, { title: "blocker" });
    const dependent = await addTask(team.id, { title: "dependent", blockedBy: [blocker.id] });
    // Move dependent through in_progress and fail it (force, bypass real flow)
    await updateTaskStatus(team.id, dependent.id, "in_progress");
    await markTaskFailed(team.id, dependent.id, "oops");

    // Blocker is still pending — retry should restore "blocked"
    const r = await retryTask(team.id, dependent.id);
    assert.equal(r.reset, true);
    assert.equal(r.task.status, "blocked");
  } finally {
    await tearDown(tmp);
  }
});

test("retryTask refuses if task already completed", async () => {
  const tmp = await setupTempHome();
  try {
    const team = await createTeam({ description: "no-op retry" });
    const task = await addTask(team.id, { title: "done thing" });
    await updateTaskStatus(team.id, task.id, "completed");

    const r = await retryTask(team.id, task.id);
    assert.equal(r.reset, false);
    assert.match(r.reason, /already completed/i);
  } finally {
    await tearDown(tmp);
  }
});

test("retryTask refuses if attempts exhausted and status=error", async () => {
  const tmp = await setupTempHome();
  try {
    const team = await createTeam({ description: "exhausted retry" });
    const task = await addTask(team.id, { title: "doomed", max_retries: 1 });

    await markTaskFailed(team.id, task.id, "a");
    await markTaskFailed(team.id, task.id, "b");  // exhausts max_retries=1 (attempts=2 > 1)

    const r = await retryTask(team.id, task.id);
    assert.equal(r.reset, false);
    assert.match(r.reason, /exhausted retries/i);
  } finally {
    await tearDown(tmp);
  }
});

test("updateTaskStatus accepts new statuses (retrying, error)", async () => {
  const tmp = await setupTempHome();
  try {
    const team = await createTeam({ description: "status validation" });
    const task = await addTask(team.id, { title: "t" });

    await updateTaskStatus(team.id, task.id, "retrying");
    let tasks = await listTasks(team.id);
    assert.equal(tasks[0].status, "retrying");

    await updateTaskStatus(team.id, task.id, "error");
    tasks = await listTasks(team.id);
    assert.equal(tasks[0].status, "error");

    assert.rejects(
      () => updateTaskStatus(team.id, task.id, "bogus-status"),
      /invalid status/
    );
  } finally {
    await tearDown(tmp);
  }
});

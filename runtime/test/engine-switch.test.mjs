// The safe switch (P3.4, engine/switch.mjs): another account of the same provider by
// fork, never by resume. Against the fake app-server, which mirrors 0.163's goal, fork
// and unload behaviour (an idle thread with an active goal continues on its own; an
// unloaded thread's background terminals are ended).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine, SWITCH_TEXTS, switchThread } from "../src/engine/index.mjs";
import { waitFor } from "../testkit/wait.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

async function withEngine(opts, fn) {
  const home = mkdtempSync(join(tmpdir(), "ad-switch-"));
  const engine = await createEngine({ home, command, experimental: true, ...opts });
  try {
    await fn(engine);
  } finally {
    await engine.close();
    rmSync(home, { recursive: true, force: true });
  }
}
const debug = (engine, m = "debug/state", p = {}) => engine.testRequest(m, p);
const running = async (engine, threadId) => (await engine.threads.read(threadId, { includeTurns: true })).status.type === "active";

test("an active goal is paused, the fork gets deferGoalContinuation, the goal moves to the fork and nothing continues on the old thread", async () => {
  await withEngine({}, async (engine) => {
    const { threadId } = await engine.threads.start({ cwd: "/work", modelProvider: "ad-openrouter-a" });
    await engine.threads.goal.set(threadId, "ship the release");
    const r = await switchThread({ engine, threadId, target: { modelProvider: "ad-openrouter-b", model: "m/x" } });
    assert.notEqual(r.threadId, threadId);
    assert.equal(r.goalMoved, true);
    assert.equal(r.watching, false);
    const { lastParams, calls } = await debug(engine);
    assert.equal(lastParams["thread/fork"].deferGoalContinuation, true);
    assert.equal(lastParams["thread/fork"].modelProvider, "ad-openrouter-b");
    assert.ok(calls.indexOf("thread/goal/set") < calls.indexOf("thread/fork"), "paused before the fork");
    await tick(60);
    assert.equal(await running(engine, threadId), false, "nothing runs on the old thread");
    assert.equal(await running(engine, r.threadId), false, "nothing runs on the fork before its first turn");
    assert.deepEqual(await engine.threads.goal.get(r.threadId), { threadId: r.threadId, objective: "ship the release", status: "paused" });
    assert.equal(await engine.threads.goal.get(threadId), null);
    assert.equal(lastParams["thread/unsubscribe"].threadId, threadId, "the old thread is unsubscribed");
  });
});

test("without the experimental allowlist and with an active goal, the switch is refused with the pause text and nothing changes", async () => {
  await withEngine({ experimental: false }, async (engine) => {
    const { threadId } = await engine.threads.start({ cwd: "/work" });
    await engine.threads.goal.set(threadId, "keep going");
    await assert.rejects(switchThread({ engine, threadId, target: { modelProvider: "ad-b" } }), (e) => e.code === "SWITCH_GOAL_ACTIVE" && e.message === SWITCH_TEXTS.GOAL_ACTIVE);
    assert.equal((await engine.threads.goal.get(threadId)).status, "active");
    assert.ok(!(await debug(engine)).calls.includes("thread/fork"));
  });
});

test("without a goal, an engine without the allowlist forks plainly", async () => {
  await withEngine({ experimental: false }, async (engine) => {
    const { threadId } = await engine.threads.start({ cwd: "/work" });
    const r = await switchThread({ engine, threadId, target: { modelProvider: "ad-b" } });
    assert.equal(r.goalMoved, false);
    assert.equal((await debug(engine)).lastParams["thread/fork"].deferGoalContinuation, undefined);
  });
});

test("a running turn is interrupted before the fork (a guard: callers switch at idle)", async () => {
  await withEngine({}, async (engine) => {
    const { threadId } = await engine.threads.start({ cwd: "/work" });
    await engine.startTurn({ threadId, text: "hang" });
    await waitFor(async () => running(engine, threadId));
    const r = await switchThread({ engine, threadId, target: { modelProvider: "ad-b" } });
    const { calls } = await debug(engine);
    assert.ok(calls.includes("turn/interrupt") && calls.indexOf("turn/interrupt") < calls.indexOf("thread/fork"));
    assert.equal(await running(engine, threadId), false);
    assert.ok(r.threadId);
  });
});

test("a switch with a running background terminal keeps the old thread subscribed and the terminal alive; it is unsubscribed when the terminal exits", async () => {
  await withEngine({}, async (engine) => {
    const { threadId } = await engine.threads.start({ cwd: "/work" });
    await engine.turn({ threadId, text: "bg-terminal", timeoutMs: 5000 });
    const ids = (await debug(engine, "debug/terminals", { threadId })).running;
    assert.equal(ids.length, 1);
    const r = await switchThread({ engine, threadId, target: { modelProvider: "ad-b" }, terminals: () => ids });
    assert.equal(r.watching, true);
    await tick(60);
    let t = await debug(engine, "debug/terminals", { threadId });
    assert.deepEqual(t.running, ids, "the terminal still runs");
    assert.deepEqual(t.killed, []);
    assert.ok(!(await debug(engine)).calls.some((m, i, all) => m === "thread/unsubscribe" && i > all.indexOf("thread/fork")), "not unsubscribed yet");
    await debug(engine, "debug/terminal/exit", { threadId });
    await waitFor(async () => (await debug(engine)).lastParams["thread/unsubscribe"]?.threadId === threadId);
    t = await debug(engine, "debug/terminals", { threadId });
    assert.deepEqual(t.killed, [], "it ended on its own, not by an unload");
  });
});

test("an engine-started turn on the watched old thread is interrupted and reported", async () => {
  await withEngine({}, async (engine) => {
    const { threadId } = await engine.threads.start({ cwd: "/work" });
    await engine.turn({ threadId, text: "bg-terminal", timeoutMs: 5000 });
    const ids = (await debug(engine, "debug/terminals", { threadId })).running;
    const seen = [];
    const r = await switchThread({ engine, threadId, target: { modelProvider: "ad-b" }, terminals: () => ids, onViolation: (v) => seen.push(v) });
    // The engine starts a turn there on its own (as a goal continuation would).
    const { turnId } = await engine.startTurn({ threadId, text: "hang" });
    await waitFor(() => seen.length === 1);
    assert.equal(seen[0].turnId, turnId);
    assert.equal(seen[0].text, SWITCH_TEXTS.VIOLATION);
    await waitFor(async () => !(await running(engine, threadId)));
    r.stop();
  });
});

test("a fork whose answer names another provider → RETARGET_IGNORED: the fork is archived, the old thread stays and its goal is active again", async () => {
  await withEngine({ env: { FAKE_FORK_KEEPS_PROVIDER: "1" } }, async (engine) => {
    const { threadId } = await engine.threads.start({ cwd: "/work", modelProvider: "ad-a" });
    await engine.threads.goal.set(threadId, "ship it");
    await assert.rejects(switchThread({ engine, threadId, target: { modelProvider: "ad-b" } }), { code: "RETARGET_IGNORED" });
    const { lastParams } = await debug(engine);
    assert.notEqual(lastParams["thread/unsubscribe"].threadId, threadId, "the old thread stays");
    assert.notEqual(lastParams["thread/archive"].threadId, threadId);
    assert.match(lastParams["thread/archive"].threadId, /^thread-/, "the ignored fork is archived");
    assert.equal(await engine.threads.goal.get(lastParams["thread/archive"].threadId), null);
    assert.equal((await engine.threads.goal.get(threadId)).status, "active");
  });
});

test("a goal that isn't active keeps its status on the fork (a finished goal isn't revived)", async () => {
  await withEngine({}, async (engine) => {
    const { threadId } = await engine.threads.start({ cwd: "/work" });
    await engine.threads.goal.set(threadId, "done already", { status: "complete" });
    const r = await switchThread({ engine, threadId, target: { modelProvider: "ad-b" } });
    assert.equal((await engine.threads.goal.get(r.threadId)).status, "complete");
    assert.equal(await engine.threads.goal.get(threadId), null);
  });
});

test("the terminal watch ends when the old thread closes", async () => {
  await withEngine({}, async (engine) => {
    const { threadId } = await engine.threads.start({ cwd: "/work" });
    await engine.turn({ threadId, text: "bg-terminal", timeoutMs: 5000 });
    const ids = (await debug(engine, "debug/terminals", { threadId })).running;
    const seen = [];
    const r = await switchThread({ engine, threadId, target: { modelProvider: "ad-b" }, terminals: () => ids, onViolation: (v) => seen.push(v) });
    // The thread closes (here: it is unsubscribed by someone else and unloads).
    await engine.threads.unsubscribe(threadId);
    await tick(60);
    // After the close the watch is gone: a turn there isn't treated as a violation.
    await engine.startTurn({ threadId, text: "hang" }).catch(() => {});
    await tick(60);
    assert.deepEqual(seen, []);
    await r.stop();
  });
});

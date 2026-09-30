// Tests for `ad loop` (harness/loop.mjs): the brakes are ours, not the
// model's — dual exit, circuit breaker, budgets, STOP file — plus the
// end-to-end loop against the fake app-server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdLoop, LOOP_DEFAULTS, loopDecision, nextPrompt, parseLoopStatus, usageTotal } from "../src/harness/loop.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };
const sink = () => ({ text: "", write(c) { this.text += c; return true; } });
const rec = (o = {}) => ({ turnStatus: "completed", status: { done: false, exitSignal: false, progress: "p" }, error: null, fileChanges: 1, tokens: 0, ...o });

test("parseLoopStatus takes the last status line and tolerates junk", () => {
  const s = parseLoopStatus('x\nLOOP_STATUS: {"done": false, "exit_signal": false, "progress": "a"}\ny\nLOOP_STATUS: {"done": true, "exit_signal": true, "progress": "b", "next": "c"}');
  assert.deepEqual(s, { done: true, exitSignal: true, progress: "b", next: "c" });
  assert.equal(parseLoopStatus("no status"), null);
  assert.equal(parseLoopStatus("LOOP_STATUS: {broken"), null);
});

test("dual exit: 'done' without exit_signal keeps going", () => {
  assert.equal(loopDecision([rec({ status: { done: true, exitSignal: false, progress: "x" } })]).stop, false);
  const d = loopDecision([rec({ status: { done: true, exitSignal: true, progress: "x" } })]);
  assert.equal(d.stop, true);
  assert.equal(d.success, true);
});

test("circuit breaker: no file changes and unchanged progress for 3 turns", () => {
  const idle = rec({ fileChanges: 0, status: { done: false, exitSignal: false, progress: "same" } });
  assert.equal(loopDecision([idle, idle]).stop, false);
  assert.match(loopDecision([idle, idle, idle]).reason, /no progress in 3 turns/);
  const moving = [idle, rec({ fileChanges: 0, status: { progress: "different" } }), idle];
  assert.equal(loopDecision(moving).stop, false, "changing progress text is progress");
});

test("same error 5 times, and 3 failed turns in a row, stop the loop", () => {
  const e = rec({ error: "rate limited", fileChanges: 1 });
  assert.match(loopDecision([e, e, e, e, e]).reason, /same error 5 times: rate limited/);
  const f = rec({ turnStatus: "failed" });
  assert.match(loopDecision([f, f, f]).reason, /3 failed turns/);
});

test("budgets and the STOP file", () => {
  const h = Array.from({ length: LOOP_DEFAULTS.maxIterations }, () => rec());
  assert.match(loopDecision(h).reason, /iteration limit/);
  assert.match(loopDecision([rec()], { elapsedMs: 61 * 60_000 }).reason, /time limit/);
  assert.match(loopDecision([rec()], { limits: { ...LOOP_DEFAULTS, maxTokens: 500 }, spentTokens: 600 }).reason, /token budget/);
  assert.match(loopDecision([rec()], { stopRequested: true }).reason, /STOP file/);
});

test("nextPrompt carries the last status and the unchanged objective", () => {
  assert.equal(nextPrompt("ship it", undefined), "Objective:\nship it");
  const p = nextPrompt("ship it", rec({ turnStatus: "failed", error: "boom", status: { progress: "did a", next: "do b" } }));
  assert.match(p, /ended as failed \(boom\)/);
  assert.match(p, /progress: did a; next: do b/);
  assert.match(p, /ship it/);
  assert.match(nextPrompt("x", rec({ status: null })), /no LOOP_STATUS/);
});

test("usageTotal reads ThreadTokenUsage.total", () => {
  assert.equal(usageTotal({ total: { totalTokens: 1234 }, last: { totalTokens: 10 } }), 1234);
  assert.equal(usageTotal({}), 0);
});

async function loop(objective, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "ad-loop-"));
  const out = sink();
  const err = sink();
  try {
    const code = await cmdLoop(objective, { cwd: root, home: join(root, "home"), userHome: join(root, "userhome"), command, stdout: out, stderr: err, store: { get: () => null }, ...extra(root) });
    const logs = existsSync(join(root, ".agent-daemon", "loops")) ? readdirSync(join(root, ".agent-daemon", "loops")) : [];
    const log = logs[0] ? readFileSync(join(root, ".agent-daemon", "loops", logs[0]), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
    return { code, out: out.text, err: err.text, log };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("loop runs until the agent confirms done + exit_signal, logging every iteration", async () => {
  const r = await loop("LOOPTEST-DONE-AFTER-2 fix the tests", () => ({}));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\[1\] completed — step 1 \[1 file change\(s\)\]/);
  assert.match(r.out, /stopped: objective done/);
  assert.equal(r.log.length, 2);
  assert.equal(r.log[1].tokens, 1000, "per-turn tokens are the delta of the thread total");
});

test("a model that keeps claiming done without exit_signal is stopped by the iteration cap", async () => {
  const r = await loop("LOOPTEST-CLAIMS-DONE", () => ({ limits: { maxIterations: 3 } }));
  assert.equal(r.code, 3);
  assert.match(r.out, /iteration limit \(3\)/);
});

test("a stuck loop trips the circuit breaker", async () => {
  const r = await loop("LOOPTEST-STUCK", () => ({}));
  assert.equal(r.code, 3);
  assert.match(r.out, /no progress in 3 turns/);
  assert.equal(r.log.length, 3);
});

test("an existing STOP file refuses to start", async () => {
  const r = await loop("LOOPTEST-STUCK", (root) => {
    mkdirSync(join(root, ".agent-daemon"), { recursive: true });
    writeFileSync(join(root, ".agent-daemon", "STOP"), "");
    return {};
  });
  assert.equal(r.code, 1);
  assert.match(r.err, /STOP file exists/);
});

test("the token budget stops the loop", async () => {
  const r = await loop("LOOPTEST-STUCK", () => ({ limits: { maxTokens: 1500 } }));
  assert.match(r.out, /token budget \(1500\)/);
});

test("circuit breaker: shell-command work counts as progress; missing status alone does not match", () => {
  const cmdOnly = rec({ fileChanges: 0, commands: 2, status: null });
  assert.equal(loopDecision([cmdOnly, cmdOnly, cmdOnly]).stop, false, "migrations/generators via shell are progress");
  const silent = rec({ fileChanges: 0, commands: 0, status: null });
  assert.match(loopDecision([silent, silent, silent]).reason, /no progress/, "no activity and no status at all is stuck");
  const mixed = [rec({ fileChanges: 0, status: null }), rec({ fileChanges: 0, status: { progress: "x" } }), rec({ fileChanges: 0, status: null })];
  assert.equal(loopDecision(mixed).stop, false);
});

test("resume without an objective asks to continue the thread's goal", () => {
  assert.equal(nextPrompt("", undefined), "Continue working toward this thread's goal.");
  assert.match(nextPrompt(undefined, rec()), /continue this thread's goal/);
});

test("unattended threads: only the memory MCP server stays on; live web search is downgraded", async () => {
  const { UNATTENDED_ENV, UNATTENDED_SANDBOX_POLICY, unattendedThreadConfig } = await import("../src/harness/unattended.mjs");
  const fake = { readConfig: async () => ({ mcp_servers: { "agent-daemon-memory": {}, playwright: {}, github: {} }, web_search: "live" }) };
  assert.deepEqual(await unattendedThreadConfig(fake), { "mcp_servers.playwright.enabled": false, "mcp_servers.github.enabled": false, web_search: "cached" });
  assert.deepEqual(await unattendedThreadConfig({ readConfig: async () => ({ web_search: "cached" }) }), {});
  assert.deepEqual(UNATTENDED_SANDBOX_POLICY, { type: "workspaceWrite", writableRoots: [], networkAccess: false });
  assert.equal(UNATTENDED_ENV.AD_WORKER, "1", "loop re-prompts are not the user's corrections");
});

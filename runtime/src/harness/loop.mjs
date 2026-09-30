// `ad loop "<objective>"` — autonomous, Ralph-style work loop on one Codex
// thread, with brakes that live in OUR code (the model can't talk its way
// past them):
//
//   exit        the agent must say done AND set exit_signal in its
//               LOOP_STATUS line (dual condition — "looks finished" alone
//               doesn't stop the loop)
//   circuit     3 turns with no file change and unchanged progress text, or
//   breaker     the same error 5 times, or 3 failed turns in a row → stop
//   budgets     max iterations, wall-clock minutes, tokens
//   kill switch a STOP file (<cwd>/.agent-daemon/STOP or ~/.agent-daemon/STOP)
//               checked before every turn and polled during one
//
// Unattended, so it runs like a team worker: approval policy "never",
// workspace-write sandbox rooted at --cwd, no network. Each iteration is
// logged to <cwd>/.agent-daemon/loops/<threadId>.jsonl; --resume continues
// a thread by id (never "latest").

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { describeItem } from "./run.mjs";
import { startHarnessEngine } from "./start.mjs";

export const LOOP_DEFAULTS = {
  maxIterations: 20,
  maxMinutes: 60,
  maxTokens: 0, // 0 = no token budget
  compactEvery: 8,
  noProgressLimit: 3,
  sameErrorLimit: 5,
  failedTurnLimit: 3,
};

export const LOOP_PROTOCOL = `You are running in an autonomous loop (Agent Daemon \`ad loop\`). Each turn:
1. Make concrete progress on the objective (edit files, run tests) — no busywork.
2. End your reply with exactly one status line:
LOOP_STATUS: {"done": <true|false>, "exit_signal": <true|false>, "progress": "<one line: what changed this turn>", "next": "<one line: what you will do next>"}
Set "done" true only when the objective is fully met and verified. Set "exit_signal" true only when you are certain no further turns are useful. Never claim done without verifying.`;

export function parseLoopStatus(text) {
  const matches = [...String(text ?? "").matchAll(/LOOP_STATUS:\s*(\{.*\})/g)];
  const last = matches.at(-1);
  if (!last) return null;
  try {
    const s = JSON.parse(last[1]);
    return { done: s.done === true, exitSignal: s.exit_signal === true, progress: String(s.progress ?? ""), next: String(s.next ?? "") };
  } catch {
    return null;
  }
}

export function stopFiles(cwd, home = homedir()) {
  return [path.join(cwd, ".agent-daemon", "STOP"), path.join(home, ".agent-daemon", "STOP")];
}

/**
 * Pure brake logic. history: iteration records, newest last:
 *   { status: parsed LOOP_STATUS|null, turnStatus, error, fileChanges, tokens }
 * Returns { stop: boolean, reason?: string }.
 */
export function loopDecision(history, { limits = LOOP_DEFAULTS, elapsedMs = 0, totalTokens = 0, stopRequested = false } = {}) {
  const last = history.at(-1);
  if (stopRequested) return { stop: true, reason: "STOP file present" };
  if (last?.status?.done && last.status.exitSignal) return { stop: true, reason: "objective done (agent confirmed done + exit_signal)", success: true };
  if (history.length >= limits.maxIterations) return { stop: true, reason: `iteration limit (${limits.maxIterations})` };
  if (limits.maxMinutes && elapsedMs >= limits.maxMinutes * 60_000) return { stop: true, reason: `time limit (${limits.maxMinutes} min)` };
  if (limits.maxTokens && totalTokens >= limits.maxTokens) return { stop: true, reason: `token budget (${limits.maxTokens})` };

  const tail = (n) => (history.length >= n ? history.slice(-n) : null);
  const failed = tail(limits.failedTurnLimit);
  if (failed?.every((h) => h.turnStatus !== "completed")) return { stop: true, reason: `${limits.failedTurnLimit} failed turns in a row` };

  const errs = tail(limits.sameErrorLimit);
  if (errs?.every((h) => h.error && h.error === errs[0].error)) return { stop: true, reason: `same error ${limits.sameErrorLimit} times: ${errs[0].error}` };

  const idle = tail(limits.noProgressLimit);
  if (idle?.every((h) => h.fileChanges === 0 && h.status?.progress === idle[0].status?.progress)) {
    return { stop: true, reason: `no progress in ${limits.noProgressLimit} turns (circuit breaker)` };
  }
  return { stop: false };
}

export function nextPrompt(objective, last) {
  if (!last) return `Objective:\n${objective}`;
  const s = last.status;
  const note = s ? `Last status — progress: ${s.progress || "(none)"}; next: ${s.next || "(unspecified)"}.` : "Your last reply had no LOOP_STATUS line; include one this time.";
  const err = last.turnStatus !== "completed" ? ` The last turn ended as ${last.turnStatus}${last.error ? ` (${last.error})` : ""}.` : "";
  return `Continue toward the objective.${err} ${note}\nObjective (unchanged):\n${objective}`;
}

export async function cmdLoop(objective, opts = {}) {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const cwd = opts.cwd ?? process.cwd();
  if (!objective?.trim() && !opts.resume) {
    err.write('Usage: ad loop "<objective>" [--max-iterations 20] [--max-minutes 60] [--max-tokens N] [--resume <thread-id>]\n');
    return 1;
  }
  const limits = { ...LOOP_DEFAULTS, ...pickDefined(opts.limits ?? {}) };
  const home = opts.userHome ?? homedir();
  const stopRequested = () => stopFiles(cwd, home).some((f) => existsSync(f));
  if (stopRequested()) {
    err.write(`ad loop: a STOP file exists (${stopFiles(cwd, home).join(" or ")}); remove it to start.\n`);
    return 1;
  }

  let engine;
  try {
    const started = await startHarnessEngine({ cwd, home: opts.home, command: opts.command, clientVersion: opts.clientVersion, store: opts.store, platform: opts.platform, err });
    if (!started.engine) {
      err.write(started.error + "\n");
      return started.code;
    }
    engine = started.engine;
    const threadOpts = { cwd, model: opts.model, sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: LOOP_PROTOCOL };
    const { threadId } = opts.resume ? await engine.resumeThread(opts.resume, threadOpts) : await engine.startThread(threadOpts);
    if (objective?.trim()) {
      await engine.setGoal(threadId, objective, limits.maxTokens ? { tokenBudget: limits.maxTokens } : {}).catch((e) => err.write(`[loop] could not set thread goal: ${e.message}\n`));
    }
    const logDir = path.join(cwd, ".agent-daemon", "loops");
    mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `${threadId}.jsonl`);
    out.write(`ad loop — thread ${threadId}\nlog: ${logFile}\nstop anytime: create ${stopFiles(cwd, home)[0]}\n`);

    const t0 = Date.now();
    const history = [];
    let totalTokens = 0;
    let decision = { stop: false };
    while (!decision.stop) {
      const i = history.length + 1;
      if (i > 1 && limits.compactEvery && (i - 1) % limits.compactEvery === 0) {
        await engine.compactThread(threadId).catch((e) => err.write(`[loop] compaction failed: ${e.message}\n`));
      }
      const record = await runIteration(engine, { threadId, text: nextPrompt(objective, history.at(-1)), stopRequested, err, limits, t0 });
      // record.tokens is the thread's running total; per-turn = the delta.
      const threadTotal = Math.max(totalTokens, record.tokens);
      record.tokens = threadTotal - totalTokens;
      totalTokens = threadTotal;
      history.push(record);
      appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), iteration: i, ...record }) + "\n");
      out.write(`[${i}] ${record.turnStatus}${record.status ? ` — ${record.status.progress}` : " — (no LOOP_STATUS)"}${record.fileChanges ? ` [${record.fileChanges} file change(s)]` : ""}\n`);
      decision = loopDecision(history, { limits, elapsedMs: Date.now() - t0, totalTokens, stopRequested: stopRequested() });
    }
    out.write(`ad loop stopped: ${decision.reason} (${history.length} iteration(s), ~${totalTokens} tokens). Resume: ad loop --resume ${threadId}\n`);
    return decision.success ? 0 : 3;
  } catch (e) {
    err.write(`ad loop: ${e.message}\n`);
    return 1;
  } finally {
    await engine?.close();
  }
}

async function runIteration(engine, { threadId, text, stopRequested, err, limits, t0 }) {
  let fileChanges = 0;
  let tokens = 0;
  let turnId = null;
  // Poll the STOP file (and the wall clock) during the turn.
  const poll = setInterval(() => {
    const overTime = limits.maxMinutes && Date.now() - t0 >= limits.maxMinutes * 60_000;
    if (turnId && (stopRequested() || overTime)) {
      engine.interrupt(threadId, turnId).catch((e) => err.write(`[loop] interrupt failed: ${e.message}\n`));
      turnId = null;
    }
  }, 2000);
  try {
    const r = await engine.turn({
      threadId,
      text,
      timeoutMs: 0,
      onEvent: (evt) => {
        if (evt.type === "turnStarted") turnId = evt.turnId;
        else if (evt.type === "item" && evt.item?.type === "fileChange") fileChanges += evt.item.changes?.length || 1;
        else if (evt.type === "itemStarted") {
          const line = describeItem(evt.item);
          if (line) err.write(`  ${line}\n`);
        } else if (evt.type === "usage") tokens = Math.max(tokens, usageTotal(evt.usage));
      },
    });
    return { turnStatus: r.status, status: parseLoopStatus(r.output), error: r.error?.message ?? null, fileChanges, tokens };
  } catch (e) {
    return { turnStatus: "failed", status: null, error: e.message, fileChanges, tokens };
  } finally {
    clearInterval(poll);
  }
}

// thread/tokenUsage/updated → the thread's running total (ThreadTokenUsage.total).
export function usageTotal(u) {
  const t = u?.total;
  return t ? Number(t.totalTokens ?? (t.inputTokens ?? 0) + (t.outputTokens ?? 0)) || 0 : 0;
}

function pickDefined(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && !Number.isNaN(v)));
}

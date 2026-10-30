// `ad loop "<objective>"` — autonomous, Ralph-style work loop on one engine thread
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

import { engineError, engineErrorText } from "../engine/index.mjs";
import { cliErrorLines } from "./io.mjs";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { describeItem } from "./run.mjs";
import { launchHarness } from "./engines.mjs";
import { createCoordinator, ledgerEnabled, ledgerHome, ledgerTarget, recordEngineThread } from "../sessions/coordinator.mjs";
import { classifyTurnFailure } from "./gateway-runtime.mjs";
import { UNATTENDED_ENV, UNATTENDED_SANDBOX_POLICY, unattendedThreadConfig } from "./unattended.mjs";
import { createUnattendedRun, fallbackOptIn, UNATTENDED_TEXTS } from "./unattended-run.mjs";

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
 *   { status: parsed LOOP_STATUS|null, turnStatus, error, fileChanges, commands, tokens }
 * spentTokens: tokens used by THIS loop run (not the resumed thread's past).
 * Returns { stop: boolean, reason?: string, success?: boolean }.
 */
export function loopDecision(history, { limits = LOOP_DEFAULTS, elapsedMs = 0, spentTokens = 0, stopRequested = false } = {}) {
  const last = history.at(-1);
  if (stopRequested) return { stop: true, reason: "STOP file present" };
  if (last?.status?.done && last.status.exitSignal) return { stop: true, reason: "objective done (agent confirmed done + exit_signal)", success: true };
  if (history.length >= limits.maxIterations) return { stop: true, reason: `iteration limit (${limits.maxIterations})` };
  if (limits.maxMinutes && elapsedMs >= limits.maxMinutes * 60_000) return { stop: true, reason: `time limit (${limits.maxMinutes} min)` };
  if (limits.maxTokens && spentTokens >= limits.maxTokens) return { stop: true, reason: `token budget (${limits.maxTokens})` };

  // A turn fallback moved to another model (P4.7) is neither a failure nor the same error.
  const counted = history.filter((h) => h.turnStatus !== "switched");
  const tail = (n) => (counted.length >= n ? counted.slice(-n) : null);
  const failed = tail(limits.failedTurnLimit);
  if (failed?.every((h) => h.turnStatus !== "completed")) return { stop: true, reason: `${limits.failedTurnLimit} failed turns in a row` };

  const errs = tail(limits.sameErrorLimit);
  if (errs?.every((h) => h.error && h.error === errs[0].error)) return { stop: true, reason: `same error ${limits.sameErrorLimit} times: ${errs[0].error}` };

  // Idle = no file edits AND no commands run, and the reported progress
  // didn't move. Work done through shell commands (migrations, generators,
  // git) is progress too; a missing status line never counts as "same".
  const idle = tail(limits.noProgressLimit);
  const noActivity = (h) => h.fileChanges === 0 && (h.commands ?? 0) === 0;
  if (idle?.every(noActivity)) {
    const texts = idle.map((h) => h.status?.progress ?? null);
    if (texts.every((t) => t === null) || texts.every((t) => t !== null && t === texts[0])) {
      return { stop: true, reason: `no progress in ${limits.noProgressLimit} turns (circuit breaker)` };
    }
  }
  return { stop: false };
}

export function nextPrompt(objective, last) {
  const goal = objective?.trim() ? `Objective (unchanged):\n${objective}` : "Objective: continue this thread's goal.";
  if (!last) return objective?.trim() ? `Objective:\n${objective}` : "Continue working toward this thread's goal.";
  const s = last.status;
  const note = s ? `Last status — progress: ${s.progress || "(none)"}; next: ${s.next || "(unspecified)"}.` : "Your last reply had no LOOP_STATUS line; include one this time.";
  const err = last.turnStatus === "switched" ? ` You're now on ${last.switchedTo ?? "another model"} after ${last.switchReason ?? "a limit"}.` : last.turnStatus !== "completed" ? ` The last turn ended as ${last.turnStatus}${last.error ? ` (${last.error})` : ""}.` : "";
  return `Continue toward the objective.${err} ${note}\n${goal}`;
}

const COMPACT_WAIT_MS = 5 * 60_000;

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
  // --fallback (P4.7): the loop may continue on the next model in your order.
  if (opts.fallback) {
    const env = opts.env ?? process.env;
    // A scheduled child uses its job's grant, made in a terminal (P4.7).
    const { jobGrantsFallback } = await import("./schedule.mjs");
    const ok = fallbackOptIn({ command: "ad loop", env, grantedElsewhere: jobGrantsFallback(env, opts.userHome) });
    if (!ok.ok) {
      err.write(`${ok.text}\n`);
      return ok.code;
    }
    if (ok.on) return loopWithFallback(objective, { ...opts, env, out, err, cwd, userHome: home, limits, stopRequested });
  }

  let engine;
  let release = null;
  let threadId;
  let goalSet = false;
  let ledgerRec = null; // the session ledger (P4.1)
  try {
    // UNATTENDED_ENV: our re-prompts echo the agent's own status text —
    // hooks must not store that as the user's corrections.
    // The account first (P3.4): the engine that serves it starts.
    const started = await launchHarness({ cwd, account: opts.account, model: opts.model, effort: opts.effort, home: opts.home, command: opts.command, clientVersion: opts.clientVersion, store: opts.store, platform: opts.platform, err, requireSandbox: true, env: UNATTENDED_ENV, allowHomeFolder: opts.allowHomeFolder === true, homePolicy: "grace" });
    if (!started.engine) {
      err.write(started.error + "\n");
      return started.code;
    }
    engine = started.engine;
    release = started.release;
    const threadOpts = { cwd, model: opts.model, sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: LOOP_PROTOCOL, config: await unattendedThreadConfig(engine) };
    // A resumed thread keeps its own account; a new one starts on the resolved one.
    ({ threadId } = opts.resume ? await engine.resumeThread(opts.resume, threadOpts) : await engine.startThread({ ...threadOpts, model: started.params.model, modelProvider: started.params.modelProvider }));
    const ledger = createCoordinator({ cwd, origin: "loop", root: opts.adRoot, enabled: ledgerEnabled(opts), classify: ({ error, status, threadId, startedAt }) => classifyTurnFailure({ error, status, threadId, startedAt, account: started.target?.account ?? null }), homeKey: () => ledgerHome(started.homeKey), targetOf: () => ledgerTarget({ account: started.target?.account, model: started.params.model ?? opts.model, effort: started.params.effort }) });
    ledgerRec = recordEngineThread(ledger, { engine, threadId, how: opts.resume ? "resume" : "new", warn: (m) => err.write(`ad loop: ${m}\n`) });
    if (objective?.trim()) {
      await engine
        .setGoal(threadId, objective, limits.maxTokens ? { tokenBudget: limits.maxTokens } : {})
        .then(() => (goalSet = true))
        .catch((e) => err.write("[loop] could not set thread goal\n" + cliErrorLines("loop", e)));
    }
    const logDir = path.join(cwd, ".agent-daemon", "loops");
    mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `${threadId}.jsonl`);
    out.write(`ad loop — thread ${threadId}\nlog: ${logFile}\nstop anytime: create ${stopFiles(cwd, home)[0]}\n`);

    const t0 = Date.now();
    const history = [];
    let threadTotal = null; // thread's running token total (includes resumed history)
    let baseline = null; // total before this run's first turn
    let decision = { stop: false };
    while (!decision.stop) {
      const i = history.length + 1;
      if (i > 1 && limits.compactEvery && (i - 1) % limits.compactEvery === 0) await compact(engine, threadId, err);
      const text = nextPrompt(objective, history.at(-1));
      // The objective is the user's; every later prompt is ad's own.
      ledgerRec?.prompt(text, i === 1 && objective?.trim() ? "submit" : "ad");
      const record = await runIteration(engine, { threadId, text, stopRequested, err, limits, t0, effort: started.params.effort ?? null });
      if (record.threadTotal != null) {
        baseline ??= record.baseline ?? 0;
        record.tokens = record.threadTotal - (threadTotal ?? baseline);
        threadTotal = record.threadTotal;
      } else record.tokens = 0;
      delete record.threadTotal;
      delete record.baseline;
      history.push(record);
      appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), iteration: i, ...record }) + "\n");
      out.write(`[${i}] ${record.turnStatus}${record.status ? ` — ${record.status.progress}` : " — (no LOOP_STATUS)"}${record.fileChanges ? ` [${record.fileChanges} file change(s)]` : ""}\n`);
      const spentTokens = threadTotal == null ? 0 : threadTotal - baseline;
      decision = loopDecision(history, { limits, elapsedMs: Date.now() - t0, spentTokens, stopRequested: stopRequested() });
    }
    const spent = threadTotal == null ? 0 : threadTotal - baseline;
    const reason = history.at(-1)?.error && decision.reason.startsWith("same error ")
      ? decision.reason.replace(history.at(-1).error, engineErrorText({ code: -32000 }, { details: null }))
      : decision.reason;
    out.write(`ad loop stopped: ${reason} (${history.length} iteration(s), ~${spent} tokens). Resume: ad loop --resume ${threadId}\n`);
    return decision.success ? 0 : 3;
  } catch (e) {
    err.write(cliErrorLines("loop", e));
    return 1;
  } finally {
    // An active goal could let the engine keep driving the thread on its own,
    // outside our brakes; the loop owns the goal only while it runs.
    if (goalSet) await engine.clearGoal(threadId).catch((e) => err.write("[loop] could not clear the thread goal\n" + cliErrorLines("loop", e)));
    await ledgerRec?.stop();
    if (release) await release();
    else await engine?.close();
  }
}

// Compaction runs as its own turn; starting the next turn before it ends
// fails. Wait for thread/compacted.
async function compact(engine, threadId, err) {
  const done = engine.waitForCompaction(threadId, { timeoutMs: COMPACT_WAIT_MS });
  done.catch(() => {}); // awaited below
  try {
    await engine.compactThread(threadId);
    await done;
  } catch (e) {
    err.write("[loop] compaction failed\n" + cliErrorLines("loop", e));
  }
}

async function runIteration(engine, { threadId, text, stopRequested, err, limits, t0, effort = null }) {
  let fileChanges = 0;
  let commands = 0;
  let threadTotal = null;
  let baseline = null;
  let turnId = null;
  let interruptSent = false;
  // Poll the STOP file (and the wall clock) during the turn; re-send the
  // interrupt on every poll until the turn actually ends.
  const poll = setInterval(() => {
    const overTime = limits.maxMinutes && Date.now() - t0 >= limits.maxMinutes * 60_000;
    if (turnId && (stopRequested() || overTime)) {
      if (!interruptSent) err.write(`[loop] ${overTime ? "time limit reached" : "STOP file found"} — interrupting\n`);
      interruptSent = true;
      engine.interrupt(threadId, turnId).catch((e) => err.write("[loop] interrupt failed\n" + cliErrorLines("loop", e)));
    }
  }, 2000);
  try {
    const r = await engine.turn({
      threadId,
      text,
      timeoutMs: 0,
      sandboxPolicy: UNATTENDED_SANDBOX_POLICY, // every turn, whatever config.toml says
      ...(effort ? { effort } : {}),
      onEvent: (evt) => {
        if (evt.type === "turnStarted") turnId = evt.turnId;
        else if (evt.type === "item" && evt.item?.type === "fileChange") fileChanges += evt.item.changes?.length || 1;
        else if (evt.type === "item" && evt.item?.type === "commandExecution") commands++;
        else if (evt.type === "itemStarted") {
          const line = describeItem(evt.item);
          if (line) err.write(`  ${line}\n`);
        } else if (evt.type === "usage") {
          const total = usageTotal(evt.usage);
          // The first update of the turn: total before it = total − last call.
          if (baseline === null && total) baseline = total - usageLast(evt.usage);
          if (total) threadTotal = Math.max(threadTotal ?? 0, total);
        }
      },
    });
    if (r.error?.message) err.write(cliErrorLines("loop", engineError(-32000, r.error.message, { raw: r.error.message })));
    return { turnStatus: r.status, status: parseLoopStatus(r.output), error: r.error?.message ?? null, fileChanges, commands, threadTotal, baseline };
  } catch (e) {
    err.write(cliErrorLines("loop", e));
    return { turnStatus: "failed", status: null, error: e.message, fileChanges, commands, threadTotal, baseline };
  } finally {
    clearInterval(poll);
  }
}

// thread/tokenUsage/updated → the thread's running total (ThreadTokenUsage.total).
export function usageTotal(u) {
  const t = u?.total;
  return t ? Number(t.totalTokens ?? (t.inputTokens ?? 0) + (t.outputTokens ?? 0)) || 0 : 0;
}

function usageLast(u) {
  const l = u?.last;
  return l ? Number(l.totalTokens ?? (l.inputTokens ?? 0) + (l.outputTokens ?? 0)) || 0 : 0;
}

function pickDefined(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && !Number.isNaN(v)));
}

/**
 * ad loop --fallback (P4.7): the same loop through the headless fallback runner. A turn that
 * fallback moved to another model is logged "switched" and never counts toward the failure
 * brakes; the next prompt says where the loop is now. A pause stops the loop (exit 4). Every
 * thread, a switch's continuation included, keeps the loop's own settings (LOOP_PROTOCOL,
 * approval never, workspace-write, the unattended config); the token budget sums every model.
 */
async function loopWithFallback(objective, o) {
  // userHome: where the STOP file lives; o.home is an engine home a caller chose (launchHarness's).
  const { out, err, cwd, userHome, limits, stopRequested, env } = o;
  const started = await launchHarness({ cwd, account: o.account, model: o.model, effort: o.effort, home: o.home, command: o.command, clientVersion: o.clientVersion, store: o.store, platform: o.platform, err, requireSandbox: true, env: UNATTENDED_ENV, allowHomeFolder: o.allowHomeFolder === true, homePolicy: "grace" });
  if (!started.engine) {
    err.write(started.error + "\n");
    return started.code;
  }
  let run = null;
  let goalSet = false;
  let fileChanges = 0;
  let commands = 0;
  let spent = 0;
  try {
    const { createTuiAccounts } = await import("../tui/accounts.mjs");
    const { createSecretStore } = await import("../auth/secrets.mjs");
    run = createUnattendedRun({
      started,
      cwd,
      origin: env.AD_SCHEDULE_JOB ? "schedule" : "loop",
      adRoot: o.adRoot,
      env,
      err,
      threadOpts: { sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: LOOP_PROTOCOL, config: await unattendedThreadConfig(started.engine) },
      turnOpts: { sandboxPolicy: UNATTENDED_SANDBOX_POLICY, ...(started.params?.effort ? { effort: started.params.effort } : {}) },
      accounts:
        o.accountsFor ??
        ((session) => createTuiAccounts({ session, store: o.store ?? createSecretStore(), clientVersion: o.clientVersion, launch: (a) => launchHarness({ cwd, account: a.id, command: o.command, clientVersion: o.clientVersion, store: o.store, err, requireSandbox: true, env: UNATTENDED_ENV, homePolicy: "grace", allowHomeFolder: o.allowHomeFolder === true }) })),
      onEvent: (ev) => {
        if (ev.type === "item.completed" && ev.item?.kind === "fileChange") fileChanges += ev.item.changes?.length || 1;
        else if (ev.type === "item.completed" && ev.item?.kind === "commandExecution") commands++;
        else if (ev.type === "thread.tokens") spent += ev.usage?.last?.total ?? 0;
      },
      deps: o.fallbackDeps ?? {},
    });
    const s = run.session;
    if (o.resume) await s.resume(o.resume);
    else await s.startThread();
    const threadId = s.state.thread.id;
    if (objective?.trim()) {
      await started.engine
        .setGoal(threadId, objective, limits.maxTokens ? { tokenBudget: limits.maxTokens } : {})
        .then(() => (goalSet = true))
        .catch((e) => err.write("[loop] could not set thread goal\n" + cliErrorLines("loop", e)));
    }
    // One log per loop, whatever model it moves to.
    const logDir = path.join(cwd, ".agent-daemon", "loops");
    mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `${threadId}.jsonl`);
    const log = (o2) => appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), ...o2 }) + "\n");
    out.write(`ad loop — thread ${threadId} (fallback on)\nlog: ${logFile}\nstop anytime: create ${stopFiles(cwd, userHome)[0]}\n`);
    const t0 = Date.now();
    const history = [];
    let decision = { stop: false };
    while (!decision.stop) {
      const i = history.length + 1;
      const text = nextPrompt(objective, history.at(-1));
      const f0 = run.fallback().length;
      const [fc0, c0, s0] = [fileChanges, commands, spent];
      // The STOP file and the wall clock, during the turn too.
      const poll = setInterval(() => {
        const overTime = limits.maxMinutes && Date.now() - t0 >= limits.maxMinutes * 60_000;
        if ((stopRequested() || overTime) && s.state.activeTurnId) s.interrupt().catch(() => {});
      }, 2000);
      let r;
      try {
        r = await run.turn(text, { via: i === 1 && objective?.trim() ? "submit" : "ad" });
      } finally {
        clearInterval(poll);
      }
      const moved = run.fallback().slice(f0);
      for (const e of moved) log({ type: "fallback", event: e.type, text: e.text, reason: e.reason ?? null, sessionId: r.sessionId, threadId: s.state.thread?.id ?? null });
      const switched = moved.some((e) => e.type === "switched");
      const record = {
        turnStatus: r.status === "completed" && switched ? "switched" : r.status,
        status: parseLoopStatus(r.output),
        error: r.error?.message ?? null,
        fileChanges: fileChanges - fc0,
        commands: commands - c0,
        tokens: spent - s0,
        ...(switched ? { switchedTo: r.target ? `${r.target.account}${r.target.model ? ` \u{b7} ${r.target.model}` : ""}` : null, switchReason: moved.find((e) => e.type === "switched")?.text?.split(": ").slice(1).join(": ").replace(/\. Fallback \d+ of \d+\.$/, "") ?? null } : {}),
      };
      history.push(record);
      log({ iteration: i, ...record });
      out.write(`[${i}] ${record.turnStatus}${record.status ? ` — ${record.status.progress}` : " — (no LOOP_STATUS)"}${record.fileChanges ? ` [${record.fileChanges} file change(s)]` : ""}\n`);
      if (r.status === "paused") {
        out.write(`ad loop stopped: paused: ${r.reason} (${history.length} iteration(s), ~${spent} tokens).\n`);
        err.write(`${UNATTENDED_TEXTS.PAUSED(r.reason, r.sessionId)}\n`);
        return 4;
      }
      // A switched turn's success is its own: done + exit_signal still ends the loop.
      const forBrakes = record.turnStatus === "switched" && record.status?.done && record.status.exitSignal ? [...history.slice(0, -1), { ...record, turnStatus: "completed" }] : history;
      decision = loopDecision(forBrakes, { limits, elapsedMs: Date.now() - t0, spentTokens: spent, stopRequested: stopRequested() });
    }
    out.write(`ad loop stopped: ${decision.reason} (${history.length} iteration(s), ~${spent} tokens). Resume: ad loop --fallback --resume ${run.session.state.thread?.id ?? threadId}\n`);
    return decision.success ? 0 : 3;
  } catch (e) {
    err.write(cliErrorLines("loop", e));
    return 1;
  } finally {
    // The goal lives on the thread the loop ended on (a switch moved it there, paused).
    const tid = run?.session.state.thread?.id;
    if (goalSet && tid) await (run.session.engine ?? started.engine).clearGoal(tid).catch(() => {});
    await run?.close();
    await started.release?.();
  }
}

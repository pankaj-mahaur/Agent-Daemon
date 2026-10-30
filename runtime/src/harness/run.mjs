// `ad run "<prompt>"` — one non-interactive agent turn on ad's engine.
//
// Nobody is at the keyboard, so every approval request is declined (and
// reported on stderr). Streamed agent text goes to stdout; activity
// (commands, file edits, errors) goes to stderr so stdout stays pipeable.

import { engineError, turnErrorOf } from "../engine/index.mjs";
import { cliErrorLines } from "./io.mjs";
import { NOT_LOGGED_IN } from "./start.mjs";
import { launchHarness } from "./engines.mjs";
import { createCoordinator, ledgerEnabled, ledgerHome, ledgerTarget, recordEngineThread } from "../sessions/coordinator.mjs";
import { gatewayReason } from "./gateway-runtime.mjs";
import { accountName } from "../auth/accounts/target.mjs";
import { classifyTurnFailure } from "./gateway-runtime.mjs";
import { createUnattendedRun, fallbackOptIn, isLimitClass, policyOn, UNATTENDED_TEXTS } from "./unattended-run.mjs";

/** The one-line hint for a run that hit a limit with fallback on in the settings but not here (P4.7). */
export function fallbackHint(env = process.env) {
  if (env.AD_SCHEDULE_JOB) return UNATTENDED_TEXTS.HINT(`ad schedule edit ${env.AD_SCHEDULE_JOB} --fallback`);
  return UNATTENDED_TEXTS.HINT("add --fallback");
}

export { NOT_LOGGED_IN };

export function describeItem(item) {
  switch (item?.type) {
    case "commandExecution":
      return `$ ${Array.isArray(item.command) ? item.command.join(" ") : item.command}`;
    case "fileChange":
      return `~ ${(item.changes ?? []).map((c) => c.path).join(", ") || "file change"}`;
    case "mcpToolCall":
      return `⚙ ${item.server ?? "mcp"}.${item.tool ?? "tool"}`;
    case "webSearch":
      return `🔎 ${item.query ?? ""}`;
    default:
      return null;
  }
}

// "OpenRouter · work · qwen3-coder": the account (when ad resolved one) and the model.
function targetLine(started, opts) {
  const a = started.target?.account;
  const model = started.params?.model ?? opts.model ?? null;
  if (!a) return model;
  return `${accountName(a)}${model ? ` \u{b7} ${model}` : ""}${started.params?.effort ? ` ${started.params.effort}` : ""}`;
}

export async function cmdRun(prompt, opts = {}) {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  if (!prompt?.trim()) {
    err.write('Usage: ad run "<prompt>" [--cwd <dir>] [--account <provider/label>] [--model <m>] [--effort <e>] [--sandbox read-only|workspace-write|danger-full-access] [--fallback] [--json]\n');
    return 1;
  }
  const env = opts.env ?? process.env;
  // --fallback (P4.7): this run may continue on the next model in your order.
  let fallbackOn = false;
  if (opts.fallback) {
    // A scheduled child uses its job's grant, made in a terminal (P4.7).
    const { jobGrantsFallback } = await import("./schedule.mjs");
    const ok = fallbackOptIn({ command: "ad run", env, grantedElsewhere: jobGrantsFallback(env, opts.userHome) });
    if (!ok.ok) {
      err.write(`${ok.text}\n`);
      return ok.code;
    }
    fallbackOn = ok.on;
  }

  let engine;
  let release = null;
  let record = null; // the session ledger (P4.1)
  try {
    // The account first (P3.4): the engine that serves it starts, never the default one by chance.
    const started = await launchHarness({
      cwd: opts.cwd ?? process.cwd(),
      account: opts.account,
      model: opts.model,
      effort: opts.effort,
      home: opts.home,
      command: opts.command,
      clientVersion: opts.clientVersion,
      store: opts.store,
      platform: opts.platform,
      err,
      // For now a script in the home folder still runs, with a one-time note (strict in a later release).
      allowHomeFolder: opts.allowHomeFolder === true,
      homePolicy: "grace",
      onApproval: (req) => {
        err.write(`[declined ${req.kind} — ad run is non-interactive; use ad chat to approve]\n`);
        record?.answered(req, "decline");
        return "decline";
      },
    });
    if (!started.engine) {
      err.write(started.error + "\n");
      return started.code;
    }
    engine = started.engine;
    release = started.release;
    if (fallbackOn) {
      release = null; // the run's session owns the engine's lease now
      engine = null;
      return await runWithFallback(prompt, started, { ...opts, env, out, err });
    }
    const { threadId } = await engine.startThread({ cwd: opts.cwd, model: started.params.model, modelProvider: started.params.modelProvider, sandbox: opts.sandbox });
    const ledger = createCoordinator({ cwd: opts.cwd ?? process.cwd(), origin: "run", root: opts.adRoot, enabled: ledgerEnabled(opts), classify: ({ error, status, threadId, startedAt }) => classifyTurnFailure({ error, status, threadId, startedAt, account: started.target?.account ?? null }), homeKey: () => ledgerHome(started.homeKey), targetOf: () => ledgerTarget({ account: started.target?.account, model: started.params.model ?? opts.model, effort: started.params.effort }) });
    record = recordEngineThread(ledger, { engine, threadId, warn: (m) => err.write(`ad run: ${m}\n`) });
    // Which account and model run it (P4.2), on stderr: stdout stays the agent's text.
    const target = targetLine(started, opts);
    if (target) err.write(`target: ${target}\n`);
    record.prompt(prompt);
    const streamed = new Set();
    const turnStart = Date.now();
    const r = await engine.turn({
      threadId,
      text: prompt,
      ...(started.params.effort ? { effort: started.params.effort } : {}),
      onEvent: (evt) => {
        if (opts.json) return;
        if (evt.type === "delta") {
          if (streamed.size && !streamed.has(evt.itemId)) out.write("\n\n"); // next message
          streamed.add(evt.itemId);
          out.write(evt.text);
        } else if (evt.type === "item" && evt.item?.type === "agentMessage" && !streamed.has(evt.item.id)) {
          if (streamed.size) out.write("\n\n");
          streamed.add(evt.item.id);
          out.write(evt.item.text ?? ""); // arrived whole, without deltas
        } else if (evt.type === "itemStarted") {
          const line = describeItem(evt.item);
          if (line) err.write(`\n${line}\n`);
        } else if (evt.type === "error") err.write(cliErrorLines("run", engineError(-32000, evt.message, { raw: evt.message })));
      },
    });
    // A provider ad translates for: the gateway's reason beats the engine's generic words.
    const why = r.status === "failed" ? gatewayReason({ threadId, sinceMs: turnStart }) : null;
    // A limit while fallback is on in the settings but not for this run: say how to opt in.
    const hint = r.status === "failed" && isLimitClass(classifyTurnFailure({ error: turnErrorOf(r.error), status: r.status, threadId, startedAt: turnStart, account: started.target?.account ?? null }).class) && policyOn({ env }) ? fallbackHint(env) : null;
    if (opts.json) out.write(JSON.stringify({ threadId, turnId: r.turnId, status: r.status, output: r.output, error: r.error, ...(why ? { reason: why } : {}), ...(hint ? { hint } : {}), ...(targetLine(started, opts) ? { target: targetLine(started, opts) } : {}) }) + "\n");
    else out.write("\n");
    if (r.status !== "completed") {
      err.write(`[turn ${r.status}]\n`);
      if (why) err.write(`ad run: ${why}\n`);
      if (hint) err.write(`ad run: ${hint}\n`);
      if (r.error?.message) err.write(cliErrorLines("run", engineError(-32000, r.error.message, { raw: r.error.message })));
      return 1;
    }
    return 0;
  } catch (e) {
    err.write(cliErrorLines("run", e));
    return 1;
  } finally {
    await record?.stop();
    if (release) await release();
    else await engine?.close();
  }
}

/**
 * ad run --fallback (P4.7): the prompt through the headless fallback runner. Exit 0 when a
 * target completes it, 4 when fallback paused (nobody to ask), 1 otherwise.
 */
async function runWithFallback(prompt, started, opts) {
  const { out, err } = opts;
  const { createTuiAccounts } = await import("../tui/accounts.mjs");
  const { createSecretStore } = await import("../auth/secrets.mjs");
  const cwd = opts.cwd ?? process.cwd();
  const run = createUnattendedRun({
    started,
    cwd,
    origin: opts.env?.AD_SCHEDULE_JOB ? "schedule" : "run",
    adRoot: opts.adRoot,
    env: opts.env,
    err,
    threadOpts: opts.sandbox ? { sandbox: opts.sandbox } : {},
    turnOpts: started.params?.effort ? { effort: started.params.effort } : {},
    // As without --fallback: nobody approves, so every request is declined and said so.
    onRequest: (req) => {
      err.write(`[declined ${req.kind ?? req.method ?? "request"} — ad run is non-interactive; use ad chat to approve]\n`);
      return "decline";
    },
    accounts: opts.accountsFor ?? ((session) => createTuiAccounts({ session, store: opts.store ?? createSecretStore(), clientVersion: opts.clientVersion, launch: (a) => launchHarness({ cwd, account: a.id, command: opts.command, clientVersion: opts.clientVersion, store: opts.store, err, homePolicy: "grace", allowHomeFolder: opts.allowHomeFolder === true }) })),
    deps: opts.fallbackDeps ?? {},
  });
  try {
    const target = targetLine(started, opts);
    if (target) err.write(`target: ${target}\n`);
    const r = await run.turn(prompt);
    if (opts.json) out.write(`${JSON.stringify({ threadId: r.threadId, turnId: r.turnId, status: r.status, output: r.output, error: r.error, sessionId: r.sessionId, target: r.target, fallback: r.fallback, ...(r.status === "paused" ? { reason: r.reason, resetsAt: r.resetsAt ?? null } : {}) })}\n`);
    else out.write(`${r.output}\n`);
    if (r.status === "paused") {
      err.write(`${UNATTENDED_TEXTS.PAUSED(r.reason, r.sessionId)}\n`);
      return 4;
    }
    if (r.status !== "completed") {
      err.write(`[turn ${r.status}]\n`);
      if (r.error?.message) err.write(cliErrorLines("run", engineError(-32000, r.error.message, { raw: r.error.message })));
      return 1;
    }
    return 0;
  } finally {
    await run.close();
    await started.release?.();
  }
}

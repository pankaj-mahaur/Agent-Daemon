// `ad run "<prompt>"` — one non-interactive agent turn on ad's engine.
//
// Nobody is at the keyboard, so every approval request is declined (and
// reported on stderr). Streamed agent text goes to stdout; activity
// (commands, file edits, errors) goes to stderr so stdout stays pipeable.

import { engineError } from "../engine/index.mjs";
import { cliErrorLines } from "./io.mjs";
import { NOT_LOGGED_IN } from "./start.mjs";
import { launchHarness } from "./engines.mjs";
import { createCoordinator, ledgerEnabled, ledgerHome, ledgerTarget, recordEngineThread } from "../sessions/coordinator.mjs";
import { gatewayReason } from "./gateway-runtime.mjs";
import { accountName } from "../auth/accounts/target.mjs";
import { classifyTurnFailure } from "./gateway-runtime.mjs";

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
    err.write('Usage: ad run "<prompt>" [--cwd <dir>] [--account <provider/label>] [--model <m>] [--effort <e>] [--sandbox read-only|workspace-write|danger-full-access] [--json]\n');
    return 1;
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
      // 3.0.x: a script in the home folder still runs, with a one-time note (strict from 3.1).
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
    if (opts.json) out.write(JSON.stringify({ threadId, turnId: r.turnId, status: r.status, output: r.output, error: r.error, ...(why ? { reason: why } : {}), ...(targetLine(started, opts) ? { target: targetLine(started, opts) } : {}) }) + "\n");
    else out.write("\n");
    if (r.status !== "completed") {
      err.write(`[turn ${r.status}]\n`);
      if (why) err.write(`ad run: ${why}\n`);
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

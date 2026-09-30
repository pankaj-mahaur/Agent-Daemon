// `ad run "<prompt>"` — one non-interactive agent turn on the Codex engine.
//
// Nobody is at the keyboard, so every approval request is declined (and
// reported on stderr). Streamed agent text goes to stdout; activity
// (commands, file edits, errors) goes to stderr so stdout stays pipeable.

import { createEngine } from "../engine/index.mjs";
import { providerEnv } from "../auth/providers.mjs";

export const NOT_LOGGED_IN = "Not logged in. Run: ad auth login chatgpt   (or: ad auth login openai | ad auth login openrouter --model <slug>)";

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

export async function cmdRun(prompt, opts = {}) {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  if (!prompt?.trim()) {
    err.write('Usage: ad run "<prompt>" [--cwd <dir>] [--model <m>] [--sandbox read-only|workspace-write] [--json]\n');
    return 1;
  }

  let engine;
  try {
    engine = await createEngine({
      cwd: opts.cwd,
      home: opts.home,
      command: opts.command,
      clientVersion: opts.clientVersion,
      env: providerEnv(opts.store),
      onApproval: (req) => {
        err.write(`[declined ${req.kind} — ad run is non-interactive; use ad chat to approve]\n`);
        return "decline";
      },
    });
    const acct = await engine.account();
    if (acct.requiresOpenaiAuth && !acct.account) {
      err.write(NOT_LOGGED_IN + "\n");
      return 2;
    }
    const { threadId } = await engine.startThread({ cwd: opts.cwd, model: opts.model, sandbox: opts.sandbox });
    const r = await engine.turn({
      threadId,
      text: prompt,
      onEvent: (evt) => {
        if (opts.json) return;
        if (evt.type === "delta") out.write(evt.text);
        else if (evt.type === "itemStarted") {
          const line = describeItem(evt.item);
          if (line) err.write(`\n${line}\n`);
        } else if (evt.type === "error") err.write(`\n[error] ${evt.message}\n`);
      },
    });
    if (opts.json) out.write(JSON.stringify({ threadId, turnId: r.turnId, status: r.status, output: r.output, error: r.error }) + "\n");
    else out.write("\n");
    if (r.status !== "completed") {
      err.write(`[turn ${r.status}${r.error?.message ? `: ${r.error.message}` : ""}]\n`);
      return 1;
    }
    return 0;
  } catch (e) {
    err.write(`ad run: ${e.message}\n`);
    return 1;
  } finally {
    await engine?.close();
  }
}

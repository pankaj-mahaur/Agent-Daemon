// `ad run "<prompt>"` — one non-interactive agent turn on the Codex engine.
//
// Nobody is at the keyboard, so every approval request is declined (and
// reported on stderr). Streamed agent text goes to stdout; activity
// (commands, file edits, errors) goes to stderr so stdout stays pipeable.

import { NOT_LOGGED_IN, startHarnessEngine } from "./start.mjs";

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

export async function cmdRun(prompt, opts = {}) {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  if (!prompt?.trim()) {
    err.write('Usage: ad run "<prompt>" [--cwd <dir>] [--model <m>] [--sandbox read-only|workspace-write|danger-full-access] [--json]\n');
    return 1;
  }

  let engine;
  try {
    const started = await startHarnessEngine({
      cwd: opts.cwd ?? process.cwd(),
      home: opts.home,
      command: opts.command,
      clientVersion: opts.clientVersion,
      store: opts.store,
      platform: opts.platform,
      err,
      onApproval: (req) => {
        err.write(`[declined ${req.kind} — ad run is non-interactive; use ad chat to approve]\n`);
        return "decline";
      },
    });
    if (!started.engine) {
      err.write(started.error + "\n");
      return started.code;
    }
    engine = started.engine;
    const { threadId } = await engine.startThread({ cwd: opts.cwd, model: opts.model, sandbox: opts.sandbox });
    const streamed = new Set();
    const r = await engine.turn({
      threadId,
      text: prompt,
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

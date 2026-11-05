#!/usr/bin/env node
// The hook dispatcher (plan L2): one entry for every host and event, run in
// exec form so no shell sits in front of it:
//
//   node <root>/runtime/bin/hook.mjs <event> [--host claude|codex]
//
// Events: tool.before, tool.after, prompt.submit, session.start, session.end,
// stop, subagent.stop. Each loads only what it needs (dynamic imports): the
// tool.before path reads the rules snapshot and the matcher, never the memory
// store or the full CLI, to stay near node's own start-up time.
//
// Memory hooks always exit 0 with valid JSON; a failure never blocks the
// session. tool.before answers ask when it can't check a call that a rule
// may cover. The dispatcher never migrates the store; jobs that need it run
// detached (session-start drains in its own budget, as before).

import { readStdinJson } from "../src/hooks/io.mjs";

const args = process.argv.slice(2);
const event = args[0] ?? "";
const hostIdx = args.indexOf("--host");
const hostFlag = hostIdx >= 0 ? args[hostIdx + 1] ?? null : null;

const print = (obj) => process.stdout.write(JSON.stringify(obj ?? {}));

async function main() {
  const input = await readStdinJson();
  const { hostOf } = await import("../src/hooks/host-capabilities.mjs");
  const host = hostOf(input, { flag: hostFlag });

  switch (event) {
    case "tool.before": {
      const { toolBefore } = await import("../src/hooks/tool-before.mjs");
      let out = null;
      try {
        out = toolBefore(input, { host });
      } catch (err) {
        out = await failClosed(input, host, err);
      }
      if (out) print(out);
      return 0;
    }
    case "tool.after": {
      // CronCreate and ScheduleWakeup prompts come back later as if typed: remember them.
      const name = String(input?.tool_name ?? "");
      if (name === "CronCreate" || name === "ScheduleWakeup") {
        const { recordScheduled } = await import("../src/hooks/prompt-source.mjs");
        recordScheduled(input?.tool_input?.prompt, { session: input?.session_id ?? null, kind: "scheduled" });
      }
      print({});
      return 0;
    }
    case "subagent.stop": {
      const { recordScheduled } = await import("../src/hooks/prompt-source.mjs");
      recordScheduled(input?.last_assistant_message, { session: input?.session_id ?? null, kind: "subagent" });
      print({});
      return 0;
    }
    case "prompt.submit": {
      const { promptSource } = await import("../src/hooks/prompt-source.mjs");
      const source = promptSource(input, { host });
      const { userPromptExtract } = await import("../src/hooks/user-prompt-extract.mjs");
      await userPromptExtract(input, { source }); // prints its own passthrough
      return 0;
    }
    case "session.start": {
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const { runSessionStart } = await import("../src/session-start.mjs");
      const cwd = String(input?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
      const projectRoot = process.env.AGENT_DAEMON_HOME ? path.resolve(process.env.AGENT_DAEMON_HOME) : path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
      await runSessionStart({ cwd, outputJson: true, projectRoot, sessionId: input?.session_id, transcript: input?.transcript_path });
      return 0;
    }
    case "session.end":
    case "stop": {
      // The digest runs detached: the host kills a hook that outlives its timeout.
      if (event === "session.end") {
        const { digestArgs } = await import("../src/hooks/engine-session-end.mjs");
        const { spawnDetached } = await import("../src/hooks/detached.mjs");
        const a = digestArgs(input);
        if (a) spawnDetached(a, { key: `digest-${input?.session_id ?? "x"}` });
      }
      print({});
      return 0;
    }
    default:
      print({});
      return 0;
  }
}

// tool.before broke: ask if a rule might cover this call, else let it run.
async function failClosed(input, host, err) {
  try {
    const { loadGuards, projectFor } = await import("../src/hooks/guards.mjs");
    const { toolDecision } = await import("../src/hooks/host-capabilities.mjs");
    const found = projectFor(loadGuards().snapshot, process.env.CLAUDE_PROJECT_DIR || input?.cwd);
    if (!found || found.project.paused || !found.project.rules?.length) return null;
    return toolDecision("ask", { host, permissionMode: input?.permission_mode, reason: "ad couldn't check this call against your rules.", notice: `ad: couldn't check this call against your rules (${String(err?.message ?? err).slice(0, 120)}).` });
  } catch {
    return null;
  }
}

// Exit once stdout has drained (a pipe can lose a write cut off by exit).
const done = (code) => process.stdout.write("", () => process.exit(code ?? 0));
main().then(done, () => {
  // Never a non-zero exit from a memory hook: the session goes on.
  process.stdout.write("{}");
  done(0);
});

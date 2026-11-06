#!/usr/bin/env node
// The hook dispatcher (plan L2): one entry for every host and event, run in
// exec form so no shell sits in front of it:
//
//   node <root>/runtime/bin/hook.mjs <event> [--host claude|codex|ad] [--plugin] [--memory-only]
//
// Events (hooks/routes.mjs maps host events to them): tool.before,
// tool.after, prompt.submit, session.start, session.end, stop, subagent.stop,
// skill.use, bash.guard, mcp.audit. Each loads only what it needs (dynamic
// imports): the tool.before path reads the rules snapshot and the matcher,
// never the memory store or the full CLI, to stay near node's own start-up.
//
// --plugin: run as the agent-daemon-memory plugin's hook. Memory only (no
// routing advice, no digest), and a step passes through when ad's own entry
// in Claude Code's settings runs it, so nothing is captured or injected twice.
//
// --memory-only: memory steps only, the same as --plugin without its pass-through
// rule. The memory product's stable launcher (memory/launch/run.mjs) passes it: its
// copy has no repo root, no full CLI for a digest, no routing map.
//
// Memory hooks always exit 0 with valid JSON; a failure never blocks the
// session. tool.before answers ask when it can't check a call that a rule
// may cover. The dispatcher never migrates the store; jobs that need it run
// detached (session-start drains in its own budget, as before).

import { readStdinJson } from "../src/hooks/io.mjs";

const args = process.argv.slice(2);
const event = args[0] ?? "";
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? null : null;
};
const hostFlag = flag("--host");
const plugin = args.includes("--plugin");
const memoryOnly = plugin || args.includes("--memory-only");
// hooks/io.mjs adapts input and output to Codex-protocol hosts by this variable.
if (hostFlag) process.env.AD_HOOK_HOST = hostFlag;
// A hook never migrates the memory store (memory/sqlite.mjs open, memory/no-migrate.mjs);
// jobs it starts detached run without these (hooks/detached.mjs jobEnv).
process.env.AD_HOOK_NO_MIGRATE = "1";
process.env.AD_HOOK_EVENT = event.slice(0, 40);

const log = async (message) => {
  try {
    (await import("../src/hooks/hook-log.mjs")).hookLog(event, message);
  } catch {
    // the log is best-effort
  }
};

const print = (obj) => process.stdout.write(JSON.stringify(obj ?? {}));
const context = (hostEvent, text) => (text ? { hookSpecificOutput: { hookEventName: hostEvent, additionalContext: text } } : {});
const quietly = async (fn) => {
  try {
    return await fn();
  } catch {
    return null;
  }
};

// The plugin's copy of a step passes through when ad's own entry runs it (ad init).
async function pluginSkips(step, host) {
  if (!plugin || host !== "claude") return false;
  const { adStepInClaudeSettings } = await import("../src/hooks/routes.mjs");
  return adStepInClaudeSettings(step);
}

/** The project folder: Claude Code's CLAUDE_PROJECT_DIR (only there: elsewhere it is an outer session's), else the payload's cwd. */
const projectDir = (input, host) => (host === "claude" ? process.env.CLAUDE_PROJECT_DIR : null) || input?.cwd || null;

async function main() {
  const input = await readStdinJson();
  const { hostOf } = await import("../src/hooks/host-capabilities.mjs");
  const host = hostOf(input, { flag: hostFlag });

  switch (event) {
    case "tool.before": {
      const { toolBefore } = await import("../src/hooks/tool-before.mjs");
      let out = null;
      let warning = null;
      try {
        out = toolBefore(input, { host, onWarning: (w) => (warning = w) });
      } catch (err) {
        await log(`couldn't check a call against the rules: ${err?.message ?? err}`);
        out = await failClosed(input, host, err);
      }
      if (warning) await log(warning);
      if (out) print(out);
      return 0;
    }
    case "tool.after": {
      const name = String(input?.tool_name ?? "");
      // CronCreate and ScheduleWakeup prompts come back later as if typed: remember them.
      if (name === "CronCreate" || name === "ScheduleWakeup") {
        if (!(await pluginSkips("scheduled-hashes", host))) {
          const { recordScheduled } = await import("../src/hooks/prompt-source.mjs");
          recordScheduled(input?.tool_input?.prompt, { session: input?.session_id ?? null, kind: "scheduled" });
        }
      } else if (!memoryOnly && name === "Bash") {
        return (await import("../src/hooks/bash-post.mjs")).bashPost(input) ?? 0;
      } else if (!memoryOnly && /^(?:Edit|Write|MultiEdit|apply_patch)$/.test(name)) {
        return (await import("../src/hooks/edit-post.mjs")).editPost(input) ?? 0;
      }
      print({});
      return 0;
    }
    case "subagent.stop": {
      if (!(await pluginSkips("subagent-hashes", host))) {
        const { recordScheduled } = await import("../src/hooks/prompt-source.mjs");
        recordScheduled(input?.last_assistant_message, { session: input?.session_id ?? null, kind: "subagent" });
      }
      print({});
      return 0;
    }
    case "prompt.submit": {
      const { promptSource } = await import("../src/hooks/prompt-source.mjs");
      const source = promptSource(input, { host });
      if (!(await pluginSkips("user-prompt-extract", host))) {
        const { userPromptExtract } = await import("../src/hooks/user-prompt-extract.mjs");
        await userPromptExtract(input, { source, print: false });
      }
      const parts = [];
      if (!memoryOnly) parts.push(await quietly(async () => (await import("../src/hooks/capability-route-advice.mjs")).routeAdviceContext(input)));
      if (!(await pluginSkips("query-retrieve", host))) {
        parts.push(await quietly(async () => (await import("../src/query-retrieve.mjs")).queryRetrieveContext(input, { cwd: projectDir(input, host) || undefined })));
      }
      print(context("UserPromptSubmit", parts.filter(Boolean).join("\n\n")));
      return 0;
    }
    case "session.start": {
      if (await pluginSkips("session-start", host)) {
        print({});
        return 0;
      }
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const { runSessionStart } = await import("../src/session-start.mjs");
      const cwd = String(input?.cwd || projectDir(input, host) || process.cwd());
      // The plugin has no repo root (ad's skills and constitution aren't in it).
      const projectRoot = memoryOnly ? undefined : process.env.AGENT_DAEMON_HOME ? path.resolve(process.env.AGENT_DAEMON_HOME) : path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
      await runSessionStart({ cwd, outputJson: true, projectRoot, sessionId: input?.session_id, transcript: input?.transcript_path, memoryOnly });
      return 0;
    }
    case "session.end":
    case "stop": {
      // The digest runs detached: the host kills a hook that outlives its timeout.
      // The plugin has no digest (ad's full CLI isn't in it).
      if (event === "session.end" && !memoryOnly) {
        const { digestArgs } = await import("../src/hooks/engine-session-end.mjs");
        const { spawnDetached, jobEnv } = await import("../src/hooks/detached.mjs");
        const a = digestArgs({ ...input, cwd: input?.cwd || projectDir(input, host) || process.cwd() });
        // The session-end digest is deterministic (no API): an LLM fallback set for other commands doesn't apply.
        if (a) spawnDetached(a, { key: `digest-${input?.session_id ?? "x"}`, env: jobEnv(process.env, ["AGENT_DAEMON_FALLBACK_LLM"]) });
      }
      print({});
      return 0;
    }
    case "skill.use":
      if (memoryOnly) break;
      return (await import("../src/hooks/skill-use.mjs")).skillUse(input) ?? 0;
    case "bash.guard":
      if (memoryOnly) break;
      return (await import("../src/hooks/bash-pre.mjs")).bashPre(input) ?? 0;
    case "mcp.audit":
      if (memoryOnly) break;
      return (await import("../src/hooks/mcp-audit.mjs")).mcpAudit(input) ?? 0;
  }
  print({});
  return 0;
}

// tool.before broke: ask if a rule might cover this call, else let it run.
async function failClosed(input, host, err) {
  try {
    const { loadGuards, projectFor } = await import("../src/hooks/guards.mjs");
    const { toolDecision } = await import("../src/hooks/host-capabilities.mjs");
    const found = projectFor(loadGuards().snapshot, projectDir(input, host));
    if (!found || found.project.paused || !found.project.rules?.length) return null;
    return toolDecision("ask", { host, permissionMode: input?.permission_mode, reason: "ad couldn't check this call against your rules.", notice: `ad: couldn't check this call against your rules (${String(err?.message ?? err).slice(0, 120)}).` });
  } catch {
    return null;
  }
}

// Exit 0 once stdout has drained (a pipe can lose a write cut off by exit).
// Never another code: a decision travels as JSON, and Codex reads exit 2 as a
// block while both hosts report other codes as a failed hook.
const done = () => process.stdout.write("", () => process.exit(0));
main().then(done, async (err) => {
  await log(`failed: ${err?.message ?? err}`);
  process.stdout.write("{}");
  done();
});

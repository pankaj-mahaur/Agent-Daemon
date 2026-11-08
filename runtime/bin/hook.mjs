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
      // A typed remember (L3, D21): saved once, pending, with a receipt. The plugin's
      // copy never passes it through; ad's own Claude Code entries leave it to the
      // plugin (the command is the plugin's); on Codex the entry that captures saves it.
      const { bareRememberIsOurs, looksBare, rememberText } = await import("../src/hooks/remember.mjs");
      let remember = rememberText(input?.prompt, host);
      // The short /remember, when it can only be the plugin's command.
      if (remember === null && host === "claude" && looksBare(input?.prompt) && bareRememberIsOurs({ cwd: projectDir(input, host) || undefined })) remember = rememberText(input.prompt, host, { bare: true });
      // A typed forget or restore (L5): the same forms and the same owner as remember.
      const { memoryVerb, bareVerb } = await import("../src/hooks/remember.mjs");
      let verbCmd = remember === null ? memoryVerb(input?.prompt, host) : null;
      if (remember === null && !verbCmd && host === "claude" && bareVerb(input?.prompt) && bareRememberIsOurs({ cwd: projectDir(input, host) || undefined, name: bareVerb(input.prompt) })) verbCmd = memoryVerb(input.prompt, host, { bare: true });
      // A typed recall (plan L6): answered here like remember and forget, by the same owner.
      const RC = await import("../src/memory/recall-command.mjs");
      let recallCmd = remember === null && !verbCmd ? RC.recallTopic(input?.prompt, host) : null;
      if (recallCmd === null && remember === null && !verbCmd && host === "claude" && RC.looksBareRecall(input?.prompt) && bareRememberIsOurs({ cwd: projectDir(input, host) || undefined, name: "recall" })) recallCmd = RC.recallTopic(input.prompt, host, { bare: true });
      const { contextHost } = await import("../src/hooks/host-capabilities.mjs");
      const recallHost = contextHost(input, { flag: hostFlag, plugin });
      let receipt = null;
      if (recallCmd !== null && (plugin || host !== "claude")) {
        receipt = await quietly(async () => {
          if (recallHost === "unknown") return null;
          const { hookProjectKeys } = await import("../src/memory/scope.mjs");
          const { db } = await import("../src/memory/episodic.mjs");
          const { ownVersion } = await import("../src/memory/own-version.mjs");
          const handle = await db();
          if (!handle) return null;
          const keys = await hookProjectKeys(String(projectDir(input, host) || process.cwd())).catch(() => []);
          const a = await RC.answerRecall(handle, { keys, topic: recallCmd, sessionId: input?.session_id ?? null, host, version: ownVersion(), plugin });
          return { systemMessage: a.systemMessage ?? undefined, context: a.context };
        });
      }
      if (verbCmd && (plugin || host !== "claude")) {
        receipt = await quietly(async () => {
          const { ownVersion } = await import("../src/memory/own-version.mjs");
          const r = await (await import("../src/hooks/memory-command.mjs")).runMemoryVerb({ ...verbCmd, input, source, host, cwd: String(input?.cwd || projectDir(input, host) || process.cwd()), version: ownVersion() });
          return r?.receipt ?? null;
        });
      }
      if (remember !== null && (plugin || host !== "claude")) {
        const R = await import("../src/hooks/remember.mjs");
        const { ownVersion } = await import("../src/memory/own-version.mjs");
        // The extractor goes to an older ad's entry, which would capture the prompt too: one capture, its.
        if (plugin && (await pluginSkips("user-prompt-extract", host)) && !(await R.adEntriesKnowRemember())) receipt = R.rememberReceipt({ text: remember, saved: false, why: R.OLDER_AD, version: ownVersion(), host });
        else receipt = (await R.captureRemember({ text: remember, input, source, host, cwd: String(input?.cwd || projectDir(input, host) || process.cwd()), version: ownVersion() })).receipt;
      }
      if (!(await pluginSkips("user-prompt-extract", host))) {
        // L5: what the user's prompt teaches goes through the capture library (screen,
        // L4a's extractor, dedupe, the store or the journal); the older extractor keeps only
        // the previous assistant turn's notes (no double capture).
        if (remember === null && !verbCmd && recallCmd === null && !receipt) {
          receipt = await quietly(async () => {
            const { capturePrompt, captureReceipt } = await import("../src/memory/capture-prompt.mjs");
            const r = await capturePrompt(input, { source, host, cwd: String(input?.cwd || projectDir(input, host) || process.cwd()) });
            if (!["pending", "provisional", "journal", "quarantined", "said-again", "repeat", "refused-secret", "deleted-before"].includes(r.status)) return null;
            const { PRODUCT, pinnedCommand } = await import("../src/product.mjs");
            const { ownVersion } = await import("../src/memory/own-version.mjs");
            const v = ownVersion();
            const line = captureReceipt({ ...r, review: v ? pinnedCommand("review", v) : `npx -y ${PRODUCT.package} review`, terminalRemember: v ? pinnedCommand("remember", v) : `npx -y ${PRODUCT.package} remember`, product: PRODUCT.displayName, forget: plugin ? `/${PRODUCT.plugin}:forget` : `${v ? pinnedCommand("forget", v) : `npx -y ${PRODUCT.package} forget`}`, remember: `/${PRODUCT.plugin}:remember` });
            return line ? { systemMessage: line, context: null } : null;
          });
        }
        const { userPromptExtract } = await import("../src/hooks/user-prompt-extract.mjs");
        // A remember's words were saved above: the extractor doesn't see them (no double capture).
        await userPromptExtract(remember !== null || verbCmd || recallCmd !== null ? { ...input, prompt: "" } : input, { source, print: false, userHandled: true });
        // The agent's hides and forget requests, once, on the next typed Claude Code prompt.
        if (host === "claude" && source?.typed) {
          const notice = await quietly(async () => {
            const { ownVersion } = await import("../src/memory/own-version.mjs");
            return (await import("../src/hooks/memory-command.mjs")).agentActionsNotice({ cwd: String(input?.cwd || projectDir(input, host) || process.cwd()), version: ownVersion() });
          });
          if (notice) receipt = { systemMessage: receipt?.systemMessage ? `${receipt.systemMessage}\n${notice}` : notice, context: receipt?.context ?? null };
        }
      }
      const parts = receipt?.context ? [receipt.context] : [];
      if (!memoryOnly) parts.push(await quietly(async () => (await import("../src/hooks/capability-route-advice.mjs")).routeAdviceContext(input)));
      // Prompt-time recall (plan L6): only into a host that honours it, named by a positive
      // signal; a typed recall already answered.
      if (recallHost !== "unknown" && recallCmd === null && !(await pluginSkips("query-retrieve", host))) {
        parts.push(await quietly(async () => (await import("../src/query-retrieve.mjs")).queryRetrieveContext(input, { cwd: projectDir(input, host) || undefined })));
      }
      print({ ...(receipt?.systemMessage ? { systemMessage: receipt.systemMessage } : {}), ...context("UserPromptSubmit", parts.filter(Boolean).join("\n\n")) });
      return 0;
    }
    case "session.start": {
      // The plugin, before any skip (L3, D19): the env-file marker, its dists entry, the setup line.
      let pluginNote = null;
      if (plugin && host === "claude") {
        pluginNote = await quietly(async () => {
          const os = await import("node:os");
          const { adRoot } = await import("../src/ad-root.mjs");
          const { ownVersion } = await import("../src/memory/own-version.mjs");
          const { pluginSessionStart } = await import("../src/hooks/plugin-session.mjs");
          return pluginSessionStart({ input, home: os.homedir(), root: adRoot(), version: ownVersion() });
        });
      }
      if (await pluginSkips("session-start", host)) {
        print(pluginNote ? { systemMessage: pluginNote } : {});
        return 0;
      }
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const { runSessionStart } = await import("../src/session-start.mjs");
      const cwd = String(input?.cwd || projectDir(input, host) || process.cwd());
      // The plugin has no repo root (ad's skills and constitution aren't in it).
      const projectRoot = memoryOnly ? undefined : process.env.AGENT_DAEMON_HOME ? path.resolve(process.env.AGENT_DAEMON_HOME) : path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
      // Codex (L3, D22): the marker setup put in config.toml is gone → say how to put it back.
      let systemMessage;
      if (hostFlag === "codex") {
        systemMessage = await quietly(async () => {
          const { adRoot } = await import("../src/ad-root.mjs");
          const gone = (await import("../src/memory/codex-marker.mjs")).codexMarkerMissing(adRoot());
          if (!gone) return undefined;
          const { PRODUCT, pinnedCommand } = await import("../src/product.mjs");
          const cmd = gone.version ? pinnedCommand("setup --host codex", gone.version) : `npx -y ${PRODUCT.package} setup --host codex`;
          return `${PRODUCT.displayName}: AD_TOOL_SHELL is gone from ${gone.file}, so Codex's agent shell isn't marked any more. Run ${cmd} in your own terminal.`;
        });
      }
      // L5: new learnings from the user's prompts wait for review (daily, then weekly). Only a
      // Claude Code session someone attends: a headless run, ad's worker or a child session
      // would use up the day's reminder unseen.
      const attended = host === "claude" && process.env.CLAUDE_CODE_ENTRYPOINT !== "sdk-cli" && process.env.CLAUDE_CODE_SESSION_ATTENDED !== "0" && process.env.AD_WORKER !== "1" && !process.env.CLAUDE_CODE_CHILD_SESSION;
      const reminder = !attended ? null : await quietly(async () => {
        const ep = await import("../src/memory/episodic.mjs");
        const store = await ep.db();
        if (!store) return null;
        const { slugCollides } = await import("../src/memory/safety.mjs");
        if (slugCollides(store, ep.projectSlug(path.resolve(cwd)), path.resolve(cwd))) return null;
        const { projectIdOf } = await import("../src/memory/projects.mjs");
        const { PRODUCT, pinnedCommand } = await import("../src/product.mjs");
        const { ownVersion } = await import("../src/memory/own-version.mjs");
        const v = ownVersion();
        const projectId = projectIdOf(path.resolve(cwd));
        return (await import("../src/memory/reminder.mjs")).reviewReminder(store, { keys: [ep.projectSlug(path.resolve(cwd)), projectId].filter(Boolean), projectId, product: PRODUCT.displayName, review: v ? pinnedCommand("review", v) : `npx -y ${PRODUCT.package} review` });
      });
      const message = [systemMessage ?? pluginNote, reminder].filter(Boolean).join("\n");
      // Recall (plan L6): only into a host that honours it, named by a positive signal.
      const { contextHost } = await import("../src/hooks/host-capabilities.mjs");
      const recallHost = contextHost(input, { flag: hostFlag, plugin });
      const review = await quietly(async () => {
        const { PRODUCT, pinnedCommand } = await import("../src/product.mjs");
        const { ownVersion } = await import("../src/memory/own-version.mjs");
        const v = ownVersion();
        return v ? pinnedCommand("review", v) : `npx -y ${PRODUCT.package} review`;
      });
      await runSessionStart({ cwd, outputJson: true, projectRoot, sessionId: input?.session_id, source: typeof input?.source === "string" ? input.source : null, transcript: input?.transcript_path, memoryOnly, systemMessage: message || undefined, host: recallHost === "unknown" ? null : recallHost, recall: recallHost !== "unknown", review });
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

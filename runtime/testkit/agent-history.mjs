// Agent history fixtures for the mistakes report (L4a): Claude Code
// transcripts and Codex rollouts written into a temp home, in the shapes the
// L0 spike captured from Claude Code 2.1.314 and Codex 0.164.0
// (test/fixtures/hosts/README.md). Never point these at a real home.

import fs from "node:fs";
import path from "node:path";
import { claudeProjectSlug } from "../src/mistakes/history.mjs";

let seq = 0;
const nextUuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

/** One Claude Code transcript line. `text` makes a typed user prompt. */
export function claudeEntry({ cwd, session, ts, text, uuid = nextUuid(), type = "user", content, ...rest }) {
  const message = type === "assistant" ? { role: "assistant", content: content ?? [{ type: "text", text: text ?? "ok" }] } : { role: "user", content: content ?? text };
  return { parentUuid: null, isSidechain: false, userType: "external", cwd, sessionId: session, version: "2.1.314", gitBranch: "main", promptSource: type === "user" ? "user" : undefined, type, message, uuid, timestamp: ts, ...rest };
}

/** Write a Claude Code session file under <config>/projects/<slug of cwd>/. */
export function writeClaudeSession(configDir, { cwd, session, entries, slugOf = cwd, file = `${session}.jsonl` }) {
  const dir = path.join(configDir, "projects", claudeProjectSlug(slugOf));
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, file);
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return p;
}

/** One Codex rollout line. */
export const codexLine = (ts, type, payload) => ({ timestamp: ts, type, payload });

/** A typed prompt as Codex 0.164 records it (a user response_item). */
export const codexTyped = (ts, text, id = `msg_${nextUuid()}`) => codexLine(ts, "response_item", { type: "message", id, role: "user", content: [{ type: "input_text", text }] });

/** The context Codex injects as a user message at the start of a thread. */
export const codexInjected = (ts, cwd) => codexLine(ts, "response_item", { type: "message", id: `msg_${nextUuid()}`, role: "user", content: [{ type: "input_text", text: `<environment_context>\n  <cwd>${cwd}</cwd>\n</environment_context>` }] });

/**
 * The L4a fixture history: one project ("app") with a subfolder, a sibling
 * project whose slug starts the same ("app-old"), and every entry the reader
 * must drop. Returns the folders and the exact numbers the report must show.
 *
 * This project: 10 typed prompts (Claude Code 6, Codex 4), 8 corrections in
 * 4 clusters: "use pnpm, not npm" ×3 (both agents), "stop adding comments to
 * every function" ×3 (both agents), "we use tabs, not spaces" ×1, "always run
 * lint before committing" ×1. --all-projects adds "never push to main" ×2.
 */
export function buildScenario(base) {
  const home = path.join(base, "home");
  const claudeDir = path.join(home, ".claude");
  const codexHome = path.join(home, ".codex");
  const project = path.join(base, "work", "app");
  const other = path.join(base, "work", "app-old");
  for (const d of [project, other]) fs.mkdirSync(path.join(d, ".git", "info"), { recursive: true });
  fs.mkdirSync(path.join(project, "packages", "web"), { recursive: true });
  // Two rules Claude Code reads and Codex doesn't (no AGENTS.md).
  fs.writeFileSync(path.join(project, "CLAUDE.md"), "# Rules\n- use pnpm, not npm\n- never push to main\n");

  const lastWeek = (h) => `2026-10-27T${String(h).padStart(2, "0")}:00:00.000Z`;
  const thisWeek = (h) => `2026-11-03T${String(h).padStart(2, "0")}:00:00.000Z`;
  const now = Date.parse("2026-11-05T12:00:00.000Z");

  // Claude Code, session s1 (last week).
  const typed1 = claudeEntry({ cwd: project, session: "s1", ts: lastWeek(9), text: "no, use pnpm here, not npm" });
  const typed10 = claudeEntry({ cwd: project, session: "s1", ts: lastWeek(10), text: "stop adding comments to every function" });
  const s1 = [
    typed1,
    claudeEntry({ cwd: project, session: "s1", ts: lastWeek(9), type: "assistant", text: "switching to pnpm" }),
    claudeEntry({ cwd: project, session: "s1", ts: lastWeek(9), content: [{ type: "tool_result", tool_use_id: "t1", content: "never use npm here" }], toolUseResult: { stdout: "" } }),
    claudeEntry({ cwd: project, session: "s1", ts: lastWeek(9), text: "add a login page" }),
    claudeEntry({ cwd: project, session: "s1", ts: lastWeek(9), text: "<local-command-caveat>Caveat: never use npm</local-command-caveat>", isMeta: true }),
    claudeEntry({ cwd: project, session: "s1", ts: lastWeek(9), text: "<task-notification>stop using npm</task-notification>", promptSource: "system", origin: { kind: "task-notification" } }),
    claudeEntry({ cwd: project, session: "s1", ts: lastWeek(9), text: "never use npm in this repo", isSidechain: true }),
    claudeEntry({ cwd: project, session: "s1", ts: lastWeek(9), text: "This session is being continued from a previous conversation. Always use pnpm.", isCompactSummary: true }),
    claudeEntry({ cwd: project, session: "s1", ts: lastWeek(9), text: "<command-name>/review</command-name>\n<command-args>never use npm</command-args>" }),
    claudeEntry({ cwd: project, session: "s1", ts: lastWeek(9), text: "WAKE: always use pnpm", isMeta: true, promptSource: "system" }),
    // Each of these is caught by one filter only (mutation checks rely on it).
    claudeEntry({ cwd: project, session: "s1", ts: lastWeek(9), text: "system: never use npm", promptSource: "system" }),
    claudeEntry({ cwd: project, session: "s1", ts: lastWeek(9), text: "scheduled: never use npm", origin: { kind: "scheduled-task" } }),
    claudeEntry({ cwd: project, session: "s1", ts: lastWeek(9), text: "tool output: never use npm", toolUseResult: { stdout: "" } }),
    claudeEntry({ cwd: project, session: "s1", ts: lastWeek(9), content: [{ type: "tool_result", tool_use_id: "t2", content: "x" }, { type: "text", text: "older tool result: never use npm" }] }),
    claudeEntry({ cwd: project, session: "s1", ts: lastWeek(9), text: "Summary: the user said never use npm", isCompactSummary: true }),
    claudeEntry({ cwd: project, session: "s1", ts: lastWeek(9), text: "meta: never use npm", isMeta: true }),
    claudeEntry({ cwd: project, session: "s1", ts: lastWeek(9), text: "sidechain: never use npm", isSidechain: true }),
    typed10,
    claudeEntry({ cwd: project, session: "s1", ts: lastWeek(11), content: [{ type: "text", text: "we use tabs, not spaces" }, { type: "text", text: "<system-reminder>never use npm</system-reminder>" }] }),
  ];
  writeClaudeSession(claudeDir, { cwd: project, session: "s1", entries: s1 });
  // A subagent transcript and an old-style sidechain file: never read.
  fs.mkdirSync(path.join(claudeDir, "projects", claudeProjectSlug(project), "s1", "subagents"), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "projects", claudeProjectSlug(project), "s1", "subagents", "agent-a1.jsonl"), JSON.stringify(claudeEntry({ cwd: project, session: "s1", ts: lastWeek(9), text: "use pnpm, not npm" })) + "\n");
  writeClaudeSession(claudeDir, { cwd: project, session: "s1", file: "agent-b2.jsonl", entries: [claudeEntry({ cwd: project, session: "s1", ts: lastWeek(9), text: "use pnpm, not npm" })] });
  // Session s2 resumes s1: its first entries are copies (same uuids).
  writeClaudeSession(claudeDir, { cwd: project, session: "s2", entries: [typed1, typed10, claudeEntry({ cwd: project, session: "s2", ts: thisWeek(9), text: "use pnpm, not npm. how many times" })] });
  // A session started in a subfolder of the project.
  const web = path.join(project, "packages", "web");
  writeClaudeSession(claudeDir, { cwd: web, session: "s3", entries: [claudeEntry({ cwd: web, session: "s3", ts: thisWeek(10), text: "stop adding comments to every function!" })] });
  // The sibling project shares the slug prefix; its entries name its own cwd.
  writeClaudeSession(claudeDir, { cwd: other, session: "s4", entries: [claudeEntry({ cwd: other, session: "s4", ts: thisWeek(11), text: "never push to main" })] });

  // Codex.
  const r1 = [
    codexInjected(lastWeek(12), project),
    codexLine(lastWeek(12), "response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "never use npm" }] }),
    codexTyped(lastWeek(12), "stop using npm, we use pnpm", "msg_r1a"),
    codexLine(lastWeek(12), "event_msg", { type: "user_message", message: "stop using npm, we use pnpm" }),
    codexTyped(lastWeek(13), "fix the failing test", "msg_r1b"),
  ];
  writeCodexRollout(codexHome, { cwd: project, id: "c1", ts: lastWeek(12), lines: r1 });
  writeCodexRollout(codexHome, { cwd: project, id: "c2", ts: thisWeek(12), source: { subagent: { other: "review" } }, lines: [codexTyped(thisWeek(12), "use pnpm, not npm", "msg_c2")] });
  writeCodexRollout(codexHome, { cwd: project, id: "c2b", ts: thisWeek(12), threadSource: "subagent", lines: [codexTyped(thisWeek(12), "use pnpm, not npm", "msg_c2b")] });
  // A fork of c1: copies its items (same ids), then one new prompt.
  writeCodexRollout(codexHome, { cwd: project, id: "c3", ts: thisWeek(13), lines: [...r1, codexTyped(thisWeek(13), "don't add comments to every function", "msg_c3")] });
  writeCodexRollout(codexHome, { cwd: other, id: "c4", ts: thisWeek(14), lines: [codexTyped(thisWeek(14), "never push to main", "msg_c4")] });
  // Legacy history mode: the prompt is only an event_msg.
  writeCodexRollout(codexHome, { cwd: project, id: "c5", ts: thisWeek(15), archived: true, lines: [codexLine(thisWeek(15), "event_msg", { type: "user_message", message: "always run lint before committing" })] });
  // A plan hand-off a client generated.
  writeCodexRollout(codexHome, { cwd: project, id: "c6", ts: thisWeek(16), lines: [codexTyped(thisWeek(16), "A previous agent produced the plan below to accomplish the user's task. Implement the plan in a fresh context. Treat the plan as the source of user intent, re-read files as needed, and carry the work through implementation and verification.\n\nAlways use pnpm.", "msg_c6")] });

  return {
    home,
    claudeDir,
    codexHome,
    project,
    other,
    now,
    expected: {
      prompts: { claude: 6, codex: 4 },
      corrections: 8,
      clusters: [
        { count: 3, hosts: { claude: 2, codex: 1 }, sentence: "use pnpm, not npm" },
        { count: 3, hosts: { claude: 2, codex: 1 }, sentence: "stop adding comments to every function" },
      ],
      singles: 2,
      weekly: { "2026-10-26": 4, "2026-11-02": 4 },
      allProjects: { prompts: 12, corrections: 10, repeats: 3 },
    },
  };
}

/** Write a Codex rollout under <codexHome>/sessions/YYYY/MM/DD/. */
export function writeCodexRollout(codexHome, { cwd, id, ts, lines, source = "cli", threadSource, archived = false }) {
  const d = new Date(ts);
  const dir = archived
    ? path.join(codexHome, "archived_sessions")
    : path.join(codexHome, "sessions", String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0"));
  fs.mkdirSync(dir, { recursive: true });
  const meta = codexLine(ts, "session_meta", { session_id: id, id, timestamp: ts, cwd, originator: "codex_cli_rs", cli_version: "0.164.0", source, thread_source: threadSource, base_instructions: { text: "x".repeat(2000) } });
  const p = path.join(dir, `rollout-${ts.slice(0, 19).replace(/:/g, "-")}-${id}.jsonl`);
  fs.writeFileSync(p, [meta, ...lines].map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

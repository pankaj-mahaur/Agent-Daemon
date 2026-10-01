// Tests for the Codex rollout adapter (adapters/codex.mjs) and detection.
//
// Two real-world shapes: older rollouts carry event_msg user_message; codex
// 0.159 app-server rollouts carry the prompt only as an item_completed
// UserMessage (plus a role=user response item next to injected AGENTS.md
// context). Either way a prompt must be counted once, and injected context
// never counted as the user speaking.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isInjectedContext, summarize, summarizeRollout } from "../src/adapters/codex.mjs";
import { detect, summarize as summarizeAny } from "../src/adapters/index.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/codex-rollout.jsonl", import.meta.url));

test("rollout fixture: turns, tools, edits and reads are counted", async () => {
  const s = await summarize(FIXTURE);
  assert.equal(s.sessionId, "01a0f3aa-1111-7222-8333-944455556666");
  assert.equal(s.userTurns, 2, "user_message events only — not the AGENTS.md / role=user copies");
  assert.equal(s.assistantTurns, 2);
  assert.equal(s.toolCalls, 3);
  assert.equal(s.edits, 2, "one apply_patch touching two files");
  assert.equal(s.reads, 1, "rg counts as a read; npm test does not");
  assert.equal(s.cwd, "/work/demo");
  assert.match(s.lastUserText, /formatUtc helper/);
  assert.equal(s.durationMs, 21_000, "world_state lines are not events");
  const tool = s.events.find((e) => e.type === "tool_result");
  assert.equal(tool.text, "src/date.js:3:export function formatDate", "function_call_output JSON is unwrapped");
});

const line = (type, payload, s = 0) => JSON.stringify({ timestamp: `2026-10-01T00:00:0${s}.000Z`, type, payload });

test("0.159-style rollout: prompt from the UserMessage item, counted once", () => {
  const raw = [
    line("session_meta", { session_id: "s-159", cwd: "/w" }),
    line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>x</INSTRUCTIONS>" }] }),
    line("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "<skills_instructions>" }] }),
    line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "hello there" }] }, 1),
    line("event_msg", { type: "item_completed", item: { type: "UserMessage", id: "u1", content: [{ type: "text", text: "hello there" }] } }, 1),
    line("event_msg", { type: "item_completed", item: { type: "AgentMessage", id: "a1", content: [{ type: "text", text: "hi!" }] } }, 2),
  ].join("\n");
  const s = summarizeRollout(raw);
  assert.equal(s.userTurns, 1);
  assert.equal(s.lastUserText, "hello there");
  assert.equal(s.assistantTurns, 1, "AgentMessage items used when there is no assistant response item");
  assert.deepEqual(s.events.map((e) => e.type), ["system", "user", "assistant"], "events keep file order");
});

test("oldest style: only role=user response items — injected context filtered out", () => {
  const raw = [
    line("session_meta", { id: "s-old" }),
    line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n<cwd>/w</cwd>" }] }),
    line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "add a test" }] }),
    line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }),
  ].join("\n");
  const s = summarizeRollout(raw);
  assert.equal(s.userTurns, 1);
  assert.equal(s.lastUserText, "add a test");
});

test("garbage and unknown lines are ignored, not fatal", () => {
  const s = summarizeRollout(["not json", line("world_state", { full: true }), line("brand_new_type", { x: 1 }), ""].join("\n"), { transcriptPath: "/x/rollout-2026-10-01T00-00-00-01a0f3b3-c597-7601-8ee2-d59fb222c83f.jsonl" });
  assert.equal(s.userTurns, 0);
  assert.equal(s.sessionId, "01a0f3b3-c597-7601-8ee2-d59fb222c83f", "falls back to the uuid in the file name");
});

test("isInjectedContext", () => {
  for (const t of ["# AGENTS.md instructions for /w", "<environment_context>", "<user_instructions>x", "<!-- agent-daemon:start -->"]) assert.ok(isInjectedContext(t), t);
  for (const t of ["fix the bug", "<div> is broken in header.tsx", "# heading in my message"]) assert.ok(!isInjectedContext(t), t);
});

test("detection: harness sessions dir, rollout file name, and first-line sniff", async () => {
  const root = mkdtempSync(join(tmpdir(), "ad-detect-"));
  try {
    const harness = join(root, "codex-home", "sessions", "2026", "10", "01");
    mkdirSync(harness, { recursive: true });
    const a = join(harness, "whatever.jsonl");
    writeFileSync(a, "{}\n");
    assert.equal(await detect(a), "codex");
    const b = join(root, "rollout-2026-10-01T00-00-00-abc.jsonl");
    writeFileSync(b, "{}\n");
    assert.equal(await detect(b), "codex");
    const c = join(root, "copied.jsonl");
    writeFileSync(c, line("session_meta", { id: "x" }) + "\n");
    assert.equal(await detect(c), "codex");
    const d = join(root, "claude.jsonl");
    writeFileSync(d, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
    assert.equal(await detect(d), "claude-code", "Claude transcripts are not mistaken for rollouts");
    const { adapter, summary } = await summarizeAny(FIXTURE, { adapter: undefined });
    assert.equal(adapter, "codex");
    assert.equal(summary.userTurns, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("watcher config always includes the harness session folder unless opted out", async () => {
  const { withHarnessSessions } = await import("../src/daemon/config.mjs");
  const base = { watch: [{ path: "/x/.claude/projects", pattern: "**/*.jsonl" }] };
  const withIt = withHarnessSessions(base);
  assert.ok(withIt.watch.some((w) => /codex-home[\\/]sessions$/.test(w.path) && w.adapter === "codex"));
  assert.equal(withHarnessSessions(withIt).watch.length, withIt.watch.length, "not added twice");
  assert.equal(withHarnessSessions({ ...base, harnessSessions: false }).watch.length, 1);
});

test("a subagent rollout (parent history embedded) is skipped, not double counted", () => {
  const raw = [
    line("session_meta", { id: "child", source: { subagent: { thread_spawn: {} } } }),
    line("session_meta", { id: "parent", source: "vscode" }),
    line("event_msg", { type: "user_message", message: "parent prompt" }),
  ].join("\n");
  const s = summarizeRollout(raw);
  assert.equal(s.subagent, true);
  assert.equal(s.userTurns, 0);
  assert.equal(s.sessionId, "child");
});

test("huge tool output is clipped in events", () => {
  const big = "x".repeat(50_000);
  const s = summarizeRollout([line("session_meta", { id: "s" }), line("response_item", { type: "function_call_output", call_id: "c", output: big })].join("\n"));
  assert.ok(s.events.find((e) => e.type === "tool_result").text.length < 9_000);
});

test("digest file tags include apply_patch paths from Codex sessions", async () => {
  const { touchedFiles } = await import("../src/digest/digest.mjs");
  const s = await summarize(FIXTURE);
  assert.deepEqual(touchedFiles(s, "/work/demo").sort(), ["src/date.js", "test/date.test.js"]);
});

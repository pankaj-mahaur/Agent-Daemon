// Tests for the two managed surfaces that `ad init` writes/refreshes between
// <!-- agent-daemon:start --> / <!-- agent-daemon:end --> markers:
//   - renderManagedClaudeBlock() — the SHORT synopsis injected into CLAUDE.md
//     (loaded every session, so it must stay lean and point at the manual)
//   - renderAdInstructions()     — the FULL operating manual written to
//     AD-INSTRUCTIONS.md (read on demand, so it carries the decision tree /
//     workflow / session-close protocol / multi-agent guide)
//
// The full manual used to live inside the CLAUDE.md block; it was moved out to
// AD-INSTRUCTIONS.md to keep per-session context small. These tests pin both
// the slimming of the block AND the completeness of the manual.

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderManagedClaudeBlock, renderAdInstructions } from "../src/managed-claude-block.mjs";

const START = "<!-- agent-daemon:start -->";
const END = "<!-- agent-daemon:end -->";

// ---------------------------------------------------------------------------
// Slim CLAUDE.md synopsis block
// ---------------------------------------------------------------------------

test("renderManagedClaudeBlock: frames output with both markers", () => {
  const out = renderManagedClaudeBlock(START, END);
  assert.ok(out.startsWith(START), "starts with start marker");
  assert.ok(out.endsWith(END), "ends with end marker");
});

test("renderManagedClaudeBlock: self-describes as managed (refresh hint)", () => {
  const out = renderManagedClaudeBlock(START, END);
  assert.match(out, /managed by `ad init`/i);
});

test("renderManagedClaudeBlock: points at the on-demand manual", () => {
  const out = renderManagedClaudeBlock(START, END);
  assert.match(out, /AD-INSTRUCTIONS\.md/, "names the manual file");
  assert.match(out, /read .*AD-INSTRUCTIONS\.md.* before any substantial/is,
    "instructs reading the manual before substantial work");
});

test("renderManagedClaudeBlock: keeps the always-on proportionality rule", () => {
  const out = renderManagedClaudeBlock(START, END);
  assert.match(out, /Proportionality rule/i);
  assert.match(out, /hey/, "trivial requests skip skill search");
});

test("renderManagedClaudeBlock: is slim — full manual content moved out", () => {
  const out = renderManagedClaudeBlock(START, END);
  // The heavy detail now lives in AD-INSTRUCTIONS.md, not the always-on block.
  assert.doesNotMatch(out, /\| User says \(English \/ Hinglish\) \| Invoke skill \|/,
    "no full skill decision table in the slim block");
  assert.doesNotMatch(out, /SessionStart hook  →/, "no workflow diagram in the slim block");
  assert.doesNotMatch(out, /Task-complexity gate \(size the request/,
    "no full task-complexity gate in the slim block");
  // Keep it genuinely small.
  assert.ok(out.split("\n").length < 30, "slim block stays under 30 lines");
});

test("renderManagedClaudeBlock: idempotent — same input produces same output", () => {
  const a = renderManagedClaudeBlock(START, END);
  const b = renderManagedClaudeBlock(START, END);
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// Full AD-INSTRUCTIONS.md operating manual
// ---------------------------------------------------------------------------

test("renderAdInstructions: frames output with both markers", () => {
  const out = renderAdInstructions(START, END);
  assert.ok(out.startsWith(START), "starts with start marker");
  assert.ok(out.endsWith(END), "ends with end marker");
});

test("renderAdInstructions: self-describes as managed (refresh hint)", () => {
  const out = renderAdInstructions(START, END);
  assert.match(out, /managed by `ad init`/i);
});

test("renderAdInstructions: includes the task-complexity gate", () => {
  const out = renderAdInstructions(START, END);
  assert.match(out, /Task-complexity gate/i);
  assert.match(out, /Simple \/ direct/);
  assert.match(out, /High-risk \/ parallel/);
});

test("renderAdInstructions: includes the skill decision table", () => {
  const out = renderAdInstructions(START, END);
  assert.match(out, /Skill decision tree/i);
  assert.match(out, /debug-triage/, "bug → debug-triage");
  assert.match(out, /skill-author/, "create-a-skill → skill-author");
  assert.match(out, /session-close/, "bye → session-close");
});

test("renderAdInstructions: covers Hinglish trigger phrases", () => {
  const out = renderAdInstructions(START, END);
  assert.match(out, /toot gaya/, "Hinglish bug phrase");
  assert.match(out, /banao/, "Hinglish build phrase");
  assert.match(out, /session khatam/, "Hinglish session-end phrase");
  assert.match(out, /har baar yaad rakhna/, "Hinglish skill-author phrase");
});

test("renderAdInstructions: includes daemon workflow diagram", () => {
  const out = renderAdInstructions(START, END);
  assert.match(out, /SessionStart hook/);
  assert.match(out, /UserPromptSubmit/);
  assert.match(out, /PostToolUse/);
  assert.match(out, /SessionEnd hook/);
  assert.match(out, /agent-daemon-digest/);
});

test("renderAdInstructions: includes mid-session memory discipline", () => {
  const out = renderAdInstructions(START, END);
  assert.match(out, /Mid-session memory discipline/i);
  assert.match(out, /activeContext\.md/);
});

test("renderAdInstructions: preserves the session-close 3-step protocol", () => {
  const out = renderAdInstructions(START, END);
  assert.match(out, /Update the session log/);
  assert.match(out, /Emit the agent-daemon digest block/);
  assert.match(out, /Create handoff docs/);
  assert.match(out, /\.agent-daemon\/handoffs\/handoff-/);
  assert.match(out, /~\/\.agent-daemon\/handoffs\/<project-slug>/);
});

test("renderAdInstructions: folds in the multi-agent orchestration guide", () => {
  const out = renderAdInstructions(START, END);
  assert.match(out, /Multi-agent orchestration/i);
  // Commands + templates that previously lived in the static template file
  assert.match(out, /ad team list-templates/);
  assert.match(out, /full-stack-feature/);
  assert.match(out, /Always ask before spawning/);
});

test("renderAdInstructions: describes deterministic continuous capture accurately", () => {
  const out = renderAdInstructions(START, END);
  assert.match(out, /without an API key/i);
  assert.doesNotMatch(out, /NOTHING lands in SQLite/);
});

test("renderAdInstructions: idempotent — same input produces same output", () => {
  const a = renderAdInstructions(START, END);
  const b = renderAdInstructions(START, END);
  assert.equal(a, b);
});

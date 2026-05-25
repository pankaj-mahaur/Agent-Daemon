// Tests for the managed CLAUDE.md block that `ad init` writes/refreshes
// between <!-- agent-daemon:start --> / <!-- agent-daemon:end --> markers.
//
// Background: prior to Tier 1 (2026-05-22), the block was added on first
// `ad init` and never refreshed — existing projects never picked up content
// updates (skill decision tree, daemon workflow diagram). This suite pins:
//   1. renderManagedClaudeBlock() returns a string framed by both markers
//   2. The block contains the skill decision table + daemon workflow diagram
//      + mid-session discipline rule (the Tier 1 additions)
//   3. The block is self-describing — mentions it's managed by `ad init`
//      so users know re-running upgrades it

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderManagedClaudeBlock } from "../src/managed-claude-block.mjs";

const START = "<!-- agent-daemon:start -->";
const END = "<!-- agent-daemon:end -->";

test("renderManagedClaudeBlock: frames output with both markers", () => {
  const out = renderManagedClaudeBlock(START, END);
  assert.ok(out.startsWith(START), "starts with start marker");
  assert.ok(out.endsWith(END), "ends with end marker");
});

test("renderManagedClaudeBlock: includes skill decision table", () => {
  const out = renderManagedClaudeBlock(START, END);
  assert.match(out, /Skill decision tree/i);
  // Spot-check three rows the user explicitly asked for
  assert.match(out, /debug-triage/, "bug → debug-triage");
  assert.match(out, /skill-author/, "create-a-skill → skill-author");
  assert.match(out, /session-close/, "bye → session-close");
});

test("renderManagedClaudeBlock: covers Hinglish trigger phrases", () => {
  const out = renderManagedClaudeBlock(START, END);
  // Hinglish phrases that the daemon workflow specifically targets
  assert.match(out, /toot gaya/, "Hinglish bug phrase");
  assert.match(out, /banao/, "Hinglish build phrase");
  assert.match(out, /session khatam/, "Hinglish session-end phrase");
  assert.match(out, /har baar yaad rakhna/, "Hinglish skill-author phrase");
});

test("renderManagedClaudeBlock: includes daemon workflow diagram", () => {
  const out = renderManagedClaudeBlock(START, END);
  assert.match(out, /SessionStart hook/);
  assert.match(out, /UserPromptSubmit/);
  assert.match(out, /PostToolUse/);
  assert.match(out, /SessionEnd hook/);
  assert.match(out, /agent-daemon-digest/);
});

test("renderManagedClaudeBlock: includes mid-session memory discipline", () => {
  const out = renderManagedClaudeBlock(START, END);
  assert.match(out, /Mid-session memory discipline/i);
  assert.match(out, /activeContext\.md/);
});

test("renderManagedClaudeBlock: self-describes as managed (refresh hint)", () => {
  const out = renderManagedClaudeBlock(START, END);
  // Users must know re-running `ad init` upgrades this block
  assert.match(out, /managed by `ad init`/i);
});

test("renderManagedClaudeBlock: preserves the legacy session-close 3-step protocol", () => {
  const out = renderManagedClaudeBlock(START, END);
  assert.match(out, /Update the session log/);
  assert.match(out, /Emit the agent-daemon digest block/);
  assert.match(out, /Create handoff docs/);
  // Both handoff locations still documented
  assert.match(out, /\.agent-daemon\/handoffs\/handoff-/);
  assert.match(out, /~\/\.agent-daemon\/handoffs\/<project-slug>/);
});

test("renderManagedClaudeBlock: describes deterministic continuous capture accurately", () => {
  const out = renderManagedClaudeBlock(START, END);
  assert.match(out, /continuous extraction still runs/i);
  assert.match(out, /without an API key/i);
  assert.doesNotMatch(out, /NOTHING lands in SQLite/);
});

test("renderManagedClaudeBlock: idempotent — same input produces same output", () => {
  const a = renderManagedClaudeBlock(START, END);
  const b = renderManagedClaudeBlock(START, END);
  assert.equal(a, b);
});

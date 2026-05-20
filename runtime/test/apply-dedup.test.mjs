// Tests for runtime/src/digest/apply.mjs — cross-session dedup when appending
// learnings to activeContext.md.
//
// Real-world dogfood data showed entries like
//   - **decision** (conf 0.65): it "knew" enough from training...
//   - **pattern** (conf 0.55): invokes the answer-LLM
// appearing 2× in activeContext.md across sessions. SQLite has content-hash
// uniqueness in the episodic store, but appendToMemory just appended blindly.
// These tests pin the new dedup behavior.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { applyLearnings } from "../src/digest/apply.mjs";

async function makeTmp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ad-apply-dedup-"));
  await fs.mkdir(path.join(dir, ".agent-daemon", "memory"), { recursive: true });
  await fs.writeFile(path.join(dir, ".agent-daemon", "memory", "activeContext.md"), "# Active context\n\n", "utf8");
  return dir;
}

function makeClassified(type, text, opts = {}) {
  return {
    targets: ["memory:project"],
    routeReason: "test",
    learning: {
      type,
      text,
      evidence_quote: opts.evidence || "test evidence",
      evidence_speaker: opts.speaker || "agent",
      scope: "project",
      confidence: opts.confidence ?? 0.7,
      tags: opts.tags || []
    }
  };
}

test("first apply writes all learnings", async () => {
  const cwd = await makeTmp();
  const memPath = path.join(cwd, ".agent-daemon", "memory", "activeContext.md");
  const r = await applyLearnings({
    classified: [
      makeClassified("pattern", "always use pnpm in this repo"),
      makeClassified("decision", "decided to go with SSE not polling")
    ],
    sessionId: "sess-1",
    sessionSummary: "first run",
    cwd
  });
  assert.equal(r.memoryProjectAppended, 2);
  const content = await fs.readFile(memPath, "utf8");
  assert.match(content, /\*\*pattern\*\*.*always use pnpm/);
  assert.match(content, /\*\*decision\*\*.*decided to go with SSE/);
});

test("second apply of identical learnings skips them", async () => {
  const cwd = await makeTmp();
  const memPath = path.join(cwd, ".agent-daemon", "memory", "activeContext.md");
  const same = [
    makeClassified("pattern", "always use pnpm in this repo"),
    makeClassified("decision", "decided to go with SSE not polling")
  ];
  await applyLearnings({ classified: same, sessionId: "sess-1", sessionSummary: "run-1", cwd });
  await applyLearnings({ classified: same, sessionId: "sess-2", sessionSummary: "run-2", cwd });
  const content = await fs.readFile(memPath, "utf8");
  // Each text-prefix should appear once, not twice
  const pnpmHits = (content.match(/always use pnpm/g) || []).length;
  const sseHits = (content.match(/decided to go with SSE/g) || []).length;
  assert.equal(pnpmHits, 1, "pnpm pattern should not duplicate");
  assert.equal(sseHits, 1, "SSE decision should not duplicate");
});

test("dedup ignores trailing punctuation drift", async () => {
  const cwd = await makeTmp();
  const memPath = path.join(cwd, ".agent-daemon", "memory", "activeContext.md");
  await applyLearnings({
    classified: [makeClassified("pattern", "always use pnpm in this repo")],
    sessionId: "sess-1", sessionSummary: "r1", cwd
  });
  // Same text but with trailing period
  await applyLearnings({
    classified: [makeClassified("pattern", "always use pnpm in this repo.")],
    sessionId: "sess-2", sessionSummary: "r2", cwd
  });
  const content = await fs.readFile(memPath, "utf8");
  const hits = (content.match(/always use pnpm/g) || []).length;
  assert.equal(hits, 1, "trailing punctuation should not bypass dedup");
});

test("dedup is case-insensitive on the text body", async () => {
  const cwd = await makeTmp();
  const memPath = path.join(cwd, ".agent-daemon", "memory", "activeContext.md");
  await applyLearnings({
    classified: [makeClassified("pattern", "Always use pnpm in this repo")],
    sessionId: "sess-1", sessionSummary: "r1", cwd
  });
  await applyLearnings({
    classified: [makeClassified("pattern", "always use PNPM in this repo")],
    sessionId: "sess-2", sessionSummary: "r2", cwd
  });
  const content = await fs.readFile(memPath, "utf8");
  // First letter case matters in markdown rendering but the dedup key normalises
  const allHits = (content.match(/use pnpm/gi) || []).length;
  assert.equal(allHits, 1, "case-insensitive dedup should kick in");
});

test("different types with same text both get written (type is part of key)", async () => {
  const cwd = await makeTmp();
  const memPath = path.join(cwd, ".agent-daemon", "memory", "activeContext.md");
  await applyLearnings({
    classified: [
      makeClassified("pattern",  "ssr requires a real DB connection"),
      makeClassified("gotcha",   "ssr requires a real DB connection")
    ],
    sessionId: "sess-1", sessionSummary: "r1", cwd
  });
  const content = await fs.readFile(memPath, "utf8");
  assert.match(content, /\*\*pattern\*\*.*ssr requires/);
  assert.match(content, /\*\*gotcha\*\*.*ssr requires/);
});

test("within-batch dedup also fires (same item twice in classified[])", async () => {
  const cwd = await makeTmp();
  const memPath = path.join(cwd, ".agent-daemon", "memory", "activeContext.md");
  const dupe = makeClassified("pattern", "use bracket-notation, not dot");
  await applyLearnings({
    classified: [dupe, dupe, dupe],
    sessionId: "sess-1", sessionSummary: "r1", cwd
  });
  const content = await fs.readFile(memPath, "utf8");
  const hits = (content.match(/use bracket-notation/g) || []).length;
  assert.equal(hits, 1, "within-batch duplicates should collapse to 1");
});

test("partial overlap: only the new entries get appended", async () => {
  const cwd = await makeTmp();
  const memPath = path.join(cwd, ".agent-daemon", "memory", "activeContext.md");
  await applyLearnings({
    classified: [makeClassified("pattern", "X is the cause")],
    sessionId: "sess-1", sessionSummary: "r1", cwd
  });
  const r2 = await applyLearnings({
    classified: [
      makeClassified("pattern", "X is the cause"),     // already there
      makeClassified("pattern", "Y is the new finding"), // new
    ],
    sessionId: "sess-2", sessionSummary: "r2", cwd
  });
  // Both lines reported as "appended" by the counter (we count input items
  // routed to project memory, not survivors of dedup). What matters: only the
  // new one ends up on disk.
  assert.ok(r2.memoryProjectAppended >= 1);
  const content = await fs.readFile(memPath, "utf8");
  const xHits = (content.match(/X is the cause/g) || []).length;
  const yHits = (content.match(/Y is the new finding/g) || []).length;
  assert.equal(xHits, 1);
  assert.equal(yHits, 1);
});

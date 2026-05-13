// Tests for runtime/src/hooks/journal-drain.mjs — the SessionStart consumer
// that pulls journal entries into memory + episodic SQLite.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { appendLearnings, readJournal } from "../src/hooks/journal.mjs";
import { drainJournal } from "../src/hooks/journal-drain.mjs";

async function makeTmp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ad-drain-"));
  // Scaffold a minimal .agent-daemon/memory/ so apply.mjs has a target
  await fs.mkdir(path.join(dir, ".agent-daemon", "memory"), { recursive: true });
  await fs.writeFile(path.join(dir, ".agent-daemon", "memory", "activeContext.md"), "# Active context\n\n", "utf8");
  return dir;
}

test("drain on empty journal is a no-op", async () => {
  const cwd = await makeTmp();
  const res = await drainJournal({ cwd });
  assert.equal(res.ok, true);
  assert.equal(res.drained, 0);
  assert.equal(res.applied, null);
});

test("drain routes a project-scoped pattern into activeContext.md", async () => {
  const cwd = await makeTmp();
  await appendLearnings({
    cwd,
    entries: [{
      type: "pattern",
      text: "we always rebase before pushing",
      evidence_quote: "user said so",
      evidence_speaker: "user",
      scope: "project",
      confidence: 0.75,
      tags: ["git", "rebase"]
    }]
  });

  const res = await drainJournal({ cwd, verbose: false });
  assert.equal(res.ok, true);
  assert.equal(res.drained, 1);

  // Journal should be archived (empty now)
  const j = await readJournal({ cwd });
  assert.equal(j.entries.length, 0);

  // activeContext.md should mention the learning
  const active = await fs.readFile(path.join(cwd, ".agent-daemon", "memory", "activeContext.md"), "utf8");
  assert.match(active, /rebase before pushing/i);
});

test("drain dedupes by text-prefix + type within the journal", async () => {
  const cwd = await makeTmp();
  await appendLearnings({
    cwd,
    entries: [
      { type: "pattern", text: "we use npm not pnpm", evidence_quote: "x", evidence_speaker: "user", scope: "project", confidence: 0.7 },
      { type: "pattern", text: "we use npm not pnpm", evidence_quote: "y", evidence_speaker: "user", scope: "project", confidence: 0.7 },
      { type: "pattern", text: "we use npm not pnpm", evidence_quote: "z", evidence_speaker: "user", scope: "project", confidence: 0.7 }
    ]
  });
  const res = await drainJournal({ cwd, verbose: false });
  assert.equal(res.drained, 1, "expected dedupe to leave a single unique learning");
});

test("drain on dryRun does not archive the journal", async () => {
  const cwd = await makeTmp();
  await appendLearnings({
    cwd,
    entries: [{ type: "pattern", text: "stays in journal", evidence_quote: "q", evidence_speaker: "user", scope: "project", confidence: 0.7 }]
  });
  await drainJournal({ cwd, dryRun: true });
  const j = await readJournal({ cwd });
  assert.equal(j.entries.length, 1, "journal should be untouched in dry-run");
});

test("drain is fail-safe without cwd", async () => {
  const res = await drainJournal({});
  assert.equal(res.ok, false);
  assert.match(res.error, /cwd/i);
});

test("drain appends to sessions.jsonl audit ledger", async () => {
  const cwd = await makeTmp();
  await appendLearnings({
    cwd,
    entries: [{ type: "pattern", text: "leaves an audit trail", evidence_quote: "q", evidence_speaker: "user", scope: "project", confidence: 0.7 }]
  });
  await drainJournal({ cwd });
  const audit = await fs.readFile(path.join(cwd, ".agent-daemon", "sessions.jsonl"), "utf8");
  const lines = audit.trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.adapter, "journal-drain");
  assert.equal(entry.extract_source, "user-prompt-hook");
  assert.equal(entry.learnings_extracted, 1);
});

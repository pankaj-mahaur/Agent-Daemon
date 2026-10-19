// Tests for runtime/src/hooks/journal.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { appendLearnings, readJournal, archiveJournal, journalPath, archivePath } from "../src/hooks/journal.mjs";

async function makeTmp() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ad-journal-"));
}

test("appendLearnings + readJournal round-trip", async () => {
  const cwd = await makeTmp();
  const res = await appendLearnings({
    cwd,
    entries: [
      { type: "pattern", text: "we use npm", confidence: 0.7 },
      { type: "correction", text: "actually rebase not merge", confidence: 0.75 }
    ]
  });
  assert.equal(res.ok, true);
  assert.equal(res.written, 2);

  const read = await readJournal({ cwd });
  assert.equal(read.ok, true);
  assert.equal(read.entries.length, 2);
  assert.equal(read.entries[0].type, "pattern");
  assert.equal(read.entries[1].type, "correction");
  // Each entry has a ts stamp
  for (const e of read.entries) {
    assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T/);
  }
});

test("readJournal returns empty when file does not exist", async () => {
  const cwd = await makeTmp();
  const read = await readJournal({ cwd });
  assert.equal(read.ok, true);
  assert.deepEqual(read.entries, []);
});

test("archiveJournal moves contents and clears the journal", async () => {
  const cwd = await makeTmp();
  await appendLearnings({ cwd, entries: [{ type: "pattern", text: "one" }] });
  const before = await readJournal({ cwd });
  assert.equal(before.entries.length, 1);

  const arch = await archiveJournal({ cwd });
  assert.equal(arch.ok, true);
  assert.ok(arch.archivedBytes > 0);

  // Journal is gone
  const after = await readJournal({ cwd });
  assert.equal(after.entries.length, 0);

  // Archive file exists
  const archStat = await fs.stat(archivePath(cwd));
  assert.ok(archStat.size > 0);
});

test("archiveJournal is a no-op when journal is missing or empty", async () => {
  const cwd = await makeTmp();
  const a1 = await archiveJournal({ cwd });
  assert.equal(a1.ok, true);
  assert.equal(a1.archivedBytes, 0);
});

test("appendLearnings is fail-safe without cwd", async () => {
  const res = await appendLearnings({ entries: [{ type: "pattern", text: "x" }] });
  assert.equal(res.ok, false);
  assert.match(res.error, /cwd/i);
});

test("appendLearnings with empty entries is a no-op", async () => {
  const cwd = await makeTmp();
  const res = await appendLearnings({ cwd, entries: [] });
  assert.equal(res.ok, true);
  assert.equal(res.written, 0);
});

test("journalPath / archivePath: the project's own .agent-daemon when it exists, else a folder outside the repo", async () => {
  const cwd = await makeTmp();
  // No .agent-daemon: the files live under ad's root, never inside the folder (P5.2).
  assert.ok(!journalPath(cwd).startsWith(cwd + path.sep), journalPath(cwd));
  assert.equal(path.basename(journalPath(cwd)), "learning-journal.jsonl");
  assert.equal(path.dirname(archivePath(cwd)), path.dirname(journalPath(cwd)));
  await fs.mkdir(path.join(cwd, ".agent-daemon"));
  assert.equal(journalPath(cwd), path.join(cwd, ".agent-daemon", "learning-journal.jsonl"));
  assert.equal(archivePath(cwd), path.join(cwd, ".agent-daemon", "learning-journal.archive.jsonl"));
});

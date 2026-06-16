// Tests for the progressive-disclosure + file-aware episodic helpers:
//   getLearningsByIds      — the "detail" layer (full rows by id)
//   learningTimeline       — the "context" layer (session + siblings)
//   searchLearningsByFile  — file-aware recall (tags LIKE path/basename)
//   touchedFiles           — pure transcript→files extraction (digest.mjs)
//
// GOTCHA (project memory): never assert between a raw sqlite open() and its
// close() — a throwing assert leaves the tmp DB self-locked and fs.rm retry
// backoff burns ~12 min. These tests gather results, close the singleton, THEN
// assert.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { touchedFiles } from "../src/digest/digest.mjs";

async function withEpisodic(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ad-progressive-"));
  const prevHome = process.env.HOME;
  const prevUP = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  const mod = await import(`../src/memory/episodic.mjs?cachebust=${Date.now()}-${Math.random()}`);
  try {
    return await fn(mod);
  } finally {
    try { mod.closeDb(); } catch { /* ignore */ }
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUP;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/* ------------------------- getLearningsByIds ------------------------- */

test("getLearningsByIds returns full rows for the given ids", async () => {
  const { rows, id1, id2 } = await withEpisodic(async (mod) => {
    const id1 = await mod.insertLearning({ category: "pattern", text: "alpha learning", evidence: "ev-a", confidence: 0.8, tags: ["x"] });
    const id2 = await mod.insertLearning({ category: "gotcha", text: "beta learning", confidence: 0.6 });
    await mod.insertLearning({ category: "fact", text: "gamma learning" });
    const rows = await mod.getLearningsByIds([id1, id2]);
    return { rows, id1, id2 };
  });
  assert.equal(rows.length, 2);
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(byId[id1].text, "alpha learning");
  assert.equal(byId[id1].evidence, "ev-a");
  assert.equal(byId[id2].category, "gotcha");
  // detail layer surfaces provenance + evolution counters
  assert.ok("created_at" in byId[id1]);
  assert.ok("observed_count" in byId[id1]);
});

test("getLearningsByIds ignores non-integer ids and handles empties", async () => {
  const { empty, mixed, id1 } = await withEpisodic(async (mod) => {
    const id1 = await mod.insertLearning({ category: "pattern", text: "only one" });
    const empty = await mod.getLearningsByIds([]);
    const mixed = await mod.getLearningsByIds([id1, "nope", null, 99999]);
    return { empty, mixed, id1 };
  });
  assert.deepEqual(empty, []);
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].id, id1);
});

/* ------------------------- learningTimeline ------------------------- */

test("learningTimeline returns the session and sibling learnings", async () => {
  const tl = await withEpisodic(async (mod) => {
    await mod.upsertSession({
      id: "sess-A",
      projectPath: "/tmp/projA",
      startedAt: "2026-06-01T10:00:00.000Z",
      endedAt: "2026-06-01T10:30:00.000Z"
    });
    const slug = mod.projectSlug("/tmp/projA");
    const target = await mod.insertLearning({ sessionId: "sess-A", projectSlug: slug, category: "pattern", text: "the target learning" });
    await mod.insertLearning({ sessionId: "sess-A", projectSlug: slug, category: "gotcha", text: "sibling one" });
    await mod.insertLearning({ sessionId: "sess-A", projectSlug: slug, category: "fact", text: "sibling two" });
    // a learning from a different session must NOT appear as a neighbor
    await mod.upsertSession({ id: "sess-B", projectPath: "/tmp/projA", startedAt: "2026-06-02T10:00:00.000Z" });
    await mod.insertLearning({ sessionId: "sess-B", projectSlug: slug, category: "pattern", text: "unrelated other session" });
    return mod.learningTimeline(target);
  });
  assert.ok(tl, "timeline returned");
  assert.equal(tl.learning.text, "the target learning");
  assert.ok(tl.session, "session row resolved");
  assert.equal(tl.session.id, "sess-A");
  const neighborTexts = tl.neighbors.map(n => n.text);
  assert.deepEqual(neighborTexts.sort(), ["sibling one", "sibling two"]);
  assert.ok(!neighborTexts.includes("unrelated other session"));
});

test("learningTimeline returns null for an unknown id", async () => {
  const tl = await withEpisodic(async (mod) => mod.learningTimeline(123456));
  assert.equal(tl, null);
});

/* ----------------------- searchLearningsByFile ---------------------- */

test("searchLearningsByFile matches on full path and on basename", async () => {
  const { byPath, byBase, miss } = await withEpisodic(async (mod) => {
    await mod.insertLearning({ category: "gotcha", text: "auth race condition", tags: ["src/auth/login.ts", "login.ts"] });
    await mod.insertLearning({ category: "pattern", text: "unrelated learning", tags: ["other.ts"] });
    const byPath = await mod.searchLearningsByFile("src/auth/login.ts");
    const byBase = await mod.searchLearningsByFile("login.ts");
    const miss = await mod.searchLearningsByFile("does-not-exist.ts");
    return { byPath, byBase, miss };
  });
  assert.equal(byPath.length, 1);
  assert.match(byPath[0].text, /auth race condition/);
  assert.equal(byBase.length, 1);
  assert.match(byBase[0].text, /auth race condition/);
  assert.equal(miss.length, 0);
});

test("searchLearningsByFile normalizes backslash paths to forward slashes", async () => {
  const hits = await withEpisodic(async (mod) => {
    await mod.insertLearning({ category: "gotcha", text: "windows path learning", tags: ["src/win/file.ts"] });
    // query with a Windows-style separator → should still match
    return mod.searchLearningsByFile("src\\win\\file.ts");
  });
  assert.equal(hits.length, 1);
});

/* --------------------------- touchedFiles --------------------------- */

test("touchedFiles extracts file paths from tool_use events, cwd-relative", () => {
  const summary = {
    events: [
      { type: "tool_use", tool: "Edit", text: JSON.stringify({ file_path: "C:/proj/src/a.ts", old_string: "x" }) },
      { type: "tool_use", tool: "Read", text: JSON.stringify({ file_path: "C:/proj/src/b.ts" }) },
      { type: "tool_use", tool: "Bash", text: JSON.stringify({ command: "ls" }) },     // not a file tool
      { type: "assistant", text: "hello" },                                            // not a tool
      { type: "tool_use", tool: "NotebookEdit", text: JSON.stringify({ notebook_path: "C:/proj/nb.ipynb" }) }
    ]
  };
  const files = touchedFiles(summary, "C:/proj");
  assert.deepEqual(files.sort(), ["nb.ipynb", "src/a.ts", "src/b.ts"]);
});

test("touchedFiles dedupes and survives malformed tool input", () => {
  const summary = {
    events: [
      { type: "tool_use", tool: "Edit", text: JSON.stringify({ file_path: "/p/x.ts" }) },
      { type: "tool_use", tool: "Edit", text: JSON.stringify({ file_path: "/p/x.ts" }) },  // dup
      { type: "tool_use", tool: "Write", text: "not json at all" },                        // malformed
      { type: "tool_use", tool: "Write", text: JSON.stringify({ no_path_field: true }) }    // no path
    ]
  };
  const files = touchedFiles(summary, "/p");
  assert.deepEqual(files, ["x.ts"]);
});

test("touchedFiles returns [] for an empty / missing summary", () => {
  assert.deepEqual(touchedFiles(null, "/p"), []);
  assert.deepEqual(touchedFiles({}, "/p"), []);
  assert.deepEqual(touchedFiles({ events: [] }, "/p"), []);
});

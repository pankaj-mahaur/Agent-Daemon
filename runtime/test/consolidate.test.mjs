// Tests for the memory-evolution loop: reinforcement on dedup, consolidation
// analysis (merges / stale / contradictions), and user_facts observation.
//
// All sqlite handles close before assertions (see digest-sweep.test.mjs note).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as ep from "../src/memory/episodic.mjs";

// One shared episodic module — closeDb() between tests resets the singleton
// so the next db() call re-opens under the new tmp HOME (consolidate.mjs uses
// the same module instance, so they always agree on the active DB).
async function withTmpHome(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ad-consolidate-"));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  ep.closeDb();
  try {
    await fn(root, ep);
  } finally {
    ep.closeDb();
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevProfile;
    try {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch { /* leave for OS tmp cleaner */ }
  }
}

test("re-observed learning reinforces: confidence bump + observed_count", async () => {
  await withTmpHome(async (root, ep) => {
    const text = "always run the full suite before claiming a fix works in this repo";
    const id = await ep.insertLearning({ category: "pattern", text, confidence: 0.5 });
    assert.ok(id, "first insert returns an id");

    const dup = await ep.insertLearning({ category: "pattern", text, confidence: 0.5 });
    assert.equal(dup, null, "dedup signalled");

    const handle = await ep.db();
    const row = handle.get("SELECT confidence, observed_count, last_verified_at FROM learnings WHERE id = ?", [id]);
    ep.closeDb();
    assert.equal(row.observed_count, 2, "observation counted");
    assert.ok(Math.abs(row.confidence - 0.6) < 1e-9, `confidence reinforced (got ${row.confidence})`);
    assert.ok(row.last_verified_at, "verification stamped");
  });
});

test("consolidation finds near-duplicate clusters and picks the strongest survivor", async () => {
  await withTmpHome(async (root, ep) => {
    const con = await import("../src/memory/consolidate.mjs");
    await ep.insertLearning({ category: "gotcha", projectSlug: "proj-x", confidence: 0.8,
      text: "chokidar misses new file events on Windows so polling mode is required" });
    await ep.insertLearning({ category: "gotcha", projectSlug: "proj-x", confidence: 0.5,
      text: "chokidar misses new file events on Windows — polling mode required" });
    await ep.insertLearning({ category: "gotcha", projectSlug: "proj-x", confidence: 0.7,
      text: "completely unrelated learning about database migrations and schemas" });

    const analysis = await con.analyzeConsolidation({ projectSlug: "proj-x" });
    ep.closeDb();
    assert.equal(analysis.driver, true);
    assert.equal(analysis.mergeClusters.length, 1, "one duplicate cluster");
    const cluster = analysis.mergeClusters[0];
    assert.ok(Math.abs(cluster.survivor.confidence - 0.8) < 1e-9, "highest-confidence row survives");
    assert.equal(cluster.duplicates.length, 1);
  });
});

test("applyMerges supersedes duplicates and sums observed_count onto the survivor", async () => {
  await withTmpHome(async (root, ep) => {
    const con = await import("../src/memory/consolidate.mjs");
    await ep.insertLearning({ category: "pattern", projectSlug: "proj-y", confidence: 0.9,
      text: "use the project linter configuration instead of editor defaults everywhere" });
    await ep.insertLearning({ category: "pattern", projectSlug: "proj-y", confidence: 0.4,
      text: "use the project linter configuration instead of editor defaults" });

    const analysis = await con.analyzeConsolidation({ projectSlug: "proj-y" });
    assert.equal(analysis.mergeClusters.length, 1);
    const superseded = await con.applyMerges(analysis);
    assert.equal(superseded, 1);

    const handle = await ep.db();
    const survivor = handle.get("SELECT observed_count, status FROM learnings WHERE id = ?", [analysis.mergeClusters[0].survivor.id]);
    const dup = handle.get("SELECT status, superseded_by FROM learnings WHERE id = ?", [analysis.mergeClusters[0].duplicates[0].id]);
    ep.closeDb();
    assert.equal(survivor.status, "active");
    assert.equal(survivor.observed_count, 2, "duplicate's observation absorbed");
    assert.equal(dup.status, "superseded");
    assert.equal(dup.superseded_by, analysis.mergeClusters[0].survivor.id);
  });
});

test("contradiction detection pairs a statement with its negation", async () => {
  await withTmpHome(async (root, ep) => {
    const con = await import("../src/memory/consolidate.mjs");
    await ep.insertLearning({ category: "decision", projectSlug: "proj-z", confidence: 0.8,
      text: "use polling mode for the transcript watcher on Windows machines" });
    await ep.insertLearning({ category: "decision", projectSlug: "proj-z", confidence: 0.7,
      text: "never use polling mode for the transcript watcher on Windows machines" });

    const analysis = await con.analyzeConsolidation({ projectSlug: "proj-z" });
    ep.closeDb();
    assert.equal(analysis.contradictions.length, 1, "negation pair flagged");
  });
});

test("user fact observation upserts: re-observation bumps count and accrues projects", async () => {
  await withTmpHome(async (root, ep) => {
    const first = await ep.observeUserFact({
      category: "preference",
      text: "prefers pnpm over npm in every project",
      confidence: 0.6,
      projectSlug: "proj-a"
    });
    assert.equal(first.observed, 1);

    const second = await ep.observeUserFact({
      category: "preference",
      text: "prefers pnpm over npm in every project",
      confidence: 0.6,
      projectSlug: "proj-b"
    });
    assert.equal(second.observed, 2);
    assert.deepEqual(second.projects.sort(), ["proj-a", "proj-b"], "cross-project provenance accrues");

    const top = await ep.topUserFacts({ limit: 3 });
    ep.closeDb();
    assert.equal(top.length, 1);
    assert.equal(top[0].observed_count, 2);
  });
});

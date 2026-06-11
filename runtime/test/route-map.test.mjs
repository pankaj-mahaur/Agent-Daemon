// Tests for the data-driven route-map compiler (src/route-map.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  extractTriggerPhrases,
  compileRouteMapForDir,
  writeRouteMap,
  loadRouteMaps,
  compileEntryRegex,
  globalRouteMapPath,
  projectRouteMapPath
} from "../src/route-map.mjs";

/* ------------------------------------------------------------------ */
/* extractTriggerPhrases                                               */
/* ------------------------------------------------------------------ */

test("extractTriggerPhrases pulls quoted spans, lowercased and deduped", () => {
  const desc = 'Use when the user says "install a skill", "add skill X", "INSTALL A SKILL", or pastes a git URL.';
  const phrases = extractTriggerPhrases(desc);
  assert.deepEqual(phrases, ["install a skill", "add skill x"]);
});

test("extractTriggerPhrases filters by length and letter content", () => {
  assert.deepEqual(extractTriggerPhrases('quoted: "ok"'), [], "2 chars — too short");
  assert.deepEqual(extractTriggerPhrases('quoted: "12345"'), [], "no letters");
  assert.deepEqual(extractTriggerPhrases(`quoted: "${"x".repeat(70)}"`), [], "over 60 chars");
  assert.deepEqual(extractTriggerPhrases('quoted: "ok go"'), ["ok go"], "valid phrase");
});

test("extractTriggerPhrases caps at 24 and returns [] for no quotes", () => {
  const many = Array.from({ length: 30 }, (_, i) => `"trigger phrase ${i}"`).join(" ");
  assert.equal(extractTriggerPhrases(many).length, 24);
  assert.deepEqual(extractTriggerPhrases("no quoted phrases here"), []);
});

/* ------------------------------------------------------------------ */
/* compileRouteMapForDir                                               */
/* ------------------------------------------------------------------ */

async function writeSkill(laneDir, name, frontmatterLines, body = "# Body") {
  const dir = path.join(laneDir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), ["---", ...frontmatterLines, "---", "", body, ""].join("\n"), "utf8");
}

test("compileRouteMapForDir compiles quoted-description + routing-triggers skills, skips opted-out", async () => {
  const lane = await fs.mkdtemp(path.join(os.tmpdir(), "ad-routemap-"));
  try {
    await writeSkill(lane, "quoted-skill", [
      "name: quoted-skill",
      'description: "Use when the user says \\"fix the flaky test\\" or \\"test is flaky\\". One-liner."'
    ]);
    await writeSkill(lane, "explicit-skill", [
      "name: explicit-skill",
      'description: "Use for database migrations."',
      'routing-triggers: "run migration, migrate the db, schema change"'
    ]);
    await writeSkill(lane, "optout-skill", [
      "name: optout-skill",
      'description: "Use when \\"never route me\\" appears."',
      "disable-model-invocation: true"
    ]);
    await writeSkill(lane, "no-triggers", [
      "name: no-triggers",
      'description: "Use when something unquantifiable happens."'
    ]);

    const entries = await compileRouteMapForDir(lane, { lane: "global" });
    const names = entries.map(e => e.skill).sort();
    assert.deepEqual(names, ["explicit-skill", "quoted-skill"]);

    const explicit = entries.find(e => e.skill === "explicit-skill");
    assert.deepEqual(explicit.triggers, ["run migration", "migrate the db", "schema change"]);

    // Determinism: two compiles produce identical entries
    const entries2 = await compileRouteMapForDir(lane, { lane: "global" });
    assert.deepEqual(entries, entries2);
  } finally {
    try { await fs.rm(lane, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* tmp */ }
  }
});

/* ------------------------------------------------------------------ */
/* loadRouteMaps + regex                                               */
/* ------------------------------------------------------------------ */

test("loadRouteMaps merges lanes with project shadowing global, survives corrupt files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ad-routemap-load-"));
  const cwd = path.join(root, "proj");
  await fs.mkdir(cwd, { recursive: true });
  try {
    await writeRouteMap([
      { skill: "shared-skill", triggers: ["global phrase"], tier: "substantial", note: "g", lane: "global" },
      { skill: "global-only", triggers: ["another phrase"], tier: "substantial", note: "g", lane: "global" }
    ], globalRouteMapPath(root));
    await writeRouteMap([
      { skill: "shared-skill", triggers: ["project phrase"], tier: "substantial", note: "p", lane: "project" }
    ], projectRouteMapPath(cwd));

    const entries = await loadRouteMaps({ cwd, home: root });
    assert.equal(entries.length, 2);
    const shared = entries.find(e => e.skill === "shared-skill");
    assert.deepEqual(shared.triggers, ["project phrase"], "project entry shadows global");

    // Corrupt project map → global still loads
    await fs.writeFile(projectRouteMapPath(cwd), "{ not json", "utf8");
    const fallback = await loadRouteMaps({ cwd, home: root });
    assert.equal(fallback.length, 2);
    assert.deepEqual(fallback.find(e => e.skill === "shared-skill").triggers, ["global phrase"]);
  } finally {
    try { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* tmp */ }
  }
});

test("compileEntryRegex matches word-bounded, case-insensitive, escapes regex chars", () => {
  const entry = { triggers: ["fix the build", "c++ errors (weird)"] };
  const re = compileEntryRegex(entry);
  assert.ok(re.test("please FIX THE BUILD now"));
  assert.ok(!re.test("prefix-fix the buildx"));
  assert.ok(re.test("seeing c++ errors (weird) again"));
  assert.equal(compileEntryRegex(entry), re, "regex cached on entry");
});

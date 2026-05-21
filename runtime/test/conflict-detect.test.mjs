// Tests for runtime/src/orchestration/conflict-detect.mjs — WS-7c.
//
// Verifies path-extraction heuristic + conflict detection between
// unordered task pairs.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractPaths,
  detectConflicts,
  formatConflicts
} from "../src/orchestration/conflict-detect.mjs";

test("extractPaths catches src/ paths in prose", () => {
  const text = "Modify src/auth/login.ts and src/utils/jwt.ts, then test src/auth/login.test.ts";
  const paths = extractPaths(text);
  assert.ok(paths.has("src/auth/login.ts"));
  assert.ok(paths.has("src/utils/jwt.ts"));
  assert.ok(paths.has("src/auth/login.test.ts"));
});

test("extractPaths catches backtick-quoted paths", () => {
  const text = "The implementation lives in `runtime/src/cli.mjs` near `runtime/profiles/profiles.json`.";
  const paths = extractPaths(text);
  assert.ok(paths.has("runtime/src/cli.mjs"));
  assert.ok(paths.has("runtime/profiles/profiles.json"));
});

test("extractPaths normalises Windows backslashes", () => {
  const text = "Edit src\\auth\\login.ts please";
  const paths = extractPaths(text);
  assert.ok(paths.has("src/auth/login.ts"));
});

test("extractPaths ignores files outside whitelisted top-level dirs", () => {
  const text = "Edit somerandom/dir/file.ts and node_modules/foo/bar.ts";
  const paths = extractPaths(text);
  assert.equal(paths.size, 0, `expected zero, got: ${[...paths].join(",")}`);
});

test("detectConflicts flags two tasks touching the same file", () => {
  const tasks = [
    { id: "t1", title: "Add JWT auth", description: "Modify src/auth/jwt.ts to issue tokens" },
    { id: "t2", title: "Refactor JWT util", description: "Clean up src/auth/jwt.ts" }
  ];
  const reports = detectConflicts(tasks);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].taskA, "t1");
  assert.equal(reports[0].taskB, "t2");
  assert.deepEqual(reports[0].overlappingPaths, ["src/auth/jwt.ts"]);
});

test("detectConflicts ignores chained tasks (blocked_by)", () => {
  const tasks = [
    { id: "t1", title: "First", description: "Touch src/foo.ts" },
    { id: "t2", title: "Second", description: "Touch src/foo.ts", blockedBy: ["t1"] }
  ];
  const reports = detectConflicts(tasks);
  assert.equal(reports.length, 0, "chained tasks should not flag");
});

test("detectConflicts handles template-style blocked_by (snake_case)", () => {
  const tasks = [
    { id: "t1", title: "First", description: "Touch src/foo.ts" },
    { id: "t2", title: "Second", description: "Touch src/foo.ts", blocked_by: ["t1"] }
  ];
  const reports = detectConflicts(tasks);
  assert.equal(reports.length, 0);
});

test("detectConflicts returns multiple overlaps", () => {
  const tasks = [
    { id: "a", description: "Edit src/auth.ts and src/db.ts" },
    { id: "b", description: "Refactor src/auth.ts" },
    { id: "c", description: "Migrate src/db.ts" }
  ];
  const reports = detectConflicts(tasks);
  // a↔b on auth.ts, a↔c on db.ts (b↔c don't share anything)
  assert.equal(reports.length, 2);
  const allOverlaps = reports.flatMap(r => r.overlappingPaths).sort();
  assert.deepEqual(allOverlaps, ["src/auth.ts", "src/db.ts"]);
});

test("detectConflicts returns empty for single task", () => {
  const reports = detectConflicts([{ id: "x", description: "Edit src/foo.ts" }]);
  assert.equal(reports.length, 0);
});

test("detectConflicts returns empty for tasks without any paths", () => {
  const tasks = [
    { id: "t1", description: "Plan the API design" },
    { id: "t2", description: "Document the rollout" }
  ];
  assert.equal(detectConflicts(tasks).length, 0);
});

test("formatConflicts produces a human-readable warning", () => {
  const reports = [
    { taskA: "t1", taskB: "t2", overlappingPaths: ["src/auth.ts"] }
  ];
  const out = formatConflicts(reports);
  assert.match(out, /1 potential overlap/);
  assert.match(out, /t1.*t2/);
  assert.match(out, /src\/auth\.ts/);
  assert.match(out, /blocked_by/);
});

test("formatConflicts returns empty string for no reports", () => {
  assert.equal(formatConflicts([]), "");
});

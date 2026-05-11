// Smoke test for runtime/scripts/skills-diff.mjs — make sure it still runs
// against the current repo and produces a sensible JSON shape. We don't pin
// counts because the skills/ catalog will grow over time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "..", "scripts", "skills-diff.mjs");

test("skills-diff --json emits a structured report", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  const data = JSON.parse(r.stdout);
  assert.equal(typeof data.ours, "number");
  assert.equal(typeof data.ecc, "number");
  assert.ok(Array.isArray(data.duplicate));
  assert.ok(Array.isArray(data["near-duplicate"]));
  assert.ok(Array.isArray(data["net-new"]));
  // After our wholesale import there should be no net-new ECC skills left
  // unless someone re-fetches the vendored snapshot with newer content.
  assert.equal(data["net-new"].length, 0, "net-new should be 0 after import — re-run skills-diff --apply if not");
});

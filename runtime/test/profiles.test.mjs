// Tests for runtime/src/profiles.mjs — the install-profile resolver.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProfile, listProfiles } from "../src/profiles.mjs";

test("listProfiles returns minimal, developer, security and a default", async () => {
  const { names, default: def } = await listProfiles();
  assert.ok(names.includes("minimal"));
  assert.ok(names.includes("developer"));
  assert.ok(names.includes("security"));
  assert.equal(def, "developer");
});

test("resolveProfile() with no argument uses the default", async () => {
  const r = await resolveProfile();
  assert.equal(r.name, "developer");
  assert.ok(r.hooks.length > 0);
});

test("minimal profile installs only lifecycle hooks + continuous extraction, no skills", async () => {
  const r = await resolveProfile("minimal");
  assert.equal(r.name, "minimal");
  // v0.3: user-prompt-extract is part of minimal too — it's the harness-enforced
  // continuous learning capture, and has zero dependencies.
  assert.deepEqual(
    r.hooks.map(h => h.id).sort(),
    ["query-retrieve", "session-end", "session-start", "skill-use", "slash-command-use", "user-prompt-extract"]
  );
  assert.deepEqual(r.skills, []);
  assert.equal(r.features.qmd, false);
});

test("developer profile adds dev-quality hooks and core skills", async () => {
  const r = await resolveProfile("developer");
  assert.equal(r.name, "developer");
  const ids = r.hooks.map(h => h.id);
  assert.ok(ids.includes("session-start"));
  assert.ok(ids.includes("query-retrieve"));
  assert.ok(ids.includes("skill-use"));
  assert.ok(ids.includes("slash-command-use"));
  assert.ok(ids.includes("edit-post-lint"));
  assert.ok(ids.includes("bash-post-log"));
  assert.ok(r.skills.includes("bootstrap-daemon"));
  assert.equal(r.features.qmd, true);
});

test("installed SessionEnd remains deterministic unless fallback is explicitly requested", async () => {
  const r = await resolveProfile("developer");
  const sessionEnd = r.hooks.find(h => h.id === "session-end");
  assert.ok(sessionEnd);
  assert.doesNotMatch(sessionEnd.command, /--fallback-to-llm/);
  assert.equal(sessionEnd.command, "ad hook session-end-digest");
});

test("security profile extends developer and adds guards + security skills", async () => {
  const r = await resolveProfile("security");
  assert.equal(r.name, "security");
  const ids = r.hooks.map(h => h.id);
  // Inherits developer hooks.
  assert.ok(ids.includes("edit-post-lint"));
  assert.ok(ids.includes("bash-post-log"));
  // Adds security-only hooks.
  assert.ok(ids.includes("bash-pre-guard"));
  assert.ok(ids.includes("mcp-pre-audit"));
  // Inherits developer skills + adds security skills.
  assert.ok(r.skills.includes("bootstrap-daemon"));
  assert.ok(r.skills.includes("security-audit"));
  assert.ok(r.skills.includes("llm-app-safety"));
});

test("unknown profile throws with a helpful message", async () => {
  await assert.rejects(
    () => resolveProfile("nonsense"),
    /unknown profile "nonsense"/,
  );
});

test("each hook in profile carries event, matcher, command, timeout", async () => {
  const r = await resolveProfile("security");
  for (const h of r.hooks) {
    assert.ok(h.event, `hook ${h.id} missing event`);
    assert.ok(typeof h.matcher === "string", `hook ${h.id} missing matcher`);
    assert.ok(h.command, `hook ${h.id} missing command`);
    assert.ok(typeof h.timeout === "number", `hook ${h.id} missing timeout`);
  }
});

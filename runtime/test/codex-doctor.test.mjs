// Tests for the Codex engine checks in `ad doctor` (engine/codex/doctor.mjs).
// The runner is injected, so these never spawn codex.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pinnedCodexVersion } from "../src/engine/codex/app-server.mjs";
import { codexChecks, parseCodexVersion } from "../src/engine/codex/doctor.mjs";

const env = { AD_CODEX_HOME: "/nonexistent/ad-codex-home" };

test("parseCodexVersion reads codex --version output", () => {
  assert.equal(parseCodexVersion("codex-cli 0.159.2\n"), "0.159.2");
  assert.equal(parseCodexVersion("codex-cli 0.161.0-alpha.4"), "0.161.0-alpha.4");
  assert.equal(parseCodexVersion("garbage"), null);
});

test("matching installed version passes", () => {
  const [engine, home] = codexChecks({ env, run: () => `codex-cli ${pinnedCodexVersion()}` });
  assert.equal(engine.ok, true);
  assert.match(engine.note, /matches pin/);
  assert.match(home.note, /created on first ad run/);
});

test("version drift fails with the fix command", () => {
  const [engine] = codexChecks({ env, run: () => "codex-cli 0.0.1" });
  assert.equal(engine.ok, false);
  assert.match(engine.note, /pins/);
  assert.match(engine.note, /npm install/);
});

test("an unrunnable codex fails instead of throwing", () => {
  const [engine] = codexChecks({ env, run: () => { const e = new Error("spawn ENOENT"); e.code = "ENOENT"; throw e; } });
  assert.equal(engine.ok, false);
  assert.match(engine.note, /not runnable \(ENOENT\)/);
});

// Tests for the Codex engine checks in `ad doctor` (engine/codex/doctor.mjs).
// The runner is injected, so these never spawn codex.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pinnedCodexVersion } from "../src/engine/codex/app-server.mjs";
import { engineChecks, parseCodexVersion } from "../src/engine/codex/doctor.mjs";

const env = { AD_CODEX_HOME: "/nonexistent/ad-codex-home" };

test("parseCodexVersion reads codex --version output", () => {
  assert.equal(parseCodexVersion("codex-cli 0.159.2\n"), "0.159.2");
  assert.equal(parseCodexVersion("codex-cli 0.161.0-alpha.4"), "0.161.0-alpha.4");
  assert.equal(parseCodexVersion("garbage"), null);
});

test("matching installed version passes", () => {
  const [v, home] = engineChecks({ env, run: () => `codex-cli ${pinnedCodexVersion()}` });
  assert.equal(v.code, "engine.version");
  assert.equal(v.ok, true);
  assert.equal(v.data.installed, pinnedCodexVersion());
  assert.equal(home.code, "engine.home");
  assert.equal(home.data.exists, false);
});

test("version drift fails with the fix command", () => {
  const [v] = engineChecks({ env, run: () => "codex-cli 0.0.1" });
  assert.equal(v.ok, false);
  assert.equal(v.data.installed, "0.0.1");
  assert.equal(v.data.pinned, pinnedCodexVersion());
});

test("an unrunnable codex fails instead of throwing", () => {
  const [c] = engineChecks({ env, run: () => { const e = new Error("spawn ENOENT"); e.code = "ENOENT"; throw e; } });
  assert.equal(c.code, "engine.notRunnable");
  assert.equal(c.data.error, "ENOENT");
});

test("live checks: skipped without a harness home; report login, hooks, sandbox", async () => {
  const { engineLiveChecks } = await import("../src/engine/codex/doctor.mjs");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  assert.deepEqual(await engineLiveChecks({ env: { AD_CODEX_HOME: "/nonexistent/ad-home" }, engineFactory: async () => { throw new Error("must not be called"); } }), [], "never creates the home");
  const home = mkdtempSync(join(tmpdir(), "ad-doc-"));
  try {
    writeFileSync(join(home, "hooks.json"), "{}");
    const fake = {
      account: async () => ({ account: null, requiresOpenaiAuth: true }),
      readConfig: async () => ({ windows: { sandbox: "unelevated" } }),
      listHooks: async () => [{ sourcePath: join(home, "hooks.json"), trustStatus: "trusted" }, { sourcePath: join(home, "hooks.json"), trustStatus: "modified" }],
      sandbox: { readiness: async () => "ready" },
      close: async () => {},
    };
    const checks = await engineLiveChecks({ env: { AD_CODEX_HOME: home }, engineFactory: async () => fake, platform: "win32" });
    const by = Object.fromEntries(checks.map((c) => [c.code, c]));
    assert.equal(by["engine.login"].ok, false);
    assert.equal(by["engine.hooks"].ok, false);
    assert.deepEqual(by["engine.hooks"].data, { trusted: 1, total: 2 });
    assert.equal(by["engine.windowsSandbox"].ok, true);
    assert.equal(by["engine.windowsSandbox"].data.status, "ready");
    const broken = await engineLiveChecks({ env: { AD_CODEX_HOME: home }, engineFactory: async () => { throw new Error("boom"); } });
    assert.equal(broken[0].code, "engine.unreachable");
    assert.match(broken[0].data.error, /boom/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the version probe runs Codex in a throwaway CODEX_HOME, never ~/.codex", async () => {
  const { existsSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  let seen = null;
  engineChecks({ env: { ...env, CODEX_HOME: join(homedir(), ".codex") }, run: (_cmd, _args, opts) => { seen = opts.env.CODEX_HOME; return "codex-cli 1.0.0"; } });
  assert.ok(seen, "CODEX_HOME is set explicitly");
  assert.notEqual(seen, join(homedir(), ".codex"), "the inherited user home is replaced");
  assert.match(seen, /ad-codex-version-/);
  assert.equal(existsSync(seen), false, "the scratch home is removed afterwards");
});

test("a matching install also reports the tested versions and what changed (compat.json)", () => {
  const checks = engineChecks({ env, run: () => `codex-cli ${pinnedCodexVersion()}` });
  const compat = checks.find((c) => c.code === "engine.compat");
  assert.ok(compat, "compat line present");
  assert.ok(compat.data.tested.includes(pinnedCodexVersion()));
});

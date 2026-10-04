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

test("live checks: skipped without a harness home; report login, hooks, sandbox", async () => {
  const { codexLiveChecks } = await import("../src/engine/codex/doctor.mjs");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  assert.deepEqual(await codexLiveChecks({ env: { AD_CODEX_HOME: "/nonexistent/ad-home" } }), [], "never creates the home");
  const home = mkdtempSync(join(tmpdir(), "ad-doc-"));
  try {
    writeFileSync(join(home, "hooks.json"), "{}");
    const fake = {
      account: async () => ({ account: null, requiresOpenaiAuth: true }),
      readConfig: async () => ({ windows: { sandbox: "unelevated" } }),
      listHooks: async () => [{ sourcePath: join(home, "hooks.json"), trustStatus: "trusted" }, { sourcePath: join(home, "hooks.json"), trustStatus: "modified" }],
      server: { request: async () => ({ status: "ready" }) },
      close: async () => {},
    };
    const checks = await codexLiveChecks({ env: { AD_CODEX_HOME: home }, engineFactory: async () => fake, platform: "win32" });
    const by = Object.fromEntries(checks.map((c) => [c.name, c]));
    assert.equal(by["Harness login"].ok, false);
    assert.match(by["Harness login"].note, /ad auth login chatgpt/);
    assert.equal(by["Harness hooks"].note.startsWith("1/2 trusted"), true);
    assert.equal(by["Windows sandbox"].ok, true);
    const broken = await codexLiveChecks({ env: { AD_CODEX_HOME: home }, engineFactory: async () => { throw new Error("boom"); } });
    assert.match(broken[0].note, /boom/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the version probe runs Codex in a throwaway CODEX_HOME, never ~/.codex", async () => {
  const { existsSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  let seen = null;
  codexChecks({ env: { ...env, CODEX_HOME: join(homedir(), ".codex") }, run: (_cmd, _args, opts) => { seen = opts.env.CODEX_HOME; return "codex-cli 1.0.0"; } });
  assert.ok(seen, "CODEX_HOME is set explicitly");
  assert.notEqual(seen, join(homedir(), ".codex"), "the inherited user home is replaced");
  assert.match(seen, /ad-codex-version-/);
  assert.equal(existsSync(seen), false, "the scratch home is removed afterwards");
});

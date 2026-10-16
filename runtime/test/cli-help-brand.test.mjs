// The help test (own-harness Part 3, G2): ad's own surfaces name no engine.
// Every case runs `node runtime/src/cli.mjs` with a fake home and asserts
// the output has no brand word outside the attribution module's allowance.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { screenHits } from "../scripts/check-brand.mjs";
import { brandPatterns } from "../src/engine/attribution.mjs";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

const CASES = [
  ["--help"],
  ["tui", "--help"],
  ["codex"],
  ["codex", "--help"],
  ["about"],
  ["auth"],
  ["run"],
  ["loop"],
  ["sandbox", "bogus"],
  ["schedule", "bogus"],
  ["tools", "bogus"],
  ["agy"],
  ["hook", "bogus"],
];

test("help, usage errors, the tombstone and ad about name no engine", () => {
  const home = mkdtempSync(join(tmpdir(), "ad-help-"));
  try {
    for (const args of CASES) {
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      delete env.AD_CODEX_HOME;
      delete env.AD_ENGINE_DIR;
      delete env.CODEX_HOME;
      const r = spawnSync(process.execPath, [CLI, ...args], { input: "", encoding: "utf8", timeout: 30_000, env });
      assert.ok((r.status ?? 1) <= 2, `ad ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
      const hits = screenHits(`${r.stdout ?? ""}\n${r.stderr ?? ""}`, { allow: brandPatterns() });
      assert.deepEqual(hits, [], `ad ${args.join(" ")} names the engine: ${JSON.stringify(hits)}`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ad codex exits 2 with the tombstone and empty stdout; ad engine falls through", () => {
  const home = mkdtempSync(join(tmpdir(), "ad-help-"));
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.AD_CODEX_HOME;
    delete env.AD_ENGINE_DIR;
    delete env.CODEX_HOME;
    const run = (args) => spawnSync(process.execPath, [CLI, ...args], { input: "", encoding: "utf8", timeout: 30_000, env });
    for (const args of [["codex"], ["codex", "--help"]]) {
      const r = run(args);
      assert.equal(r.status, 2, `ad ${args.join(" ")}`);
      assert.match(r.stderr, /was removed in 3\.0\. Settings: .*config\.toml|\(see ad doctor\)/);
      assert.equal((r.stdout ?? "").trim(), "", "stdout stays empty");
    }
    const e = run(["engine"]);
    assert.equal(e.status, 2);
    assert.match(e.stderr ?? e.stdout, /unknown command "engine"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

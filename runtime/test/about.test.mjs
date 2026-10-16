// Tests for `ad about` (harness/about.mjs, G6): what ad runs on, without
// starting the engine — plus the version check the starts use.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { screenHits } from "../scripts/check-brand.mjs";
import { brandPatterns, ENGINE } from "../src/engine/attribution.mjs";
import { engineVersion } from "../src/engine/index.mjs";
import { cmdAbout } from "../src/harness/about.mjs";
import { startHarnessEngine } from "../src/harness/start.mjs";

const FAKE = { cmd: process.execPath, prefix: [fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url))] };
const PINNED = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).dependencies[ENGINE.npmPackage];
const TESTED = engineVersion.compat().tested;
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

class Sink {
  constructor() {
    this.text = "";
  }
  write(s) {
    this.text += s;
    return true;
  }
}

test("ad about names ad, the engine, its process, the settings and the tested versions", () => {
  const root = mkdtempSync(join(tmpdir(), "ad-about-"));
  try {
    const out = new Sink();
    assert.equal(cmdAbout({ stdout: out, env: {}, root }), 0);
    assert.match(out.text, new RegExp(`^Agent Daemon ${PKG.version.replace(/\./g, "\\.")} \\(MIT\\)`, "m"));
    assert.match(out.text, new RegExp(`engine: Codex ${PINNED.replace(/\./g, "\\.")} by OpenAI, Apache-2\\.0, https://github\\.com/openai/codex`, "m"));
    assert.match(out.text, /its process shows as codex/);
    assert.ok(out.text.includes(join(root, "engine", "config.toml")), "the settings path under the resolved home");
    assert.match(out.text, new RegExp(`tested engine versions: ${TESTED.join(", ")}`, "m"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ad about shows no engine name outside the attribution texts", () => {
  const root = mkdtempSync(join(tmpdir(), "ad-about-"));
  try {
    const out = new Sink();
    cmdAbout({ stdout: out, env: {}, root });
    assert.deepEqual(screenHits(out.text, { allow: brandPatterns() }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("engineVersion.check grades an installed version and never refuses", () => {
  const other = TESTED.find((v) => v !== PINNED) ?? "0.0.0-tested";
  assert.equal(engineVersion.check({ installed: PINNED }).code, "pinned");
  assert.equal(engineVersion.check({ installed: other }).code, other === "0.0.0-tested" ? "untested" : "tested");
  assert.equal(engineVersion.check({ installed: "0.0.0-unknown" }).code, "untested");
  assert.equal(engineVersion.check({ installed: null }).code, "unknown");
});

test("starting the harness with the pinned engine warns nothing", async () => {
  const home = mkdtempSync(join(tmpdir(), "ad-about-home-"));
  const err = new Sink();
  try {
    const { engine } = await startHarnessEngine({ home, command: FAKE, setup: false, err });
    try {
      assert.ok(!/tested with/.test(err.text), JSON.stringify(err.text));
    } finally {
      await engine?.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

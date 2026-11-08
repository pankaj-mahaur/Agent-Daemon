// doctor's plugin rows (L3 D18): the plugin's record and dispatcher on disk, and a
// Claude Code new enough for its exec-form hooks; no rows when it isn't installed.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installedPlugin, productChecks } from "../src/memory-install/doctor-product.mjs";
import { PRODUCT } from "../src/product.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-doctor-product-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const ID = `${PRODUCT.plugin}@${PRODUCT.marketplace}`;
let n = 0;
function ctx({ files = true, enabled } = {}) {
  const home = path.join(TMP, `h${++n}`);
  const installPath = path.join(home, ".claude", "plugins", "cache", "x", PRODUCT.plugin, "3.1.0");
  fs.mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { [ID]: [{ scope: "user", installPath, version: "3.1.0" }] } }));
  if (enabled !== undefined) fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { [ID]: enabled } }));
  if (files) {
    fs.mkdirSync(path.join(installPath, "server", "bin"), { recursive: true });
    fs.writeFileSync(path.join(installPath, "server", "bin", "hook.mjs"), "");
  }
  return { home, env: { HOME: home }, display: (p) => p };
}
const rows = async (c, v) => Object.fromEntries((await productChecks(c, { claudeVersion: async () => v })).map((r) => [r.code, r]));

test("the plugin installed with its files, on a Claude Code new enough: both rows pass", async () => {
  const r = await rows(ctx(), "2.1.319");
  assert.equal(r["plugin.installed"].ok, true);
  assert.equal(r["plugin.installed"].note, `${ID} 3.1.0`);
  assert.equal(r["plugin.version"].ok, true);
  assert.equal(r["plugin.version"].note, "Claude Code 2.1.319");
  assert.equal((await rows(ctx(), "2.1.314"))["plugin.version"].ok, true, "the first version the exec form was verified on");
});

test("files missing, or a Claude Code older than the exec form: the row fails and says what to do", async () => {
  const gone = await rows(ctx({ files: false }), "2.1.319");
  assert.equal(gone["plugin.installed"].ok, false);
  assert.match(gone["plugin.installed"].note, /files are missing: reinstall it/);
  const old = await rows(ctx(), "2.1.300");
  assert.equal(old["plugin.version"].ok, false);
  assert.match(old["plugin.version"].note, /needs 2\.1\.314 or later/);
  const unknown = await rows(ctx(), null);
  assert.equal(unknown["plugin.version"].ok, true, "can't tell: said, not failed");
  assert.match(unknown["plugin.version"].note, /couldn't tell/);
});

test("turned off: said; not installed: no rows at all", async () => {
  assert.match((await rows(ctx({ enabled: false }), "2.1.319"))["plugin.installed"].note, /turned off/);
  const bare = { home: path.join(TMP, "bare"), env: {}, display: (p) => p };
  fs.mkdirSync(bare.home, { recursive: true });
  assert.equal(installedPlugin(bare), null);
  assert.deepEqual(await productChecks(bare, { claudeVersion: async () => "2.1.319" }), []);
});

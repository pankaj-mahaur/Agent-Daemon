// Settings that must not split across engine homes (P3.4, T2-M5): the default home is
// the record for [tui] and folder trust; ad's account homes mirror it. Stub engines in a
// throwaway HOME / AD_ROOT.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-settings-sync-"));
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, AD_ROOT: process.env.AD_ROOT };
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;
process.env.AD_ROOT = path.join(TMP, ".agent-daemon");
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

const { engineHome } = await import("../src/engine/index.mjs");
const sync = await import("../src/harness/settings-sync.mjs");

function stub(home, config = {}) {
  const writes = [];
  return { home, writes, config, readConfig: async () => structuredClone(config), writeConfig: async (edits) => void writes.push(...edits) };
}
const defaultEngine = (config) => stub(engineHome.defaultPath(), config);
const apiEngine = () => stub(sync.apiHomePath());
const reset = () => fs.rmSync(sync.recordFile(), { force: true });

test("an engine on the default home becomes the record ([tui] and [projects], read through the engine)", async () => {
  reset();
  await sync.syncSettings(defaultEngine({ tui: { theme: "dark", alternate_screen: "never" }, projects: { "/w/app": { trust_level: "trusted" } }, model: "not-mirrored" }));
  const rec = sync.readRecord();
  assert.deepEqual(rec.tui, { theme: "dark", alternate_screen: "never" });
  assert.deepEqual(rec.projects, { "/w/app": { trust_level: "trusted" } });
  assert.equal(rec.model, undefined);
  assert.equal(rec.revision, 1);
  // Unchanged: no new revision.
  await sync.syncSettings(defaultEngine({ tui: { theme: "dark", alternate_screen: "never" }, projects: { "/w/app": { trust_level: "trusted" } } }));
  assert.equal(sync.readRecord().revision, 1);
});

test("/tui set in an account-home window is applied to the default home at its next start and survives its snapshot", async () => {
  reset();
  const api = apiEngine();
  await sync.recordSettings([["tui.theme", "light"]], { engine: api });
  assert.deepEqual(api.writes, [["tui.theme", "light"]], "the window's engine gets it");
  assert.deepEqual(sync.readRecord().pending, [["tui.theme", "light"]]);
  const def = defaultEngine({ tui: { theme: "dark" } });
  // The default home's engine applies it before its snapshot (the stub models the write).
  def.writeConfig = async (edits) => {
    def.writes.push(...edits);
    for (const [k, v] of edits) if (k === "tui.theme") def.config.tui.theme = v;
  };
  await sync.syncSettings(def);
  assert.deepEqual(def.writes, [["tui.theme", "light"]]);
  assert.deepEqual(sync.readRecord().pending, []);
  assert.equal(sync.readRecord().tui.theme, "light");
});

test("a trust answer reaches every home; a home a command chose is left alone", async () => {
  reset();
  await sync.recordSettings([[`projects.${JSON.stringify("/w/shop-app")}.trust_level`, "trusted"]], { engine: defaultEngine({}), written: true });
  assert.deepEqual(sync.readRecord().pending, [], "written in the default home: nothing waits");
  const api = apiEngine();
  await sync.syncSettings(api);
  assert.deepEqual(api.writes, [["tui", {}], ["projects", { "/w/shop-app": { trust_level: "trusted" } }]]);
  const chosen = stub(path.join(TMP, "somewhere-else"));
  await sync.syncSettings(chosen);
  assert.deepEqual(chosen.writes, []);
});

test("a hand edit of [tui] in the default home reaches an account home after the default home's next start", async () => {
  reset();
  await sync.syncSettings(defaultEngine({ tui: { theme: "dark" } }));
  await sync.syncSettings(defaultEngine({ tui: { theme: "hand-edited" } }));
  const api = apiEngine();
  await sync.syncSettings(api);
  assert.deepEqual(api.writes, [["tui", { theme: "hand-edited" }], ["projects", {}]]);
});

test("a key or a trust answer removed in the default home is removed in the copies too", async () => {
  reset();
  await sync.syncSettings(defaultEngine({ tui: { theme: "dark", status_line: ["model"] }, projects: { "/w/a": { trust_level: "trusted" }, "/w/b": { trust_level: "trusted" } } }));
  await sync.syncSettings(defaultEngine({ tui: { theme: "dark" }, projects: { "/w/a": { trust_level: "trusted" } } }));
  const api = apiEngine();
  await sync.syncSettings(api);
  assert.deepEqual(api.writes, [["tui", { theme: "dark" }], ["projects", { "/w/a": { trust_level: "trusted" } }]], "whole tables, replaced");
});

test("folderTrusted: the folder or one inside a trusted folder; untrusted otherwise", () => {
  const rec = { projects: { [path.join(TMP, "w", "app")]: { trust_level: "trusted" }, [path.join(TMP, "w", "no")]: { trust_level: "untrusted" } } };
  assert.equal(sync.folderTrusted(path.join(TMP, "w", "app"), rec), true);
  assert.equal(sync.folderTrusted(path.join(TMP, "w", "app", "src"), rec), true);
  assert.equal(sync.folderTrusted(path.join(TMP, "w", "app-other"), rec), false);
  assert.equal(sync.folderTrusted(path.join(TMP, "w", "no"), rec), false);
  assert.equal(sync.folderTrusted(null, rec), false);
});

test("a failing engine never fails a start: a warning comes back", async () => {
  const bad = apiEngine();
  reset();
  await sync.recordSettings([["tui.theme", "x"]], { engine: stub(path.join(TMP, "x")) });
  bad.writeConfig = async () => {
    throw new Error("config/batchWrite refused");
  };
  assert.match(await sync.syncSettings(bad), /settings sync: config\/batchWrite refused/);
});

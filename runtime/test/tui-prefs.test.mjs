// TUI settings (tui/prefs.mjs, terminal UI plan 1c): the engine's own in its
// config.toml (through the engine), ad's own in prefs.json.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngineSettings, createPrefs } from "../src/tui/prefs.mjs";

function fakeEngine(config) {
  const writes = [];
  return {
    writes,
    fail: false,
    async readConfig() {
      if (this.fail) throw new Error("engine down");
      return structuredClone(config);
    },
    async writeConfig(edits) {
      writes.push(edits);
    },
  };
}

test("engine settings: read by key path, written through the engine, kept when a re-read fails", async () => {
  const eng = fakeEngine({ tui: { status_line: ["model", "current-dir"], theme: "dracula" }, plan_mode_reasoning_effort: "high" });
  const s = createEngineSettings({ engine: () => eng });
  assert.equal(s.get("tui.status_line"), undefined, "nothing before load()");
  await s.load();
  assert.deepEqual(s.get("tui.status_line"), ["model", "current-dir"]);
  assert.equal(s.get("plan_mode_reasoning_effort"), "high");
  assert.equal(s.get("tui.vim_mode_default"), undefined);
  await s.set("tui.vim_mode_default", true);
  await s.set("tui.theme", null);
  assert.deepEqual(eng.writes, [[["tui.vim_mode_default", true]], [["tui.theme", null]]]);
  assert.equal(s.get("tui.vim_mode_default"), true);
  assert.equal(s.get("tui.theme"), undefined, "null removed it");
  eng.fail = true;
  await s.load();
  assert.equal(s.get("tui.vim_mode_default"), true, "a failed re-read keeps the last values");
});

test("engine settings: ad never writes tui.keymap (the stock UI refuses to start on a conflict)", async () => {
  const eng = fakeEngine({});
  const s = createEngineSettings({ engine: () => eng });
  await assert.rejects(s.set("tui.keymap.composer.submit", "enter"), /doesn't write tui\.keymap/);
  await assert.rejects(s.set("tui.keymap", {}), /doesn't write tui\.keymap/);
  assert.deepEqual(eng.writes, []);
});

test("ad's prefs: defaults when missing or broken; saved at once, atomically, owner-only", () => {
  const dir = mkdtempSync(join(tmpdir(), "ad-prefs-"));
  try {
    const file = join(dir, "tui", "prefs.json");
    const p = createPrefs({ file });
    assert.equal(p.get("clear.keepScrollback", false), false);
    p.set("clear.keepScrollback", true);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { "clear.keepScrollback": true });
    assert.deepEqual(readdirSync(join(dir, "tui")), ["prefs.json"], "no temp file left behind");
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(createPrefs({ file }).get("clear.keepScrollback"), true, "read back by the next start");
    p.set("clear.keepScrollback", null);
    assert.deepEqual(createPrefs({ file }).all(), {});
    writeFileSync(file, "{not json");
    assert.deepEqual(createPrefs({ file }).all(), {});
    writeFileSync(file, "[1,2]");
    assert.deepEqual(createPrefs({ file }).all(), {}, "only an object counts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("on another home the TUI reads [tui] from the settings record, not from that home's copy; its [tui] writes go through the record (P3.4)", async () => {
  const writes = [];
  const recorded = [];
  const engine = { readConfig: async () => ({ tui: { theme: "stale-copy", status_line: ["model"] }, model: "m" }), writeConfig: async (e) => void writes.push(...e) };
  const s = createEngineSettings({ engine: () => engine, record: () => ({ theme: "from-record" }), write: async (e) => void recorded.push(...e) });
  await s.load();
  assert.equal(s.get("tui.theme"), "from-record");
  assert.deepEqual(s.get("tui.status_line"), ["model"], "keys the record lacks still come from the engine");
  await s.set("tui.theme", "dark");
  assert.deepEqual(recorded, [["tui.theme", "dark"]]);
  assert.deepEqual(writes, []);
  await s.set("model_reasoning_effort", "high");
  assert.deepEqual(writes, [["model_reasoning_effort", "high"]], "other settings go to the window's engine");
});

// G6: THIRD_PARTY_NOTICES.md exists and names what ad runs on; the README
// carries the attribution sentence verbatim.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ATTRIBUTED_FILES, ENGINE, readmeSentence } from "../src/engine/attribution.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PINNED = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).dependencies[ENGINE.npmPackage];

test("THIRD_PARTY_NOTICES.md names the engine, the pin and every reproduced file", () => {
  const path = `${ROOT}THIRD_PARTY_NOTICES.md`;
  assert.ok(existsSync(path), "the notices file exists");
  const text = readFileSync(path, "utf8");
  assert.ok(text.includes(ENGINE.url), "the upstream URL");
  assert.ok(text.includes(ENGINE.license), "the license id");
  assert.ok(text.includes(PINNED), "the pinned version from runtime/package.json");
  for (const { file } of ATTRIBUTED_FILES) assert.ok(text.includes(file), `the reproduced file ${file}`);
  assert.ok(text.includes("Apache License") && text.includes("Version 2.0"), "the license text");
});

test("the README carries the attribution sentence verbatim", () => {
  const readme = readFileSync(`${ROOT}README.md`, "utf8");
  assert.ok(readme.includes(readmeSentence), "readmeSentence verbatim in the README");
});


test("the README and troubleshooting login recipes lead with API routes", () => {
  const readme = readFileSync(`${ROOT}README.md`, "utf8");
  const recipe = readme.split("The harness commands need a login.")[1]?.split("\n")[0] ?? "";
  assert.ok(recipe.includes("ad auth login openai"), recipe);
  assert.ok(recipe.indexOf("openai") < recipe.indexOf("chatgpt"), recipe);
  assert.ok(recipe.indexOf("openrouter") < recipe.indexOf("chatgpt"), recipe);
  const troubleshooting = readFileSync(`${ROOT}docs/troubleshooting.md`, "utf8");
  const fix = troubleshooting.split("## 14.")[1]?.split("## 15.")[0] ?? "";
  assert.ok(fix.indexOf("ad auth login openai") >= 0, fix);
  assert.ok(fix.indexOf("ad auth login openai") < fix.indexOf("ad auth login chatgpt                          #"), fix);
  assert.ok(fix.indexOf("ad auth login openrouter") < fix.indexOf("ad auth login chatgpt                          #"), fix);
});

test("the upgrade guide distinguishes env-name lifetime and value aliases", () => {
  const guide = readFileSync(`${ROOT}docs/upgrade-3.0.md`, "utf8");
  const renamed = guide.split("## Renamed")[1]?.split("## Removed:")[0] ?? "";
  assert.match(renamed, /old env var names keep working/i);
  assert.match(renamed, /old (?:product )?values work (?:at least )?until 3\.1/i);
});

test("the rollback recipe offers optional undo before switching to 2.2.0", () => {
  const guide = readFileSync(`${ROOT}docs/upgrade-3.0.md`, "utf8");
  const rollback = guide.split("## Rolling back to 2.2.0")[1]?.split("## Something wrong?")[0] ?? "";
  assert.ok(rollback.indexOf("ad migrate --undo") >= 0, rollback);
  assert.ok(rollback.indexOf("ad migrate --undo") < rollback.indexOf("git checkout v2.2.0"), rollback);
});


test("the reference adapter guide points to ad's current UI and data folder", () => {
  const guide = readFileSync(`${ROOT}adapters/${ENGINE.name.toLowerCase()}/README.md`, "utf8");
  assert.ok(guide.includes("~/.agent-daemon/engine"));
  assert.ok(guide.includes("ad engine ui --debug"));
  assert.ok(!guide.includes(`ad ${ENGINE.name.toLowerCase()}\x60 opens`));
});

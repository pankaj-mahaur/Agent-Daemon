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

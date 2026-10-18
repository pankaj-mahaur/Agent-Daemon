// Tests for runtime/src/ad-root.mjs: one answer to "where does ad keep its state".

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { adPackageRoot, adRoot, legacyAdRoots } from "../src/ad-root.mjs";
import { defaultRoot } from "../src/engine/codex/home-resolve.mjs";

const abs = (...p) => path.resolve(path.sep, ...p);

test("AD_ROOT (absolute) wins; a relative AD_ROOT is ignored", () => {
  const home = () => abs("h");
  assert.equal(adRoot({ env: { AD_ROOT: abs("state", "ad") }, homedir: home }), abs("state", "ad"));
  assert.equal(adRoot({ env: { AD_ROOT: "rel/ad" }, homedir: home }), path.join(abs("h"), ".agent-daemon"));
  assert.equal(adRoot({ env: {}, homedir: home }), path.join(abs("h"), ".agent-daemon"));
});

test("HOME ≠ USERPROFILE: the HOME-based location is listed as a legacy root", () => {
  const env = { HOME: abs("msys", "home", "u"), USERPROFILE: abs("Users", "u") };
  const roots = legacyAdRoots({ env, homedir: () => env.USERPROFILE, platform: process.platform });
  assert.deepEqual(roots, [path.join(env.HOME, ".agent-daemon")]);
  assert.deepEqual(legacyAdRoots({ env: { HOME: abs("u"), USERPROFILE: abs("u") }, homedir: () => abs("u") }), []);
  // Windows compares case-insensitively.
  assert.deepEqual(legacyAdRoots({ env: { HOME: "C:\\Users\\U", USERPROFILE: "C:\\Users\\u" }, homedir: () => "C:\\Users\\u", platform: "win32" }).length, process.platform === "win32" ? 0 : 1);
});

test("defaultRoot() is adRoot()", () => {
  assert.equal(defaultRoot(), adRoot());
});

test("adPackageRoot() is the runtime folder", () => {
  assert.ok(existsSync(path.join(adPackageRoot(), "package.json")));
  assert.ok(existsSync(path.join(adPackageRoot(), "src", "ad-root.mjs")));
});

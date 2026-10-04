// Tests for the one-liner installers (install.sh / install.ps1 at the repo root).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (name) => readFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)), "utf8");

test("install.ps1 is pure ASCII (Windows PowerShell 5.1 reads BOM-less files as ANSI)", () => {
  // UTF-8 for ✓ or — contains 0x93/0x94, which 5.1 parses as quote marks.
  const bad = read("install.ps1").split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) => /[^\x00-\x7F]/.test(l));
  assert.deepEqual(bad, []);
});

test("install.ps1 never defines a function named like the git it calls", () => {
  // PowerShell names are case-insensitive: `function Git { git ... }` recurses forever.
  assert.doesNotMatch(read("install.ps1"), /^\s*function\s+git\b/im);
});

test("both installers honour AD_VERSION", () => {
  assert.match(read("install.sh"), /AD_VERSION/);
  assert.match(read("install.ps1"), /\$env:AD_VERSION/);
});

test("installers keep devDependencies (test-only terminal emulators) out of user installs", () => {
  for (const name of ["install.sh", "install.ps1"]) {
    const src = read(name);
    assert.match(src, /npm install --omit=dev/, `${name}: npm install --omit=dev`);
    assert.match(src, /npm link --omit=dev/, `${name}: npm link --omit=dev`);
    assert.doesNotMatch(src, /npm (install|link)\s*(\)|&&|$)/m, `${name}: no bare npm install/link`);
  }
});

test("installers warn (not fail) when Node is too old for the terminal UI", () => {
  for (const name of ["install.sh", "install.ps1"]) assert.match(read(name), /22\.17\+ or 24\.2\+/, name);
});

test("install.ps1 stops when npm fails instead of reporting success", () => {
  const src = read("install.ps1");
  assert.match(src, /npm install --omit=dev\s*\r?\n\s*if \(\$LASTEXITCODE -ne 0\)/);
  assert.match(src, /npm link --omit=dev\s*\r?\n\s*if \(\$LASTEXITCODE -ne 0\)/);
});

#!/usr/bin/env node
// Users install with `npm install --omit=dev` (install.sh / install.ps1):
// runtime code that imports a devDependency (the test-only node-pty, xterm)
// breaks every install while every test still passes. This fails when a bare
// import in runtime/src isn't a production dependency or a Node builtin.
//
//   node .claude/skills/ad-ci-readiness/scripts/check-prod-imports.mjs

import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../runtime");
const pkg = JSON.parse(readFileSync(path.join(runtime, "package.json"), "utf8"));
const deps = new Set(Object.keys(pkg.dependencies ?? {}));
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.m?js$/.test(e.name)) files.push(p);
  }
})(path.join(runtime, "src"));

const bad = [];
const seen = new Set();
const IMPORT = /(?:import\s[^"']*?from\s*|import\s*\(\s*|require\(\s*)["']([^"']+)["']/g;
for (const f of files) {
  for (const [, spec] of readFileSync(f, "utf8").matchAll(IMPORT)) {
    if (/^(?:\.|node:|file:)/.test(spec)) continue;
    const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    seen.add(name);
    if (!deps.has(name) && !builtinModules.includes(name)) bad.push(`${path.relative(runtime, f)}: ${spec}`);
  }
}
console.log(`bare imports in runtime/src: ${[...seen].sort().join(", ") || "(none)"}`);
if (bad.length) {
  console.log(`Not production dependencies (breaks \`npm install --omit=dev\`):\n  ${bad.join("\n  ")}`);
  process.exit(1);
}
console.log("OK: every bare import is a production dependency or a Node builtin.");

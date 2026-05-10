#!/usr/bin/env node
// Re-hydrate vendored upstream snapshots from MANIFEST.md pins.
// Usage: node vendored/fetch.mjs [--force]

import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FORCE = process.argv.includes("--force");

const VENDORED = [
  {
    name: "everything-claude-code",
    url: "https://github.com/affaan-m/everything-claude-code",
    commit: "841beea45cb25ba51f29fa45b7e272938d19b80a",
    strip: [
      "ecc2",
      "ecc_dashboard.py",
      "pyproject.toml",
      "README.zh-CN.md",
      "EVALUATION.md",
      "SOUL.md",
      "SPONSORS.md",
      "SPONSORING.md",
      "REPO-ASSESSMENT.md",
    ],
  },
];

for (const v of VENDORED) {
  const dest = join(HERE, v.name);
  if (existsSync(dest)) {
    if (!FORCE) {
      console.log(`[skip] ${v.name} already present (use --force to refetch)`);
      continue;
    }
    rmSync(dest, { recursive: true, force: true });
  }
  console.log(`[clone] ${v.url} -> ${dest}`);
  execSync(`git clone ${v.url} "${dest}"`, { stdio: "inherit" });
  execSync(`git -C "${dest}" checkout ${v.commit}`, { stdio: "inherit" });
  for (const path of v.strip) {
    const target = join(dest, path);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      console.log(`[strip] ${path}`);
    }
  }
  console.log(`[done] ${v.name} pinned at ${v.commit}`);
}

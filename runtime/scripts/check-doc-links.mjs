#!/usr/bin/env node
// Checks the relative links in the repo's tracked Markdown files: each must
// point at a file git tracks (a link into an ignored or untracked folder is
// broken for everyone who clones the repo). Web links, mailto: and in-page
// anchors are skipped. Exit 1 when any link is broken.
//
//   node runtime/scripts/check-doc-links.mjs            # every tracked .md
//   node runtime/scripts/check-doc-links.mjs README.md docs/
//
// Used by the ad-pre-push skill before every push.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
const tracked = new Set(git("ls-files", "-z").split("\0").filter(Boolean));
const dirs = new Set();
for (const f of tracked) for (let d = path.posix.dirname(f); d !== "."; d = path.posix.dirname(d)) dirs.add(d);

const only = process.argv.slice(2).map((a) => a.replace(/\\/g, "/").replace(/\/$/, ""));
// Skills and the constitution are written for their installed layout
// (~/.claude/skills/<name>/, playbooks beside them), and the constitution's
// links are examples: checked only when named explicitly.
const INSTALLED = ["skills/", "constitution/"];
const files = [...tracked].filter(
  (f) => f.endsWith(".md") && (only.length ? only.some((o) => f === o || f.startsWith(`${o}/`)) : !INSTALLED.some((p) => f.startsWith(p))),
);

const broken = [];
for (const file of files) {
  const text = readFileSync(path.join(root, file), "utf8");
  // Fenced code is example text, not links.
  const prose = text.replace(/^(```|~~~)[\s\S]*?^\1/gm, (m) => m.replace(/[^\n]/g, " "));
  const lines = prose.split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      const target = m[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue; // http:, mailto:, #anchor
      const clean = decodeURIComponent(target.split("#")[0].replace(/:\d+(?::\d+)?$/, ""));
      if (!clean) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), clean)).replace(/\/$/, "");
      if (resolved.startsWith("..")) {
        broken.push(`${file}:${i + 1}  ${target}  (outside the repo)`);
        continue;
      }
      if (!tracked.has(resolved) && !dirs.has(resolved)) broken.push(`${file}:${i + 1}  ${target}`);
    }
  });
}

if (broken.length) {
  console.log(`${broken.length} broken link${broken.length === 1 ? "" : "s"} (target not tracked by git):`);
  for (const b of broken) console.log(`  ${b}`);
  process.exit(1);
}
console.log(`All relative links in ${files.length} Markdown files point at tracked files.`);

#!/usr/bin/env node
// Diff our skills against vendored upstreams and optionally import net-new.
//
// Usage:
//   node runtime/scripts/skills-diff.mjs            # dry-run report
//   node runtime/scripts/skills-diff.mjs --apply    # copy net-new into skills/
//   node runtime/scripts/skills-diff.mjs --json     # emit JSON report

import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUR_SKILLS = join(ROOT, "skills");
const VENDORED_ECC = join(ROOT, "vendored", "everything-claude-code", "skills");
const VENDORED_ECC_CLAUDE = join(ROOT, "vendored", "everything-claude-code", ".claude", "skills");

const APPLY = process.argv.includes("--apply");
const JSON_OUT = process.argv.includes("--json");

// Stem normalization: strip common method prefixes/suffixes and split tokens.
function stem(name) {
  return name
    .toLowerCase()
    .replace(/^methodology-/, "")
    .replace(/-workflow$/, "")
    .replace(/-patterns$/, "")
    .replace(/-method$/, "");
}

function listSkillDirs(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => {
      const p = join(root, n);
      try {
        return statSync(p).isDirectory() && existsSync(join(p, "SKILL.md"));
      } catch {
        return false;
      }
    });
}

const ours = listSkillDirs(OUR_SKILLS);
const ourStems = new Set(ours.map(stem));

const eccTop = listSkillDirs(VENDORED_ECC);
const eccClaude = listSkillDirs(VENDORED_ECC_CLAUDE);

// Prefer top-level ECC skills when both exist (top-level is upstream source-of-truth).
const eccUnion = new Map();
for (const n of eccTop) eccUnion.set(n, join(VENDORED_ECC, n));
for (const n of eccClaude) if (!eccUnion.has(n)) eccUnion.set(n, join(VENDORED_ECC_CLAUDE, n));

const buckets = { duplicate: [], "near-duplicate": [], "net-new": [] };
for (const [name, srcPath] of eccUnion) {
  const s = stem(name);
  if (ours.includes(name)) buckets.duplicate.push({ name, srcPath });
  else if (ourStems.has(s)) buckets["near-duplicate"].push({ name, srcPath, ourStemMatch: s });
  else buckets["net-new"].push({ name, srcPath });
}

if (JSON_OUT) {
  console.log(JSON.stringify({ ours: ours.length, ecc: eccUnion.size, ...buckets }, null, 2));
  process.exit(0);
}

console.log(`Our skills:      ${ours.length}`);
console.log(`ECC skills:      ${eccUnion.size}`);
console.log(`  duplicates:    ${buckets.duplicate.length}`);
console.log(`  near-dupes:    ${buckets["near-duplicate"].length}`);
console.log(`  net-new:       ${buckets["net-new"].length}`);

if (buckets.duplicate.length) {
  console.log(`\n[duplicate] (skip — exact name match in our skills/):`);
  for (const x of buckets.duplicate) console.log(`  - ${x.name}`);
}
if (buckets["near-duplicate"].length) {
  console.log(`\n[near-duplicate] (skip — stem matches an existing skill, hand-merge if interesting):`);
  for (const x of buckets["near-duplicate"]) console.log(`  - ${x.name}  (matches stem "${x.ourStemMatch}")`);
}
if (!APPLY) {
  console.log(`\n[net-new] (would import ${buckets["net-new"].length} skills with --apply):`);
  for (const x of buckets["net-new"]) console.log(`  + ${x.name}`);
  console.log(`\nDry-run only. Re-run with --apply to copy into skills/.`);
  process.exit(0);
}

let copied = 0;
let sourceTagged = 0;
for (const { name, srcPath } of buckets["net-new"]) {
  const dest = join(OUR_SKILLS, name);
  if (existsSync(dest)) continue;
  cpSync(srcPath, dest, { recursive: true });
  copied++;

  // Tag SKILL.md frontmatter with provenance line.
  const skillMd = join(dest, "SKILL.md");
  if (existsSync(skillMd)) {
    const txt = readFileSync(skillMd, "utf8");
    const fmMatch = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch && !fmMatch[1].includes("source:")) {
      const rel = srcPath.replace(ROOT + "\\", "").replace(ROOT + "/", "").replaceAll("\\", "/");
      const tagged = txt.replace(/^---\r?\n/, `---\nsource: ${rel}\n`);
      writeFileSync(skillMd, tagged);
      sourceTagged++;
    }
  }
}
console.log(`\n[apply] copied ${copied} skills, tagged ${sourceTagged} with source: provenance.`);

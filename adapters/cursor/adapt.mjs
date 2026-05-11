#!/usr/bin/env node
// Convert agent-daemon SKILL.md → Cursor MDC rule (.mdc).
//
// Cursor's rule format (https://docs.cursor.com/context/rules):
//   ---
//   description: "<trigger phrase>"
//   alwaysApply: false
//   ---
//   # Skill body...
//
// Our SKILL.md format:
//   ---
//   name: <kebab-case>
//   description: Use when ...  (≤500 chars, starts with trigger phrase)
//   [optional] source: vendored/...     ← vendored skills
//   ---
//   # Skill body...
//
// Usage:
//   node adapters/cursor/adapt.mjs <skill-dir>              # one skill -> stdout
//   node adapters/cursor/adapt.mjs --all --out .cursor/rules  # batch all of skills/
//   node adapters/cursor/adapt.mjs --core --out .cursor/rules # only our 36 core skills (skip vendored)

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SKILLS_DIR = join(REPO_ROOT, "skills");

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return { fields, body: m[2] };
}

function escapeYamlDouble(s) {
  // Cursor's MDC frontmatter is YAML-ish. Use double-quoted scalar; escape
  // double-quote and backslash, collapse newlines into spaces.
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ").trim();
}

export function skillToMdc(skillMdPath) {
  const text = readFileSync(skillMdPath, "utf8");
  const parsed = parseFrontmatter(text);
  if (!parsed) throw new Error(`no frontmatter in ${skillMdPath}`);

  const name = parsed.fields.name || basename(dirname(skillMdPath));
  const description = parsed.fields.description || "";
  if (!description) throw new Error(`${name}: missing description in frontmatter`);

  // Cursor caps description at ~250 chars practically; we cap at 400 for safety.
  const trimmed = description.length > 400 ? description.slice(0, 397) + "..." : description;

  const out = [
    "---",
    `description: "${escapeYamlDouble(trimmed)}"`,
    "alwaysApply: false",
    "---",
    "",
    parsed.body.trimEnd(),
    "",
  ].join("\n");

  return { name, mdc: out };
}

function listSkillDirs() {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR).filter((entry) => {
    const p = join(SKILLS_DIR, entry);
    try {
      return statSync(p).isDirectory() && existsSync(join(p, "SKILL.md"));
    } catch {
      return false;
    }
  });
}

function isVendored(skillMdPath) {
  try {
    return /^source:\s*\S/m.test(readFileSync(skillMdPath, "utf8"));
  } catch {
    return false;
  }
}

function main(argv) {
  const args = argv.slice(2);
  const all = args.includes("--all");
  const coreOnly = args.includes("--core");
  const outIdx = args.indexOf("--out");
  const outDir = outIdx >= 0 ? args[outIdx + 1] : null;
  const target = args.find((a) => a && !a.startsWith("--") && (outIdx < 0 || args.indexOf(a) !== outIdx + 1));

  if (!all && !coreOnly && !target) {
    console.error("usage: adapt.mjs <skill-dir> | --all [--out <dir>] | --core [--out <dir>]");
    process.exit(2);
  }

  if (all || coreOnly) {
    const names = listSkillDirs().filter((n) => {
      if (!coreOnly) return true;
      return !isVendored(join(SKILLS_DIR, n, "SKILL.md"));
    });
    if (!outDir) {
      console.error("--all / --core require --out <dir>");
      process.exit(2);
    }
    mkdirSync(outDir, { recursive: true });
    let count = 0;
    for (const n of names) {
      const path = join(SKILLS_DIR, n, "SKILL.md");
      try {
        const { mdc } = skillToMdc(path);
        writeFileSync(join(outDir, `${n}.mdc`), mdc);
        count++;
      } catch (err) {
        console.error(`[skip] ${n}: ${err.message}`);
      }
    }
    console.error(`wrote ${count} .mdc rules to ${outDir}`);
    return 0;
  }

  // Single-skill mode.
  const skillPath = target.endsWith("SKILL.md") ? target : join(target, "SKILL.md");
  const resolved = resolve(skillPath);
  if (!existsSync(resolved)) {
    console.error(`no SKILL.md at ${resolved}`);
    return 1;
  }
  const { mdc } = skillToMdc(resolved);
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    const name = basename(dirname(resolved));
    writeFileSync(join(outDir, `${name}.mdc`), mdc);
    console.error(`wrote ${outDir}/${name}.mdc`);
  } else {
    process.stdout.write(mdc);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1].endsWith("adapt.mjs")) {
  process.exit(main(process.argv) || 0);
}

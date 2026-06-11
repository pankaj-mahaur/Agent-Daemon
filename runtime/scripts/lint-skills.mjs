#!/usr/bin/env node
// Lint SKILL.md files against the agentskills.io spec (obra/superpowers compatible).
//
// Validation rules live in runtime/src/skill-lint.mjs (shared with
// `ad skill install` and the route-map compiler). This script is the CI
// reporter: walks the skills dir, prints per-skill results, exits non-zero
// on errors.
//
// Usage:
//   node runtime/scripts/lint-skills.mjs [skills-dir]
//   npm run lint:skills

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSkill, collectSkillEntries } from "../src/skill-lint.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_SKILLS_DIR = path.resolve(__dirname, "..", "..", "skills");

async function lintSkills(skillsDir) {
  const entries = await collectSkillEntries(skillsDir);
  const knownSkills = new Set(entries.map(e => e.name));
  let errors = 0;
  let warnings = 0;
  let checked = 0;

  for (const entry of entries) {
    const skillMd = path.join(entry.dir, "SKILL.md");
    let content;
    try {
      content = await fs.readFile(skillMd, "utf8");
    } catch {
      continue;
    }
    // Skip vendored upstream skills — they follow their own conventions, traceable via `source:` frontmatter.
    if (/^source:\s*\S/m.test(content)) {
      console.log(`  -  ${entry.label} (vendored, skipped)`);
      continue;
    }
    checked++;

    const issues = validateSkill(entry.name, content);

    // Flow skills (composite workflows): `- uses: \`skill\`` step references
    // should resolve to a bundled skill. Built-ins and user-installed skills
    // legitimately live outside the bundle, so unknowns warn rather than fail
    // — the flow body already handles the not-installed case at runtime.
    if (entry.name.endsWith("-flow")) {
      const KNOWN_EXTERNAL = new Set(["verify", "run", "review", "code-review"]);
      for (const m of content.matchAll(/^- uses:\s*`?([a-z0-9-]+)`?\s*$/gm)) {
        if (!knownSkills.has(m[1]) && !KNOWN_EXTERNAL.has(m[1])) {
          issues.push({ severity: "warning", message: `flow step references skill \`${m[1]}\` not in this bundle (built-in or user-installed?)` });
        }
      }
    }
    for (const issue of issues) {
      const prefix = issue.severity === "error" ? "  ✗" : "  ⚠";
      console.log(`${prefix}  ${entry.label}: ${issue.message}`);
      if (issue.severity === "error") errors++;
      else warnings++;
    }
    if (issues.length === 0) {
      console.log(`  ✓  ${entry.label}`);
    }
  }

  console.log(`\nChecked ${checked} skills: ${errors} error(s), ${warnings} warning(s)`);
  return errors > 0 ? 1 : 0;
}

const skillsDir = process.argv[2] || DEFAULT_SKILLS_DIR;
console.log(`Linting skills in: ${skillsDir}\n`);
lintSkills(skillsDir).then(code => process.exit(code));

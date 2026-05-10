#!/usr/bin/env node
// Lint SKILL.md files against the agentskills.io spec (obra/superpowers compatible).
//
// Spec constraints:
//   - name: kebab-case
//   - description: starts with "Use when"/"Use for"/"Use whenever" (third-person trigger), ≤500 chars
//   - Total frontmatter ≤1024 chars
//   - No workflow summary in description — only triggering conditions
//
// Usage:
//   node runtime/scripts/lint-skills.mjs [skills-dir]
//   npm run lint:skills

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_SKILLS_DIR = path.resolve(__dirname, "..", "..", "skills");

const KEBAB_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const TRIGGER_START_RE = /^Use\s+(when|for|whenever|only when|if|to)\b/i;
const TRIGGER_CONTAINS_RE = /\bUse\s+(when|for|whenever|only when|if|to)\b/i;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_FRONTMATTER_CHARS = 1024;

async function lintSkills(skillsDir) {
  const entries = await fs.readdir(skillsDir);
  let errors = 0;
  let warnings = 0;
  let checked = 0;

  for (const entry of entries.sort()) {
    const skillMd = path.join(skillsDir, entry, "SKILL.md");
    let content;
    try {
      content = await fs.readFile(skillMd, "utf8");
    } catch {
      continue;
    }
    // Skip vendored upstream skills — they follow their own conventions, traceable via `source:` frontmatter.
    if (/^source:\s*\S/m.test(content)) {
      console.log(`  -  ${entry} (vendored, skipped)`);
      continue;
    }
    checked++;

    const issues = validateSkill(entry, content);
    for (const issue of issues) {
      const prefix = issue.severity === "error" ? "  ✗" : "  ⚠";
      console.log(`${prefix}  ${entry}: ${issue.message}`);
      if (issue.severity === "error") errors++;
      else warnings++;
    }
    if (issues.length === 0) {
      console.log(`  ✓  ${entry}`);
    }
  }

  console.log(`\nChecked ${checked} skills: ${errors} error(s), ${warnings} warning(s)`);
  return errors > 0 ? 1 : 0;
}

function validateSkill(dirName, content) {
  const issues = [];

  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) {
    issues.push({ severity: "error", message: "missing frontmatter (no --- delimiters)" });
    return issues;
  }

  const frontmatter = fmMatch[1];
  const fmBytes = fmMatch[0].length;

  // Parse YAML-ish frontmatter (simple key: value)
  const fields = {};
  for (const line of frontmatter.split("\n")) {
    const m = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (m) fields[m[1]] = m[2].trim();
  }

  // name: must be kebab-case
  const name = fields.name;
  if (!name) {
    issues.push({ severity: "error", message: "missing `name` field in frontmatter" });
  } else {
    if (!KEBAB_RE.test(name)) {
      issues.push({ severity: "error", message: `name "${name}" is not kebab-case` });
    }
    if (name !== dirName) {
      issues.push({ severity: "warning", message: `name "${name}" doesn't match directory "${dirName}"` });
    }
  }

  // description: must exist, start with trigger phrase, ≤500 chars
  const desc = fields.description;
  if (!desc) {
    issues.push({ severity: "error", message: "missing `description` field in frontmatter" });
  } else {
    if (desc.length > MAX_DESCRIPTION_CHARS) {
      issues.push({ severity: "error", message: `description is ${desc.length} chars (max ${MAX_DESCRIPTION_CHARS})` });
    }
    if (!TRIGGER_START_RE.test(desc)) {
      if (TRIGGER_CONTAINS_RE.test(desc)) {
        issues.push({ severity: "warning", message: `description contains trigger phrase but should start with "Use when/for/whenever..." (found: "${desc.slice(0, 40)}...")` });
      } else {
        issues.push({ severity: "error", message: `description must contain a trigger phrase like "Use when/for/whenever..." (found: "${desc.slice(0, 40)}...")` });
      }
    }
  }

  // Total frontmatter ≤1024 chars
  if (fmBytes > MAX_FRONTMATTER_CHARS) {
    issues.push({ severity: "warning", message: `frontmatter is ${fmBytes} chars (recommended max ${MAX_FRONTMATTER_CHARS})` });
  }

  return issues;
}

const skillsDir = process.argv[2] || DEFAULT_SKILLS_DIR;
console.log(`Linting skills in: ${skillsDir}\n`);
lintSkills(skillsDir).then(code => process.exit(code));

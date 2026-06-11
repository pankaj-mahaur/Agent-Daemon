// Shared SKILL.md validation — agentskills.io spec (obra/superpowers compatible).
//
// Extracted from runtime/scripts/lint-skills.mjs so `ad skill install` and the
// route-map compiler can reuse the exact same rules the CI linter enforces.
// The script remains a thin reporter wrapper around these exports.
//
// Spec constraints:
//   - name: kebab-case
//   - description: starts with "Use when"/"Use for"/"Use whenever" (third-person trigger), ≤500 chars
//   - Total frontmatter ≤1024 chars
//   - No workflow summary in description — only triggering conditions

import fs from "node:fs/promises";
import path from "node:path";
import { BUCKETS as BUCKET_LIST } from "./skills-source.mjs";

export const BUCKETS = new Set(BUCKET_LIST);

const KEBAB_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const TRIGGER_START_RE = /^Use\s+(when|for|whenever|only when|if|to)\b/i;
const TRIGGER_CONTAINS_RE = /\bUse\s+(when|for|whenever|only when|if|to)\b/i;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_FRONTMATTER_CHARS = 1024;

/**
 * Detect whether a YAML scalar value is safely unquoted.
 * A value is unsafe-unquoted when it contains ": " (colon-space) which YAML
 * parsers (including Claude Code's) treat as a nested key separator.
 *
 * @param {string} rawLine - the full "key: value" line from frontmatter
 * @returns {boolean}
 */
export function isUnsafeUnquotedYaml(rawLine) {
  const colonIdx = rawLine.indexOf(": ");
  if (colonIdx === -1) return false;
  const value = rawLine.slice(colonIdx + 2).trim();
  // Already quoted — safe.
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) return false;
  // Block/folded scalar — safe (handled by multi-line YAML).
  if (value === "|" || value === ">" || value === "") return false;
  // Unsafe: unquoted value contains ": " which breaks YAML key detection.
  return value.includes(": ");
}

/**
 * Parse simple key:value frontmatter from a SKILL.md. Returns null when the
 * file has no frontmatter delimiters at all.
 *
 * @param {string} content
 * @returns {{ fields: Record<string, string>, fmBytes: number, yamlIssues: Array<{severity: string, message: string}> } | null}
 */
export function parseFrontmatter(content) {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return null;

  const frontmatter = fmMatch[1];
  const fmBytes = fmMatch[0].length;
  const fields = {};
  const yamlIssues = [];
  for (const line of frontmatter.split("\n")) {
    const m = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (m) fields[m[1]] = m[2].trim();
    // Catch unquoted values containing ": " which YAML parsers treat as nested keys.
    // This is the exact pattern that causes Claude Code startup warnings.
    if (m && isUnsafeUnquotedYaml(line)) {
      yamlIssues.push({
        severity: "error",
        message: `field \`${m[1]}\` has an unquoted value containing ": " — YAML parsers will split this into a nested key. Wrap the value in quotes or replace ": " with " — ".`,
      });
    }
  }
  return { fields, fmBytes, yamlIssues };
}

/**
 * Strip surrounding quotes from a frontmatter scalar.
 *
 * @param {string} v
 * @returns {string}
 */
export function unquote(v) {
  return String(v || "").replace(/^["']|["']$/g, "");
}

/**
 * Validate one SKILL.md against the spec.
 *
 * @param {string} dirName - the skill's directory name
 * @param {string} content - full SKILL.md content
 * @returns {Array<{severity: 'error'|'warning', message: string}>}
 */
export function validateSkill(dirName, content) {
  const parsed = parseFrontmatter(content);
  if (!parsed) {
    return [{ severity: "error", message: "missing frontmatter (no --- delimiters)" }];
  }

  const issues = [...parsed.yamlIssues];
  const { fields, fmBytes } = parsed;

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

  // description: must exist, start with trigger phrase, ≤500 chars.
  // Quoted YAML scalars are tested on their UNQUOTED value — `"Use when..."`
  // is correct authoring and must not warn about the leading quote.
  const desc = fields.description ? unquote(fields.description) : "";
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

  // argument-hint: optional, must be a non-empty string ≤200 chars (Claude Code surfaces it on /skill <name>)
  if ("argument-hint" in fields) {
    const hint = unquote(fields["argument-hint"]);
    if (!hint) {
      issues.push({ severity: "error", message: "`argument-hint` is empty (omit the field if no args)" });
    } else if (hint.length > 200) {
      issues.push({ severity: "warning", message: `argument-hint is ${hint.length} chars (recommended max 200)` });
    }
  }

  // disable-model-invocation: optional, must be a literal `true` or `false` (Claude Code reads it to gate auto-routing)
  if ("disable-model-invocation" in fields) {
    const v = fields["disable-model-invocation"];
    if (v !== "true" && v !== "false") {
      issues.push({ severity: "error", message: `disable-model-invocation must be "true" or "false" (found: "${v}")` });
    }
  }

  return issues;
}

/**
 * Walk a skills dir (flat and bucketed) and return entries to lint.
 *
 * @param {string} skillsDir
 * @returns {Promise<Array<{name: string, dir: string, label: string}>>}
 */
export async function collectSkillEntries(skillsDir) {
  const out = [];
  let topEntries;
  try {
    topEntries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch { return out; }

  for (const e of topEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    if (BUCKETS.has(e.name)) {
      const bucketPath = path.join(skillsDir, e.name);
      let inner;
      try { inner = await fs.readdir(bucketPath, { withFileTypes: true }); }
      catch { continue; }
      for (const skill of inner.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!skill.isDirectory()) continue;
        out.push({ name: skill.name, dir: path.join(bucketPath, skill.name), label: `${e.name}/${skill.name}` });
      }
    } else {
      out.push({ name: e.name, dir: path.join(skillsDir, e.name), label: e.name });
    }
  }
  return out;
}

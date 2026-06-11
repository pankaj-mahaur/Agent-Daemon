// Compiled route maps — data-driven skill routing from installed skills.
//
// The capability-route-advice hook historically matched 5 hardcoded patterns.
// This module compiles a route map from EVERY installed skill's frontmatter:
//   - `routing-triggers:` (comma-separated, explicit — takes precedence)
//   - otherwise: double-quoted phrases extracted from the description
//     (descriptions conventionally enumerate trigger phrases in quotes)
//   - `disable-model-invocation: true` opts a skill out entirely
//
// Compiled artifacts (one per install lane):
//   ~/.agent-daemon/route-map.json            ← from ~/.claude/skills/
//   <project>/.agent-daemon/route-map.json    ← from <project>/.claude/skills/
//
// Recompiled by `ad init`, `ad skill install|remove`, and `ad route rebuild`.
// The hook reads the two JSON files (project shadows global) — two single
// file reads keep it far inside its 3s timeout. Deterministic, no LLM.

import fs from "node:fs/promises";
import path from "node:path";
import { buildSkillIndex } from "./skills-source.mjs";
import { parseFrontmatter, unquote } from "./skill-lint.mjs";

const MAX_TRIGGERS_PER_SKILL = 24;
const MIN_PHRASE_CHARS = 3;
const MAX_PHRASE_CHARS = 60;

/**
 * Extract trigger phrases from a skill description: every double-quoted span
 * of 3–60 chars containing at least one letter. Deterministic; returns [] when
 * nothing extractable (the skill simply isn't auto-routed — status quo).
 *
 * @param {string} description
 * @returns {string[]} lowercased, deduped
 */
export function extractTriggerPhrases(description) {
  const out = new Set();
  const re = /"([^"\n]{3,60})"/g;
  let m;
  while ((m = re.exec(String(description || ""))) !== null) {
    const phrase = m[1].trim().toLowerCase();
    if (phrase.length < MIN_PHRASE_CHARS || phrase.length > MAX_PHRASE_CHARS) continue;
    if (!/\p{L}/u.test(phrase)) continue;
    out.add(phrase);
    if (out.size >= MAX_TRIGGERS_PER_SKILL) break;
  }
  return [...out];
}

/**
 * Compile a route map from one installed-skills lane directory.
 *
 * @param {string} skillsLaneDir - e.g. ~/.claude/skills or <project>/.claude/skills
 * @param {{ lane: 'global'|'project' }} opts
 * @returns {Promise<Array<{skill: string, triggers: string[], tier: string, note: string, lane: string}>>}
 */
export async function compileRouteMapForDir(skillsLaneDir, { lane }) {
  let index;
  try {
    index = await buildSkillIndex(skillsLaneDir);
  } catch {
    return [];
  }

  const entries = [];
  for (const [skill, dir] of index) {
    let content;
    try {
      content = await fs.readFile(path.join(dir, "SKILL.md"), "utf8");
    } catch { continue; }

    const parsed = parseFrontmatter(content);
    if (!parsed) continue;
    const { fields } = parsed;
    if (fields["disable-model-invocation"] === "true") continue;
    if (fields.status === "deprecated") continue;

    // YAML double-quoted scalars escape inner quotes as \" — unescape so the
    // quoted-phrase extractor sees real quotes (the daemon's own skills use
    // this escaping).
    const desc = unquote(fields.description || "").replace(/\\"/g, '"');

    const explicit = unquote(fields["routing-triggers"] || "");
    const triggers = explicit
      ? explicit.split(",").map(t => t.trim().toLowerCase()).filter(t => t.length >= MIN_PHRASE_CHARS && t.length <= MAX_PHRASE_CHARS).slice(0, MAX_TRIGGERS_PER_SKILL)
      : extractTriggerPhrases(desc);
    if (triggers.length === 0) continue;
    const firstSentence = desc.split(/(?<=[.!?])\s/)[0] || desc;
    entries.push({
      skill,
      triggers,
      tier: "substantial",
      note: firstSentence.slice(0, 140),
      lane
    });
  }

  // Deterministic output: longest max-trigger first (more specific phrases
  // win first-match-wins ordering), then name.
  entries.sort((a, b) => {
    const aMax = Math.max(...a.triggers.map(t => t.length));
    const bMax = Math.max(...b.triggers.map(t => t.length));
    return bMax - aMax || a.skill.localeCompare(b.skill);
  });
  return entries;
}

/**
 * Persist a compiled map.
 *
 * @param {Array<object>} entries
 * @param {string} outPath
 */
export async function writeRouteMap(entries, outPath) {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const doc = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    entries
  };
  await fs.writeFile(outPath, JSON.stringify(doc, null, 2), "utf8");
}

export function globalRouteMapPath(home) {
  return path.join(home, ".agent-daemon", "route-map.json");
}

export function projectRouteMapPath(cwd) {
  return path.join(cwd, ".agent-daemon", "route-map.json");
}

/**
 * Load the merged route maps: project entries first (a project skill shadows
 * a global same-name). Each file read is try/catch → [] (fail-safe: a corrupt
 * map degrades to builtin-only routing, never an error).
 *
 * @param {{ cwd?: string, home?: string }} opts
 * @returns {Promise<Array<object>>}
 */
export async function loadRouteMaps({ cwd, home }) {
  const out = [];
  const seen = new Set();
  const paths = [
    cwd ? projectRouteMapPath(cwd) : null,
    home ? globalRouteMapPath(home) : null
  ].filter(Boolean);

  for (const p of paths) {
    try {
      const doc = JSON.parse(await fs.readFile(p, "utf8"));
      for (const entry of doc.entries || []) {
        if (!entry?.skill || !Array.isArray(entry.triggers) || entry.triggers.length === 0) continue;
        if (seen.has(entry.skill)) continue;  // project shadows global
        seen.add(entry.skill);
        out.push(entry);
      }
    } catch { /* missing/corrupt map — skip lane */ }
  }
  return out;
}

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

/**
 * Compile an entry's triggers into one case-insensitive word-bounded regex.
 * Lookarounds instead of \b — triggers can end in non-word chars ("c++",
 * "(weird)") where \b can never match. Cached on the entry object.
 *
 * @param {{ triggers: string[], _re?: RegExp }} entry
 * @returns {RegExp}
 */
export function compileEntryRegex(entry) {
  if (entry._re) return entry._re;
  const alts = entry.triggers.map(t => t.replace(ESCAPE_RE, "\\$&")).join("|");
  entry._re = new RegExp(`(?<![\\w])(?:${alts})(?![\\w])`, "i");
  return entry._re;
}

/**
 * Compile + write both lane maps. Shared by init, skill install/remove, and
 * `ad route rebuild`.
 *
 * @param {{ home: string, cwd?: string }} opts
 * @returns {Promise<{ global: number, project: number | null }>} entry counts
 */
export async function rebuildRouteMaps({ home, cwd }) {
  const globalEntries = await compileRouteMapForDir(path.join(home, ".claude", "skills"), { lane: "global" });
  await writeRouteMap(globalEntries, globalRouteMapPath(home));

  let projectCount = null;
  if (cwd) {
    const projectLane = path.join(cwd, ".claude", "skills");
    let hasLane = false;
    try { await fs.access(projectLane); hasLane = true; } catch { /* no project lane */ }
    if (hasLane) {
      const projectEntries = await compileRouteMapForDir(projectLane, { lane: "project" });
      await writeRouteMap(projectEntries, projectRouteMapPath(cwd));
      projectCount = projectEntries.length;
    }
  }
  return { global: globalEntries.length, project: projectCount };
}

// Resolve skill names to source paths under repo `skills/`.
//
// Supports both layouts during the bucket-reorg transition:
//   - Flat:     skills/<name>/SKILL.md           (legacy + vendored)
//   - Bucketed: skills/<bucket>/<name>/SKILL.md  (post-C1 for non-vendored)
//
// Skill names in profiles.json + at install time are always bare ("audit-runner").
// Callers don't need to know which bucket a skill lives in.
//
// Build an in-memory map once per process, then `resolveSkillSource(name)` is O(1).

import fs from "node:fs/promises";
import path from "node:path";

// Bucket names recognised as containers for skills. Any directory under
// `skills/` not in this list is treated as a flat skill (legacy/vendored).
const BUCKETS = ["engineering", "productivity", "daemon", "domain", "deprecated", "in-progress"];

/**
 * Build a Map<name, absolutePath> for every skill found under `skillsRoot`.
 * Both flat and bucketed layouts are scanned. If a name appears in both
 * (shouldn't happen in practice), the bucketed path wins.
 */
export async function buildSkillIndex(skillsRoot) {
  const index = new Map();

  let topEntries;
  try {
    topEntries = await fs.readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return index;
  }

  // First pass — flat skills (any directory with a SKILL.md directly inside).
  for (const e of topEntries) {
    if (!e.isDirectory()) continue;
    if (BUCKETS.includes(e.name)) continue;
    const skillMd = path.join(skillsRoot, e.name, "SKILL.md");
    try {
      await fs.access(skillMd);
      index.set(e.name, path.join(skillsRoot, e.name));
    } catch { /* not a skill dir — skip */ }
  }

  // Second pass — bucketed skills (overrides flat hits with same name).
  for (const e of topEntries) {
    if (!e.isDirectory()) continue;
    if (!BUCKETS.includes(e.name)) continue;
    const bucketPath = path.join(skillsRoot, e.name);
    let bucketEntries;
    try {
      bucketEntries = await fs.readdir(bucketPath, { withFileTypes: true });
    } catch { continue; }
    for (const skill of bucketEntries) {
      if (!skill.isDirectory()) continue;
      const skillMd = path.join(bucketPath, skill.name, "SKILL.md");
      try {
        await fs.access(skillMd);
        index.set(skill.name, path.join(bucketPath, skill.name));
      } catch { /* not a skill dir — skip */ }
    }
  }

  return index;
}

/**
 * Resolve a single skill name to its source path. Returns null if not found.
 * Wraps `buildSkillIndex` for callers that only need one lookup.
 */
export async function resolveSkillSource(skillsRoot, skillName) {
  const index = await buildSkillIndex(skillsRoot);
  return index.get(skillName) ?? null;
}

export { BUCKETS };

// File-conflict pre-detection across team tasks.
//
// When multiple agents work on the same team's tasks in parallel (different
// git worktrees but same logical codebase), modifying overlapping files
// guarantees a painful merge later. The cheap heuristic is to scan task
// descriptions for file-path mentions and flag pairs that are NOT in a
// dependency chain.
//
// This is a heuristic, not a guarantee — task descriptions are human prose
// and may omit file paths. False negatives are common; false positives are
// rare (we only flag explicit path mentions).

const PATH_PATTERN = /(?:^|[\s`"(<])((?:src|app|lib|runtime|skills|teams|components|hooks|services|tests?|spec|api|routes|pages|public|templates|static)\/[\w./\-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|json|md|css|scss|html|yml|yaml|toml|sql|sh|rs|go|java|kt|swift|dart|rb|php))(?=[\s`")>,;:]|$)/gi;

/**
 * Extract file paths mentioned in a task description / instructions string.
 *
 * @param {string} text
 * @returns {Set<string>} normalised path set
 */
export function extractPaths(text) {
  const paths = new Set();
  if (!text || typeof text !== "string") return paths;
  // Normalise Windows backslashes BEFORE matching so the regex (which uses
  // forward-slash) works on cross-platform prose.
  const normalised = text.replace(/\\/g, "/");
  const matches = normalised.matchAll(PATH_PATTERN);
  for (const m of matches) {
    const p = m[1]
      .replace(/^[\.\/]+/, "") // strip leading ./
      .toLowerCase();
    paths.add(p);
  }
  return paths;
}

/**
 * @typedef {Object} ConflictReport
 * @property {string} taskA            - task id (or title if id missing)
 * @property {string} taskB            - task id (or title)
 * @property {string[]} overlappingPaths
 */

/**
 * Detect overlapping file paths between unordered task pairs.
 *
 * A "chain" is task A → blocked_by → B (B runs before A) — in that case
 * they don't actually conflict because they run sequentially. Only pairs
 * with NO dependency relation (either direction) are flagged.
 *
 * @param {Array<{ id?: string, title?: string, description?: string, blockedBy?: string[], blocked_by?: string[] }>} tasks
 * @returns {ConflictReport[]}
 */
export function detectConflicts(tasks) {
  if (!Array.isArray(tasks) || tasks.length < 2) return [];

  // Pre-compute path sets + dependency map
  const meta = tasks.map(t => {
    const text  = [t.description, t.title, t.instructions].filter(Boolean).join("\n");
    const paths = extractPaths(text);
    const blockers = new Set([...(t.blockedBy || []), ...(t.blocked_by || [])]);
    return { id: t.id || t.title || "(unnamed)", paths, blockers };
  });

  // Build transitive blocker map so chained deps don't flag
  const blockerMap = new Map();
  for (const m of meta) blockerMap.set(m.id, new Set(m.blockers));
  // (We don't compute full transitive closure here — direct dep check is
  // sufficient for the common case; over-flagging on indirect chains
  // is acceptable.)

  const reports = [];
  for (let i = 0; i < meta.length; i++) {
    const a = meta[i];
    if (a.paths.size === 0) continue;
    for (let j = i + 1; j < meta.length; j++) {
      const b = meta[j];
      if (b.paths.size === 0) continue;

      // Skip if one task blocks the other (they run sequentially)
      if (blockerMap.get(a.id)?.has(b.id)) continue;
      if (blockerMap.get(b.id)?.has(a.id)) continue;

      // Find overlapping paths
      const overlap = [...a.paths].filter(p => b.paths.has(p));
      if (overlap.length > 0) {
        reports.push({
          taskA: a.id,
          taskB: b.id,
          overlappingPaths: overlap.sort()
        });
      }
    }
  }

  return reports;
}

/**
 * Format a conflict report as a multi-line human-readable warning.
 *
 * @param {ConflictReport[]} reports
 * @returns {string}
 */
export function formatConflicts(reports) {
  if (!reports || reports.length === 0) return "";
  const lines = [`⚠ File-conflict pre-detection — ${reports.length} potential overlap(s):`];
  for (const r of reports) {
    lines.push(`  ${r.taskA}  ↔  ${r.taskB}`);
    for (const p of r.overlappingPaths) {
      lines.push(`    · ${p}`);
    }
  }
  lines.push("");
  lines.push("These tasks may modify the same files in parallel. Consider:");
  lines.push("  1. Add `blocked_by` to make one wait for the other");
  lines.push("  2. Reassign one task to a different file scope");
  lines.push("  3. Proceed anyway — heuristic-only, may be a false positive");
  return lines.join("\n");
}

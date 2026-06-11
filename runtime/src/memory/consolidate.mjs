// Memory consolidation — the Hermes-style evolution pass (`ad memory consolidate`).
//
// Deterministic, no LLM. Three sweeps over the learnings table:
//   1. Near-duplicate merge candidates: same category + project scope, token
//      Jaccard ≥ 0.8 → proposal to keep the highest-confidence survivor and
//      mark the rest superseded (observed_count summed onto the survivor).
//   2. Stale-archive candidates: not retrieved or verified in 90 days AND
//      confidence < 0.4 → proposal to archive.
//   3. Contradiction candidates (conservative): two active learnings in the
//      same category+project where one is the negation of the other
//      ("X" vs "not/never/don't X") → flagged for review.
//
// NOTHING auto-applies. Every finding becomes a proposal markdown in
// <cwd>/.agent-daemon/proposed/ gated by `ad review` — the user stays the
// acceptance gate. `--apply` executes accepted merge/archive actions from a
// previously reviewed run (used by review tooling later).

import fs from "node:fs/promises";
import path from "node:path";
import { db } from "./episodic.mjs";

const JACCARD_THRESHOLD = 0.8;
const STALE_DAYS = 90;
const STALE_CONFIDENCE = 0.4;
const MAX_CLUSTER_SCAN = 2000;  // most-recent rows scanned per run — keeps the pass O(bounded)

const NEGATION_RE = /\b(not|never|don'?t|no longer|avoid|stop)\b/i;

/**
 * Porter-free token set (lowercased word chars ≥3 long).
 * @param {string} text
 * @returns {Set<string>}
 */
function tokens(text) {
  return new Set((String(text).toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) || []));
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Run the consolidation analysis.
 *
 * @param {{ projectSlug?: string | null }} [opts] - limit to one project (null/undefined = all)
 * @returns {Promise<{
 *   driver: boolean,
 *   scanned: number,
 *   mergeClusters: Array<{ survivor: object, duplicates: object[], similarity: number }>,
 *   staleCandidates: object[],
 *   contradictions: Array<{ a: object, b: object }>
 * }>}
 */
export async function analyzeConsolidation(opts = {}) {
  const handle = await db();
  if (!handle) return { driver: false, scanned: 0, mergeClusters: [], staleCandidates: [], contradictions: [] };

  let where = "status = 'active'";
  const params = [];
  if (opts.projectSlug) {
    where += " AND project_slug = ?";
    params.push(opts.projectSlug);
  }

  const rows = handle.all(
    `SELECT id, project_slug, category, text, confidence, observed_count,
            retrieval_count, last_retrieved_at, last_verified_at, created_at
       FROM learnings
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ?`,
    [...params, MAX_CLUSTER_SCAN]
  );

  // 1. Near-duplicate clusters within (category, project_slug) groups.
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.category}|${r.project_slug || ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...r, _tokens: tokens(r.text) });
  }

  const mergeClusters = [];
  const clustered = new Set();
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      if (clustered.has(group[i].id)) continue;
      const cluster = [group[i]];
      for (let j = i + 1; j < group.length; j++) {
        if (clustered.has(group[j].id)) continue;
        const sim = jaccard(group[i]._tokens, group[j]._tokens);
        if (sim >= JACCARD_THRESHOLD) cluster.push({ ...group[j], _sim: sim });
      }
      if (cluster.length > 1) {
        // Survivor: highest confidence, tie-break most-observed then oldest (stable id)
        const sorted = [...cluster].sort((a, b) =>
          b.confidence - a.confidence ||
          (b.observed_count || 1) - (a.observed_count || 1) ||
          a.id - b.id
        );
        const survivor = sorted[0];
        const duplicates = sorted.slice(1);
        for (const c of cluster) clustered.add(c.id);
        mergeClusters.push({
          survivor: strip(survivor),
          duplicates: duplicates.map(strip),
          similarity: Math.min(...duplicates.map(d => d._sim ?? 1))
        });
      }
    }
  }

  // 2. Stale candidates.
  const staleCutoff = new Date(Date.now() - STALE_DAYS * 86400000).toISOString();
  const staleCandidates = rows
    .filter(r =>
      r.confidence < STALE_CONFIDENCE &&
      (r.last_retrieved_at || r.created_at) < staleCutoff &&
      (r.last_verified_at || r.created_at) < staleCutoff &&
      !clustered.has(r.id)
    )
    .map(strip);

  // 3. Conservative contradictions: one text negates the other within a group.
  const contradictions = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const aNeg = NEGATION_RE.test(a.text);
        const bNeg = NEGATION_RE.test(b.text);
        if (aNeg === bNeg) continue;  // both plain or both negated — not our pattern
        const pos = aNeg ? b : a;
        const neg = aNeg ? a : b;
        const negStripped = tokens(neg.text.replace(NEGATION_RE, " "));
        if (jaccard(pos._tokens, negStripped) >= 0.7) {
          contradictions.push({ a: strip(pos), b: strip(neg) });
        }
      }
    }
  }

  return { driver: true, scanned: rows.length, mergeClusters, staleCandidates, contradictions };
}

function strip(row) {
  const { _tokens, _sim, ...rest } = row;
  return rest;
}

/**
 * Write proposal markdowns for an analysis. Returns paths written.
 *
 * @param {Awaited<ReturnType<typeof analyzeConsolidation>>} analysis
 * @param {{ cwd: string, dryRun?: boolean }} opts
 * @returns {Promise<string[]>}
 */
export async function writeConsolidationProposals(analysis, { cwd, dryRun }) {
  const proposedDir = path.join(cwd, ".agent-daemon", "proposed");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const paths = [];

  const renderRow = (r) =>
    `  - [id ${r.id}] (conf ${Number(r.confidence).toFixed(2)}, seen ${r.observed_count || 1}×, retrieved ${r.retrieval_count || 0}×) ${r.text.slice(0, 160)}`;

  if (analysis.mergeClusters.length > 0) {
    const lines = [
      "# Proposal — memory-consolidate (merge near-duplicates)",
      "",
      `_Generated: ${new Date().toISOString()}_`,
      "",
      `${analysis.mergeClusters.length} duplicate cluster(s) found (token similarity ≥ ${JACCARD_THRESHOLD}).`,
      "Accepting merges each cluster: survivor keeps the summed observed_count; duplicates become status=superseded.",
      ""
    ];
    for (const c of analysis.mergeClusters) {
      lines.push(`## Cluster (similarity ${(c.similarity * 100).toFixed(0)}%)`);
      lines.push("", "KEEP:", renderRow(c.survivor), "", "SUPERSEDE:");
      for (const d of c.duplicates) lines.push(renderRow(d));
      lines.push("");
    }
    lines.push("## Action", "", "Apply with: `ad memory consolidate --apply-merges` — or reject by deleting this file.", "");
    const p = path.join(proposedDir, `memory-consolidate-merges-${stamp}.md`);
    if (!dryRun) {
      await fs.mkdir(proposedDir, { recursive: true });
      await fs.writeFile(p, lines.join("\n"), "utf8");
    }
    paths.push(p);
  }

  if (analysis.staleCandidates.length > 0) {
    const lines = [
      "# Proposal — memory-consolidate (archive stale learnings)",
      "",
      `_Generated: ${new Date().toISOString()}_`,
      "",
      `${analysis.staleCandidates.length} learning(s) below confidence ${STALE_CONFIDENCE} with no retrieval/verification in ${STALE_DAYS} days:`,
      "",
      ...analysis.staleCandidates.map(renderRow),
      "",
      "## Action",
      "",
      "Apply with: `ad memory consolidate --apply-stale` — or reject by deleting this file.",
      ""
    ];
    const p = path.join(proposedDir, `memory-consolidate-stale-${stamp}.md`);
    if (!dryRun) {
      await fs.mkdir(proposedDir, { recursive: true });
      await fs.writeFile(p, lines.join("\n"), "utf8");
    }
    paths.push(p);
  }

  if (analysis.contradictions.length > 0) {
    const lines = [
      "# Proposal — memory-consolidate (possible contradictions)",
      "",
      `_Generated: ${new Date().toISOString()}_`,
      "",
      "These pairs look like one learning negates the other. Review and either",
      "mark one superseded (edit its status), merge them into a corrected fact,",
      "or delete this file if both are valid in context.",
      ""
    ];
    for (const { a, b } of analysis.contradictions) {
      lines.push("## Pair", "", renderRow(a), renderRow(b), "");
    }
    const p = path.join(proposedDir, `memory-consolidate-contradictions-${stamp}.md`);
    if (!dryRun) {
      await fs.mkdir(proposedDir, { recursive: true });
      await fs.writeFile(p, lines.join("\n"), "utf8");
    }
    paths.push(p);
  }

  return paths;
}

/**
 * Execute merge actions: survivor absorbs observed_count, duplicates →
 * status=superseded + superseded_by pointer. Used by --apply-merges after a
 * reviewed proposal.
 *
 * @param {Awaited<ReturnType<typeof analyzeConsolidation>>} analysis
 * @returns {Promise<number>} rows superseded
 */
export async function applyMerges(analysis) {
  const handle = await db();
  if (!handle) return 0;
  let superseded = 0;
  handle.transaction(() => {
    for (const c of analysis.mergeClusters) {
      const extraObserved = c.duplicates.reduce((a, d) => a + (d.observed_count || 1), 0);
      handle.run(
        `UPDATE learnings SET observed_count = observed_count + ? WHERE id = ?`,
        [extraObserved, c.survivor.id]
      );
      for (const d of c.duplicates) {
        handle.run(
          `UPDATE learnings SET status = 'superseded', superseded_by = ? WHERE id = ? AND status = 'active'`,
          [c.survivor.id, d.id]
        );
        superseded++;
      }
    }
  });
  return superseded;
}

/**
 * Execute stale-archive actions (status='archived').
 *
 * @param {Awaited<ReturnType<typeof analyzeConsolidation>>} analysis
 * @returns {Promise<number>} rows archived
 */
export async function applyStaleArchive(analysis) {
  const handle = await db();
  if (!handle) return 0;
  let archived = 0;
  handle.transaction(() => {
    for (const r of analysis.staleCandidates) {
      handle.run(`UPDATE learnings SET status = 'archived' WHERE id = ? AND status = 'active'`, [r.id]);
      archived++;
    }
  });
  return archived;
}

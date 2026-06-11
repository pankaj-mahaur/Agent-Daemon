// Routing-map evolution — deterministic metrics over skill_route_events.
//
// A second evolvable artifact class beyond skill bodies: routes whose advice
// is consistently ignored, or whose recommended skill keeps failing right
// after being advised, get demote/remove proposals. No LLM, no synthesized
// regexes — v1 only proposes removals/demotions of EXISTING entries, applied
// by editing runtime/profiles/routing-map.json (or the user override) after
// `ad review`-style human review.
//
// Data dependency: the followed/diverged/ignored correlation shipped with the
// skill-use hook. Minimum sample gates keep N=2 noise from generating churn.

import fs from "node:fs/promises";
import path from "node:path";
import { routeAdviceStats, db } from "../../memory/episodic.mjs";

const MIN_SAMPLES = 5;
const LOW_FOLLOW_RATE = 0.25;
const HIGH_FAILURE_RATE = 0.5;

/**
 * Analyze route effectiveness.
 *
 * @param {{ days?: number }} [opts]
 * @returns {Promise<{
 *   driver: boolean,
 *   findings: Array<{ skill: string, kind: string, evidence: string, suggestion: string }>
 * }>}
 */
export async function analyzeRouting({ days = 30 } = {}) {
  const stats = await routeAdviceStats({ days });
  const handle = await db();
  if (!handle) return { driver: false, findings: [] };

  const findings = [];
  for (const row of stats.rows) {
    if (row.advised < MIN_SAMPLES) continue;

    const followRate = row.followed / row.advised;
    if (followRate < LOW_FOLLOW_RATE) {
      findings.push({
        skill: row.skill,
        kind: "low-follow-rate",
        evidence: `advised ${row.advised}× in ${days}d, followed ${row.followed}× (${(followRate * 100).toFixed(0)}%), ignored ${row.ignored}×`,
        suggestion: row.diverged > row.followed
          ? `Claude consistently picks a different skill — consider re-pointing this route or removing it`
          : `advice is being ignored — narrow the trigger pattern or demote the route`
      });
    }

    // Post-advice failure: the skill was followed but then failed (per
    // skill_executions outcome within the same sessions).
    if (row.followed >= MIN_SAMPLES) {
      const fail = handle.get(
        `SELECT COUNT(*) AS n FROM skill_executions se
          WHERE se.skill_name = ?
            AND se.succeeded = 0
            AND se.created_at >= datetime('now', ?)
            AND se.session_id IN (
              SELECT session_id FROM skill_route_events
               WHERE recommended_capability = ? AND invoked_skill = ?
                 AND created_at >= datetime('now', ?)
            )`,
        [row.skill, `-${days} days`, row.skill, row.skill, `-${days} days`]
      ).n;
      const failRate = fail / row.followed;
      if (failRate >= HIGH_FAILURE_RATE) {
        findings.push({
          skill: row.skill,
          kind: "post-advice-failure",
          evidence: `followed ${row.followed}×, failed ${fail}× afterwards (${(failRate * 100).toFixed(0)}%)`,
          suggestion: `the routed skill itself is failing — run \`ad evolve ${row.skill}\` before touching the route`
        });
      }
    }
  }

  return { driver: true, findings };
}

/**
 * Write a routing-edit proposal for review.
 *
 * @param {Awaited<ReturnType<typeof analyzeRouting>>} analysis
 * @param {{ cwd: string, days: number, dryRun?: boolean }} opts
 * @returns {Promise<string | null>} proposal path
 */
export async function writeRoutingProposal(analysis, { cwd, days, dryRun }) {
  if (analysis.findings.length === 0) return null;
  const proposedDir = path.join(cwd, ".agent-daemon", "proposed");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const p = path.join(proposedDir, `routing-edit-${stamp}.md`);

  const lines = [
    "# Proposal — routing-edit",
    "",
    `_Generated: ${new Date().toISOString()}_ · window: ${days} days`,
    "",
    "Telemetry-backed route findings. Apply by editing the matching entry in",
    "`runtime/profiles/routing-map.json` (repo default) or",
    "`~/.agent-daemon/routing-map.json` (user override; takes precedence,",
    "delete it to roll back instantly). Reject by deleting this file.",
    ""
  ];
  for (const f of analysis.findings) {
    lines.push(`## ${f.skill} — ${f.kind}`, "", `- evidence: ${f.evidence}`, `- suggestion: ${f.suggestion}`, "");
  }

  if (!dryRun) {
    await fs.mkdir(proposedDir, { recursive: true });
    await fs.writeFile(p, lines.join("\n"), "utf8");
  }
  return p;
}

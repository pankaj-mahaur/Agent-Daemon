// GEPA — Genetic-Pareto Prompt Evolution.
// Self-improvement loop for SKILL.md files.
//
// Algorithm (per Agrawal et al., ICLR 2026 "Reflective Prompt Evolution Can Outperform RL"):
//
//   1. SAMPLE   — pull execution traces for this skill from the episodic store.
//                 Mix successes + failures; recent + diverse.
//   2. REFLECT  — LLM reads traces, identifies what made successes succeed and
//                 failures fail. Output: structured failure modes + improvement directions.
//   3. GENERATE — produce K candidate variants of the skill body, each addressing
//                 one or more failure modes.
//   4. EVALUATE — for each variant, simulate (or replay) on a held-out trace set,
//                 score against multiple objectives.
//   5. SELECT   — Pareto frontier across (quality, size, compat, tests).
//                 Pick the non-dominated set; from those, pick the highest-quality
//                 with size below the parent's.
//   6. PROPOSE  — write the winner as a proposal (diff against current SKILL.md)
//                 to the proposals queue. User accepts via `agent-daemon review`.
//
// v0.1 status: orchestrator skeleton + module stubs. The five sub-modules
// (sample, reflect, generate, evaluate, select) are present as stubs that
// document their I/O contracts. Wiring to headless `claude` and the SQLite
// store lands in v0.2.
//
// Inspired by Hermes Agent's self-evolution (https://github.com/NousResearch/hermes-agent-self-evolution).

import path from "node:path";
import fs from "node:fs/promises";
import { sampleTraces } from "./sample.mjs";
import { reflectOnTraces } from "./reflect.mjs";
import { generateVariants } from "./generate.mjs";
import { evaluateVariants } from "./evaluate.mjs";
import { paretoSelect } from "./select.mjs";

/**
 * @typedef {Object} EvolveOptions
 * @property {string} skillPath        - absolute path to the SKILL.md file
 * @property {string} skillName        - logical name (matches frontmatter and dir)
 * @property {number} [variantCount=8] - K candidates to generate
 * @property {number} [traceSampleSize=20]
 * @property {number} [evalHoldoutSize=10]
 * @property {string} [evalSource='sessiondb']  - 'sessiondb' | 'synthetic'
 * @property {boolean} [dryRun=false]
 * @property {boolean} [verbose=false]
 * @property {string} [proposedDir]    - where to drop the winning-variant proposal
 *
 * @typedef {Object} EvolveResult
 * @property {string} runId
 * @property {string} skillName
 * @property {Object[]} variants
 * @property {Object[]} winners
 * @property {string|null} proposalPath
 * @property {string} status           - 'no-traces' | 'no-improvement' | 'proposed' | 'error'
 * @property {string} reason
 */

/**
 * Run one full GEPA evolution pass on a single skill.
 *
 * @param {EvolveOptions} opts
 * @returns {Promise<EvolveResult>}
 */
export async function evolveSkill(opts) {
  const runId = `evolve-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const log = opts.verbose ? (msg) => console.error(`[${runId}] ${msg}`) : () => {};

  log(`evolving skill: ${opts.skillName}`);

  // Read current skill body
  let parentBody;
  try {
    parentBody = await fs.readFile(opts.skillPath, "utf8");
  } catch (err) {
    return { runId, skillName: opts.skillName, variants: [], winners: [], proposalPath: null, status: "error", reason: `cannot read skill: ${err.message}` };
  }

  // Stage 1 — sample execution traces
  log("stage 1/5 — sampling traces");
  const traces = await sampleTraces({
    skillName: opts.skillName,
    sampleSize: opts.traceSampleSize ?? 20,
    holdoutSize: opts.evalHoldoutSize ?? 10,
    source: opts.evalSource ?? "sessiondb"
  });
  if (traces.training.length === 0) {
    log("no training traces — skipping evolution");
    return { runId, skillName: opts.skillName, variants: [], winners: [], proposalPath: null, status: "no-traces", reason: "no execution traces found for this skill" };
  }

  // Stage 2 — reflect on successes vs failures
  log(`stage 2/5 — reflecting on ${traces.training.length} traces (${traces.training.filter(t => t.succeeded).length} ✓, ${traces.training.filter(t => !t.succeeded).length} ✗)`);
  const reflections = await reflectOnTraces({
    skillName: opts.skillName,
    parentBody,
    traces: traces.training,
    verbose: opts.verbose
  });

  // Stage 3 — generate candidate variants
  log(`stage 3/5 — generating ${opts.variantCount ?? 8} candidate variants`);
  const variants = await generateVariants({
    skillName: opts.skillName,
    parentBody,
    reflections,
    count: opts.variantCount ?? 8,
    verbose: opts.verbose
  });

  // Stage 4 — evaluate each variant against held-out traces
  log(`stage 4/5 — evaluating ${variants.length} variants against ${traces.holdout.length} held-out traces`);
  const scored = await evaluateVariants({
    variants,
    holdoutTraces: traces.holdout,
    parentBody,
    verbose: opts.verbose
  });

  // Stage 5 — Pareto select winners
  log("stage 5/5 — Pareto selection");
  const winners = paretoSelect(scored, parentBody);
  if (winners.length === 0) {
    log("no winning variants on the Pareto frontier — parent dominates");
    return { runId, skillName: opts.skillName, variants: scored, winners: [], proposalPath: null, status: "no-improvement", reason: "no candidate variants improved on the parent across the Pareto objectives" };
  }

  // Pick the highest-quality winner that's not larger than the parent
  const best = winners[0];

  // Write proposal
  if (opts.dryRun) {
    log(`[dry-run] would propose: ${best.variantId} (quality=${best.scores.quality}, size=${best.scores.size})`);
    return { runId, skillName: opts.skillName, variants: scored, winners, proposalPath: null, status: "proposed", reason: "dry-run; no proposal written" };
  }

  const proposedDir = opts.proposedDir || path.join(process.cwd(), ".agent-daemon", "proposed");
  await fs.mkdir(proposedDir, { recursive: true });
  const proposalPath = path.join(proposedDir, `skill-${opts.skillName}-${runId}.md`);

  const proposalContent = renderProposal({
    runId,
    skillName: opts.skillName,
    skillPath: opts.skillPath,
    parentBody,
    winner: best,
    allWinners: winners,
    reflections
  });

  await fs.writeFile(proposalPath, proposalContent, "utf8");
  log(`proposal written: ${proposalPath}`);

  return {
    runId,
    skillName: opts.skillName,
    variants: scored,
    winners,
    proposalPath,
    status: "proposed",
    reason: `${winners.length} winner(s); best variant gained quality=${best.scores.quality.toFixed(2)} (parent baseline=${best.parentBaseline.toFixed(2)})`
  };
}

function renderProposal({ runId, skillName, skillPath, parentBody, winner, allWinners, reflections }) {
  const lines = [
    `# Proposed skill update — ${skillName}`,
    "",
    `_Run id: ${runId}_  ·  _Generated: ${new Date().toISOString()}_`,
    "",
    "## Why this change",
    "",
    "GEPA evolution found this variant improves on the parent across the Pareto frontier of",
    "(task quality, size, compatibility, tests).",
    "",
    "**Reflection summary** (failure modes the variant addresses):",
    "",
    ...reflections.failureModes.map(fm => `- **${fm.title}** — ${fm.description}`),
    "",
    "## Scores",
    "",
    `| Metric         | Parent | Winner | Δ |`,
    `|---------------|--------|--------|---|`,
    `| Quality        | ${winner.parentBaseline.toFixed(2)} | ${winner.scores.quality.toFixed(2)} | ${(winner.scores.quality - winner.parentBaseline).toFixed(2)} |`,
    `| Size (chars)   | ${parentBody.length} | ${winner.scores.size} | ${winner.scores.size - parentBody.length} |`,
    `| Compat         | 1 | ${winner.scores.compat} | — |`,
    `| Tests passed   | 1 | ${winner.scores.testPass} | — |`,
    "",
    `**Total winners on frontier:** ${allWinners.length}`,
    "",
    "## To accept",
    "",
    "```bash",
    `# review the diff (proposal includes the winner body inline below)`,
    `agent-daemon review`,
    "",
    `# accept (manual for v0.1)`,
    `cp '${proposalPath_relForDoc(skillPath)}' '${skillPath}'`,
    "```",
    "",
    "## Winner body",
    "",
    "```markdown",
    winner.body,
    "```",
    "",
    "## Other Pareto winners (alternatives)",
    "",
    ...allWinners.slice(1, 4).map((w, i) => `### Alternative ${i + 1}\n\nQuality=${w.scores.quality.toFixed(2)} Size=${w.scores.size}\n\n<details><summary>Body</summary>\n\n\`\`\`markdown\n${w.body}\n\`\`\`\n\n</details>`)
  ];
  return lines.join("\n");
}

function proposalPath_relForDoc(skillPath) {
  // Just for display in the proposal markdown
  return skillPath.replace(/.*[\\/]skills[\\/]/, "skills/");
}

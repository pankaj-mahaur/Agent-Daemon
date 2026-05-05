// GEPA — Genetic-Pareto Prompt Evolution.
// Self-improvement loop for SKILL.md files.
//
// Algorithm (Agrawal et al., ICLR 2026 "Reflective Prompt Evolution Can Outperform RL"):
//
//   1. SAMPLE   — pull execution traces from the SQLite store (stratified failures + successes)
//   2. REFLECT  — LLM reads traces; outputs structured failure modes + success patterns
//   3. GENERATE — LLM produces K candidate variants of the body, each addressing failure modes
//   4. EVALUATE — LLM-as-judge scores each candidate (addresses_failures + preserves_purpose + clarity)
//   5. SELECT   — Pareto frontier across (quality, size, compat, tests)
//   6. PROPOSE  — write the winner as a markdown proposal in .agent-daemon/proposed/
//
// v0.3: real LLM calls in stages 2-4 via headless `claude --bare`. Stage 5 was
// already real in v0.2.
//
// Inspired by Hermes Agent's self-evolution.

import path from "node:path";
import fs from "node:fs/promises";
import { sampleTraces } from "./sample.mjs";
import { reflectOnTraces } from "./reflect.mjs";
import { generateVariants } from "./generate.mjs";
import { evaluateVariants } from "./evaluate.mjs";
import { paretoSelect } from "./select.mjs";

/**
 * @typedef {Object} EvolveOptions
 * @property {string} skillPath
 * @property {string} skillName
 * @property {number} [variantCount=4]
 * @property {number} [traceSampleSize=20]
 * @property {number} [evalHoldoutSize=10]
 * @property {string} [evalSource='sessiondb']
 * @property {boolean} [dryRun=false]
 * @property {boolean} [verbose=false]
 * @property {string} [proposedDir]
 * @property {string} [model]
 * @property {number} [maxBudgetUsd=0.50]
 *
 * @typedef {Object} EvolveResult
 * @property {string} runId
 * @property {string} skillName
 * @property {Object[]} scored
 * @property {Object[]} winners
 * @property {string|null} proposalPath
 * @property {string} status      - 'no-traces' | 'no-improvement' | 'proposed' | 'error'
 * @property {string} reason
 * @property {number} totalCostUsd
 */

/**
 * @param {EvolveOptions} opts
 * @returns {Promise<EvolveResult>}
 */
export async function evolveSkill(opts) {
  const runId = `evolve-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const log = opts.verbose ? (msg) => console.error(`[${runId}] ${msg}`) : () => {};
  let totalCost = 0;
  const empty = (status, reason) => ({ runId, skillName: opts.skillName, scored: [], winners: [], proposalPath: null, status, reason, totalCostUsd: totalCost });

  log(`evolving skill: ${opts.skillName}`);

  // Read current skill body
  let parentBody;
  try {
    parentBody = await fs.readFile(opts.skillPath, "utf8");
  } catch (err) {
    return empty("error", `cannot read skill file: ${err.message}`);
  }

  // Stage 1 — sample
  log("stage 1/5 — sampling traces");
  const traces = await sampleTraces({
    skillName: opts.skillName,
    sampleSize: opts.traceSampleSize ?? 20,
    holdoutSize: opts.evalHoldoutSize ?? 10,
    source: opts.evalSource ?? "sessiondb"
  });
  if (traces.training.length === 0) {
    return empty("no-traces", `no execution traces for skill "${opts.skillName}" in episodic store (run a few sessions first, or seed via recordSkillExecution)`);
  }
  log(`  sampled training=${traces.training.length} holdout=${traces.holdout.length} (successes=${traces.stats.successes}, failures=${traces.stats.failures})`);

  // Stage 2 — reflect
  log("stage 2/5 — reflecting on traces (headless claude)");
  const reflectResult = await reflectOnTraces({
    skillName: opts.skillName,
    parentBody,
    traces: traces.training,
    model: opts.model,
    maxBudgetUsd: opts.maxBudgetUsd ? opts.maxBudgetUsd * 0.2 : 0.10,
    verbose: opts.verbose
  });
  if (!reflectResult.ok) {
    return empty("error", `reflect failed: ${reflectResult.error}`);
  }
  totalCost += reflectResult.costUsd || 0;
  const reflections = reflectResult.reflections;
  log(`  identified ${reflections.failureModes.length} failure mode(s), ${reflections.successPatterns.length} success pattern(s)`);

  if (reflections.failureModes.length === 0 && traces.training.filter(t => t.succeeded === false).length === 0) {
    return empty("no-improvement", "no failures observed in training set — nothing to improve");
  }

  // Stage 3 — generate
  log(`stage 3/5 — generating ${opts.variantCount ?? 4} variants (headless claude)`);
  const generateResult = await generateVariants({
    skillName: opts.skillName,
    parentBody,
    reflections,
    count: opts.variantCount ?? 4,
    model: opts.model,
    maxBudgetUsd: opts.maxBudgetUsd ? opts.maxBudgetUsd * 0.4 : 0.20,
    verbose: opts.verbose
  });
  if (!generateResult.ok || !generateResult.variants || generateResult.variants.length === 0) {
    return empty("error", `generate failed: ${generateResult.error || "no variants produced"}`);
  }
  totalCost += generateResult.costUsd || 0;
  log(`  generated ${generateResult.variants.length} variant(s)`);

  // Stage 4 — evaluate (LLM-as-judge)
  log(`stage 4/5 — evaluating variants (LLM-as-judge)`);
  const evalResult = await evaluateVariants({
    variants: generateResult.variants,
    parentBody,
    skillName: opts.skillName,
    reflections,
    model: opts.model,
    maxBudgetUsd: opts.maxBudgetUsd ? opts.maxBudgetUsd * 0.4 : 0.20,
    verbose: opts.verbose
  });
  if (!evalResult.ok) {
    return empty("error", `evaluate failed: ${evalResult.error}`);
  }
  totalCost += evalResult.totalCostUsd || 0;
  const scored = evalResult.scored;
  log(`  parent baseline = ${evalResult.parentBaseline.toFixed(2)}, candidate range: ${Math.min(...scored.map(s => s.scores.quality)).toFixed(2)} → ${Math.max(...scored.map(s => s.scores.quality)).toFixed(2)}`);

  // Stage 5 — Pareto select
  log("stage 5/5 — Pareto selection");
  const winners = paretoSelect(scored, parentBody);
  if (winners.length === 0) {
    return { ...empty("no-improvement", "no candidate variants beat the parent on the Pareto frontier"), scored };
  }
  const best = winners[0];
  log(`  ${winners.length} winner(s); best: ${best.variantId} (quality=${best.scores.quality.toFixed(2)}, size=${best.scores.size})`);

  // Write proposal
  if (opts.dryRun) {
    return { runId, skillName: opts.skillName, scored, winners, proposalPath: null, status: "proposed", reason: "[dry-run] no proposal written", totalCostUsd: totalCost };
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
    reflections,
    totalCostUsd: totalCost
  });

  await fs.writeFile(proposalPath, proposalContent, "utf8");
  log(`proposal written: ${proposalPath}`);

  return {
    runId,
    skillName: opts.skillName,
    scored,
    winners,
    proposalPath,
    status: "proposed",
    reason: `${winners.length} winner(s); best variant quality=${best.scores.quality.toFixed(2)} vs parent baseline=${best.parentBaseline.toFixed(2)}`,
    totalCostUsd: totalCost
  };
}

function renderProposal({ runId, skillName, skillPath, parentBody, winner, allWinners, reflections, totalCostUsd }) {
  const lines = [
    `# Proposed skill update — ${skillName}`,
    "",
    `_Run id: ${runId}_  ·  _Generated: ${new Date().toISOString()}_  ·  _Cost: $${(totalCostUsd || 0).toFixed(4)}_`,
    "",
    "## Why this change",
    "",
    "GEPA evolution found this variant improves on the parent across the Pareto frontier of",
    "(task quality, size, compatibility, tests).",
    "",
    "**Failure modes the variant addresses:**",
    "",
    ...(reflections.failureModes.length > 0
      ? reflections.failureModes.map(fm => `- **${fm.title}** — ${fm.description}`)
      : ["_(none — refinement based on success patterns)_"]),
    "",
    "**Reflection summary:** " + reflections.summary,
    "",
    "## Scores",
    "",
    `| Metric          | Parent | Winner | Δ |`,
    `|-----------------|--------|--------|---|`,
    `| Quality (LLM-as-judge) | ${winner.parentBaseline.toFixed(2)} | ${winner.scores.quality.toFixed(2)} | ${(winner.scores.quality - winner.parentBaseline).toFixed(2)} |`,
    `| Size (chars)    | ${parentBody.length} | ${winner.scores.size} | ${winner.scores.size - parentBody.length} |`,
    `| Compat          | 1 | ${winner.scores.compat} | — |`,
    `| Tests passed    | 1 | ${winner.scores.testPass} | — |`,
    "",
    `**Judge rationale:** ${winner.judgeRationale || "(none)"}`,
    "",
    `**Total winners on Pareto frontier:** ${allWinners.length}`,
    "",
    "## To accept",
    "",
    "Run `agent-daemon review` and choose **(a)ccept** when prompted. Or apply manually:",
    "",
    "```bash",
    `# Replace the body of ${displayPath(skillPath)} with the winner body below`,
    `# (preserve the YAML frontmatter at the top — variants do NOT include it)`,
    "```",
    "",
    "## Winner body",
    "",
    "```markdown",
    winner.body,
    "```",
    ""
  ];

  if (allWinners.length > 1) {
    lines.push("## Other Pareto winners (alternatives)");
    lines.push("");
    for (const [i, w] of allWinners.slice(1, 4).entries()) {
      lines.push(`### Alternative ${i + 1} — quality=${w.scores.quality.toFixed(2)}, size=${w.scores.size}`);
      lines.push("");
      lines.push("<details><summary>Show body</summary>");
      lines.push("");
      lines.push("```markdown");
      lines.push(w.body);
      lines.push("```");
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
  }

  return lines.join("\n");
}

function displayPath(absPath) {
  return absPath.replace(/.*[\\/]skills[\\/]/, "skills/");
}

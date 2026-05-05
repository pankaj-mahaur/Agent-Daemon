// Digest pipeline orchestrator.
// Reads a transcript, runs triage, runs the extractor, classifies, applies.
//
// v0.2 wiring: extract + classify + apply are now real (LLM call + rules + file writes).
// SQLite episodic store still pending (writes will happen when better-sqlite3 lands).

import path from "node:path";
import fs from "node:fs/promises";
import { summarize } from "../adapters/claude-code.mjs";
import { triage } from "./triage.mjs";
import { extractLearnings } from "./extract.mjs";
import { classify } from "./classify.mjs";
import { applyLearnings } from "./apply.mjs";

/**
 * @param {{
 *   transcript?: string,
 *   sessionId?: string,
 *   cwd?: string,
 *   dryRun?: boolean,
 *   verbose?: boolean,
 *   projectRoot: string,
 *   model?: string,
 *   maxBudgetUsd?: number
 * }} opts
 */
export async function runDigest(opts) {
  if (!opts.transcript) {
    console.error("agent-daemon digest: --transcript is required (or set CLAUDE_TRANSCRIPT_PATH)");
    return 1;
  }

  // Step 1 — read & normalize the transcript
  let summary;
  try {
    summary = await summarize(opts.transcript, { sessionId: opts.sessionId });
  } catch (err) {
    console.error(`agent-daemon digest: cannot read transcript: ${err.message}`);
    return 1;
  }

  if (opts.verbose) {
    console.error(`agent-daemon: transcript summary — turns=${summary.userTurns}/${summary.assistantTurns} tools=${summary.toolCalls} edits=${summary.edits} duration=${(summary.durationMs / 60000).toFixed(1)}min`);
  }

  // Step 2 — triage
  const t = triage(summary);
  if (!t.shouldDigest) {
    console.error(`agent-daemon: skipped (${t.reason})`);
    return 0;
  }
  if (opts.verbose) {
    console.error(`agent-daemon: triage passed — ${t.reason}`);
  }

  // Step 3 — extract candidate learnings via headless `claude`
  if (opts.verbose) {
    console.error(`agent-daemon: invoking headless claude for extraction...`);
  }
  const extractResult = await extractLearnings({
    summary,
    model: opts.model,
    maxBudgetUsd: opts.maxBudgetUsd,
    verbose: opts.verbose
  });

  if (!extractResult.ok) {
    console.error(`agent-daemon: extraction failed — ${extractResult.error}`);
    // Write a failure report so the user can investigate.
    await writeFailureReport(opts, summary, t, extractResult);
    return 1;
  }

  if (extractResult.skipReason) {
    console.error(`agent-daemon: extractor returned skip — ${extractResult.skipReason}`);
    return 0;
  }

  if (extractResult.learnings.length === 0) {
    console.error(`agent-daemon: extracted 0 learnings (cost: $${extractResult.costUsd?.toFixed(4) || "?"}, ${extractResult.durationMs || "?"}ms)`);
    return 0;
  }

  if (opts.verbose) {
    console.error(`agent-daemon: extracted ${extractResult.learnings.length} learning(s) — cost: $${extractResult.costUsd?.toFixed(4) || "?"}, ${extractResult.durationMs}ms`);
  }

  // Step 4 — classify each learning to a target store
  // Discover available skills so the classifier can recognize skill-tagged patterns
  const skillsDir = path.join(opts.projectRoot, "skills");
  let availableSkills = [];
  try {
    availableSkills = (await fs.readdir(skillsDir, { withFileTypes: true }))
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    // skills directory may not be in projectRoot — that's fine, classifier will route conservatively
  }

  const classified = classify(extractResult.learnings, { availableSkills });

  // Step 5 — apply (write memory or queue proposals)
  const applyResult = await applyLearnings({
    classified,
    sessionId: opts.sessionId || summary.sessionId,
    sessionSummary: extractResult.sessionSummary,
    cwd: opts.cwd,
    dryRun: opts.dryRun,
    verbose: opts.verbose
  });

  // Step 6 — final summary
  const summaryParts = [];
  if (applyResult.memoryProjectAppended) summaryParts.push(`${applyResult.memoryProjectAppended} project memory`);
  if (applyResult.memoryGlobalAppended)  summaryParts.push(`${applyResult.memoryGlobalAppended} global memory`);
  if (applyResult.proposalsQueued)        summaryParts.push(`${applyResult.proposalsQueued} proposal${applyResult.proposalsQueued === 1 ? "" : "s"} queued`);
  const summaryText = summaryParts.length > 0 ? summaryParts.join(", ") : "no durable changes";

  if (opts.dryRun) {
    console.error(`agent-daemon: [dry-run] would apply — ${summaryText}`);
  } else {
    console.error(`agent-daemon: digested session — ${summaryText}`);
    if (applyResult.proposalsQueued > 0) {
      console.error(`           review: agent-daemon review --cwd "${opts.cwd}"`);
    }
  }

  return 0;
}

async function writeFailureReport(opts, summary, t, extractResult) {
  const reportDir = path.join(opts.cwd, ".agent-daemon", "logs");
  await fs.mkdir(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportDir, `digest-failure-${stamp}.md`);
  const content = [
    `# Digest failure report`,
    "",
    `_Time: ${new Date().toISOString()}_`,
    `_Session: ${opts.sessionId || summary.sessionId || "unknown"}_`,
    "",
    "## Triage",
    `- ${t.reason}`,
    "",
    "## Extract error",
    "",
    "```",
    extractResult.error || "(none)",
    "```",
    "",
    "## Transcript stats",
    `- Turns: ${summary.userTurns}/${summary.assistantTurns}`,
    `- Tool calls: ${summary.toolCalls} (edits: ${summary.edits})`,
    `- Duration: ${(summary.durationMs / 60000).toFixed(1)} min`,
    ""
  ].join("\n");
  await fs.writeFile(reportPath, content, "utf8");
  console.error(`agent-daemon: failure report → ${reportPath}`);
}

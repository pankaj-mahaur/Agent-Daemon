// Digest pipeline orchestrator.
// Reads a transcript, runs triage, runs the extractor, classifies, applies.
//
// v0.2 wiring: extract + classify + apply are now real (LLM call + rules + file writes).
// SQLite episodic store still pending (writes will happen when better-sqlite3 lands).

import path from "node:path";
import fs from "node:fs/promises";
import { summarize } from "../adapters/index.mjs";
import { triage } from "./triage.mjs";
import { extractLearnings } from "./extract.mjs";
import { classify } from "./classify.mjs";
import { applyLearnings } from "./apply.mjs";
import { upsertSession, findSkillsNeedingEvolution } from "../memory/episodic.mjs";
import { appendSessionLog, buildEntry as buildSessionLogEntry } from "./session-log.mjs";

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

  // Step 1 — read & normalize the transcript (auto-detect adapter)
  let summary, adapter;
  try {
    const result = await summarize(opts.transcript, { sessionId: opts.sessionId, adapter: opts.adapter, verbose: opts.verbose });
    summary = result.summary;
    adapter = result.adapter;
  } catch (err) {
    console.error(`agent-daemon digest: cannot read transcript: ${err.message}`);
    return 1;
  }

  if (opts.verbose) {
    console.error(`agent-daemon: transcript [${adapter}] — turns=${summary.userTurns}/${summary.assistantTurns} tools=${summary.toolCalls} edits=${summary.edits} duration=${(summary.durationMs / 60000).toFixed(1)}min`);
  }

  // Step 2 — triage
  const t = triage(summary);
  if (!t.shouldDigest && !opts.force) {
    console.error(`agent-daemon: skipped (${t.reason})${opts.verbose ? " — pass --force to bypass" : ""}`);
    if (!opts.dryRun) {
      const entry = buildSessionLogEntry({ summary, adapter, sessionId: opts.sessionId, triage: t });
      await appendSessionLog({ cwd: opts.cwd, entry });
    }
    return 0;
  }
  if (opts.force && !t.shouldDigest) {
    console.error(`agent-daemon: triage said skip (${t.reason}) — forced via --force`);
    t.shouldDigest = true;
    t.reason = `forced (was: ${t.reason})`;
  }
  if (opts.verbose) {
    console.error(`agent-daemon: triage passed — ${t.reason}`);
  }

  // Persist the session row to SQLite (audit trail; survives even if extraction fails)
  if (!opts.dryRun) {
    try {
      await upsertSession({
        id: opts.sessionId || summary.sessionId || "unknown",
        projectPath: opts.cwd,
        startedAt: summary.startTime?.toISOString() || new Date().toISOString(),
        endedAt: summary.endTime?.toISOString(),
        userTurns: summary.userTurns,
        assistantTurns: summary.assistantTurns,
        toolCalls: summary.toolCalls,
        edits: summary.edits,
        transcriptPath: opts.transcript,
        digestStatus: "in-progress"
      });
    } catch (err) {
      if (opts.verbose) console.error(`agent-daemon: SQLite session upsert skipped (${err.message})`);
    }
  }

  // Step 3 — extract candidate learnings from agent-emitted digest block
  // (zero-LLM by default; agent already did the extraction in-context per ending-protocol)
  const extractResult = await extractLearnings({
    summary,
    verbose: opts.verbose,
    fallbackToLlm: opts.fallbackToLlm
  });

  if (!extractResult.ok) {
    console.error(`agent-daemon: extraction failed — ${extractResult.error}`);
    await writeFailureReport(opts, summary, t, extractResult);
    if (!opts.dryRun) {
      const entry = buildSessionLogEntry({
        summary, adapter,
        sessionId: opts.sessionId,
        triage: t,
        extractResult: { ...extractResult, source: extractResult.source || "extract-error" }
      });
      await appendSessionLog({ cwd: opts.cwd, entry });
    }
    return 1;
  }

  if (extractResult.skipReason) {
    if (opts.verbose) console.error(`agent-daemon: ${extractResult.skipReason}`);
    if (!opts.dryRun) {
      const entry = buildSessionLogEntry({
        summary, adapter,
        sessionId: opts.sessionId,
        triage: t,
        extractResult: { ...extractResult, source: extractResult.source || "no-block-found" }
      });
      await appendSessionLog({ cwd: opts.cwd, entry });
    }
    return 0;
  }

  if (extractResult.learnings.length === 0) {
    if (opts.verbose) console.error(`agent-daemon: 0 learnings extracted (source: ${extractResult.source || "none"})`);
    if (!opts.dryRun) {
      const entry = buildSessionLogEntry({
        summary, adapter,
        sessionId: opts.sessionId,
        triage: t,
        extractResult
      });
      await appendSessionLog({ cwd: opts.cwd, entry });
    }
    return 0;
  }

  if (opts.verbose) {
    const costPart = extractResult.costUsd ? ` (cost: $${extractResult.costUsd.toFixed(4)})` : "";
    console.error(`agent-daemon: extracted ${extractResult.learnings.length} learning(s) [source=${extractResult.source}]${costPart}`);
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

  // Mark the session digested in SQLite
  if (!opts.dryRun) {
    try {
      await upsertSession({
        id: opts.sessionId || summary.sessionId || "unknown",
        projectPath: opts.cwd,
        startedAt: summary.startTime?.toISOString() || new Date().toISOString(),
        endedAt: summary.endTime?.toISOString(),
        userTurns: summary.userTurns,
        assistantTurns: summary.assistantTurns,
        toolCalls: summary.toolCalls,
        edits: summary.edits,
        transcriptPath: opts.transcript,
        digestStatus: "digested",
        digestReason: t.reason
      });
    } catch { /* best-effort */ }
  }

  // Step 6 — auto-trigger evolve for skills with 3+ recent failures
  if (!opts.dryRun) {
    try {
      const evolveConfig = await loadEvolveConfig();
      const needsEvolve = await findSkillsNeedingEvolution({
        minFailures: evolveConfig.evolve_on_failure_count || 3,
        dayWindow: evolveConfig.evolve_window_days || 30
      });
      for (const { skill_name, failure_count } of needsEvolve) {
        const skillPath = path.join(opts.projectRoot, "skills", skill_name, "SKILL.md");
        try {
          await fs.access(skillPath);
          console.error(`agent-daemon: auto-evolve triggered for "${skill_name}" (${failure_count} failures) — run: agent-daemon evolve ${skill_name}`);
        } catch { /* skill not found locally — skip */ }
      }
    } catch {
      // auto-evolve detection is best-effort
    }
  }

  // Step 7 — final summary
  const summaryParts = [];
  if (applyResult.sqliteInserted)        summaryParts.push(`${applyResult.sqliteInserted} SQLite`);
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
    // Append the per-session audit line.
    const entry = buildSessionLogEntry({
      summary, adapter,
      sessionId: opts.sessionId,
      triage: t,
      extractResult,
      applyResult
    });
    await appendSessionLog({ cwd: opts.cwd, entry });
  }

  return 0;
}

async function loadEvolveConfig() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const configPath = path.join(home, ".agent-daemon", "watch.json");
  try {
    return JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch {
    return {};
  }
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

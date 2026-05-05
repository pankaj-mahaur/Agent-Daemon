// Digest pipeline — Stage 4: apply (or queue) each classified learning.
//
// Targets behavior:
//   - episodic-only       → SQLite-only insert (low-risk audit trail)
//   - memory:project      → SQLite + append to <cwd>/.agent-daemon/memory/activeContext.md
//   - memory:global       → SQLite + append to ~/.agent-daemon/user.md
//   - skill-edit          → SQLite + write a proposal markdown to .agent-daemon/proposed/
//   - constitution-add    → SQLite + write a proposal markdown to .agent-daemon/proposed/
//
// Every learning lands in SQLite (the durable audit trail), regardless of which
// markdown surface it also writes to. SQLite reads are used by session-start
// for retrieval-augmented context loading.

import fs from "node:fs/promises";
import path from "node:path";
import { insertLearnings, projectSlug } from "../memory/episodic.mjs";

/**
 * @typedef {import("./classify.mjs").ClassifiedLearning} ClassifiedLearning
 *
 * @typedef {Object} ApplyResult
 * @property {number} memoryProjectAppended
 * @property {number} memoryGlobalAppended
 * @property {number} episodicOnly
 * @property {number} sqliteInserted
 * @property {number} proposalsQueued
 * @property {string[]} proposalPaths
 * @property {string[]} memoryFilesTouched
 */

/**
 * Apply all classified learnings.
 *
 * @param {{
 *   classified: ClassifiedLearning[],
 *   sessionId: string|null,
 *   sessionSummary: string,
 *   cwd: string,
 *   dryRun?: boolean,
 *   verbose?: boolean
 * }} opts
 * @returns {Promise<ApplyResult>}
 */
export async function applyLearnings(opts) {
  const result = {
    memoryProjectAppended: 0,
    memoryGlobalAppended:  0,
    episodicOnly: 0,
    sqliteInserted: 0,
    proposalsQueued: 0,
    proposalPaths: [],
    memoryFilesTouched: []
  };

  const home = process.env.HOME || process.env.USERPROFILE || ".";
  const stamp = new Date().toISOString();
  const dateOnly = stamp.slice(0, 10);
  const slug = projectSlug(opts.cwd);

  // Resolve memory locations
  const projectMemoryPath = await resolveProjectMemoryPath(opts.cwd);
  const globalMemoryPath  = path.join(home, ".agent-daemon", "user.md");
  const proposedDir       = path.join(opts.cwd, ".agent-daemon", "proposed");

  // Group learnings by target file so we batch one append per file
  const projectAppends = [];
  const globalAppends  = [];
  const sqliteRows     = [];

  for (const item of opts.classified) {
    if (item.targets.includes("episodic-only")) result.episodicOnly++;

    if (item.targets.includes("memory:project")) {
      projectAppends.push(item);
    }
    if (item.targets.includes("memory:global")) {
      globalAppends.push(item);
    }
    if (item.targets.includes("skill-edit") || item.targets.includes("constitution-add")) {
      const proposalPath = await writeProposal({
        item,
        proposedDir,
        sessionId: opts.sessionId,
        stamp,
        dryRun: opts.dryRun
      });
      result.proposalPaths.push(proposalPath);
      result.proposalsQueued++;
    }

    // Build SQLite row — every learning lands in the audit trail
    const l = item.learning;
    const isProjectScoped = item.targets.includes("memory:project") || (l.scope === "project");
    sqliteRows.push({
      sessionId: opts.sessionId || null,
      projectSlug: isProjectScoped ? slug : null,
      category: l.type,
      text: l.text,
      evidence: l.evidence_quote,
      confidence: l.confidence,
      tags: l.tags,
      appliedTo: item.targets.filter(t => t !== "episodic-only").join(",") || "episodic"
    });
  }

  // SQLite insert (transactional). Skipped if dry-run or driver missing.
  if (sqliteRows.length > 0 && !opts.dryRun) {
    try {
      const ids = await insertLearnings(sqliteRows);
      result.sqliteInserted = ids.length;
      if (opts.verbose) console.error(`agent-daemon: wrote ${ids.length} rows to SQLite learnings table`);
    } catch (err) {
      if (opts.verbose) console.error(`agent-daemon: SQLite insert skipped (${err.message}) — markdown layer still working`);
    }
  }

  // Project memory append
  if (projectAppends.length > 0) {
    if (!opts.dryRun) {
      await appendToMemory(projectMemoryPath, projectAppends, opts.sessionId, dateOnly);
    }
    result.memoryProjectAppended = projectAppends.length;
    result.memoryFilesTouched.push(projectMemoryPath);
    if (opts.verbose) console.error(`agent-daemon: appended ${projectAppends.length} project-memory entries → ${projectMemoryPath}`);
  }

  // Global memory append
  if (globalAppends.length > 0) {
    if (!opts.dryRun) {
      await appendToMemory(globalMemoryPath, globalAppends, opts.sessionId, dateOnly);
    }
    result.memoryGlobalAppended = globalAppends.length;
    result.memoryFilesTouched.push(globalMemoryPath);
    if (opts.verbose) console.error(`agent-daemon: appended ${globalAppends.length} global-memory entries → ${globalMemoryPath}`);
  }

  return result;
}

/**
 * Choose where project memory lives. Preference order:
 *   1. <cwd>/.agent-daemon/memory/activeContext.md
 *   2. <cwd>/.claude/memory/MEMORY.md
 *   3. ~/.claude/projects/<encoded>/memory/MEMORY.md
 *   4. <cwd>/.agent-daemon/memory/activeContext.md (created if missing)
 *
 * @param {string} cwd
 */
async function resolveProjectMemoryPath(cwd) {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  const candidates = [
    path.join(cwd, ".agent-daemon", "memory", "activeContext.md"),
    path.join(cwd, ".claude", "memory", "MEMORY.md"),
    path.join(home, ".claude", "projects", encodeProjectPath(cwd), "memory", "MEMORY.md")
  ];

  for (const c of candidates) {
    try {
      await fs.access(c);
      return c;
    } catch {
      // continue
    }
  }
  // Fall through — return the canonical project location; we'll create it.
  return path.join(cwd, ".agent-daemon", "memory", "activeContext.md");
}

function encodeProjectPath(p) {
  return p.replace(/[\\/:]/g, "-");
}

async function appendToMemory(memPath, items, sessionId, dateOnly) {
  await fs.mkdir(path.dirname(memPath), { recursive: true });

  // If the file doesn't exist yet, seed it with a header.
  let initial = "";
  try {
    await fs.access(memPath);
  } catch {
    initial = `# Memory\n\n_Auto-managed by agent-daemon. Hand-edits welcome._\n\n`;
  }

  const block = renderMemoryBlock(items, sessionId, dateOnly);
  await fs.appendFile(memPath, initial + block, "utf8");
}

function renderMemoryBlock(items, sessionId, dateOnly) {
  const lines = [];
  lines.push("");
  lines.push(`<!-- agent-daemon: digested ${dateOnly}${sessionId ? ` (session ${sessionId.slice(0, 8)})` : ""} -->`);
  for (const it of items) {
    const l = it.learning;
    const tagPart = l.tags && l.tags.length > 0 ? `  _tags: ${l.tags.join(", ")}_` : "";
    lines.push(`- **${l.type}** (conf ${l.confidence.toFixed(2)}): ${l.text.replace(/\s+/g, " ").trim()}${tagPart}`);
    if (l.evidence_quote) {
      lines.push(`  > ${l.evidence_quote.replace(/\s+/g, " ").trim()}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function writeProposal({ item, proposedDir, sessionId, stamp, dryRun }) {
  const safeStamp = stamp.replace(/[:.]/g, "-");
  const kind = item.targets.includes("skill-edit") ? "skill-edit" : "constitution-add";
  const slug = (item.learning.tags?.[0] || item.learning.type).replace(/[^a-z0-9-]/gi, "-").slice(0, 32);
  const filename = `${kind}-${slug}-${safeStamp}.md`;
  const filePath = path.join(proposedDir, filename);

  const content = renderProposalMd(item, sessionId, kind);

  if (!dryRun) {
    await fs.mkdir(proposedDir, { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }

  return filePath;
}

function renderProposalMd(item, sessionId, kind) {
  const l = item.learning;
  const lines = [
    `# Proposal — ${kind}`,
    "",
    `_Generated: ${new Date().toISOString()}_  ${sessionId ? `· _Source session: ${sessionId}_` : ""}`,
    "",
    "## Summary",
    "",
    l.text,
    "",
    "## Evidence",
    "",
    `> ${l.evidence_quote}`,
    "",
    `_(${l.evidence_speaker}, confidence ${l.confidence.toFixed(2)})_`,
    "",
    "## Routing",
    "",
    `- **Targets:** ${item.targets.join(", ")}`,
    `- **Reason:** ${item.routeReason}`,
    `- **Tags:** ${(l.tags || []).join(", ") || "(none)"}`,
    "",
    "## Action",
    "",
    kind === "skill-edit"
      ? "Review, then either:\n- Apply the suggested change to the relevant `skills/<name>/SKILL.md`, OR\n- Reject by deleting this file."
      : "Review, then either:\n- Promote to a constitution rule by editing `constitution/core.md`, OR\n- Reject by deleting this file.",
    ""
  ];
  return lines.join("\n");
}

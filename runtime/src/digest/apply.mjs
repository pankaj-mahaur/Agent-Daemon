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
import { insertLearnings, projectSlug, observeUserFact } from "../memory/episodic.mjs";
import { screenLearning, neutralizeText } from "./sanitize.mjs";

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
    quarantined: 0,
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
    // Injection screen — the single choke point (covers both the digest path
    // and journal-drain, which bypasses extract.mjs). Suspicious learnings
    // never reach memory surfaces: they go to proposals for human review and
    // land in SQLite tagged quarantined (audit trail preserved). A screen
    // error counts as clean — render-time neutralization is the second layer.
    let screen = { verdict: "clean", reasons: [] };
    try { screen = screenLearning(item.learning); } catch { /* fail-open */ }
    if (screen.verdict === "suspicious") {
      const proposalPath = await writeProposal({
        item,
        proposedDir,
        sessionId: opts.sessionId,
        stamp,
        dryRun: opts.dryRun,
        kindOverride: "quarantined-learning",
        quarantineReasons: screen.reasons
      });
      result.proposalPaths.push(proposalPath);
      result.proposalsQueued++;
      result.quarantined++;
      if (opts.verbose) {
        console.error(`agent-daemon: quarantined learning (${screen.reasons.join(", ")}) → ${path.basename(proposalPath)}`);
      }
      const l = item.learning;
      sqliteRows.push({
        sessionId: opts.sessionId || null,
        projectSlug: l.scope === "project" ? slug : null,
        category: l.type,
        text: neutralizeText(l.text),
        evidence: neutralizeText(l.evidence_quote || ""),
        confidence: l.confidence,
        tags: l.tags,
        appliedTo: "quarantined"
      });
      continue;
    }

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
    if (item.targets.includes("user-fact") && !opts.dryRun) {
      try {
        const l = item.learning;
        await observeUserFact({
          category: l.type === "tool" ? "tool" : "preference",
          text: neutralizeText(l.text),
          evidence: neutralizeText(l.evidence_quote || ""),
          confidence: l.confidence,
          sessionId: opts.sessionId,
          projectSlug: slug
        });
        result.userFactsObserved = (result.userFactsObserved || 0) + 1;
      } catch { /* user-fact observation is best-effort */ }
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
  // On failure (DB locked, etc.), queue to pending_messages for retry on next digest.
  if (sqliteRows.length > 0 && !opts.dryRun) {
    try {
      const ids = await insertLearnings(sqliteRows);
      result.sqliteInserted = ids.length;
      if (opts.verbose) console.error(`agent-daemon: wrote ${ids.length} rows to SQLite learnings table`);
    } catch (err) {
      if (opts.verbose) console.error(`agent-daemon: SQLite insert failed (${err.message}) — queuing to pending_messages`);
      await queuePendingMessages(sqliteRows, opts.sessionId, err.message);
    }
  }

  // Drain any previously queued pending_messages (best-effort)
  if (!opts.dryRun) {
    await drainPendingMessages(opts.verbose);
  }

  // Project memory append
  if (projectAppends.length > 0) {
    if (!opts.dryRun) {
      await appendToMemory(projectMemoryPath, projectAppends, opts.sessionId, stamp);
    }
    result.memoryProjectAppended = projectAppends.length;
    result.memoryFilesTouched.push(projectMemoryPath);
    if (opts.verbose) console.error(`agent-daemon: appended ${projectAppends.length} project-memory entries → ${projectMemoryPath}`);
  }

  // Global memory append
  if (globalAppends.length > 0) {
    if (!opts.dryRun) {
      await appendToMemory(globalMemoryPath, globalAppends, opts.sessionId, stamp);
    }
    result.memoryGlobalAppended = globalAppends.length;
    result.memoryFilesTouched.push(globalMemoryPath);
    if (opts.verbose) console.error(`agent-daemon: appended ${globalAppends.length} global-memory entries → ${globalMemoryPath}`);
  }

  // Optional: mirror learnings to CLAUDE.md managed section
  if (!opts.dryRun && (projectAppends.length > 0 || globalAppends.length > 0)) {
    try {
      const config = await loadConfig();
      if (config.mirror_to_claude_md) {
        const claudeMdPath = path.join(opts.cwd, "CLAUDE.md");
        const allAppends = [...projectAppends, ...globalAppends];
        await mirrorToClaudeMd(claudeMdPath, allAppends, dateOnly);
        if (opts.verbose) console.error(`agent-daemon: mirrored ${allAppends.length} learning(s) to CLAUDE.md`);
      }
    } catch {
      // mirror is best-effort
    }
  }

  return result;
}

async function loadConfig() {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  const configPath = path.join(home, ".agent-daemon", "config.json");
  try {
    return JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch {
    return {};
  }
}

const MANAGED_START = "<!-- agent-daemon:learnings:start -->";
const MANAGED_END = "<!-- agent-daemon:learnings:end -->";

async function mirrorToClaudeMd(claudeMdPath, items, dateOnly) {
  let content;
  try {
    content = await fs.readFile(claudeMdPath, "utf8");
  } catch {
    return;
  }

  const summaries = items.map(it => {
    const l = it.learning;
    return `- **${l.type}**: ${neutralizeText(l.text).replace(/\s+/g, " ").trim()}`;
  });

  const newSection = [
    MANAGED_START,
    `## Recent learnings (agent-daemon, ${dateOnly})`,
    "",
    ...summaries,
    MANAGED_END
  ].join("\n");

  if (content.includes(MANAGED_START)) {
    // Replace existing managed section (idempotent)
    const re = new RegExp(`${escapeRegExp(MANAGED_START)}[\\s\\S]*?${escapeRegExp(MANAGED_END)}`);
    content = content.replace(re, newSection);
  } else {
    content += "\n" + newSection + "\n";
  }

  await fs.writeFile(claudeMdPath, content, "utf8");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MAX_PENDING_ENTRIES = 100;
const MAX_PENDING_AGE_DAYS = 14;

function pendingArchivePath() {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return path.join(home, ".agent-daemon", "pending_messages.archive.jsonl");
}

async function archivePendingEntries(entries, reason) {
  if (!entries || entries.length === 0) return;
  const lines = entries.map(e => JSON.stringify({ ...e, archived_at: new Date().toISOString(), archive_reason: reason }));
  try {
    await fs.appendFile(pendingArchivePath(), lines.join("\n") + "\n", "utf8");
  } catch { /* archive is best-effort — better than the old silent drop */ }
}

async function queuePendingMessages(rows, sessionId, errorMsg) {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  const queueDir = path.join(home, ".agent-daemon");
  const queueFile = path.join(queueDir, "pending_messages.json");
  await fs.mkdir(queueDir, { recursive: true });

  let pending = [];
  try {
    pending = JSON.parse(await fs.readFile(queueFile, "utf8"));
  } catch { /* no existing queue */ }

  pending.push({
    queued_at: new Date().toISOString(),
    session_id: sessionId,
    error: errorMsg,
    rows
  });

  // Cap to prevent unbounded growth — overflow is archived, never dropped.
  if (pending.length > MAX_PENDING_ENTRIES) {
    const overflow = pending.slice(0, pending.length - MAX_PENDING_ENTRIES);
    await archivePendingEntries(overflow, "queue-overflow");
    pending = pending.slice(-MAX_PENDING_ENTRIES);
  }
  await fs.writeFile(queueFile, JSON.stringify(pending, null, 2), "utf8");
}

async function drainPendingMessages(verbose) {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  const queueFile = path.join(home, ".agent-daemon", "pending_messages.json");

  let pending;
  try {
    pending = JSON.parse(await fs.readFile(queueFile, "utf8"));
  } catch {
    return;
  }

  if (!pending || pending.length === 0) return;

  const ageCutoff = Date.now() - MAX_PENDING_AGE_DAYS * 24 * 60 * 60 * 1000;
  const remaining = [];
  const expired = [];
  let drained = 0;
  for (const entry of pending) {
    const queuedMs = entry.queued_at ? new Date(entry.queued_at).getTime() : Date.now();
    if (queuedMs < ageCutoff) {
      // Stuck for 2+ weeks — SQLite has been failing persistently. Archive
      // instead of retrying forever; doctor surfaces the queue age.
      expired.push(entry);
      continue;
    }
    try {
      await insertLearnings(entry.rows);
      drained++;
    } catch {
      remaining.push(entry);
    }
  }

  await archivePendingEntries(expired, "age-expired");

  if (remaining.length > 0) {
    await fs.writeFile(queueFile, JSON.stringify(remaining, null, 2), "utf8");
  } else {
    await fs.unlink(queueFile).catch(() => {});
  }

  if (verbose && (drained > 0 || expired.length > 0)) {
    console.error(`agent-daemon: pending queue — drained ${drained}, archived ${expired.length}, remaining ${remaining.length}`);
  }
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

async function appendToMemory(memPath, items, sessionId, stamp) {
  await fs.mkdir(path.dirname(memPath), { recursive: true });

  // Read existing content (if any) — used both to seed a fresh file AND to
  // dedup against entries already present from previous sessions. Without
  // this, real-world dogfood runs accumulate the same "pattern: X" /
  // "decision: Y" line 4-5 times across a week's sessions because SQLite's
  // content-hash uniqueness only gates the episodic store, not this markdown.
  let existing = "";
  try {
    existing = await fs.readFile(memPath, "utf8");
  } catch { /* file doesn't exist yet */ }

  const initial = existing
    ? ""
    : `# Memory\n\n_Auto-managed by agent-daemon. Hand-edits welcome._\n\n`;

  // Build the set of (type, text-prefix) tuples already in the file. The
  // markdown shape we append is `- **<type>** (conf X.XX): <text>` so we
  // match on that prefix to extract previously-written learnings. Match by
  // first ~80 chars of text (case-insensitive, whitespace-collapsed) so
  // near-identical drift ("X is the cause" vs "X is the cause.") still
  // dedupes.
  const seen = collectSeenLearnings(existing);
  const fresh = items.filter((it) => {
    const key = makeDedupKey(it.learning.type, it.learning.text);
    if (seen.has(key)) return false;
    seen.add(key);  // also dedup within the batch in case classify produced near-dupes
    return true;
  });

  if (fresh.length === 0 && !initial) return;  // nothing new, nothing to seed

  const block = fresh.length > 0
    ? renderMemoryBlock(fresh, sessionId, stamp)
    : "";
  await fs.appendFile(memPath, initial + block, "utf8");
}

/**
 * Walk an existing memory markdown file and return the set of dedup keys
 * for learnings already recorded. Format we recognise:
 *   - **<type>** (conf 0.NN): <text...>
 *
 * @param {string} content
 * @returns {Set<string>}
 */
function collectSeenLearnings(content) {
  const seen = new Set();
  if (!content) return seen;
  const re = /^-\s+\*\*([a-z]+)\*\*\s+\(conf\s+\d+\.\d+\)\s*:\s*(.+)$/gim;
  let m;
  while ((m = re.exec(content)) !== null) {
    seen.add(makeDedupKey(m[1], m[2]));
  }
  return seen;
}

function makeDedupKey(type, text) {
  const normText = String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/, "")
    .trim()
    .slice(0, 80);
  return `${type}|${normText}`;
}

function renderMemoryBlock(items, sessionId, stamp) {
  const lines = [];
  lines.push("");
  // Full ISO stamp — same-day appends from different sessions stay distinguishable.
  lines.push(`<!-- agent-daemon: digested ${stamp}${sessionId ? ` (session ${sessionId.slice(0, 8)})` : ""} -->`);
  for (const it of items) {
    const l = it.learning;
    const tagPart = l.tags && l.tags.length > 0 ? `  _tags: ${l.tags.map(t => neutralizeText(t)).join(", ")}_` : "";
    lines.push(`- **${l.type}** (conf ${l.confidence.toFixed(2)}): ${neutralizeText(l.text).replace(/\s+/g, " ").trim()}${tagPart}`);
    if (l.evidence_quote) {
      lines.push(`  > ${neutralizeText(l.evidence_quote).replace(/\s+/g, " ").trim()}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function writeProposal({ item, proposedDir, sessionId, stamp, dryRun, kindOverride, quarantineReasons }) {
  const safeStamp = stamp.replace(/[:.]/g, "-");
  const kind = kindOverride || (item.targets.includes("skill-edit") ? "skill-edit" : "constitution-add");
  const slug = (item.learning.tags?.[0] || item.learning.type).replace(/[^a-z0-9-]/gi, "-").slice(0, 32);
  const filename = `${kind}-${slug}-${safeStamp}.md`;
  const filePath = path.join(proposedDir, filename);

  const content = renderProposalMd(item, sessionId, kind, quarantineReasons);

  if (!dryRun) {
    await fs.mkdir(proposedDir, { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }

  return filePath;
}

function renderProposalMd(item, sessionId, kind, quarantineReasons) {
  const l = item.learning;
  // Proposals quote transcript-derived text — neutralize so a quarantined
  // injection can't fire from the proposal file itself.
  const safeText = neutralizeText(l.text);
  const safeEvidence = neutralizeText(l.evidence_quote || "");
  const actionByKind = {
    "skill-edit": "Review, then either:\n- Apply the suggested change to the relevant `skills/<name>/SKILL.md`, OR\n- Reject by deleting this file.",
    "constitution-add": "Review, then either:\n- Promote to a constitution rule by editing `constitution/core.md`, OR\n- Reject by deleting this file.",
    "quarantined-learning": "This learning matched injection-screen patterns and was NOT written to memory.\nReview, then either:\n- Confirm it is benign and manually add it to the right memory file, OR\n- Reject by deleting this file."
  };
  const lines = [
    `# Proposal — ${kind}`,
    "",
    `_Generated: ${new Date().toISOString()}_  ${sessionId ? `· _Source session: ${sessionId}_` : ""}`,
    "",
    ...(quarantineReasons && quarantineReasons.length > 0
      ? ["## Quarantine reasons", "", ...quarantineReasons.map(r => `- ${r}`), ""]
      : []),
    "## Summary",
    "",
    safeText,
    "",
    "## Evidence",
    "",
    `> ${safeEvidence}`,
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
    actionByKind[kind] || actionByKind["constitution-add"],
    ""
  ];
  return lines.join("\n");
}

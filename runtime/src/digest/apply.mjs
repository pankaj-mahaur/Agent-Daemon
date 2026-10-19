// Digest pipeline — Stage 4: apply (or queue) each classified learning.
//
// Targets behavior:
//   - episodic-only       → SQLite-only insert (low-risk audit trail)
//   - memory:project      → SQLite + append to <data>/memory/activeContext.md
//   - memory:global       → SQLite + append to ~/.agent-daemon/user.md
//   - skill-edit          → SQLite + write a proposal markdown to <data>/proposed/
//   - constitution-add    → SQLite + write a proposal markdown to <data>/proposed/
//
// <data> is the project's capture folder (memory/project-dir.mjs): its own
// .agent-daemon when the user set one up, else a folder under ad's root.
//
// Every learning lands in SQLite (the durable audit trail), regardless of which
// markdown surface it also writes to. SQLite reads are used by session-start
// for retrieval-augmented context loading.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { insertLearnings, projectSlug, observeUserFact } from "../memory/episodic.mjs";
import { screenLearning, neutralizeText } from "./sanitize.mjs";
import { redactSecrets } from "../security/secret-patterns.mjs";
import { appendToMemory, writeMemoryProposal, writeProposal } from "./proposals.mjs";
import { ensureProjectDataDir, projectDataDir } from "../memory/project-dir.mjs";

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
 *   sessionFiles?: string[],
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

  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const stamp = new Date().toISOString();
  const dateOnly = stamp.slice(0, 10);
  const slug = projectSlug(opts.cwd);
  // File-aware tags — merged into the SQLite audit row only (NOT the markdown
  // render, which stays human-readable). Feeds searchLearningsByFile + the
  // SessionStart working-set boost.
  const sessionFiles = Array.isArray(opts.sessionFiles) ? opts.sessionFiles : [];

  // Resolve memory locations
  const projectMemoryPath = await resolveProjectMemoryPath(opts.cwd);
  const globalMemoryPath  = path.join(home, ".agent-daemon", "user.md");
  const proposedDir       = path.join(projectDataDir(opts.cwd), "proposed");

  if (!opts.dryRun && opts.classified.length) ensureProjectDataDir(opts.cwd);

  // Group learnings by target file so we batch one append per file
  const projectAppends = [];
  const globalAppends  = [];
  const sqliteRows     = [];

  for (const raw of opts.classified) {
    // Secrets go first, before any surface (SQLite, memory files, proposals,
    // the pending queue) sees the text.
    const item = redactItem(raw);
    // Who wrote it: the user's own words apply at once within their project;
    // agent-written notes (assistant turns, agent evidence) wait as 'pending'
    // and touch no memory file, mirror or user fact.
    const origin = originOf(item.learning);
    // Automatic global is off: a global target becomes a project row that
    // asks the user for promotion (promote_request 'global').
    const wantsGlobal = item.targets.includes("memory:global") || item.learning.scope === "global" || item.learning.promote_request === "global";
    if (wantsGlobal) {
      item.targets = [...new Set(item.targets.map((t) => (t === "memory:global" ? "memory:project" : t)))];
      item.learning = { ...item.learning, scope: "project" };
    }
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
      // status 'quarantined': held back from every reader, older ad included.
      sqliteRows.push({
        sessionId: opts.sessionId || null,
        projectSlug: slug,
        category: l.type,
        text: neutralizeText(l.text),
        evidence: neutralizeText(l.evidence_quote || ""),
        confidence: l.confidence,
        tags: l.tags,
        appliedTo: "quarantined",
        status: "quarantined",
        quarantineReason: `injection:${screen.reasons.join(",")}`,
        origin,
        captureRef: l.capture_ref,
        projectPath: path.resolve(opts.cwd)
      });
      continue;
    }

    if (origin === "agent") {
      const l = item.learning;
      sqliteRows.push({
        sessionId: opts.sessionId || null,
        projectSlug: slug,
        category: l.type,
        text: l.text,
        evidence: l.evidence_quote,
        confidence: l.confidence,
        tags: mergeFileTags(l.tags, sessionFiles),
        appliedTo: "pending",
        status: "pending",
        origin,
        promoteRequest: wantsGlobal ? "global" : null,
        captureRef: l.capture_ref,
        projectPath: path.resolve(opts.cwd)
      });
      result.pending = (result.pending || 0) + 1;
      continue;
    }

    // Did the user have to say this again? (P5.5's repeat-correction metric)
    if (item.learning.type === "correction" && !opts.dryRun) await noteCorrection(opts, slug, item.learning, path.join(projectDataDir(opts.cwd), "proposed"));

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
          projectSlug: slug,
          origin
        });
        result.userFactsObserved = (result.userFactsObserved || 0) + 1;
      } catch { /* user-fact observation is best-effort */ }
    }

    // Build SQLite row — every learning lands in the audit trail
    // Every new row belongs to its project; nothing is written global any more.
    const l = item.learning;
    sqliteRows.push({
      sessionId: opts.sessionId || null,
      projectSlug: slug,
      category: l.type,
      text: l.text,
      evidence: l.evidence_quote,
      confidence: l.confidence,
      tags: mergeFileTags(l.tags, sessionFiles),
      appliedTo: item.targets.filter(t => t !== "episodic-only").join(",") || "episodic",
      origin,
      promoteRequest: wantsGlobal ? "global" : null,
      captureRef: l.capture_ref,
      projectPath: path.resolve(opts.cwd)
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

// A correction in the user's words: record its event; a lesson shown twice and
// still repeated gets a memory-reword proposal. Telemetry: never fails the apply.
async function noteCorrection(opts, slug, l, proposedDir) {
  try {
    const { db } = await import("../memory/episodic.mjs");
    const { classifyCorrection } = await import("../memory/metrics.mjs");
    const handle = await db();
    const { hookProjectKeys } = await import("../memory/scope.mjs");
    // A folder that shares its key with another (or is never a project) gets no metric.
    const keys = await hookProjectKeys(opts.cwd).catch(() => []);
    if (!keys.length) return;
    const r = classifyCorrection(handle, { keys, text: l.text, captureRef: l.capture_ref || opts.sessionId || null, source: opts.sessionId ? "digest" : "hooks" });
    if (r.reword) {
      const row = handle.get("SELECT text, evidence FROM learnings WHERE id = ?", [r.learningId]);
      await writeMemoryProposal({ kind: "memory-reword", learningId: r.learningId, text: row.text, evidence: `repeated twice after being shown; last time: ${l.text}`, origin: "ad (the same correction came back after the lesson was shown)", proposedDir });
    }
  } catch {
    // the metric never blocks capture
  }
}

// Secrets out of text, evidence and tags (secret-patterns.mjs).
function redactItem(item) {
  const l = item.learning ?? {};
  const r = (s) => (typeof s === "string" ? redactSecrets(s).text : s);
  return {
    ...item,
    targets: [...(item.targets ?? [])],
    learning: { ...l, text: r(l.text), evidence_quote: r(l.evidence_quote), evidence: r(l.evidence), tags: Array.isArray(l.tags) ? l.tags.map(r) : l.tags },
  };
}

// The writer of a learning: source_speaker (who said the words), else
// evidence_speaker; "user" | "agent" | "unknown".
export function originOf(l) {
  const s = l?.source_speaker ?? l?.evidence_speaker;
  return s === "user" || s === "agent" ? s : "unknown";
}

async function loadConfig() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
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

/**
 * Merge a learning's own tags with the session's touched-files list for the
 * SQLite audit row. Deduped, original tags first (more specific), capped so a
 * huge session can't bloat the indexed tags column. Returns undefined when
 * there's nothing to store (keeps the column NULL, matching prior behavior).
 *
 * @param {string[]|undefined} ownTags
 * @param {string[]} fileTags
 * @returns {string[]|undefined}
 */
function mergeFileTags(ownTags, fileTags) {
  const own = Array.isArray(ownTags) ? ownTags.filter(t => typeof t === "string") : [];
  if (!fileTags.length) return own.length ? own : undefined;
  const merged = [...new Set([...own, ...fileTags])].slice(0, 16);
  return merged.length ? merged : undefined;
}

const MAX_PENDING_ENTRIES = 100;
const MAX_PENDING_AGE_DAYS = 14;

function pendingArchivePath() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
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
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
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
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
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
 *   1. <data>/memory/activeContext.md (the capture folder, memory/project-dir.mjs)
 *   2. <cwd>/.claude/memory/MEMORY.md
 *   3. ~/.claude/projects/<encoded>/memory/MEMORY.md
 *   4. <data>/memory/activeContext.md (created if missing)
 *
 * @param {string} cwd
 */
export async function resolveProjectMemoryPath(cwd) {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const own = path.join(projectDataDir(cwd), "memory", "activeContext.md");
  const candidates = [
    own,
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
  return own;
}

function encodeProjectPath(p) {
  return p.replace(/[\\/:]/g, "-");
}

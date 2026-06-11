// SessionStart consumer of the learning-journal.
//
// Reads <cwd>/.agent-daemon/learning-journal.jsonl, dedupes against the
// episodic SQLite store, classifies + applies each learning the same way
// the digest pipeline does, then archives the journal. Appends one summary
// line to <cwd>/.agent-daemon/sessions.jsonl so the audit ledger captures
// continuous-extraction runs too.
//
// Idempotent: re-running on an empty journal is a no-op.
// Fail-safe: any error returns a result with ok:false but never throws —
// the SessionStart hook must always succeed.

import path from "node:path";
import fsp from "node:fs/promises";
import { readJournal, archiveJournal, journalPath } from "./journal.mjs";
import { classify } from "../digest/classify.mjs";
import { applyLearnings } from "../digest/apply.mjs";
import { appendSessionLog, buildEntry as buildSessionLogEntry } from "../digest/session-log.mjs";

const ORPHAN_ADOPT_AGE_MS = 60 * 60 * 1000;  // crashed-drain leftovers older than 1h

/**
 * Claim the journal exclusively by renaming it to a per-pid draining file.
 * Two concurrent SessionStart drains race on the rename; the loser gets
 * ENOENT and no-ops — without this both would apply the same entries.
 * Also adopts orphaned .draining-* files left by a crashed drain (>1h old)
 * by folding their lines into the claimed file.
 *
 * @param {string} cwd
 * @returns {Promise<string | null>} path of the claimed file, or null
 */
async function claimJournal(cwd) {
  const live = journalPath(cwd);
  const dir = path.dirname(live);
  const claimed = path.join(dir, `learning-journal.draining-${process.pid}.jsonl`);

  let adopted = "";
  try {
    for (const name of await fsp.readdir(dir)) {
      if (!/^learning-journal\.draining-\d+\.jsonl$/.test(name)) continue;
      const p = path.join(dir, name);
      try {
        const st = await fsp.stat(p);
        if (Date.now() - st.mtimeMs > ORPHAN_ADOPT_AGE_MS) {
          adopted += await fsp.readFile(p, "utf8");
          await fsp.unlink(p).catch(() => {});
        }
      } catch { /* vanished — fine */ }
    }
  } catch { /* dir missing — fine */ }

  let haveLive = true;
  try {
    await fsp.rename(live, claimed);
  } catch (err) {
    if (err.code !== "ENOENT") return null;  // unexpected — treat as lost race
    haveLive = false;
  }

  if (adopted) {
    await fsp.appendFile(claimed, adopted, "utf8").catch(() => {});
    haveLive = true;
  }
  return haveLive ? claimed : null;
}

/**
 * Drain the learning journal into memory + episodic store.
 *
 * @param {{cwd: string, projectRoot?: string, dryRun?: boolean, verbose?: boolean}} opts
 * @returns {Promise<{ok: boolean, drained: number, applied: object|null, error?: string}>}
 */
export async function drainJournal(opts) {
  const cwd = opts.cwd;
  if (!cwd) return { ok: false, drained: 0, applied: null, error: "cwd required" };

  // Dry-run reads in place (must not consume the journal). Real runs claim
  // the file first so concurrent drains can't double-apply.
  let claimedFile = null;
  if (!opts.dryRun) {
    claimedFile = await claimJournal(cwd);
    if (!claimedFile) return { ok: true, drained: 0, applied: null };
  }

  try {
    const { ok, entries, error } = claimedFile
      ? await readJournalFile(claimedFile)
      : await readJournal({ cwd });
    if (!ok) return { ok: false, drained: 0, applied: null, error };
    if (entries.length === 0) {
      if (claimedFile) await fsp.unlink(claimedFile).catch(() => {});
      return { ok: true, drained: 0, applied: null };
    }

    // Dedupe within journal by `text-prefix + type` (case-insensitive).
    // Cross-session dedup against SQLite happens inside insertLearnings via
    // the existing content-hash uniqueness.
    const dedupKey = (e) => `${e.type}|${(e.text || "").toLowerCase().slice(0, 80)}`;
    const seen = new Set();
    /** @type {import("../digest/extract.mjs").Learning[]} */
    const learnings = [];
    for (const e of entries) {
      const key = dedupKey(e);
      if (seen.has(key)) continue;
      seen.add(key);
      learnings.push(toLearning(e));
    }

    if (opts.verbose) {
      process.stderr.write(`agent-daemon: draining ${learnings.length} unique learning(s) from journal (${entries.length} raw)\n`);
    }

    // Build the available-skills hint for the classifier (same as digest does).
    let availableSkills = [];
    if (opts.projectRoot) {
      try {
        const fs = await import("node:fs/promises");
        const skillsDir = path.join(opts.projectRoot, "skills");
        availableSkills = (await fs.readdir(skillsDir, { withFileTypes: true }))
          .filter(d => d.isDirectory()).map(d => d.name);
      } catch { /* no skills dir — ok */ }
    }

    const classified = classify(learnings, { availableSkills });

    const applyResult = await applyLearnings({
      classified,
      sessionId: null,
      sessionSummary: `Continuous extraction across ${entries.length} prior-turn hook fire(s).`,
      cwd,
      dryRun: opts.dryRun,
      verbose: opts.verbose
    });

    if (!opts.dryRun) {
      // Archive the claimed file — we processed it.
      await archiveJournal({ cwd, file: claimedFile });

      // Audit ledger entry so users can see continuous-extraction runs in sessions.jsonl.
      const sessionLogEntry = buildSessionLogEntry({
        summary: { userTurns: 0, assistantTurns: 0, toolCalls: 0, edits: 0, durationMs: 0 },
        adapter: "journal-drain",
        sessionId: null,
        triage: { shouldDigest: true, reason: `journal drain (${learnings.length} learnings)` },
        extractResult: { learnings, source: "user-prompt-hook" },
        applyResult
      });
      await appendSessionLog({ cwd, entry: sessionLogEntry });
    }

    return { ok: true, drained: learnings.length, applied: applyResult };
  } catch (err) {
    // Restore the claimed file to the live journal so the entries aren't
    // stranded behind this pid (best-effort; orphan adoption is the backstop).
    if (claimedFile) {
      await fsp.rename(claimedFile, journalPath(cwd)).catch(() => {});
    }
    return { ok: false, drained: 0, applied: null, error: err.message };
  }
}

/**
 * Read a specific journal file (parsed JSONL, bad lines skipped).
 *
 * @param {string} file
 * @returns {Promise<{ok: boolean, entries: Array<object>, error?: string}>}
 */
async function readJournalFile(file) {
  try {
    const raw = await fsp.readFile(file, "utf8");
    const entries = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { /* skip bad line */ }
    }
    return { ok: true, entries };
  } catch (err) {
    if (err.code === "ENOENT") return { ok: true, entries: [] };
    return { ok: false, entries: [], error: err.message };
  }
}

/**
 * Coerce a journal entry into the Learning shape consumed by classify/apply.
 *
 * @param {object} e
 * @returns {import("../digest/extract.mjs").Learning}
 */
function toLearning(e) {
  return {
    type: e.type || "pattern",
    text: String(e.text || "").trim(),
    evidence_quote: String(e.evidence_quote || "").slice(0, 400),
    evidence_speaker: e.evidence_speaker === "agent" ? "agent" : "user",
    scope: e.scope === "global" ? "global" : "project",
    confidence: typeof e.confidence === "number" ? Math.max(0, Math.min(1, e.confidence)) : 0.5,
    tags: Array.isArray(e.tags) ? e.tags.slice(0, 12) : []
  };
}

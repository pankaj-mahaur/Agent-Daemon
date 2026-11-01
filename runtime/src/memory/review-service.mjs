// The review service (MCP launch plan 02 §2.2, D3): the only code that makes a note
// accepted, accepts it in every project, or releases it from quarantine.
//
// Each write needs a token from reviewToken(), issued only in the user's own terminal:
//   - a real TTY on stdin and stdout;
//   - not the agent's tool shell (AD_TOOL_SHELL=1);
//   - no agent process above it (memory/ancestry.mjs), and in an editor's terminal or a
//     broken process chain, the code from a native dialog typed back (dialog-code.mjs).
// No environment variable stands in for a check. Tests inject isTTY, the probe and the
// dialog as functions; review-gate.test.mjs holds the in-process callers to the CLI
// review verbs. It is a gate against accidents and prompt injection, not a sandbox.

import { stdin as input, stdout as output } from "node:process";
import { learningContentHash, scopedContentHash } from "./sqlite.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { purgeLearnings } from "./purge.mjs";
import { projectClause } from "./projects.mjs";
import { dropFromFile } from "./metrics.mjs";
import { probeAncestry } from "./ancestry.mjs";
import { confirmByDialog } from "./dialog-code.mjs";

const issued = new WeakSet();

export const REVIEW_TEXTS = Object.freeze({
  toolShell: "accepting notes can't run from the agent's own shell. Run it yourself in a terminal.",
  noTty: "accepting notes needs an interactive terminal.",
  agent: (name) => `accepting notes can't run under an agent (${name}). Run it yourself in a terminal.`,
});

const realTTY = () => Boolean(input.isTTY && output.isTTY);

function mint() {
  const token = Object.freeze({ issuedAt: Date.now() });
  issued.add(token);
  return token;
}

/**
 * The checks that need no answer from the user. → { token }, { refused: text }, or
 * { needsCode: found } when the terminal must prove itself with the dialog code (no
 * token is issued then; reviewToken asks for the code).
 */
export function checkReviewToken({ env = process.env, isTTY = realTTY, ancestry = probeAncestry } = {}) {
  if (env.AD_TOOL_SHELL === "1") return { refused: REVIEW_TEXTS.toolShell };
  if (!isTTY()) return { refused: REVIEW_TEXTS.noTty };
  const found = ancestry() ?? { verdict: "unknown" };
  if (found.verdict === "agent") return { refused: REVIEW_TEXTS.agent(found.agent) };
  if (found.verdict !== "terminal") return { needsCode: found };
  return { token: mint() };
}

/** → { token } in the user's own terminal (asking for the dialog code when needed), else { refused: text }. */
export async function reviewToken({ ask, out, dialog = confirmByDialog, ...checks } = {}) {
  const first = checkReviewToken(checks);
  if (!first.needsCode) return first;
  const proved = await dialog({ ask, out, found: first.needsCode });
  return proved?.ok ? { token: mint() } : { refused: proved?.text ?? "accepting notes needs the dialog code." };
}

function must(token) {
  if (!issued.has(token)) throw new Error("review service: this needs a review token (ad review, in your own terminal)");
}

const iso = (now) => (now instanceof Date ? now : new Date()).toISOString();

/** Accept one learning in its project. → rows changed. */
export function acceptLearning(handle, token, id, { appliedTo = "memory:project", now } = {}) {
  must(token);
  const t = iso(now);
  return handle.run(
    "UPDATE learnings SET status = 'active', accepted_by = 'review', accepted_at = ?, status_at = ?, quarantine_reason = NULL, applied_to = ? WHERE id = ?",
    [t, t, appliedTo, id]
  ).changes;
}

/** Accept one user fact. → rows changed. */
export function acceptFact(handle, token, id, { now } = {}) {
  must(token);
  const t = iso(now);
  return handle.run("UPDATE user_facts SET status = 'active', accepted_by = 'review', accepted_at = ?, status_at = ?, quarantine_reason = NULL WHERE id = ?", [t, t, id]).changes;
}

/** A 3.0 automatic global note, accepted for every project. */
export function acceptGlobal(handle, token, id, { now } = {}) {
  must(token);
  const t = iso(now);
  return handle.run("UPDATE learnings SET global_accepted_at = ?, accepted_by = COALESCE(accepted_by, 'review'), accepted_at = COALESCE(accepted_at, ?) WHERE id = ?", [t, t, id]).changes;
}

/** A user fact, accepted for every project. */
export function acceptFactGlobal(handle, token, id, { now } = {}) {
  must(token);
  const t = iso(now);
  return handle.run("UPDATE user_facts SET global_accepted_at = ?, accepted_by = COALESCE(accepted_by, 'review'), accepted_at = COALESCE(accepted_at, ?) WHERE id = ?", [t, t, id]).changes;
}

/**
 * memory-promote: the note becomes cross-project with the plain content hash.
 * A cross-project note with that text already there stays, and this one is
 * superseded by it (counts merged). A 3.0 project note in another project that
 * still holds the plain hash moves to its own project-scoped hash first.
 */
export function promoteLearning(handle, token, row, now = new Date()) {
  must(token);
  const plain = learningContentHash(row.text);
  const t = iso(now);
  return handle.transaction(() => {
    let holder = handle.get("SELECT id, project_slug, status, applied_to FROM learnings WHERE content_hash = ? AND id != ?", [plain, row.id]);
    // A holder that is never served (rejected, held back, superseded) gives up the
    // hash instead of swallowing the note the user just accepted.
    const served = holder && ["active", "pending"].includes(holder.status) && !String(holder.applied_to ?? "").startsWith("quarantined");
    if (holder && holder.project_slug === null && !served) {
      handle.run("UPDATE learnings SET content_hash = ?, norm_key = NULL WHERE id = ?", [`retired-${holder.id}`, holder.id]);
      holder = null;
    }
    if (holder && holder.project_slug === null) {
      handle.run(
        `UPDATE learnings SET observed_count = observed_count + ?, retrieval_count = retrieval_count + ?, global_accepted_at = COALESCE(global_accepted_at, ?),
            status = 'active', accepted_by = COALESCE(accepted_by, 'review'), accepted_at = COALESCE(accepted_at, ?) WHERE id = ?`,
        [row.observed_count ?? 1, row.retrieval_count ?? 0, t, t, holder.id]
      );
      handle.run("UPDATE learnings SET status = 'superseded', superseded_by = ?, promote_request = NULL WHERE id = ?", [holder.id, row.id]);
      return { ok: true, text: `Accepted: #${row.id} is now the cross-project note #${holder.id}.` };
    }
    if (holder) handle.run("UPDATE learnings SET content_hash = ? WHERE id = ?", [scopedContentHash(holder.project_slug, row.text), holder.id]);
    handle.run(
      `UPDATE learnings SET project_slug = NULL, content_hash = ?, global_accepted_at = ?, promote_request = NULL, status = 'active', applied_to = 'memory:global',
          accepted_by = 'review', accepted_at = ?, status_at = ? WHERE id = ?`,
      [plain, t, t, t, row.id]
    );
    return { ok: true, text: `Accepted: #${row.id} now applies in every project.` };
  });
}

// ── Consolidation ───────────────────────────────────────────────────────────
// `ad memory consolidate --apply-merges / --apply-stale` retire accepted notes: an edit of
// accepted memory, so it needs the token like an accept.

/** Duplicates superseded by their survivor, whose count absorbs theirs. → rows superseded. */
export function supersedeLearnings(handle, token, clusters) {
  must(token);
  let superseded = 0;
  handle.transaction(() => {
    for (const c of clusters) {
      const extraObserved = c.duplicates.reduce((a, d) => a + (d.observed_count || 1), 0);
      handle.run("UPDATE learnings SET observed_count = observed_count + ? WHERE id = ?", [extraObserved, c.survivor.id]);
      for (const d of c.duplicates) {
        superseded += handle.run("UPDATE learnings SET status = 'superseded', superseded_by = ?, status_at = ? WHERE id = ? AND status = 'active'", [c.survivor.id, iso(), d.id]).changes;
      }
    }
  });
  return superseded;
}

/** Stale notes archived (not served, still listed). → rows archived. */
export function archiveStale(handle, token, ids) {
  must(token);
  let archived = 0;
  handle.transaction(() => {
    for (const id of ids) archived += handle.run("UPDATE learnings SET status = 'archived', status_at = ? WHERE id = ? AND status = 'active'", [iso(), id]).changes;
  });
  return archived;
}

// ── Forgetting ──────────────────────────────────────────────────────────────
// Without a token, the agent's forget, bound to its project (keys): it hides a pending or
// provisional note the agent wrote (purged after 7 days), and flags an accepted note
// forget-requested (still recalled and enforced until the user decides). It never touches
// a note captured from the user's own words: that waits for the user in review. A
// model-called path never pauses a rule, stops recall of an accepted note or purges it
// (02 §2, D40).

const inProject = (keys) => (Array.isArray(keys) && keys.length ? projectClause("", keys) : { sql: "0", params: [] });

/** Hide a pending or provisional note the agent wrote, in these projects. → rows changed. */
export function hideNote(handle, id, { keys, now } = {}) {
  const scope = inProject(keys);
  return handle.run(
    `UPDATE learnings SET status = 'hidden', status_at = ? WHERE id = ? AND status IN ('pending', 'provisional') AND accepted_by IS NULL AND COALESCE(origin, '') <> 'user' AND ${scope.sql}`,
    [iso(now), id, ...scope.params]
  ).changes;
}

/** An accepted note of these projects the agent asked to forget: still recalled and enforced until the user decides. */
export function requestForget(handle, id, { keys, now } = {}) {
  const scope = inProject(keys);
  return handle.run(
    `UPDATE learnings SET status = 'forget-requested', status_at = ? WHERE id = ? AND status = 'active' AND accepted_by IS NOT NULL AND ${scope.sql}`,
    [iso(now), id, ...scope.params]
  ).changes;
}

/** The agent's forget: hides its own unaccepted note, flags an accepted one. → { result } */
export function forgetNote(handle, id, opts) {
  if (hideNote(handle, id, opts)) return { result: "hidden" };
  if (requestForget(handle, id, opts)) return { result: "forget-requested" };
  return { result: "none" };
}

// The note's line in the project's memory file goes too: session start injects that file.
function dropFromMemoryFile(file, text) {
  if (!file || !text) return false;
  try {
    const next = dropFromFile(readFileSync(file, "utf8"), text);
    if (next === null) return false;
    writeFileSync(file, next);
    return true;
  } catch {
    return false; // no memory file
  }
}

/** The user keeps a note the agent asked to forget. */
export function keepNote(handle, token, id, { now } = {}) {
  must(token);
  return handle.run("UPDATE learnings SET status = 'active', status_at = ? WHERE id = ? AND status = 'forget-requested'", [iso(now), id]).changes;
}

/** The user forgets an accepted note for good: purged, bytes and index entries included, and its memory-file line. */
export function forgetAccepted(handle, token, id, { memoryFile } = {}) {
  must(token);
  const row = handle.get("SELECT text FROM learnings WHERE id = ? AND status IN ('active', 'forget-requested') AND accepted_by IS NOT NULL", [id]);
  if (!row) return 0;
  const purged = purgeLearnings(handle, [id]);
  dropFromMemoryFile(memoryFile, row.text);
  return purged;
}

/** `/memory forget` in ad's terminal UI: archived (not served, still listed), this project's or a global note, and its memory-file line dropped. */
export function archiveLearning(handle, token, id, projectSlug, { memoryFile } = {}) {
  must(token);
  const row = handle.get("SELECT text FROM learnings WHERE id = ?", [id]);
  const changed = handle.run(
    "UPDATE learnings SET status = 'archived', status_at = ? WHERE id = ? AND status IN ('active', 'forget-requested') AND (project_slug = ? OR project_slug IS NULL)",
    [iso(), id, projectSlug]
  ).changes;
  if (changed) dropFromMemoryFile(memoryFile, row?.text);
  return changed;
}

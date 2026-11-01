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
import { purgeLearnings } from "./purge.mjs";
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

// ── Forgetting ──────────────────────────────────────────────────────────────
// Without a token: these only hide what nobody accepted, or flag an accepted note.
// A model-called path never pauses a rule, stops recall of an accepted note or
// purges it (02 §2, D40).

/** Hide a pending or provisional note (purged after 7 days). → rows changed. */
export function hideNote(handle, id, { now } = {}) {
  return handle.run(
    "UPDATE learnings SET status = 'hidden', status_at = ? WHERE id = ? AND status IN ('pending', 'provisional') AND accepted_by IS NULL",
    [iso(now), id]
  ).changes;
}

/** An accepted note the agent asked to forget: still recalled and enforced until the user decides. */
export function requestForget(handle, id, { now } = {}) {
  return handle.run("UPDATE learnings SET status = 'forget-requested', status_at = ? WHERE id = ? AND status = 'active' AND accepted_by IS NOT NULL", [iso(now), id]).changes;
}

/** A forget from any caller: hides an unaccepted note, flags an accepted one. → { result } */
export function forgetNote(handle, id, opts) {
  if (hideNote(handle, id, opts)) return { result: "hidden" };
  if (requestForget(handle, id, opts)) return { result: "forget-requested" };
  return { result: "none" };
}

/** The user keeps a note the agent asked to forget. */
export function keepNote(handle, token, id, { now } = {}) {
  must(token);
  return handle.run("UPDATE learnings SET status = 'active', status_at = ? WHERE id = ? AND status = 'forget-requested'", [iso(now), id]).changes;
}

/** The user forgets an accepted note for good: purged, bytes and index entries included. */
export function forgetAccepted(handle, token, id) {
  must(token);
  return purgeLearnings(handle, [id]);
}

/** `/memory forget` in ad's terminal UI: archived (not served, still listed), this project's or a global note. */
export function archiveLearning(handle, token, id, projectSlug) {
  must(token);
  return handle.run(
    "UPDATE learnings SET status = 'archived', status_at = ? WHERE id = ? AND status IN ('active', 'forget-requested') AND (project_slug = ? OR project_slug IS NULL)",
    [iso(), id, projectSlug]
  ).changes;
}

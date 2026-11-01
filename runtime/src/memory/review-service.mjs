// The review service (MCP launch plan 02 §2.2, D3): the only code that makes a note
// accepted, accepts it in every project, or releases it from quarantine.
//
// Each write needs a token from reviewToken(), issued only in the user's own terminal:
//   - a real TTY on stdin and stdout;
//   - not the agent's tool shell (AD_TOOL_SHELL=1);
//   - no agent process among the ancestors (the ancestry probe; L1.6 brings the real
//     process-tree check, until then the probe passes).
// No environment variable stands in for a check. Tests inject isTTY and the probe as
// functions; review-gate.test.mjs holds the in-process callers to the CLI review verbs.
// It is a gate against accidents and prompt injection, not a sandbox.

import { stdin as input, stdout as output } from "node:process";
import { learningContentHash, scopedContentHash } from "./sqlite.mjs";

const issued = new WeakSet();

export const REVIEW_TEXTS = Object.freeze({
  toolShell: "accepting notes can't run from the agent's own shell. Run it yourself in a terminal.",
  noTty: "accepting notes needs an interactive terminal.",
  agent: (name) => `accepting notes can't run under an agent (${name}). Run it yourself in a terminal.`,
});

const realTTY = () => Boolean(input.isTTY && output.isTTY);
const noProbe = () => ({ agent: null });

/** → { token } in the user's own terminal, else { refused: text }. */
export function reviewToken({ env = process.env, isTTY = realTTY, ancestry = noProbe } = {}) {
  if (env.AD_TOOL_SHELL === "1") return { refused: REVIEW_TEXTS.toolShell };
  if (!isTTY()) return { refused: REVIEW_TEXTS.noTty };
  const found = ancestry();
  if (found?.agent) return { refused: REVIEW_TEXTS.agent(found.agent) };
  const token = Object.freeze({ issuedAt: Date.now() });
  issued.add(token);
  return { token };
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

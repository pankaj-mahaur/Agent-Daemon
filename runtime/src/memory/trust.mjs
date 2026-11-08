// The trust model (MCP launch plan 02 §2): the one definition of an accepted note.
//
// A note is accepted when the review service accepted it (accepted_by 'review') or it
// was accepted before schema v5 (accepted_by 'legacy', backfilled once at the upgrade).
// The stored status stays 'active' for accepted notes, so older ad (3.1.0), which reads
// status = 'active', still serves them. Older ad names its own columns on insert, so a
// row it adds after the upgrade has accepted_by NULL and reads as pending here.
//
//   pending           waits for the user in review (the default for every writer)
//   provisional       a typed correction on an allow-listed host: recalled, tagged (L5)
//   active            accepted (with accepted_by set)
//   forget-requested  an accepted note the agent asked to forget: still recalled and
//                     enforced until the user decides in review
//   hidden            a provisional or pending note the user or the agent hid (purged later)
//   quarantined       held back by the screen

export const ACCEPTED_STATUSES = Object.freeze(["active", "forget-requested"]);

const prefix = (alias) => (alias ? `${alias}.` : "");

/** SQL: the row is an accepted note (served, enforceable). */
export function acceptedSql(alias = "") {
  const a = prefix(alias);
  return `(${a}status IN ('active', 'forget-requested') AND ${a}accepted_by IS NOT NULL)`;
}

/** SQL: the row waits for review: pending, or 'active' without an acceptance (an older writer's). */
export function pendingSql(alias = "") {
  const a = prefix(alias);
  return `(${a}status = 'pending' OR (${a}status = 'active' AND ${a}accepted_by IS NULL))`;
}

/** SQL for a row's status as readers report it: an unaccepted 'active' row reads 'pending'. */
export function statusSql(alias = "") {
  const a = prefix(alias);
  return `(CASE WHEN ${a}status = 'active' AND ${a}accepted_by IS NULL THEN 'pending' ELSE ${a}status END)`;
}

// ── L5 (design decision 16): one predicate per surface, none of them serves a
// provisional note anywhere but recall in its own project.

/** SQL: a provisional note (a first-party typed correction, recalled tagged, project-only). */
export function provisionalSql(alias = "") {
  const a = prefix(alias);
  return `(${a}status = 'provisional' AND ${a}accepted_by IS NULL)`;
}

/**
 * SQL: what recall may serve (L6): accepted (forget-requested included, tagged), plus
 * provisional notes that belong to a project. The caller adds the project scope (only
 * this project's provisional notes) and drops provisional under strict mode.
 */
export function recallSql(alias = "", { strict = false } = {}) {
  const a = prefix(alias);
  return strict ? acceptedSql(alias) : `(${acceptedSql(alias)} OR (${provisionalSql(alias)} AND ${a}project_slug IS NOT NULL))`;
}

/** SQL: the guards snapshot's rules come from these (L7): accepted, forget-requested kept, never provisional. */
export const guardSourceSql = (alias = "") => acceptedSql(alias);

/** SQL: a NEW rule may be proposed only from an accepted, active note (L7). */
export function ruleProposalSql(alias = "") {
  const a = prefix(alias);
  return `(${a}status = 'active' AND ${a}accepted_by IS NOT NULL)`;
}

/** SQL: may leave this machine through rule sync (02 §2.3): accepted, project, the user's own words. */
export function syncEligibleSql(alias = "") {
  const a = prefix(alias);
  return `(${acceptedSql(alias)} AND ${a}project_slug IS NOT NULL AND ${a}provenance IN ('user-prompt', 'user-cli'))`;
}

/** SQL: what `learnings export` (L8) may write: accepted notes only. */
export const exportableSql = (alias = "") => acceptedSql(alias);

/** SQL: held back — status quarantined, or an older writer's pending row marked quarantined in applied_to. */
export function flaggedSql(alias = "") {
  const a = prefix(alias);
  return `(${a}status = 'quarantined' OR COALESCE(${a}applied_to, '') LIKE 'quarantined%')`;
}

/**
 * SQL: what the review checklist may accept (L5 decision 11): pending or provisional and
 * not held back; with withFlagged (the user confirmed that one flagged row) a held-back
 * row too — never one held back for a secret (held.mjs's rule).
 */
export function reviewableSql(alias = "", { withFlagged = false } = {}) {
  const a = prefix(alias);
  const open = `((${pendingSql(alias)} OR ${provisionalSql(alias)} OR ${a}status = 'quarantined') AND ${a}accepted_by IS NULL)`;
  if (!withFlagged) return `(${open} AND NOT ${flaggedSql(alias)})`;
  return `(${open} AND COALESCE(${a}quarantine_reason, '') NOT LIKE 'secret%')`;
}

/** The tag a recalled note carries (L6), or null for a plain accepted note. */
export function tagOf(row) {
  if (row?.status === "provisional") return "provisional";
  if (row?.status === "forget-requested") return "agent asked to forget";
  return null;
}

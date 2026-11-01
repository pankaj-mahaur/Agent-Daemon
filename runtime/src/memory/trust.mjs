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

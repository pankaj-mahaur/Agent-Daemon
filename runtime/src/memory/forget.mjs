// Forget and restore, by who asks (L5 design decision 12). One module for the prompt
// hook's typed commands, the CLI verbs and (later) L8's `learnings forget`.
//
// Askers, from the strongest:
//   first-party  a typed prompt this process proved (hooks/prompt-source.mjs isFirstParty)
//   cli-token    the CLI with a review token (memory/review-service.mjs isReviewToken)
//   typed        a typed prompt no host can prove (every host today)
//   agent        the CLI without the token (the agent's shell, any non-TTY run)
// The asker a caller names is checked here: "first-party" without a minted verdict counts
// as "typed", "cli-token" without an issued token as "agent".
//
//   | asker              | user's own unaccepted note  | agent's unaccepted note | accepted                       |
//   | first-party, token | hidden                      | hidden                  | prompt: unchanged + terminal   |
//   |                    |                             |                         | line; token: typed id confirm, |
//   |                    |                             |                         | then forgetAccepted            |
//   | typed              | unchanged, marked           | hidden                  | unchanged + terminal line      |
//   | agent              | refused                     | hidden                  | forget-requested               |
//
// Nothing short of first-party or the token hides, demotes or purges a user's learning
// or anything accepted. A prompt's hide of a user's note keeps status_at NULL, so it is
// never purged before the checklist showed it (retainNotes skips it).

import { isFirstParty } from "../hooks/prompt-source.mjs";
import { isReviewToken, forgetAccepted, requestForget } from "./review-service.mjs";
import { writeProvisional } from "./provisional-write.mjs";
import { recordEvent, latestEvent } from "./l5-tables.mjs";
import { projectClause } from "./projects.mjs";
import { acceptedSql, openSql, ownWordsSql, flaggedSql } from "./trust.mjs";
import { HIDDEN_DAYS } from "./purge.mjs";

export const ASKERS = Object.freeze(["first-party", "cli-token", "typed", "agent"]);

/** A learning ref: "#12", "12", "L12" → { id }; "last" → { last: true }; anything else → null. */
export function parseRef(arg) {
  const t = String(arg ?? "").trim();
  if (/^last$/i.test(t)) return { last: true };
  const m = /^(?:#|L)?(\d{1,12})$/i.exec(t);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? { id } : null;
}

/**
 * The asker this caller may act as (never stronger than it can prove).
 * @param {{source?:object, token?:object|null, cli?:boolean}} o
 *   source: promptSource()'s verdict (the hook); cli: the CLI (token or not).
 */
export function askerOf({ source = null, token = null, cli = false } = {}) {
  if (cli) return isReviewToken(token) ? "cli-token" : "agent";
  if (isFirstParty(source)) return "first-party";
  if (source?.typed && source?.why !== "headless") return "typed";
  return null;
}

// The asker a caller names, checked against what it holds.
function checked(asker, { verdict, token }) {
  if (asker === "first-party") return isFirstParty(verdict) ? "first-party" : "typed";
  if (asker === "cli-token") return isReviewToken(token) ? "cli-token" : "agent";
  return ASKERS.includes(asker) ? asker : null;
}

const actorOf = (asker) => (asker === "agent" ? "agent" : "user");
const iso = (now) => (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();

function rowOf(handle, id) {
  return handle.get(
    `SELECT id, text, status, origin, provenance, accepted_by, project_id, project_slug, status_at, ${flaggedSql()} AS flagged,
            ${acceptedSql()} AS accepted, ${openSql()} AS open
       FROM learnings WHERE id = ?`,
    [id]
  );
}

function inProject(handle, id, keys) {
  if (!Array.isArray(keys) || !keys.length) return false;
  const scope = projectClause("", keys);
  return Boolean(handle.get(`SELECT 1 AS ok FROM learnings WHERE id = ? AND ${scope.sql}`, [id, ...scope.params]));
}

/** The user's own words: captured from the user (origin), or a typed prompt said it too (decision 15). */
function usersOwn(handle, row) {
  if (row.origin === "user") return true;
  try {
    return Boolean(handle.get("SELECT 1 AS ok FROM events WHERE kind = 'captured' AND actor = 'user' AND learning_id = ?", [row.id]));
  } catch {
    return false;
  }
}

const projectName = (row) => String(row.project_slug ?? "another project").replace(/^-+/, "").split(/[-/\\]/).filter(Boolean).pop() ?? "another project";

// Resolve a ref in these projects. → { row } or { status } (an answer for the user).
function resolve(handle, ref, { keys, sessionId }) {
  if (!ref) return { status: "bad-ref" };
  if (ref.last) {
    // The newest capture from a typed prompt in this session and project, never an agent's note.
    if (!sessionId || !Array.isArray(keys) || !keys.length) return { status: "nothing-last" };
    const scope = projectClause("", keys);
    const r = handle.get(
      `SELECT id FROM learnings WHERE capture_ref = ? AND ${ownWordsSql()} AND ${openSql()} AND ${scope.sql} ORDER BY id DESC LIMIT 1`,
      [String(sessionId).slice(0, 128), ...scope.params]
    );
    return r ? { row: rowOf(handle, r.id) } : { status: "nothing-last" };
  }
  const row = rowOf(handle, ref.id);
  if (!row) return { status: "unknown", id: ref.id };
  if (!inProject(handle, row.id, keys)) return row.project_slug ? { status: "other-project", id: row.id, project: projectName(row) } : { status: "unknown", id: row.id };
  return { row };
}

/**
 * Forget a learning.
 * @param {object} handle
 * @param {{ref:object|null, asker:string, keys:string[], verdict?:object, token?:object,
 *   sessionId?:string, confirm?:(row)=>Promise<boolean>|boolean, memoryFile?:string|string[], now?:Date}} o
 * @returns {Promise<{status:string, id?:number, text?:string, project?:string, was?:string}>}
 *   status: hidden | marked | in-use | forgotten | not-confirmed | forget-requested |
 *           refused-own | already-removed | nothing-last | unknown | other-project | bad-ref | none
 */
export async function forgetLearning(handle, o) {
  const asker = checked(o.asker, o);
  if (!asker) return { status: "none" };
  const found = resolve(handle, o.ref, o);
  if (!found.row) return found;
  const row = found.row;
  const base = { id: row.id, text: row.text, ...(o.ref?.last ? { last: true } : {}) };
  if (row.status === "hidden") return { status: "already-removed", ...base };

  if (row.accepted) {
    if (asker === "agent") {
      // Still recalled and enforced (guardSourceSql keeps forget-requested); the user decides in review.
      const changed = handle.transaction(() => {
        const c = requestForget(handle, row.id, { keys: o.keys, now: o.now });
        if (c) recordEvent(handle, { kind: "forget-requested", learningId: row.id, projectId: row.project_id, actor: "agent", at: o.now });
        return c;
      });
      return { status: changed ? "forget-requested" : row.status === "forget-requested" ? "forget-requested" : "none", ...base };
    }
    if (asker !== "cli-token") return { status: "in-use", ...base };
    // The user's own terminal: the id typed back, then purged for good.
    const ok = typeof o.confirm === "function" ? await o.confirm(row) : false;
    if (!ok) return { status: "not-confirmed", ...base };
    const purged = forgetAccepted(handle, o.token, row.id, { memoryFile: o.memoryFile });
    return { status: purged ? "forgotten" : "none", ...base };
  }

  if (!row.open) return { status: "none", ...base };
  const own = usersOwn(handle, row);
  if (own && asker === "agent") return { status: "refused-own", ...base };
  if (own && asker === "typed") {
    // Not proven typed: the note stays as it is (in use when provisional), marked for review.
    recordEvent(handle, { kind: "marked", learningId: row.id, projectId: row.project_id, actor: "user", at: o.now });
    return { status: "marked", was: row.status, ...base };
  }
  // Hidden. A prompt's hide of the user's own note waits for the checklist to show it
  // (status_at NULL); any other hide starts its 7 days now.
  const statusAt = own && asker === "first-party" ? null : iso(o.now);
  const from = row.flagged ? "quarantined" : row.status === "provisional" ? "provisional" : "pending";
  const changed = handle.transaction(() => {
    const c = handle.run(
      `UPDATE learnings SET status = 'hidden', status_at = ? WHERE id = ? AND ${openSql()}`,
      [statusAt, row.id]
    ).changes;
    if (c) recordEvent(handle, { kind: "hidden", learningId: row.id, projectId: row.project_id, actor: actorOf(asker), detail: { from, by: asker, owner: own ? "user" : "agent" }, at: o.now });
    return c;
  });
  return { status: changed ? "hidden" : "none", ...base };
}

/**
 * Restore a hidden learning (within 7 days of its hide being shown).
 * Any typed restore undoes a hide of the agent's note; a hide of the user's own note comes
 * back only through a first-party prompt, the CLI with the token or the checklist. Back to
 * provisional only for a first-party restore, through writeProvisional.
 * @returns {{status:string, id?:number, text?:string, to?:string, project?:string}}
 *   status: restored | not-removed | removed-by-you | gone | unknown | other-project | bad-ref | none
 */
export function restoreLearning(handle, o) {
  const asker = checked(o.asker, o);
  if (!asker) return { status: "none" };
  if (o.ref?.last) return { status: "bad-ref" };
  const found = resolve(handle, o.ref, o);
  if (!found.row) return found;
  const row = found.row;
  const base = { id: row.id, text: row.text, ...(o.ref?.last ? { last: true } : {}) };
  if (row.status !== "hidden" || row.accepted_by) return { status: "not-removed", ...base };
  const now = o.now instanceof Date ? o.now : new Date(o.now ?? Date.now());
  if (row.status_at && Date.parse(row.status_at) <= now.getTime() - HIDDEN_DAYS * 86_400_000) return { status: "gone", ...base };
  const hid = latestEvent(handle, "hidden", row.id);
  const owner = hid?.detail?.owner ?? (usersOwn(handle, row) ? "user" : "agent");
  const hider = hid?.actor ?? "system";
  // Who may undo it.
  // A hide the user made (of their own note, or by a first-party prompt or the token) comes back only the same way.
  const userHide = owner === "user" || ["first-party", "cli-token"].includes(hid?.detail?.by);
  if (userHide && !["first-party", "cli-token"].includes(asker)) return { status: "removed-by-you", ...base };
  if (asker === "agent" && hider !== "agent") return { status: "removed-by-you", ...base };
  const from = hid?.detail?.from ?? (row.flagged ? "quarantined" : "pending");
  if (from === "provisional" && asker === "first-party") {
    const r = writeProvisional(handle, o.verdict, { id: row.id }, { now, restore: true });
    return { status: r.status === "hidden" ? "none" : "restored", to: r.status, ...base };
  }
  // A literal CASE: back to waiting (held back when it was flagged), never in use.
  const changed = handle.transaction(() => {
    const c = handle.run(
      "UPDATE learnings SET status = CASE WHEN ? = 'quarantined' THEN 'quarantined' ELSE 'pending' END, status_at = ? WHERE id = ? AND status = 'hidden' AND accepted_by IS NULL",
      [from, now.toISOString(), row.id]
    ).changes;
    if (c) recordEvent(handle, { kind: "restored", learningId: row.id, projectId: row.project_id, actor: actorOf(asker), detail: { to: from === "quarantined" ? "quarantined" : "pending" }, at: now });
    return c;
  });
  return { status: changed ? "restored" : "none", to: from === "quarantined" ? "quarantined" : "pending", ...base };
}

/**
 * Hides and forget requests by the agent that the user hasn't been told about, per project,
 * marked told (L5 decision 12: the next typed, attended prompt shows them). → [{id, text, kind}]
 */
export function untoldAgentActions(handle, { keys, now = new Date() } = {}) {
  if (!Array.isArray(keys) || !keys.length) return [];
  const scope = projectClause("l", keys);
  try {
    const rows = handle.all(
      `SELECT e.id AS event_id, e.kind, e.learning_id AS id, l.text FROM events e JOIN learnings l ON l.id = e.learning_id
        WHERE e.kind IN ('hidden', 'forget-requested') AND e.actor = 'agent' AND e.notified_at IS NULL AND ${scope.sql} ORDER BY e.id`,
      scope.params
    );
    if (!rows.length) return [];
    handle.run(
      `UPDATE events SET notified_at = ? WHERE id IN (${rows.map(() => "?").join(",")})`,
      [iso(now), ...rows.map((r) => r.event_id)]
    );
    return rows.map((r) => ({ id: r.id, text: r.text ?? "", kind: r.kind }));
  } catch {
    return [];
  }
}

// ── receipts ──────────────────────────────────────────────────────────────────
const clip = (s, n = 60) => {
  // Neutralised: control and bidi characters out (an escape code could redraw the line).
  const t = String(s ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * The line the user sees for a forget or restore (L5 decision 17).
 * @param {{status:string, id?:number, text?:string, to?:string, was?:string, project?:string}} r
 * @param {{verb:"forget"|"restore", product?:string, forget:string, restore:string, review:string, terminalForget:(id:number)=>string}} o
 *   forget/restore: the command as the user types it here; terminalForget: the CLI form.
 */
export function commandReceipt(r, o) {
  const name = o.product ? `${o.product}: ` : "";
  const ref = r.id ? `#${r.id}` : "";
  const q = r.text ? ` "${clip(r.text)}"` : "";
  switch (r.status) {
    case "hidden":
      return `${name}Removed ${ref}${q} (restore within ${HIDDEN_DAYS} days: ${o.restore} ${r.id})`;
    case "already-removed":
      return `${name}${ref} is already removed (restore within ${HIDDEN_DAYS} days: ${o.restore} ${r.id})`;
    case "restored":
      return `${name}Restored ${ref}${q}${r.to === "provisional" ? " (in use again)" : r.to === "quarantined" ? " (saved for a closer look)" : " (waits for review)"}`;
    case "marked": {
      // `forget last` always names the note, so a wrong target is visible (decision 12).
      const which = r.last ? `${ref}${q}` : ref;
      return r.was === "provisional"
        ? `${name}${which} stays in use until you delete it in your next review (listed under "You asked to remove")`
        : `${name}${which} won't be used; delete it in your next review (it's listed under "You asked to remove")`;
    }
    case "in-use":
      return `${name}${ref} is in use; forget it in your own terminal: ${o.terminalForget(r.id)}`;
    case "forget-requested":
      return `${name}Asked to forget ${ref}: it stays in use until the user decides in review (${o.review})`;
    case "refused-own":
      return `${name}Not removed: ${ref} is the user's own learning; they decide in review (${o.review})`;
    case "forgotten":
      return `${name}Forgot ${ref}${q} for good`;
    case "not-confirmed":
      return `${name}Nothing changed: ${ref} is still in use`;
    case "not-removed":
      return `${name}${ref} isn't removed`;
    case "removed-by-you":
      return `${name}${ref} was removed by you; restore it in ${o.review}`;
    case "gone":
      return `${name}${ref} is gone: removed learnings can be restored for ${HIDDEN_DAYS} days, and this one is older`;
    case "nothing-last":
      return `${name}Nothing to forget: no learning saved from your prompts in this session`;
    case "unknown":
      return `${name}No learning ${ref} here`;
    case "other-project":
      return `${name}${ref} belongs to ${clip(r.project, 40)}`;
    case "bad-ref":
      return o.verb === "restore"
        ? `${name}Nothing changed: type ${o.restore} followed by a learning's number (#12)`
        : `${name}Nothing changed: type ${o.forget} followed by a learning's number (#12) or "last"`;
    default:
      return null;
  }
}

/** One line per project about the agent's hides and forget requests (L5 decision 12). */
export function agentActionsLine(actions, { product, review }) {
  if (!actions.length) return null;
  const name = product ? `${product}: ` : "";
  if (actions.length === 1) {
    const a = actions[0];
    return a.kind === "hidden"
      ? `${name}The agent removed #${a.id} "${clip(a.text, 40)}" · restore it in ${review}`
      : `${name}The agent asked to forget #${a.id} "${clip(a.text, 40)}" · it stays in use until you decide in ${review}`;
  }
  const hidden = actions.filter((a) => a.kind === "hidden").length;
  const asked = actions.length - hidden;
  const parts = [hidden ? `removed ${hidden} learning${hidden === 1 ? "" : "s"}` : null, asked ? `asked to forget ${asked}` : null].filter(Boolean);
  return `${name}The agent ${parts.join(" and ")} · see ${review}`;
}

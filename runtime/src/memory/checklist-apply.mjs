// Carry out the review checklist's plan (L5 design decision 11), only through the review
// service and only with its token: a stale row (decided elsewhere meanwhile) changes
// nothing, and the result counts only what changed.
//
//   accept   waiting notes through L4b's acceptQueued; a provisional or confirmed flagged
//            one through acceptReviewed; an edited one as a new note in your words
//            (rememberAccepted, provenance user-cli) that supersedes the old one
//   delete   L4b's rejection record, then discardReviewed (a hash-only tombstone)
//   forget   forgetAccepted (purged, its memory-file line too)
//   keep     keepNote · restore  forget.mjs restoreLearning as the token holder
//   unmark   clearMark
// Then a `reviewed` event (rows, choices, seconds) and the hides it showed start their
// 7 days; onApply(accepted rows) is L7's hook for the rule step.

import path from "node:path";
import os from "node:os";
import { acceptReviewed, clearMark, discardReviewed, forgetAccepted, isReviewToken, keepNote, rememberAccepted } from "./review-service.mjs";
import { acceptQueued } from "./review-queue.mjs";
import { recordRejection } from "./proposal-tables.mjs";
import { restoreLearning } from "./forget.mjs";
import { recordEvent } from "./l5-tables.mjs";
import { projectClause } from "./projects.mjs";

/**
 * @param {object} handle
 * @param {object} token  a review token (reviewToken)
 * @param {ReturnType<import("./checklist.mjs").plan>} p
 * @param {{keys:string[], projectId?:string|null, slug?:string|null, rows?:object[], shownHidden?:number[],
 *   memoryFile?:string|string[], seconds?:number, now?:Date, onApply?:(rows:object[])=>any}} o
 * @returns {Promise<{accepted:number[], deleted:number[], forgotten:number[], kept:number[], restored:number[], unmarked:number[]}>}
 */
export async function applyPlan(handle, token, p, o) {
  if (!isReviewToken(token)) throw new Error("the review checklist applies only with a review token (your own terminal)");
  const { keys, now = new Date() } = o;
  const res = { accepted: [], deleted: [], forgotten: [], kept: [], restored: [], unmarked: [] };
  const acceptedRows = [];

  for (const a of p.accept) {
    if (a.text) {
      // The edit is what gets saved: a new note in the user's words, accepted, and the old
      // one superseded (never deleted: its history stays).
      const old = handle.get("SELECT id, project_slug, project_id, project_path, category, confidence FROM learnings WHERE id = ? AND accepted_by IS NULL", [a.ids[0]]);
      if (!old) continue;
      const r = rememberAccepted(handle, token, { projectSlug: old.project_slug, projectId: old.project_id, projectPath: old.project_path, category: old.category, text: a.text, evidence: `edited in review (was #${old.id})`, confidence: old.confidence ?? 0.8 }, { keys, now });
      if (r.status !== "accepted" || r.id == null) continue;
      handle.run("UPDATE learnings SET status = 'superseded', superseded_by = ?, status_at = ? WHERE id = ? AND accepted_by IS NULL", [r.id, now.toISOString(), old.id]);
      res.accepted.push(r.id);
      acceptedRows.push({ ...a, ids: [r.id] });
      continue;
    }
    const done = [];
    if (a.flagged || a.provisional) {
      for (const id of a.ids) if (acceptReviewed(handle, token, id, { keys, withFlagged: a.flagged, now })) done.push(id);
    } else {
      done.push(...acceptQueued(handle, token, a.ids, { keys, now }));
    }
    res.accepted.push(...done);
    if (done.length) acceptedRows.push({ ...a, ids: done });
  }

  for (const d of p.delete) {
    for (const id of d.ids) {
      const row = handle.get("SELECT text FROM learnings WHERE id = ? AND accepted_by IS NULL", [id]);
      if (!row) continue;
      // L4b: neither import proposes this text again (its history wordings and file lines too).
      try {
        recordRejection(handle, keys, { id, text: row.text }, { now });
      } catch {
        // no history key or tables yet: the tombstone below still stops a re-capture
      }
      if (discardReviewed(handle, token, id, { keys, now })) res.deleted.push(id);
    }
  }

  const memoryFile = o.memoryFile ?? [path.join(os.homedir(), ".agent-daemon", "user.md")];
  for (const id of p.forget) if (inProject(handle, id, keys) && forgetAccepted(handle, token, id, { memoryFile })) res.forgotten.push(id);
  for (const id of p.keep) if (inProject(handle, id, keys) && keepNote(handle, token, id, { now })) res.kept.push(id);
  for (const id of p.restore) {
    const r = restoreLearning(handle, { ref: { id }, asker: "cli-token", token, keys, now });
    if (r.status === "restored") res.restored.push(id);
  }
  for (const id of p.unmark) if (clearMark(handle, token, id, { keys })) res.unmarked.push(id);

  reviewed(handle, { ...o, now, choices: Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v.length])) });
  if (acceptedRows.length && typeof o.onApply === "function") await o.onApply(acceptedRows);
  return res;
}

/**
 * The review happened: a `reviewed` event (counts and seconds, never text), and every
 * removed note it listed whose clock wasn't started (a prompt's hide of the user's own
 * note) now has its 7 days (decision 12: shown, so it may be purged later).
 */
export function reviewed(handle, { projectId = null, slug = null, rows = [], shownHidden = [], choices = {}, seconds = null, now = new Date() } = {}) {
  handle.transaction(() => {
    recordEvent(handle, { kind: "reviewed", projectId, actor: "review", detail: { slug, rows: rows.length, choices, seconds }, at: now });
    startClocks(handle, shownHidden, now);
  });
}

/** Start the 7 days of removed notes the user was shown. */
export function startClocks(handle, ids, now = new Date()) {
  for (const id of ids) handle.run("UPDATE learnings SET status_at = ? WHERE id = ? AND status = 'hidden' AND accepted_by IS NULL AND status_at IS NULL", [now.toISOString(), id]);
}

function inProject(handle, id, keys) {
  const scope = projectClause("", keys);
  return Boolean(handle.get(`SELECT 1 AS ok FROM learnings WHERE id = ? AND ${scope.sql}`, [id, ...scope.params]));
}

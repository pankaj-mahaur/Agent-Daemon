// The only writer of provisional notes (L5 design decision 2). Imported only by
// capture-prompt.mjs and forget.mjs; a test proves the MCP server's closure never
// reaches this module and nothing else imports it.
//
// It re-checks everything itself, inside one transaction, so no caller can skip a step:
//   - a first-party verdict this process minted (hooks/prompt-source.mjs isFirstParty),
//     issued for the prompt these words come from (verdictCovers);
//   - the note isn't held back (flagged), and a new row isn't quarantined;
//   - review mode isn't strict (review-mode.mjs);
//   - the note belongs to one project (a project id and slug);
//   - a row that was provisional before and was hidden comes back pending (hide-and-revive
//     can't renew its 30 days).
// When any check fails the note is written (or left) pending. An accepted note is never
// touched.

import { isFirstParty, verdictCovers } from "../hooks/prompt-source.mjs";
import { flaggedSql } from "./trust.mjs";
import { writeLearning, sameNote } from "./episodic.mjs";
import { isStrict } from "./review-mode.mjs";
import { recordEvent, latestEvent } from "./l5-tables.mjs";

const bound = (r) => Boolean(r && typeof r.project_id === "string" && r.project_id.startsWith("prj_") && r.project_slug);

/**
 * Make a note provisional, or pending when it can't be.
 * @param {object} handle  the store
 * @param {object} verdict promptSource()'s verdict for the prompt this note came from
 * @param {{id?:number, row?:object}} target  an existing note's id, or a new row (writeLearning's shape)
 * @param {{now?:Date}} [opts]
 * @returns {{id:number|null, status:string, why?:string}}
 */
export function writeProvisional(handle, verdict, { id = null, row = null } = {}, { now = new Date() } = {}) {
  const t = now.toISOString();
  return handle.transaction(() => {
    let noteId = id;
    if (noteId == null && row) {
      // A quarantined row stays quarantined (never upgraded here); provenance is the
      // user's proven words only with a first-party verdict, else "prompt".
      if (row.status === "quarantined") {
        const q = writeLearning(handle, { ...row, provenance: "prompt" });
        return { id: q == null ? null : Number(q), status: "quarantined", why: "flagged" };
      }
      const proven = isFirstParty(verdict) && verdictCovers(verdict, row.text);
      const fields = { ...row, status: "pending", origin: "user", provenance: proven ? "user-prompt" : "prompt" };
      noteId = writeLearning(handle, fields);
      if (noteId == null) noteId = sameNote(handle, row.projectSlug, row.text, undefined, row.projectId)?.id ?? null;
      if (noteId == null) return { id: null, status: "none", why: "not stored" };
      noteId = Number(noteId);
    }
    const cur = handle.get(`SELECT id, text, status, accepted_by, project_id, project_slug, ${flaggedSql()} AS flagged FROM learnings WHERE id = ?`, [noteId]);
    if (!cur) return { id: noteId, status: "none", why: "no such note" };
    if (cur.accepted_by) return { id: noteId, status: cur.status, why: "accepted" };
    if (cur.flagged) return { id: noteId, status: cur.status, why: "flagged" };
    // Falling back to pending: a hidden note comes back only from the agent's own hide (a
    // user's hide stands, L5 decision 15); a first-party one revives it whoever hid it.
    const pend = (why, { revive = false } = {}) => {
      const hider = cur.status === "hidden" ? latestEvent(handle, "hidden", noteId)?.actor : null;
      if (cur.status === "hidden" && (revive || hider === "agent")) {
        handle.run("UPDATE learnings SET status = 'pending', status_at = ? WHERE id = ? AND status = 'hidden' AND accepted_by IS NULL", [t, noteId]);
        recordEvent(handle, { kind: "restored", learningId: noteId, projectId: cur.project_id, actor: revive ? "user" : "system", at: now });
        return { id: noteId, status: "pending", why };
      }
      return { id: noteId, status: cur.status, why };
    };
    if (!isFirstParty(verdict)) return pend("not first-party");
    if (!verdictCovers(verdict, cur.text)) return pend("not this prompt's words");
    if (isStrict(handle)) return pend("strict", { revive: true });
    if (!bound(cur)) return pend("no project", { revive: true });
    if (!["pending", "hidden", "provisional"].includes(cur.status)) return { id: noteId, status: cur.status, why: "not reviewable" };
    if (cur.status === "provisional") return { id: noteId, status: "provisional", why: "already" };
    if (cur.status === "hidden" && latestEvent(handle, "provisional", noteId)) return pend("was provisional before", { revive: true });
    const extra = row ? ", evidence = ?, capture_ref = ?" : "";
    const params = row ? [row.evidence ?? null, row.captureRef ?? null] : [];
    handle.run(
      `UPDATE learnings SET status = 'provisional', status_at = ?, origin = 'user', provenance = 'user-prompt', promote_request = NULL${extra}
        WHERE id = ? AND accepted_by IS NULL AND status IN ('pending', 'hidden')`,
      [t, ...params, noteId]
    );
    recordEvent(handle, { kind: "provisional", learningId: noteId, projectId: cur.project_id, actor: "user", at: now });
    return { id: noteId, status: "provisional" };
  });
}

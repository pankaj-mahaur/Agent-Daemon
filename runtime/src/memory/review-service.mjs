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
import { learningContentHash, scopedContentHash, normKey } from "./sqlite.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { purgeLearnings } from "./purge.mjs";
import { isProjectId, projectClause } from "./projects.mjs";
import { dropFromFile } from "./metrics.mjs";
import { probeAncestry } from "./ancestry.mjs";
import { confirmByDialog } from "./dialog-code.mjs";
import { reviewableSql, openSql, acceptedSql } from "./trust.mjs";
import { putSetting, recordEvent, tombstoneHash } from "./l5-tables.mjs";
import { writeLearning, sameNote } from "./episodic.mjs";
import { scrubForgotten } from "./scrub.mjs";
import { gitTracked } from "./git-tracked.mjs";

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

/**
 * Is this the user's own terminal, by the token's checks without the dialog code? Mints
 * nothing: for what a command shows (L8: an agent's shell sees neutral text), never to write.
 */
export function inOwnTerminal({ env = process.env, isTTY = realTTY, ancestry = probeAncestry } = {}) {
  if (env.AD_TOOL_SHELL === "1" || !isTTY()) return false;
  return (ancestry() ?? { verdict: "unknown" }).verdict === "terminal";
}

/**
 * → { token, dialogProven? } in the user's own terminal (asking for the dialog code when
 * needed), else { refused: text }. dialogProven: this run typed L1's dialog code, so a
 * lowering verb doesn't ask for the typed code of L7 D16 again.
 */
export async function reviewToken({ ask, out, dialog = confirmByDialog, ...checks } = {}) {
  const first = checkReviewToken(checks);
  if (!first.needsCode) return first;
  const proved = await dialog({ ask, out, found: first.needsCode });
  return proved?.ok ? { token: mint(), dialogProven: true } : { refused: proved?.text ?? "accepting notes needs the dialog code." };
}

/** Is this a token the review service issued (in this process)? */
export const isReviewToken = (token) => Boolean(token && typeof token === "object" && issued.has(token));

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

/**
 * Accept one user fact. keys: the project it is reviewed in; the fact is accepted there
 * only, so sightings recorded elsewhere (a journal line can claim any) don't widen it.
 */
export function acceptFact(handle, token, id, { now, keys } = {}) {
  must(token);
  const t = iso(now);
  if (Array.isArray(keys) && keys.length) {
    const ids = keys.filter(isProjectId);
    const slugs = keys.filter((k) => !isProjectId(k) && !k.startsWith("~"));
    handle.run("UPDATE user_facts SET projects = ? WHERE id = ?", [JSON.stringify(slugs), id]);
    try {
      handle.run("UPDATE user_facts SET project_ids = ? WHERE id = ?", [JSON.stringify(ids), id]);
    } catch {
      // an older store without project ids
    }
  }
  return handle.run("UPDATE user_facts SET status = 'active', accepted_by = 'review', accepted_at = ?, status_at = ?, quarantine_reason = NULL WHERE id = ?", [t, t, id]).changes;
}

/** A 3.0 automatic global note, accepted for every project. */
export function acceptGlobal(handle, token, id, { now } = {}) {
  must(token);
  const t = iso(now);
  // A provisional note is project-only (L5 decision 16): it becomes global only after it is accepted in its project.
  return handle.run("UPDATE learnings SET global_accepted_at = ?, accepted_by = COALESCE(accepted_by, 'review'), accepted_at = COALESCE(accepted_at, ?) WHERE id = ? AND status <> 'provisional'", [t, t, id]).changes;
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
  // A provisional note is project-only (L5 decision 16).
  if (handle.get("SELECT status FROM learnings WHERE id = ?", [row.id])?.status === "provisional") return { ok: false, text: `Learning #${row.id} is in use in this project only; accept it there first.` };
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

// The note's lines in the memory files go too (the project's activeContext.md, and the
// global user.md where older ad wrote cross-project notes): session start injects both.
function dropFromMemoryFile(files, text) {
  if (!text) return false;
  let dropped = false;
  for (const file of [files].flat().filter(Boolean)) {
    try {
      const next = dropFromFile(readFileSync(file, "utf8"), text);
      if (next === null) continue;
      writeFileSync(file, next);
      dropped = true;
    } catch {
      // no such memory file
    }
  }
  return dropped;
}

/** The user keeps a note the agent asked to forget. */
export function keepNote(handle, token, id, { now } = {}) {
  must(token);
  return handle.run("UPDATE learnings SET status = 'active', status_at = ? WHERE id = ? AND status = 'forget-requested'", [iso(now), id]).changes;
}

/** The user forgets an accepted note for good: purged, bytes and index entries included, and its memory-file line. */
export function forgetAccepted(handle, token, id, { memoryFile, onScrub, tracked } = {}) {
  must(token);
  const row = handle.get("SELECT text, project_slug, project_id, project_path FROM learnings WHERE id = ? AND status IN ('active', 'forget-requested') AND accepted_by IS NOT NULL", [id]);
  if (!row) return 0;
  // L8 (design decision 7): the words it replaced go too — the superseded rows an edit or a
  // reword left behind, walked back to the first. Otherwise purging this row would orphan
  // them (superseded_by nulled) with the old words for good.
  const chain = supersededChain(handle, id);
  const texts = [row.text, ...chain.map((r) => r.text)];
  const purged = purgeLearnings(handle, [id, ...chain.map((r) => r.id)]);
  for (const t of texts) dropFromMemoryFile(memoryFile, t);
  // L8 (design decision 16): and from the journals and proposal files (best effort).
  if (purged) {
    try {
      const project = row.project_slug === null || row.project_slug === undefined ? null : { slug: row.project_slug, id: row.project_id ?? null, paths: [row.project_path, ...chain.map((r) => r.project_path)] };
      const res = scrubForgotten(handle, texts, { project, tracked: tracked ?? ((f, repo) => gitTracked(f, repo)) });
      onScrub?.({ ...res, older: chain.length });
    } catch {
      // the store no longer holds the note; the files are best effort
    }
  }
  return purged;
}

/** The superseded rows behind a note (each one's superseded_by is the next), newest first. */
export function supersededChain(handle, id, { max = 1000 } = {}) {
  const out = [];
  const seen = new Set([Number(id)]);
  let frontier = [Number(id)];
  while (frontier.length && out.length < max) {
    const marks = frontier.map(() => "?").join(",");
    const rows = handle.all(`SELECT id, text, project_path FROM learnings WHERE status = 'superseded' AND superseded_by IN (${marks})`, frontier).filter((r) => !seen.has(r.id));
    for (const r of rows) seen.add(r.id);
    out.push(...rows);
    frontier = rows.map((r) => r.id);
  }
  return out;
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

// ── L5: the review checklist, CLI remember with the token, review mode ────────────────

/**
 * Accept one note from the review checklist (L5 decision 11): only while it is still
 * reviewable in these projects (pending or provisional; a flagged one only with
 * withFlagged, never one held back for a secret), so a stale row changes nothing.
 * → rows changed (0 or 1).
 */
export function acceptReviewed(handle, token, id, { keys, withFlagged = false, appliedTo = "memory:project", now } = {}) {
  must(token);
  const scope = inProject(keys);
  const t = iso(now);
  return handle.run(
    `UPDATE learnings SET status = 'active', accepted_by = 'review', accepted_at = ?, status_at = ?, quarantine_reason = NULL, applied_to = ?
      WHERE id = ? AND ${reviewableSql("", { withFlagged })} AND ${scope.sql}`,
    [t, t, appliedTo, id, ...scope.params]
  ).changes;
}

/**
 * CLI `remember` run with the token (02 §2): the screened note is stored and accepted at
 * once, provenance user-cli. row: writeLearning's shape (the caller screened it; a flagged
 * note never comes here). An existing note with that text in the project is accepted in
 * place when it is reviewable. → { id, status }.
 */
export function rememberAccepted(handle, token, row, { keys, now } = {}) {
  must(token);
  if (!Array.isArray(keys) || !keys.length) return { id: null, status: "no-project" };
  return handle.transaction(() => {
    let id = writeLearning(handle, { ...row, status: "pending", origin: "user", provenance: "user-cli" });
    if (id == null) id = sameNote(handle, row.projectSlug, row.text, undefined, row.projectId)?.id ?? null;
    if (id == null) return { id: null, status: "none" };
    id = Number(id);
    const cur = handle.get("SELECT status, accepted_by FROM learnings WHERE id = ?", [id]);
    if (cur?.accepted_by) return { id, status: "accepted-before" };
    // A hidden note the user now remembers in their own terminal: back, and accepted. If the
    // accept can't happen (another project, flagged), it goes back to hidden as it was.
    const hidden = cur?.status === "hidden" ? handle.get("SELECT status_at FROM learnings WHERE id = ?", [id]) : null;
    if (hidden) handle.run("UPDATE learnings SET status = 'pending' WHERE id = ? AND status = 'hidden' AND accepted_by IS NULL", [id]);
    const changed = acceptReviewed(handle, token, id, { keys, now });
    if (changed) handle.run("UPDATE learnings SET provenance = 'user-cli', origin = 'user' WHERE id = ?", [id]);
    else if (hidden) handle.run("UPDATE learnings SET status = 'hidden', status_at = ? WHERE id = ? AND status = 'pending' AND accepted_by IS NULL", [hidden.status_at, id]);
    const now2 = handle.get("SELECT status FROM learnings WHERE id = ?", [id])?.status ?? "none";
    return { id, status: changed ? "accepted" : now2 };
  });
}

/** Turn review mode back to auto (L5 decision 10): it widens trust, so it needs the token. */
export function setReviewAuto(handle, token, { now = new Date() } = {}) {
  must(token);
  return handle.transaction(() => {
    putSetting(handle, "review_mode", "auto", { now });
    recordEvent(handle, { kind: "strict-off", actor: "review", at: now });
    return true;
  });
}

/**
 * Turn recall on or off for one project (plan L6, design decision 13). The review token
 * both ways: off would stop recall of accepted notes (02 §7 invariant 3), and the agent
 * mustn't undo the user's off either.
 */
export function setRecallMode(handle, token, projectId, mode, { now = new Date() } = {}) {
  must(token);
  if (!projectId || !["on", "off"].includes(mode)) throw new Error("recall mode: on or off, for a project");
  putSetting(handle, `recall_mode:${projectId}`, mode, { now });
  return mode;
}

/**
 * Delete a note for good from the review checklist (L5 decision 11): only a note of these
 * projects that was never accepted (waiting, in use before review, flagged or removed).
 * It leaves a hash-only tombstone (an events row of kind `discarded`, never the text), so
 * the same capture comes back as "You deleted this before". The caller records L4b's
 * rejection first (proposal-tables.mjs recordRejection). → rows purged (0 or 1)
 */
export function discardReviewed(handle, token, id, { keys, now } = {}) {
  must(token);
  const scope = inProject(keys);
  const row = handle.get(`SELECT id, text, project_id FROM learnings WHERE id = ? AND (${openSql()} OR (status = 'hidden' AND accepted_by IS NULL)) AND ${scope.sql}`, [id, ...scope.params]);
  if (!row) return 0;
  const nk = normKey(row.text);
  if (nk) recordEvent(handle, { kind: "discarded", projectId: row.project_id ?? null, actor: "review", detail: { hash: tombstoneHash(nk) }, at: now });
  return purgeLearnings(handle, [row.id]);
}

/** "You asked to remove", answered keep in review: the mark goes, the note stays as it is. → marks cleared */
export function clearMark(handle, token, id, { keys } = {}) {
  must(token);
  const scope = inProject(keys);
  if (!handle.get(`SELECT 1 AS ok FROM learnings WHERE id = ? AND ${scope.sql}`, [id, ...scope.params])) return 0;
  try {
    return handle.run("DELETE FROM events WHERE kind = 'marked' AND learning_id = ?", [id]).changes;
  } catch {
    return 0; // no events table: no marks
  }
}

/**
 * The user edits a note in their own terminal (MCP launch plan L8, design decision 6).
 * The path is chosen by the trust predicates, never the raw status:
 *   - accepted (active or forget-requested, accepted_by set) → a new accepted row with the
 *     new words (provenance and origin kept) supersedes it; the caller runs afterReview so
 *     its rules move to the new row;
 *   - unreviewed (pending, provisional, held back) → changed in place, back to pending;
 *   - anything else (hidden, archived, rejected, superseded) → "closed".
 * The new words pass the same screens as `remember` in the user's terminal: a secret or any
 * flag refuses the edit (it never launders text past the screen).
 * @returns {Promise<{status:"replaced"|"edited"|"same"|"empty"|"too-long"|"refused-secret"|"flagged"|"duplicate"|"closed"|"other"|"none", id?:number, newId?:number, twin?:number, flags?:string[], label?:string}>}
 */
export async function editLearning(handle, token, id, text, { keys, now = new Date() } = {}) {
  must(token);
  const row = handle.get("SELECT * FROM learnings WHERE id = ?", [id]);
  if (!row) return { status: "none" };
  const scope = inProject(keys);
  if (!handle.get(`SELECT 1 AS x FROM learnings WHERE id = ? AND (${scope.sql} OR (project_slug IS NULL AND ${acceptedSql()}))`, [id, ...scope.params])) return { status: "other" };
  const t = String(text ?? "").replace(/^\u{FEFF}/u, "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  if (!t) return { status: "empty", id };
  if (normKey(t) === normKey(row.text)) return { status: "same", id };
  if (t.length > 2000) return { status: "too-long", id };
  const { screenPrompt } = await import("./prompt-screen.mjs");
  const { screenLearning } = await import("../digest/sanitize.mjs");
  const flags = [...screenPrompt(t, { userWords: true }).flags];
  if (flags.includes("secret")) return { status: "refused-secret", id };
  if (screenLearning({ text: t, evidence_quote: "", tags: [] }).verdict !== "clean" && !flags.includes("instruction")) flags.push("instruction");
  if (flags.length) return { status: "flagged", id, flags };
  const accepted = Boolean(handle.get(`SELECT 1 AS x FROM learnings WHERE id = ? AND ${acceptedSql()}`, [id]));
  const open = Boolean(handle.get(`SELECT 1 AS x FROM learnings WHERE id = ? AND ${openSql()}`, [id]));
  if (!accepted && !open) return { status: "closed", id, label: row.status };
  const global = row.project_slug === null || row.project_slug === undefined;
  const nk = normKey(t);
  const hash = global ? learningContentHash(t) : scopedContentHash(row.project_id || row.project_slug, t);
  // A twin with these words that is served or waits refuses the edit; one that is never
  // served again (an older wording, rejected, archived, hidden) gives up its hash, as
  // promoteLearning does, so editing back to earlier words works.
  const CLOSED = ["superseded", "rejected", "archived", "hidden"];
  const twins = [
    ...handle.all("SELECT id, status FROM learnings WHERE id <> ? AND (norm_key = ? OR content_hash = ?) AND (project_slug IS ? OR (? IS NOT NULL AND project_id = ?))", [id, nk, hash, row.project_slug ?? null, row.project_id ?? null, row.project_id ?? null]),
    ...handle.all("SELECT id, status FROM learnings WHERE content_hash = ? AND id <> ?", [hash, id]),
  ].filter((x, i, all) => all.findIndex((y) => y.id === x.id) === i);
  const live = twins.find((x) => !CLOSED.includes(x.status));
  if (live) return { status: "duplicate", id, twin: live.id };
  const retire = () => {
    for (const x of twins) handle.run("UPDATE learnings SET content_hash = ?, norm_key = NULL WHERE id = ?", [`retired-${x.id}`, x.id]);
  };
  const at = iso(now);
  const detail = { from: learningContentHash(row.text), to: learningContentHash(t) };
  if (accepted) {
    return handle.transaction(() => {
      retire();
      const newId = Number(handle.run(
        `INSERT INTO learnings (session_id, project_slug, project_id, project_path, category, text, evidence, confidence, status, supersedes, tags, applied_to,
                                content_hash, norm_key, provenance, origin, accepted_by, accepted_at, status_at, global_accepted_at, created_at)
         SELECT session_id, project_slug, project_id, project_path, category, ?, ?, confidence, 'active', id, tags, applied_to,
                ?, ?, provenance, origin, 'review', ?, ?, global_accepted_at, ? FROM learnings WHERE id = ?`,
        // Not the old evidence: it quotes the old words (as ad review's reword does).
        [t, `edited in your terminal (was #${id})`, hash, nk, at, at, at, id]
      ).lastInsertRowid);
      handle.run("UPDATE learnings SET status = 'superseded', superseded_by = ?, status_at = ? WHERE id = ?", [newId, at, id]);
      recordEvent(handle, { kind: "edited", learningId: newId, projectId: row.project_id ?? null, actor: "review", detail: { ...detail, was: id }, at: now });
      return { status: "replaced", id, newId, text: t };
    });
  }
  return handle.transaction(() => {
    retire();
    handle.run(
      `UPDATE learnings SET text = ?, content_hash = ?, norm_key = ?, status_at = ?, evidence = 'edited in your terminal',
              status = CASE WHEN status IN ('provisional', 'quarantined') THEN 'pending' ELSE status END,
              quarantine_reason = NULL,
              applied_to = CASE WHEN COALESCE(applied_to, '') LIKE 'quarantined%' THEN NULL ELSE applied_to END
        WHERE id = ? AND accepted_by IS NULL`,
      [t, hash, nk, at, id]
    );
    recordEvent(handle, { kind: "edited", learningId: id, projectId: row.project_id ?? null, actor: "review", detail, at: now });
    return { status: "edited", id, text: t };
  });
}

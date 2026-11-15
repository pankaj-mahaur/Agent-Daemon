// `learnings export` and `learnings import` (MCP launch plan L8, design decisions 8–9).
//
//   exportNotes(handle, {keys, home, user})   accepted notes only (trust.mjs exportableSql),
//                                              redacted: secrets masked, home and account name
//                                              replaced; no ids, paths, tags, evidence, counts
//   buildFile(notes, {now}) / parseFile(text)  format `agent-daemon-learnings`, version 1
//   importNotes(handle, notes, {…})            every note lands in review: pending, or held
//                                              back when a screen flags it; never accepted
//
// The file is for the user's own private repository: the user pushes it (ad runs no git
// remote verb, D2). Rules travel with their note on export; import holds them back until
// L7's rule proposals exist.

import os from "node:os";
import { projectClause } from "./projects.mjs";
import { exportableSql } from "./trust.mjs";
import { findSecrets, redactSecrets } from "../security/secret-patterns.mjs";
import { normKey, scopedContentHash } from "./sqlite.mjs";
import { recordEvent } from "./l5-tables.mjs";

export const FORMAT = "agent-daemon-learnings";
export const VERSION = 1;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_NOTES = 500;
export const MAX_NOTE_CHARS = 2000;
const CATEGORIES = new Set(["correction", "pattern", "gotcha", "tool", "preference", "fact"]);
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, (c) => "\\" + c);

/** A note's words as they may leave this computer, or null when a secret is still there. */
export function redactForExport(text, { home = os.homedir(), user = safeUser(), screen } = {}) {
  // A credential told in words ("my deploy token is …") only the prompt screen catches.
  if (screen?.(String(text ?? "")).flags?.includes("secret")) return null;
  let t = redactSecrets(String(text ?? "")).text;
  // The home folder in either slash form; case-insensitive (Windows paths are).
  for (const h of [...new Set([home, home.replace(/\\/g, "/"), home.replace(/\//g, "\\")])].filter((x) => x && x.length > 1)) t = t.replace(new RegExp(`${esc(h)}(?=[\\\\/]|$|[\\s"'),.;:])`, "gi"), "~");
  // The account name only as a path segment (/Users/<name>/, C:\Users\<name>): a user named
  // "dev" keeps every other "dev" in their notes.
  if (user && user.length >= 3) t = t.replace(new RegExp(`(?<=[\\\\/](?:users|home)[\\\\/])${esc(user)}(?=[\\\\/]|$|[\\s"'),.;:])`, "gi"), "<user>");
  t = t.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return findSecrets(t).length ? null : t;
}

function safeUser() {
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
}

// Every string inside a rule's pattern goes through the same redaction.
function redactDeep(v, o) {
  if (typeof v === "string") return redactForExport(v, o);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, o));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, o)]));
  return v;
}
const hasNull = (v) => v === null || (Array.isArray(v) ? v.some(hasNull) : v && typeof v === "object" ? Object.values(v).some(hasNull) : false);

/**
 * This project's accepted notes plus the accepted global ones, redacted. → {notes, skipped}
 * @param {{keys: string[], home?: string, user?: string|null, screen?: (text:string)=>{flags:string[]}}} o
 *   screen: prompt-screen.mjs screenPrompt (the CLI passes it; notes it flags `secret` stay home)
 */
export function exportNotes(handle, { keys, home, user, screen } = {}) {
  const p = projectClause("l", keys ?? []);
  const rows = handle.all(
    `SELECT l.id, l.text, l.category, l.project_slug, l.accepted_at FROM learnings l WHERE ${exportableSql("l")} AND (${p.sql} OR l.project_slug IS NULL)`,
    p.params
  );
  const opts = { ...(home ? { home } : {}), ...(user !== undefined ? { user } : {}), ...(screen ? { screen } : {}) };
  let skipped = 0;
  const notes = [];
  for (const r of rows) {
    const text = redactForExport(r.text, opts);
    if (!text) {
      skipped++;
      continue;
    }
    let rules = [];
    try {
      rules = handle.all("SELECT kind, decision, pattern FROM rules WHERE learning_id = ? AND orphaned_at IS NULL ORDER BY id", [r.id]);
    } catch {
      rules = []; // an older store: no rules table
    }
    const kept = [];
    for (const x of rules) {
      let pattern;
      try {
        pattern = redactDeep(JSON.parse(x.pattern), opts);
      } catch {
        continue;
      }
      if (!hasNull(pattern)) kept.push({ kind: x.kind, decision: x.decision, pattern });
    }
    notes.push({ text, category: CATEGORIES.has(r.category) ? r.category : "pattern", scope: r.project_slug === null || r.project_slug === undefined ? "all" : "project", accepted_at: r.accepted_at ?? null, ...(kept.length ? { rules: kept } : {}) });
  }
  notes.sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  return { notes, skipped };
}

/** The file's JSON text. */
export function buildFile(notes, { now = new Date() } = {}) {
  return `${JSON.stringify({ format: FORMAT, version: VERSION, exported_at: now.toISOString(), notes }, null, 2)}\n`;
}

/** → {notes} or {error}. Only this format and version; bounded. */
export function parseFile(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) return { error: "the file is larger than 2 MB" };
  let j;
  try {
    j = JSON.parse(text.replace(/^\u{FEFF}/u, ""));
  } catch {
    return { error: "it isn't a learnings file (not JSON)" };
  }
  if (j?.format !== FORMAT || j?.version !== VERSION || !Array.isArray(j.notes)) return { error: `it isn't a ${FORMAT} file of version ${VERSION}` };
  if (j.notes.length > MAX_NOTES) return { error: `it holds more than ${MAX_NOTES} notes` };
  const notes = [];
  for (const n of j.notes) {
    const text = typeof n?.text === "string" ? n.text.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim() : "";
    if (!text) return { error: "a note without text" };
    if (n.text.length > MAX_NOTE_CHARS) return { error: `a note longer than ${MAX_NOTE_CHARS} characters` };
    notes.push({ text, category: CATEGORIES.has(n.category) ? n.category : "pattern", rules: Array.isArray(n.rules) ? n.rules.length : 0 });
  }
  return { notes };
}

/**
 * Add the file's notes for review in this project. Never accepted (D3).
 * @param {{projectSlug: string, projectId?: string|null, now?: Date}} o
 * @returns {Promise<{added:number, flagged:number, same:number, deleted:number, secret:number, rulesHeld:number}>}
 */
export async function importNotes(handle, notes, { projectSlug, projectId = null, now = new Date() }) {
  const { screenPrompt } = await import("./prompt-screen.mjs");
  const { screenLearning } = await import("../digest/sanitize.mjs");
  const { sameNote } = await import("./episodic.mjs");
  const { discardedBefore } = await import("./capture-prompt.mjs");
  const res = { added: 0, flagged: 0, same: 0, deleted: 0, secret: 0, rulesHeld: 0 };
  const at = now.toISOString();
  handle.transaction(() => {
    for (const n of notes) {
      res.rulesHeld += n.rules ?? 0;
      const t = n.text;
      const screen = screenPrompt(t, { userWords: false });
      if (screen.flags.includes("secret") || findSecrets(t).length) {
        res.secret++;
        continue;
      }
      const nk = normKey(t);
      if (discardedBefore(handle, nk, projectId)) {
        res.deleted++;
        continue;
      }
      if (sameNote(handle, projectSlug, t, nk, projectId)) {
        res.same++;
        continue;
      }
      const flagged = screen.flags.length > 0 || screenLearning({ text: t, evidence_quote: "", tags: [] }).verdict !== "clean";
      const hash = scopedContentHash(projectId || projectSlug, t);
      if (handle.get("SELECT 1 AS x FROM learnings WHERE content_hash = ?", [hash])) {
        res.same++;
        continue;
      }
      const id = Number(handle.run(
        `INSERT INTO learnings (project_slug, project_id, category, text, evidence, confidence, status, content_hash, norm_key, provenance, origin, applied_to, quarantine_reason, created_at)
         VALUES (?, ?, ?, ?, 'imported from a learnings file', 0.6, ?, ?, ?, 'import', 'import', ?, ?, ?)`,
        [projectSlug, projectId, n.category, t, flagged ? "quarantined" : "pending", hash, nk, flagged ? `quarantined:import` : `proposed:import`, flagged ? (screen.flags.join(", ") || "reads like an instruction") : null, at]
      ).lastInsertRowid);
      recordEvent(handle, { kind: "captured", learningId: id, projectId, actor: "system", detail: { via: "import" }, at: now });
      if (flagged) res.flagged++;
      else res.added++;
    }
  });
  return res;
}

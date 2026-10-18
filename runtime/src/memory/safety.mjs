// Memory safety checks over the episodic DB (plan §M).
//
//   slugCollides / findSlugCollisions — two folders whose paths map to the
//     same project_slug ("/x/a/b" and "/x/a-b" both become "-x-a-b"). Until
//     stable project IDs exist, such a key is withheld everywhere: serving it
//     would mix two projects' notes.
//   runSafetyScan — a one-time pass over existing rows (long-running processes
//     only: `ad` start, `ad doctor`, `ad memory scan`; never hooks, never db()).

import { existsSync } from "node:fs";
import path from "node:path";
import { findSecrets } from "../security/secret-patterns.mjs";
import { screenLearning } from "../digest/sanitize.mjs";

const samePath = (a, b) => {
  const n = (p) => path.resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

/** True when another recorded folder shares `key` with `dir`. */
export function slugCollides(handle, key, dir) {
  let rows = [];
  try {
    rows = handle.all("SELECT DISTINCT project_path FROM sessions WHERE project_slug = ? AND project_path IS NOT NULL", [key]);
  } catch {
    return false; // no sessions table yet
  }
  // A recorded folder that no longer exists (renamed, deleted) no longer collides.
  return rows.some((r) => r.project_path && !samePath(r.project_path, dir) && existsSync(r.project_path));
}

/** Every key that more than one recorded folder maps to: [{ key, paths }]. */
export function findSlugCollisions(handle) {
  let rows = [];
  try {
    rows = handle.all("SELECT project_slug AS key, project_path AS p FROM sessions WHERE project_slug IS NOT NULL AND project_path IS NOT NULL GROUP BY project_slug, project_path");
  } catch {
    return [];
  }
  const byKey = new Map();
  for (const r of rows) {
    if (!existsSync(r.p)) continue;
    const list = byKey.get(r.key) ?? [];
    if (!list.some((p) => samePath(p, r.p))) list.push(r.p);
    byKey.set(r.key, list);
  }
  return [...byKey].filter(([, paths]) => paths.length > 1).map(([key, paths]) => ({ key, paths }));
}

export const SCAN_NAME = "safety-scan-v1";
const STRONG_INJECTION = new Set(["instruction-override", "role-override", "covert-instruction", "exfil-attempt"]);
const CLASSIC_OVERRIDE = /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,24}\b(?:all|any|the|your)?\s*(?:previous|prior|above|earlier|preceding|system)\b[^.\n]{0,24}\b(?:instructions?|prompts?|messages?|directions?)\b/i;

/**
 * Hold back existing rows that 3.0 stored unsafely. Runs once (marker row in
 * memory_maintenance); only status and quarantine_reason change:
 *   - legacy quarantine (applied_to 'quarantined…' on an active row) → injection:legacy
 *   - a high-confidence secret in an active learning or fact → secret:<kinds>
 *   - else an injection-screen hit → injection:<reasons>
 * Generic secret shapes are masked when shown and never hide a row.
 *
 * @returns {{ learnings: number, facts: number, checked: number, skipped?: boolean, busy?: boolean }}
 */
export function runSafetyScan(handle, { name = SCAN_NAME } = {}) {
  if (handle.get("SELECT name FROM memory_maintenance WHERE name = ?", [name])) return { learnings: 0, facts: 0, checked: 0, skipped: true };
  const verdict = (text, evidence, tags) => {
    const kinds = [...new Set([text, evidence, tags].flatMap((t) => findSecrets(t ?? "", { minConfidence: "high" }).map((h) => h.kind)))];
    if (kinds.length) return `secret:${kinds.join(",")}`;
    // Old notes are judged only by the strong reasons: a repo that works on
    // hooks or markers writes notes that trip the spoof and command checks
    // (hookSpecificOutput, <!-- agent-daemon:… -->, curl …), and nothing can
    // release a held note yet. New notes still face the full screen at write.
    const s = screenLearning({ text: text ?? "", evidence_quote: evidence ?? "", tags: safeTags(tags) });
    // instruction-override counts only in its classic form ("ignore previous instructions");
    // "disregard the old eslint rules" is an ordinary note.
    const strong = s.reasons.filter((r) => STRONG_INJECTION.has(r) && (r !== "instruction-override" || CLASSIC_OVERRIDE.test(`${text ?? ""}\n${evidence ?? ""}`)));
    return strong.length ? `injection:${strong.join(",")}` : null;
  };
  let learnings = 0;
  let facts = 0;
  let checked = 0;
  try {
    handle.raw.transaction(() => {
      learnings += handle.run(
        "UPDATE learnings SET status = 'quarantined', quarantine_reason = 'injection:legacy' WHERE status = 'active' AND applied_to LIKE 'quarantined%'"
      ).changes;
      const mark = handle.raw.prepare("UPDATE learnings SET status = 'quarantined', quarantine_reason = ? WHERE id = ?");
      // .all(), not .iterate(): better-sqlite3 refuses other statements mid-iteration.
      for (const r of handle.raw.prepare("SELECT id, text, evidence, tags FROM learnings WHERE status = 'active'").all()) {
        checked++;
        const why = verdict(r.text, r.evidence, r.tags);
        if (why) {
          mark.run(why, r.id);
          learnings++;
        }
      }
      const markFact = handle.raw.prepare("UPDATE user_facts SET status = 'quarantined', quarantine_reason = ? WHERE id = ?");
      for (const r of handle.raw.prepare("SELECT id, text, evidence FROM user_facts WHERE status = 'active'").all()) {
        checked++;
        const why = verdict(r.text, r.evidence, null);
        if (why) {
          markFact.run(why, r.id);
          facts++;
        }
      }
      handle.run("INSERT INTO memory_maintenance (name, done_at, result) VALUES (?, ?, ?)", [name, new Date().toISOString(), JSON.stringify({ learnings, facts, checked })]);
    }).immediate();
  } catch (e) {
    if (e.code === "SQLITE_BUSY") return { learnings: 0, facts: 0, checked: 0, busy: true };
    throw e;
  }
  return { learnings, facts, checked };
}

function safeTags(tags) {
  if (!tags) return [];
  try {
    const t = JSON.parse(tags);
    return Array.isArray(t) ? t : [];
  } catch {
    return [String(tags)];
  }
}

/**
 * Run the one-time scan from a long-running command (`ad` start, `ad doctor`).
 * Never throws: a busy or missing store just means "next time".
 */
export async function runSafetyScanOnce({ err = process.stderr } = {}) {
  try {
    const { db } = await import("./episodic.mjs");
    const handle = await db();
    if (!handle || safetyScanDone(handle)) return null;
    const r = runSafetyScan(handle);
    if (!r.skipped && !r.busy && r.learnings + r.facts > 0) err.write(`agent-daemon: checked older memory notes: ${r.learnings + r.facts} held back (ad memory held)\n`);
    return r;
  } catch (e) {
    err.write(`agent-daemon: the memory check didn't run (${e.message}); ad memory scan runs it\n`);
    return null;
  }
}

/** True once the scan has run (hooks read this, never run the scan). */
export function safetyScanDone(handle, { name = SCAN_NAME } = {}) {
  try {
    return Boolean(handle.get("SELECT name FROM memory_maintenance WHERE name = ?", [name]));
  } catch {
    return false;
  }
}

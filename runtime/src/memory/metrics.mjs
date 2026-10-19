// Does memory work? (P5.5) The local loop behind ad's "fewer repeated mistakes":
//   recordInjections(handle, …)   the lessons a session was shown (SessionStart,
//                                 prompt recall, the memory tools)
//   classifyCorrection(handle, …) a new correction: does it repeat an accepted lesson
//                                 from an earlier session, and was that lesson shown?
//   mcpCaptureRef()               one id per memory-server process (the server never
//                                 learns the host's session id)
//
// The repeat test: an accepted lesson in the same project (or an accepted
// cross-project one) from an EARLIER session — another capture_ref, or one unknown
// and at least 10 minutes older — matching `exact` (norm_key) or `similar` (one
// of the top FTS hits sharing ≥ 60% of its content words). was_injected:
//   yes      the lesson was shown to this session (memory tools, recall, SessionStart
//            and its memory file)                               → "ineffective"
//   no       the session is a host session and it wasn't shown   → "retrieval miss"
//   unknown  pull or hookless surfaces, where the session can't be tied
// One event per (session, text): the hook path and the digest see the same words.
// Effects, project lessons only (a cross-project lesson isn't changed from one
// project): a similar retrieval miss raises confidence by 0.1 (an exact one is
// reinforced when stored); ineffective repeats in two different sessions ask for
// a memory-reword proposal (the caller writes it: result.reword); unknown changes
// nothing. A pending (agent-recorded) lesson is never touched: only ad review accepts.

import { normKey } from "./sqlite.mjs";
import { learningVisibility } from "./episodic.mjs";

const EARLIER_MS = 10 * 60 * 1000;
const SIMILAR = 0.6;
const STOP = new Set("the a an and or but of to in on for with is are was were be been it this that these those use uses using not no do does don't we you our your my its at by as from into than then so if when".split(" "));
const PROCESS_REF = `proc:${process.pid}-${Date.now().toString(36)}`;

/** The capture ref of this memory-server process. */
export const mcpCaptureRef = () => PROCESS_REF;
/** A host session id (hooks), as opposed to a per-process ref or nothing. */
export const isSessionRef = (ref) => typeof ref === "string" && ref !== "" && !ref.startsWith("proc:");

/** Content words, lowercased: the comparison behind "similar". */
export function contentWords(text) {
  return new Set((String(text ?? "").toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []).filter((w) => !STOP.has(w)));
}
export function jaccard(a, b) {
  const A = contentWords(a);
  const B = contentWords(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

/** Record that `ids` were shown to a session. Never throws. */
export function recordInjections(handle, { captureRef, projectKey, ids, surface, host = null }) {
  if (!handle || !ids?.length) return;
  try {
    handle.transaction(() => {
      for (const id of new Set(ids)) handle.run("INSERT INTO injections (capture_ref, project_slug, learning_id, surface, host) VALUES (?, ?, ?, ?, ?)", [captureRef || null, projectKey || null, id, surface, host]);
    });
  } catch {
    // telemetry: a missing table (older store) or a busy one never fails a read
  }
}

// A memory-file line as ad writes it: "- **<type>** (conf 0.NN): <text>  _tags: …_".
const FILE_LINE = /^-\s+\*\*[a-z]+\*\*\s+\(conf\s+\d+(?:\.\d+)?\)\s*:\s*(.+?)(?:\s{2}_tags:.*_)?\s*$/;

/** The text of each lesson line in a memory file (activeContext.md). */
export function memoryFileLessons(content) {
  const out = [];
  for (const line of String(content ?? "").split(/\r?\n/)) {
    const m = FILE_LINE.exec(line);
    if (m) out.push(m[1]);
    if (out.length >= 300) break;
  }
  return out;
}

/** Ids of this project's accepted lessons that a memory file shows (matched by norm_key). */
export function lessonIdsInFile(handle, keys, content) {
  const nks = [...new Set(memoryFileLessons(content).map((t) => normKey(t)))];
  if (!handle || !keys?.length || !nks.length) return [];
  try {
    return handle.all(
      `SELECT id FROM learnings WHERE status = 'active' AND project_slug IN (${keys.map(() => "?").join(",")}) AND norm_key IN (${nks.map(() => "?").join(",")})`,
      [...keys, ...nks]
    ).map((r) => r.id);
  } catch {
    return [];
  }
}

/** Replace a lesson's line text in a memory file; → the new content, or null when it isn't there. */
export function rewordInFile(content, oldText, newText) {
  const nk = normKey(oldText);
  let hit = false;
  const out = String(content ?? "").split(/(\r?\n)/).map((part) => {
    const m = FILE_LINE.exec(part);
    if (!m || normKey(m[1]) !== nk) return part;
    hit = true;
    // Only the text after "(conf …):", never the type before it.
    const at = part.indexOf(m[1], part.indexOf("):") + 2);
    return part.slice(0, at) + newText + part.slice(at + m[1].length);
  });
  return hit ? out.join("") : null;
}

// Accepted lessons this project may use, as candidates for a repeat.
function candidates(handle, keys) {
  const vis = learningVisibility("l", keys, "any");
  return { sql: `l.status = 'active' AND (l.project_slug IS NOT NULL OR l.global_accepted_at IS NOT NULL) AND ${vis.sql}`, params: vis.params };
}

function earlier(row, captureRef, now) {
  const ref = row.capture_ref ?? row.session_id ?? null;
  if (ref && captureRef) return ref !== captureRef;
  return now - Date.parse(String(row.created_at).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(row.created_at) ? "" : "Z")) >= EARLIER_MS;
}

/** The accepted lesson a correction repeats, or null: {row, kind}. */
export function findRepeat(handle, { keys, text, captureRef, now = Date.now() }) {
  const c = candidates(handle, keys);
  const nk = normKey(text);
  const exact = handle.all(`SELECT l.id, l.text, l.capture_ref, l.session_id, l.created_at FROM learnings l WHERE l.norm_key = ? AND ${c.sql} ORDER BY l.id`, [nk, ...c.params]);
  const hit = exact.find((r) => earlier(r, captureRef, now));
  if (hit) return { row: hit, kind: "exact" };
  // The longest few content words: a cheap stand-in for the rarest, so a hook
  // doesn't rank every row of a large store. The first hits that pass win.
  const words = [...contentWords(text)].sort((a, b) => b.length - a.length).slice(0, 6);
  if (!words.length) return null;
  let tops = [];
  try {
    tops = handle.all(
      `SELECT l.id, l.text, l.capture_ref, l.session_id, l.created_at FROM learnings_fts JOIN learnings l ON l.id = learnings_fts.rowid
        WHERE learnings_fts MATCH ? AND ${c.sql} ORDER BY bm25(learnings_fts) LIMIT 5`,
      [words.map((w) => `"${w.replace(/"/g, '""')}"`).join(" OR "), ...c.params]
    );
  } catch {
    return null;
  }
  const top = tops.find((t) => jaccard(t.text, text) >= SIMILAR && earlier(t, captureRef, now));
  return top ? { row: top, kind: "similar" } : null;
}

/**
 * Classify a new correction and record its event; apply the effects.
 * @returns {{repeat: boolean, kind?: string, learningId?: number, wasInjected?: string, reword?: boolean}}
 */
export function classifyCorrection(handle, { keys, text, captureRef = null, source, host = null, now = Date.now() }) {
  if (!handle || !keys?.length) return { repeat: false };
  try {
    // One correction, one event: the hook path and the session's digest both see
    // the same words, and an agent may record the same text twice.
    if (captureRef && handle.get("SELECT 1 AS x FROM correction_events WHERE capture_ref = ? AND norm_key = ? LIMIT 1", [captureRef, normKey(text)])) return { repeat: false, duplicate: true };
    const found = findRepeat(handle, { keys, text, captureRef, now });
    // The digest may paraphrase what the hook stored: one session repeats a lesson once.
    if (found && captureRef && handle.get("SELECT 1 AS x FROM correction_events WHERE capture_ref = ? AND matched_learning_id = ? LIMIT 1", [captureRef, found.row.id])) return { repeat: false, duplicate: true };
    let wasInjected = null;
    if (found) {
      const shown = captureRef && handle.get("SELECT 1 AS x FROM injections WHERE capture_ref = ? AND learning_id = ? LIMIT 1", [captureRef, found.row.id]);
      wasInjected = shown ? "yes" : isSessionRef(captureRef) ? "no" : "unknown";
    }
    handle.run(
      "INSERT INTO correction_events (ts, capture_ref, project_slug, norm_key, source, matched_learning_id, match_kind, was_injected, host) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [new Date(now).toISOString(), captureRef, keys[0], normKey(text), source ?? null, found?.row.id ?? null, found?.kind ?? null, wasInjected, host]
    );
    if (!found) return { repeat: false };
    let reword = false;
    // A cross-project lesson isn't changed from one project (its feedback is per project too).
    const projectRow = handle.get("SELECT project_slug FROM learnings WHERE id = ?", [found.row.id])?.project_slug != null;
    if (wasInjected === "no" && found.kind === "similar" && projectRow) {
      // Not shown when it mattered: rank it higher (accepted lessons only). An exact
      // repeat is already reinforced when the words are stored.
      handle.run("UPDATE learnings SET confidence = MIN(0.95, confidence + 0.1) WHERE id = ? AND status = 'active'", [found.row.id]);
    } else if (wasInjected === "yes" && projectRow) {
      // Shown and still repeated, in two different sessions: the wording isn't working.
      const n = handle.get("SELECT COUNT(DISTINCT capture_ref) AS n FROM correction_events WHERE matched_learning_id = ? AND was_injected = 'yes'", [found.row.id]).n;
      if (n === 2 && handle.get("SELECT COUNT(*) AS n FROM correction_events WHERE matched_learning_id = ? AND was_injected = 'yes' AND capture_ref = ?", [found.row.id, captureRef]).n === 1) reword = true;
    }
    return { repeat: true, kind: found.kind, learningId: found.row.id, wasInjected, reword };
  } catch {
    return { repeat: false };
  }
}

// The review checklist's rows (L5 design decision 11): L4b's reviewQueue (note, repeat,
// file, removed, flagged) plus L5's groups — the agent's forget requests, notes "you
// asked to remove" (a typed forget no host could prove), and every removed note of this
// project until it is purged, whoever removed it. The prompt screen runs on every row as
// it loads: a row from any writer that the screen flags can't be bulk-selected.

import { reviewQueue } from "./review-queue.mjs";
import { projectClause } from "./projects.mjs";
import { screenPrompt, FLAG_PHRASES } from "./prompt-screen.mjs";
import { HIDDEN_DAYS, PROVISIONAL_DAYS } from "./purge.mjs";
import { latestEvent } from "./l5-tables.mjs";

const DAY = 86_400_000;
const OWN = new Set(["user-prompt", "prompt"]);

/** The source word a row shows (decision 11). */
export function sourceWord(provenance, { count = 0, file = null } = {}) {
  switch (provenance) {
    case "user-prompt":
      return "you typed";
    case "prompt":
      return "from your prompt";
    case "user-cli":
      return "you ran remember";
    case "headless":
      return "from a headless run";
    case "buffered":
      return "captured in a session";
    case "digest":
      return "from a session summary";
    case "transcript":
      return `from your history${count > 1 ? ` ×${count}` : ""}`;
    case "instruction-file":
      return file ? `from ${file}` : "from an instruction file";
    case "import":
      return "imported";
    default:
      return "the agent saved";
  }
}

const sqlMs = (t) => (t == null ? NaN : Date.parse(String(t).includes("T") ? t : `${String(t).replace(" ", "T")}Z`));

/**
 * @param {object} handle
 * @param {string[]} keys  this project's memory keys
 * @param {{now?:number}} [o]
 * @returns {object[]} rows for checklist.mjs createChecklist
 */
export function checklistRows(handle, keys, { now = Date.now() } = {}) {
  if (!Array.isArray(keys) || !keys.length) return [];
  const q = reviewQueue(handle, keys, { now, first: Number.MAX_SAFE_INTEGER });
  const ids = [...new Set(q.items.flatMap((i) => i.ids))];
  const meta = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    for (const r of handle.all(
      `SELECT id, provenance, origin, status, status_at, quarantine_reason, applied_to FROM learnings WHERE id IN (${part.map(() => "?").join(",")})`,
      part
    )) meta.set(r.id, r);
  }
  const marked = new Set();
  try {
    const scope = projectClause("l", keys);
    for (const r of handle.all(`SELECT DISTINCT e.learning_id AS id FROM events e JOIN learnings l ON l.id = e.learning_id WHERE e.kind = 'marked' AND ${scope.sql}`, scope.params)) marked.add(r.id);
  } catch {
    // no events table: no marks
  }

  const rows = [];
  for (const item of q.items) {
    const id = item.ids[0];
    const m = meta.get(id) ?? {};
    const base = { key: `${item.kind}:${item.ids.join(",")}`, ids: item.ids, text: item.text, provenance: m.provenance ?? null };
    if (item.kind === "flagged") {
      const reason = String(m.quarantine_reason ?? "");
      const flag = reason.startsWith("screen:") ? reason.slice(7).split(",")[0] : null;
      rows.push({ ...base, kind: "flagged", group: "flagged", flagged: true, secret: reason.startsWith("secret"), source: sourceWord(m.provenance), status: "flagged", flagPhrase: flag ? FLAG_PHRASES[flag] ?? flag : null });
      continue;
    }
    if (item.kind === "removed") {
      rows.push({ ...base, kind: "removed", group: "gone", accepted: true, source: sourceWord("instruction-file", { file: item.files?.[0] }), status: "left its file", files: item.files });
      continue;
    }
    if (item.kind === "file") {
      rows.push({ ...base, kind: "file", group: "files", units: item.units, files: item.files, source: item.files?.join(", ") ?? "", status: `${item.ids.length} waiting` });
      continue;
    }
    const own = OWN.has(m.provenance);
    const status = m.status === "provisional" ? provisionalStatus(m.status_at, now) : "waiting";
    const row = { ...base, kind: item.kind === "repeat" ? "repeat" : "note", status, count: item.count };
    row.source = item.kind === "repeat" ? sourceWord("transcript", { count: item.count }) : sourceWord(m.provenance);
    if (item.kind === "repeat") row.group = "history";
    else if (marked.has(id)) {
      row.kind = "marked";
      row.group = "marked";
      row.status = m.status === "provisional" ? `${status} · you asked to remove it` : "you asked to remove it";
    } else row.group = own ? "new" : "agent";
    // The screen at load: a row any writer stored that the screen flags is never bulk-selected.
    const hit = screenPrompt(row.text, { userWords: own }).flags;
    if (hit.length && row.kind !== "marked") {
      row.flagged = true;
      row.flagPhrase = FLAG_PHRASES[hit[0]] ?? hit[0];
      row.secret = hit.includes("secret");
      row.group = "flagged";
      row.status = "flagged";
    }
    rows.push(row);
  }

  const scope = projectClause("", keys);
  for (const r of handle.all(`SELECT id, text, provenance FROM learnings WHERE status = 'forget-requested' AND accepted_by IS NOT NULL AND ${scope.sql} ORDER BY id`, scope.params)) {
    rows.push({ key: `forget:${r.id}`, kind: "forget-requested", group: "forget", ids: [r.id], text: r.text, accepted: true, provenance: r.provenance, source: sourceWord(r.provenance), status: "asked to forget" });
  }
  // Every removed note of this project, whoever removed it, until it is purged.
  for (const r of handle.all(`SELECT id, text, provenance, status_at FROM learnings WHERE status = 'hidden' AND accepted_by IS NULL AND ${scope.sql} ORDER BY id DESC`, scope.params)) {
    const by = latestEvent(handle, "hidden", r.id)?.actor;
    const left = r.status_at ? Math.max(0, Math.ceil((sqlMs(r.status_at) + HIDDEN_DAYS * DAY - now) / DAY)) : HIDDEN_DAYS;
    rows.push({ key: `hidden:${r.id}`, kind: "hidden", group: "removed", ids: [r.id], text: r.text, provenance: r.provenance, statusAtNull: !r.status_at, source: by === "agent" ? "removed by the agent" : by === "user" ? "removed by you" : "removed", status: `${left} day${left === 1 ? "" : "s"} left to restore` });
  }
  return rows;
}

function provisionalStatus(statusAt, now) {
  const left = Math.max(0, Math.ceil((sqlMs(statusAt) + PROVISIONAL_DAYS * DAY - now) / DAY));
  return Number.isFinite(left) ? `in use, ${left} day${left === 1 ? "" : "s"} left unless you approve` : "in use";
}

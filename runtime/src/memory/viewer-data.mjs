// What `<pkg> view` shows (MCP launch plan L8b): learnings, rules and the weekly report,
// read through the memory readers. Pure over a handle that has get/all only (the CLI
// passes the read-only store): nothing here writes. Every text that comes from the store
// leaves this module redacted like `learnings export`, neutralized like what an agent is
// shown, and with http(s):// defanged, so the page can hold no URL at all.

import { redactForExport } from "./learnings-file.mjs";
import { safeNoteText } from "./render-safe.mjs";
import { listLearnings, LABELS } from "./learnings.mjs";
import { listRules } from "./rules-service.mjs";
import { memoryReport } from "./report.mjs";
import { isProjectId } from "./projects.mjs";

export const WITHHELD_SECRET = "[withheld: this text held a secret]";
const MAX_LEARNINGS = 500;
const MAX_TEXT = 600;

/** A store text as the page may show it. */
export function shownValue(text, o = {}) {
  const redacted = redactForExport(text, o);
  if (redacted === null) return WITHHELD_SECRET;
  // An address would be a link a reader might follow: shown as words.
  return safeNoteText(redacted, { maxChars: MAX_TEXT }).replace(/\b(https?|ftp|file):\/\//gi, "$1[:]//");
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Asked and stopped counts per rule id from the rule-events log. */
export function ruleEventCounts(events) {
  const by = new Map();
  for (const e of Array.isArray(events) ? events : []) {
    const kind = e?.decision === "stopped" ? "stopped" : e?.decision === "asked" ? "asked" : null;
    if (!kind) continue;
    for (const r of Array.isArray(e.rules) ? e.rules : []) {
      const id = Number(r?.id);
      if (!Number.isInteger(id)) continue;
      const c = by.get(id) ?? { asked: 0, stopped: 0 };
      c[kind]++;
      by.set(id, c);
    }
  }
  return by;
}

const patternText = (raw, o) => {
  let p = raw;
  try {
    p = JSON.stringify(typeof raw === "string" ? JSON.parse(raw) : raw);
  } catch {
    p = String(raw ?? "");
  }
  return shownValue(p, o);
};

/**
 * @param {{get: Function, all: Function}} handle
 * @param {{keys: string[]|null, ruleEvents?: object[], now?: number, weeks?: number, home?: string, user?: string|null, screen?: Function}} o
 */
export function gatherView(handle, { keys, ruleEvents = [], now = Date.now(), weeks = 4, home, user, screen } = {}) {
  const opts = { ...(home ? { home } : {}), ...(user !== undefined ? { user } : {}), ...(screen ? { screen } : {}) };
  const learnings = listLearnings(handle, { keys, limit: MAX_LEARNINGS }).map((r) => ({
    id: num(r.id),
    label: LABELS.includes(r.label) ? r.label : "pending",
    scope: r.scope === "all" ? "all" : "project",
    category: shownValue(r.category ?? "", opts),
    provenance: shownValue(r.provenance ?? r.origin ?? "", opts),
    text: shownValue(r.text, opts),
    recalled: num(r.recalled),
    repeated: num(r.repeated),
    rules: (r.rules ?? []).map((x) => num(x.id)),
  }));
  const counts = ruleEventCounts(ruleEvents);
  const projectId = keys === null ? null : (keys ?? []).find(isProjectId) ?? null;
  const rules = listRules(handle, { projectId })
    .filter((r) => keys === null || r.project_id === projectId || r.scope === "all" || r.source === "policy")
    .map((r) => ({
      id: num(r.id),
      kind: r.kind === "write" ? "write" : "command",
      decision: r.decision === "deny" ? "deny" : "ask",
      scope: r.scope === "all" ? "all" : "project",
      source: r.source === "policy" ? "policy" : "learning",
      learning: r.learning_id ? num(r.learning_id) : null,
      orphaned: Boolean(r.orphaned_at),
      pattern: patternText(r.pattern, opts),
      reason: shownValue(r.reason ?? "", opts),
      asked: counts.get(num(r.id))?.asked ?? 0,
      stopped: counts.get(num(r.id))?.stopped ?? 0,
    }));
  let weekly = [];
  try {
    weekly = memoryReport(handle, { keys, weeks, now, ruleEvents }).weekly.map((w) => ({
      week: shownValue(w.week ?? "", opts),
      from: String(w.from ?? "").slice(0, 10),
      to: String(w.to ?? "").slice(0, 10),
      captured: num(w.captured),
      provisional: num(w.provisional),
      accepted: num(w.accepted),
      recalled: num(w.recalled),
      repeated: num(w.repeated),
      asked: w.asked === null || w.asked === undefined ? null : num(w.asked),
      stopped: w.stopped === null || w.stopped === undefined ? null : num(w.stopped),
    }));
  } catch {
    weekly = [];
  }
  return { learnings, rules, weekly, allProjects: keys === null };
}

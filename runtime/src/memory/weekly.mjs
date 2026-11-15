// The report's week-by-week counters (MCP launch plan L8, design decisions 10–14).
//
//   weeklyCounts(handle, {keys, weeks, now})    captured, provisional, accepted, recalled,
//                                                repeated per ISO week, from the store
//   weeklyRuleCounts(events, {projectId, …})    asked and stopped per ISO week, from L7's
//                                                rule-events log (hooks/rule-events.mjs)
//   shareLink(rows, {expiring})                  the opt-in "share weekly numbers" link:
//                                                integers into a fixed template, nothing else
//   weeklyLine(handle, {…})                      "Last week: 3 stopped, 2 asked, 1 repeated",
//                                                once per ISO week per project
//
// Pure reads except weeklyLine's one setting. A missing table (an older store) reads as 0.

import { projectClause, idOfKeys } from "./projects.mjs";
import { getSetting, putSetting } from "./l5-tables.mjs";
import { PRODUCT } from "../product.mjs";

const DAY = 86_400_000;
export const DISCUSSIONS_URL = "https://github.com/pankaj-mahaur/Agent-Daemon/discussions";
export const SHARE_CATEGORY = "weekly-numbers";
export const COUNTERS = Object.freeze(["captured", "provisional", "accepted", "recalled", "repeated"]);

/** The ISO week of a moment: Monday 00:00 UTC to the next Monday. → {key, from, to} */
export function isoWeek(now) {
  const d = new Date(typeof now === "number" ? now : Date.parse(now));
  const day = (d.getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * DAY;
  // The ISO year is the year of this week's Thursday.
  const thursday = new Date(monday + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);
  const week1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY;
  const n = Math.round((monday - week1) / (7 * DAY)) + 1;
  return { key: `${year}-W${String(n).padStart(2, "0")}`, from: new Date(monday).toISOString(), to: new Date(monday + 7 * DAY).toISOString() };
}

/** The last `weeks` ISO weeks, the current one last. */
export function weekWindows(weeks, now = Date.now()) {
  const cur = Date.parse(isoWeek(now).from);
  const out = [];
  for (let i = weeks - 1; i >= 0; i--) out.push(isoWeek(cur - i * 7 * DAY));
  return out;
}

const safeCount = (handle, sql, params) => {
  try {
    return handle.get(sql, params)?.n ?? 0;
  } catch (e) {
    if (/no such (table|column)/i.test(String(e?.message))) return 0;
    throw e;
  }
};

// An event is this project's by its project id, or, written where the folder had no id
// yet, by the learning it names.
function eventScope(keys) {
  if (keys === null || keys === undefined) return { sql: "1", params: [] };
  const id = idOfKeys(keys);
  const l = projectClause("l", keys);
  return {
    sql: `(${id ? "e.project_id = ? OR " : ""}(e.project_id IS NULL AND EXISTS (SELECT 1 FROM learnings l WHERE l.id = e.learning_id AND ${l.sql})))`,
    params: [...(id ? [id] : []), ...l.params],
  };
}

/**
 * @param {any} handle
 * @param {{keys: string[]|null, weeks?: number, now?: number}} o keys null = every project
 * @returns {{week:string, from:string, to:string, captured:number, provisional:number, accepted:number, recalled:number, repeated:number}[]}
 */
export function weeklyCounts(handle, { keys, weeks = 4, now = Date.now() }) {
  const ev = eventScope(keys);
  const lr = projectClause("", keys);
  const inj = projectClause("", keys, { idCol: "project_slug" });
  const pid = keys === null || keys === undefined ? null : idOfKeys(keys);
  const purgedScope = keys === null || keys === undefined ? { sql: "1", params: [] } : pid ? { sql: "e.project_id = ?", params: [pid] } : { sql: "0", params: [] };
  return weekWindows(weeks, now).map(({ key, from, to }) => {
    const kind = (k) => safeCount(handle, `SELECT COUNT(*) AS n FROM events e WHERE e.kind = ? AND e.at >= ? AND e.at < ? AND ${ev.sql}`, [k, from, to, ...ev.params]);
    return {
      week: key,
      from,
      to,
      // New notes from every writer (design decision 10, R1-H2): rows created this week, plus
      // the captures of notes purged since (their event survives with learning_id nulled).
      captured:
        safeCount(handle, `SELECT COUNT(*) AS n FROM learnings WHERE julianday(created_at) >= julianday(?) AND julianday(created_at) < julianday(?) AND ${lr.sql}`, [from, to, ...lr.params]) +
        safeCount(handle, `SELECT COUNT(*) AS n FROM events e WHERE e.kind = 'captured' AND e.learning_id IS NULL AND e.at >= ? AND e.at < ? AND ${purgedScope.sql}`, [from, to, ...purgedScope.params]),
      provisional: kind("provisional"),
      // Accepted by the review service in this week (a legacy backfill isn't a decision).
      accepted: safeCount(handle, `SELECT COUNT(*) AS n FROM learnings WHERE accepted_by IS 'review' AND julianday(accepted_at) >= julianday(?) AND julianday(accepted_at) < julianday(?) AND ${lr.sql}`, [from, to, ...lr.params]),
      // Notes the agents were given, not deliveries. injections has no project id: by slug.
      recalled: safeCount(handle, `SELECT COUNT(DISTINCT learning_id) AS n FROM injections WHERE julianday(ts) >= julianday(?) AND julianday(ts) < julianday(?) AND ${inj.sql}`, [from, to, ...inj.params]),
      // The capture writer records `repeated` only for an accepted note said again.
      repeated: kind("repeated"),
    };
  });
}

/**
 * Asked and stopped per ISO week from the rule-events lines (allow-once passes are neither).
 * @param {object[]} events readRuleEvents() lines
 * @param {{projectId: string|null, all?: boolean, weeks?: number, now?: number}} o
 */
export function weeklyRuleCounts(events, { projectId, all = false, weeks = 4, now = Date.now() }) {
  const wins = weekWindows(weeks, now).map((w) => ({ week: w.key, from: Date.parse(w.from), to: Date.parse(w.to), asked: 0, stopped: 0 }));
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== "object") continue;
    if (!all && (!projectId || e.project !== projectId)) continue;
    const t = Date.parse(e.at);
    if (!Number.isFinite(t)) continue;
    const w = wins.find((x) => t >= x.from && t < x.to);
    if (!w) continue;
    if (e.decision === "asked") w.asked++;
    else if (e.decision === "stopped") w.stopped++;
  }
  return wins.map(({ week, asked, stopped }) => ({ week, asked, stopped }));
}

/** The first rule event's time (ms), or null: weeks before it have no asked or stopped numbers. */
export function ruleEventsSince(events) {
  let first = null;
  for (const e of Array.isArray(events) ? events : []) {
    const t = Date.parse(e?.at);
    if (Number.isFinite(t) && (first === null || t < first)) first = t;
  }
  return first;
}

// ── The share link: counts only (design decision 12) ─────────────────────────

const int = (v) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1e9 ? v : 0);
const SHARE_FIELDS = Object.freeze(["weeks", "captured", "provisional", "accepted", "recalled", "repeated", "asked", "stopped", "expiring"]);

/** The fixed body; {field} places take integers only. */
export const shareTemplate = () =>
  [
    "My numbers for the last {weeks} weeks (counts only, from my own report):",
    "",
    "- corrections captured {captured}",
    "- in use before review {provisional}",
    "- accepted {accepted}",
    "- recalled to an agent {recalled}",
    "- repeated after I accepted them {repeated}",
    "- rules asked {asked}",
    "- rules stopped {stopped}",
    "- expiring soon {expiring}",
  ].join("\n");
export const shareTitleTemplate = () => `My week with ${PRODUCT.displayName}: {repeated} repeats, {stopped} stopped, {asked} asked`;

/** The totals the link may carry: whitelisted integer fields, anything else 0. */
export function shareCounts(rows, { expiring = 0 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const c = { weeks: list.length, expiring: int(expiring) };
  for (const f of ["captured", "provisional", "accepted", "recalled", "repeated", "asked", "stopped"]) c[f] = list.reduce((s, r) => s + int(r?.[f]), 0);
  return Object.fromEntries(SHARE_FIELDS.map((f) => [f, int(c[f])]));
}

const fill = (tpl, c) => tpl.replace(/\{(\w+)\}/g, (_, f) => String(int(c[f])));

/** The prefilled Discussions link. Nothing is sent: the user opens it and decides. */
export function shareLink(rows, { expiring = 0 } = {}) {
  const c = shareCounts(rows, { expiring });
  const q = new URLSearchParams({ category: SHARE_CATEGORY, title: fill(shareTitleTemplate(), c), body: fill(shareTemplate(), c) });
  return `${DISCUSSIONS_URL}/new?${q.toString()}`;
}

// ── The weekly line (design decision 14) ─────────────────────────────────────

/** → "Last week: 3 stopped, 2 asked, 1 repeated", zero parts dropped, or null. */
export function weeklyLineText({ stopped = 0, asked = 0, repeated = 0 } = {}) {
  const parts = [[int(stopped), "stopped"], [int(asked), "asked"], [int(repeated), "repeated"]].filter(([v]) => v > 0).map(([v, w]) => `${v} ${w}`);
  return parts.length ? `Last week: ${parts.join(", ")}` : null;
}

/**
 * The once-a-week session-start line for this project: last ISO week's counts, shown once
 * per week (memory_settings `weekly_line:<project>` = the week shown). → text or null
 */
export function weeklyLine(handle, { keys, projectId = null, ruleEvents = () => [], now = Date.now() }) {
  if (!Array.isArray(keys) || !keys.length) return null;
  const project = projectId ?? keys.find((k) => typeof k === "string" && !k.startsWith("~")) ?? null;
  if (!project) return null;
  const thisWeek = isoWeek(now).key;
  const key = `weekly_line:${project}`;
  // Shown this week, or nothing to show this week (`<week>:none`): no scan, no log read.
  if (String(getSetting(handle, key) ?? "").split(":")[0] === thisWeek) return null;
  const lastWeekAt = Date.parse(isoWeek(now).from) - DAY;
  const [store] = weeklyCounts(handle, { keys, weeks: 1, now: lastWeekAt });
  // The log is read only now that the line may be shown (up to 512 KB).
  const [rules] = weeklyRuleCounts(typeof ruleEvents === "function" ? ruleEvents() : ruleEvents, { projectId, weeks: 1, now: lastWeekAt });
  const text = weeklyLineText({ stopped: rules.stopped, asked: rules.asked, repeated: store.repeated });
  putSetting(handle, key, text ? thisWeek : `${thisWeek}:none`, { now: new Date(now) });
  return text;
}

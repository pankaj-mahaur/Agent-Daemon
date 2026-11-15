// `ad memory report` (P5.5): is memory working here? Numbers only, from the
// local store: corrections captured, how many repeated a lesson memory already
// had (and whether it was shown first), how much memory showed per session,
// what feedback said, and what waits for review. Nothing is sent anywhere;
// --share prints the same numbers with no project, path, lesson or session.
//
//   memoryReport(handle, {keys, days, now}) → data
//   renderReport(data, {share}) → text

import { projectClause } from "./projects.mjs";
import { pendingSql, provisionalSql } from "./trust.mjs";
import { PROVISIONAL_DAYS } from "./purge.mjs";
import { idOfKeys } from "./projects.mjs";
import { rulesLines, rulesSection } from "./rules-read.mjs";
import { PRODUCT } from "../product.mjs";
import { weeklyCounts, weeklyRuleCounts, ruleEventsSince, shareLink } from "./weekly.mjs";

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// A project's rows by id, or by slug where they have none yet (projects.mjs, P7.1a).
function scope(col, keys) {
  const alias = col.includes(".") ? col.split(".")[0] : "";
  return projectClause(alias, keys);
}

/**
 * @param {any} handle
 * @param {{keys: string[]|null, days?: number, now?: number}} opts keys null = every project
 */
export function memoryReport(handle, { keys, days = 30, now = Date.now(), weeks = 4, ruleEvents = [] }) {
  const since = new Date(now - days * 86_400_000).toISOString();
  const ev = scope("project_slug", keys);
  const events = handle.all(`SELECT source, match_kind, was_injected FROM correction_events WHERE datetime(ts) >= datetime(?) AND ${ev.sql}`, [since, ...ev.params]);
  const repeats = events.filter((e) => e.match_kind);
  const inj = scope("i.project_slug", keys);
  const perSession = handle.all(
    `SELECT i.capture_ref AS ref, COUNT(DISTINCT i.learning_id) AS n, SUM(LENGTH(l.text)) AS chars
       FROM injections i JOIN learnings l ON l.id = i.learning_id
      WHERE datetime(i.ts) >= datetime(?) AND i.capture_ref IS NOT NULL AND i.capture_ref NOT LIKE 'proc:%' AND ${inj.sql}
      GROUP BY i.capture_ref`,
    [since, ...inj.params]
  );
  const fbScope = scope("project_slug", keys);
  const fb = Object.fromEntries(handle.all(`SELECT verdict, COUNT(*) AS n FROM feedback WHERE datetime(ts) >= datetime(?) AND ${fbScope.sql} GROUP BY verdict`, [since, ...fbScope.params]).map((r) => [r.verdict, r.n]));
  const fbTotal = (fb.useful ?? 0) + (fb.stale ?? 0) + (fb.wrong ?? 0);
  const pend = scope("project_slug", keys);
  const waiting = handle.get(`SELECT COUNT(*) AS n FROM learnings WHERE ${pendingSql()} AND ${pend.sql}`, pend.params).n;
  // L5 decisions 18-19: in use before review (provisional), and how many go back to waiting this week.
  const inUse = handle.get(`SELECT COUNT(*) AS n FROM learnings WHERE ${provisionalSql()} AND ${pend.sql}`, pend.params).n;
  const weekFrom = new Date(now - PROVISIONAL_DAYS * 86_400_000).toISOString();
  const weekTo = new Date(now - (PROVISIONAL_DAYS - 7) * 86_400_000).toISOString();
  const expiringThisWeek = handle.get(`SELECT COUNT(*) AS n FROM learnings WHERE ${provisionalSql()} AND status_at >= ? AND status_at < ? AND ${pend.sql}`, [weekFrom, weekTo, ...pend.params]).n;
  const removedByPrompt = handle.get(`SELECT COUNT(*) AS n FROM learnings WHERE status = 'hidden' AND accepted_by IS NULL AND status_at IS NULL AND ${pend.sql}`, pend.params).n;
  return {
    days,
    allProjects: keys === null,
    corrections: { total: events.length, hooks: events.filter((e) => e.source !== "tools").length, tools: events.filter((e) => e.source === "tools").length },
    repeats: {
      total: repeats.length,
      rate: events.length ? repeats.length / events.length : 0,
      shownFirst: repeats.filter((e) => e.was_injected === "yes").length,
      notShown: repeats.filter((e) => e.was_injected === "no").length,
      unknown: repeats.filter((e) => e.was_injected === "unknown").length,
    },
    shown: { sessions: perSession.length, medianLessons: median(perSession.map((s) => s.n)), medianTokens: Math.round(median(perSession.map((s) => (s.chars ?? 0) / 4))) },
    feedback: { useful: fb.useful ?? 0, stale: fb.stale ?? 0, wrong: fb.wrong ?? 0, precision: fbTotal ? (fb.useful ?? 0) / fbTotal : null },
    waiting,
    inUse,
    expiringThisWeek,
    removedByPrompt,
    // L8 (design decisions 10–11): week by week, this project's rule events by its id.
    weekly: mergeWeeks(weeklyCounts(handle, { keys, weeks, now }), weeklyRuleCounts(ruleEvents, { projectId: idOfKeys(keys), all: keys === null, weeks, now }), ruleEventsSince(ruleEvents)),
    // L7 (design decision 20): rules, their asks and stops, pauses and ad's own files guarded.
    rules: rulesOf(handle, { keys, ruleEvents, days, now }),
  };
}

function rulesOf(handle, { keys, ruleEvents, days, now }) {
  const projectId = idOfKeys(keys);
  const all = keys === null;
  let rules = [];
  let reminded = 0;
  try {
    // The rules this project is enforced by (its own and the scope-all ones), read directly:
    // report stays light (the plugin's server bundles it).
    rules = all ? handle.all("SELECT decision, orphaned_at FROM rules") : handle.all("SELECT decision, orphaned_at FROM rules WHERE project_id = ? OR scope = 'all'", [projectId ?? ""]);
    const sc = scope("l.project_slug", keys);
    reminded = handle.get(`SELECT COUNT(*) AS n FROM learnings l WHERE l.status = 'active' AND l.accepted_by IS NOT NULL AND ${sc.sql} AND NOT EXISTS (SELECT 1 FROM rules r WHERE r.learning_id = l.id)`, sc.params).n;
  } catch {
    // an older store with no rules table: no rules, nothing reminded counted here
  }
  let paused = { all: null, projects: {} };
  try {
    const v = JSON.parse(handle.get("SELECT value FROM memory_settings WHERE key = 'rules_paused'")?.value ?? "null");
    if (v && typeof v === "object") paused = { all: v.all ?? null, projects: v.projects && typeof v.projects === "object" ? v.projects : {} };
  } catch {
    // no settings table, or a damaged value: nothing paused (rules stay enforced)
  }
  return rulesSection({ rules, reminded, events: ruleEvents, paused, projectId, all, days, now });
}

// A week that ended before the rule-events log's first line has no asked or stopped numbers (null).
const mergeWeeks = (store, rules, since) =>
  store.map((w, i) => {
    const before = since !== null && Date.parse(w.to) <= since;
    return { ...w, asked: before ? null : rules[i]?.asked ?? 0, stopped: before ? null : rules[i]?.stopped ?? 0 };
  });

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/**
 * The report's command line (the npm CLI's `report` and the plugin's server/report.mjs):
 * [--days N] [--weeks N] [--all-projects] [--json] [--share] [--share-link] [--purge]. → exit code
 */
export async function reportMain(argv, { cwd = process.cwd(), out = (l) => console.log(l) } = {}) {
  const r = { cwd, out };
  // --flag=value as well as --flag value (ad's own parser took both).
  argv = argv.flatMap((a) => (/^--[\w-]+=/.test(a) ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a]));
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-h" || argv[i] === "--help") {
      out("report [--days 30] [--weeks 4] [--all-projects] [--json] [--share] [--share-link] [--purge]");
      return 0;
    }
    if (argv[i] === "--days") r.days = argv[++i];
    else if (argv[i] === "--all-projects") r.allProjects = true;
    else if (argv[i] === "--json" || argv[i] === "--output-json") r.json = true;
    else if (argv[i] === "--cwd") r.cwd = argv[++i] ?? cwd; // ad's global flag (`ad memory report --cwd <dir>`)
    else if (argv[i] === "--share") r.share = true;
    else if (argv[i] === "--weeks") r.weeks = argv[++i];
    else if (argv[i] === "--share-link") r.shareLink = true;
    else if (argv[i] === "--purge") r.purge = true;
    else {
      out(`unknown option ${argv[i]}`);
      return 1;
    }
  }
  return reportCommand(r);
}

/** The command (ad memory report, npx agent-daemon-memory report). → exit code */
export async function reportCommand({ cwd = process.cwd(), days = 30, weeks = 4, allProjects = false, json = false, share = false, shareLink: link = false, purge = false, out = (l) => console.log(l), handle: given, keys: givenKeys, ruleEvents, token, ask, now = Date.now() } = {}) {
  const { db } = await import("./episodic.mjs");
  const { hookProjectKeys } = await import("./scope.mjs");
  const handle = given ?? (await db());
  if (!handle) {
    out("The memory store is unavailable (run doctor).");
    return 1;
  }
  const keys = givenKeys !== undefined ? givenKeys : allProjects ? null : await hookProjectKeys(cwd);
  // The CLIs route --purge to report-purge.mjs before they get here (the plugin's report
  // never loads the history import).
  if (purge) {
    out(`report --purge runs from the command line, in your own terminal (npx -y ${PRODUCT.package} report --purge).`);
    return 1;
  }
  const n = Number(days);
  const w = Number(weeks);
  const events = ruleEvents ?? (await import("../hooks/rule-events.mjs")).readRuleEvents();
  const r = memoryReport(handle, { keys, days: Number.isFinite(n) && n > 0 ? Math.min(n, 3650) : 30, weeks: Number.isInteger(w) && w > 0 ? Math.min(w, 25) : 4, ruleEvents: events, now });
  if (link) {
    // The opt-in "share weekly numbers" (design decision 12): counts only, nothing is sent.
    out("Your weekly numbers as a prefilled Discussions post (counts only; nothing was sent, and posting needs your GitHub sign-in):");
    out(shareLink(r.weekly, { expiring: r.expiringThisWeek }));
    return 0;
  }
  out(json ? JSON.stringify(r) : renderReport(r, { share }));
  return 0;
}

export function renderReport(r, { share = false } = {}) {
  const pct = r.corrections.total ? ` (${Math.round(r.repeats.rate * 100)}%, lower is better)` : "";
  const lines = [
    `Memory report — last ${r.days} days, ${r.allProjects ? "every project" : share ? "one project" : "this project"}`,
    `  Corrections captured        ${r.corrections.total}   (hooks and digests ${r.corrections.hooks}, record tools ${r.corrections.tools})`,
    `  Repeated corrections        ${r.repeats.total}${pct}`,
    `    shown first, repeated     ${r.repeats.shownFirst}`,
    `    not shown                 ${r.repeats.notShown}`,
    `    unknown (pull or hookless) ${r.repeats.unknown}`,
    `  Lessons shown per session   ${r.shown.sessions ? `median ${r.shown.medianLessons}, about ${k(r.shown.medianTokens)} tokens` : "no sessions recorded yet"}`,
    `  Feedback                    useful ${r.feedback.useful}, stale ${r.feedback.stale}, wrong ${r.feedback.wrong}${r.feedback.precision === null ? "" : ` (precision ${r.feedback.precision.toFixed(2)})`}`,
    `  Waiting for review          ${r.waiting}${share ? "" : r.waiting ? "   (ad review)" : ""}`,
  ];
  if (r.inUse) lines.push(`  In use before review        ${r.inUse}${r.expiringThisWeek ? `, ${r.expiringThisWeek} expiring this week` : ""}`);
  if (r.removedByPrompt) lines.push(`  Removed by a prompt         ${r.removedByPrompt}${share ? "" : "   (restore in ad review)"}`);
  if (Array.isArray(r.weekly) && r.weekly.length) {
    lines.push("  Week by week                captured  in use  accepted  recalled  repeated  asked  stopped");
    for (const w of r.weekly) {
      const cells = [w.captured, w.provisional, w.accepted, w.recalled, w.repeated, w.asked, w.stopped].map((v, i) => String(v ?? "–").padStart([8, 8, 10, 10, 10, 7, 9][i]));
      lines.push(`    ${`${w.week} (from ${String(w.from).slice(5, 10)})`.padEnd(24)}${cells.join("")}`);
    }
    if (r.weekly.some((w) => w.asked === null)) lines.push("    (– : the rule events log keeps only its most recent entries)");
  }
  if (r.rules && (r.rules.rules || r.rules.asked || r.rules.stopped || r.rules.selfProtect.stopped || r.rules.selfProtect.asked)) lines.push(...rulesLines(r.rules, { share }));
  if (share) lines.push("  (numbers only: no project, path, lesson or session; nothing was sent anywhere)");
  return lines.join("\n");
}

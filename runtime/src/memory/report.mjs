// `ad memory report` (P5.5): is memory working here? Numbers only, from the
// local store: corrections captured, how many repeated a lesson memory already
// had (and whether it was shown first), how much memory showed per session,
// what feedback said, and what waits for review. Nothing is sent anywhere;
// --share prints the same numbers with no project, path, lesson or session.
//
//   memoryReport(handle, {keys, days, now}) → data
//   renderReport(data, {share}) → text

import { projectClause } from "./projects.mjs";

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
export function memoryReport(handle, { keys, days = 30, now = Date.now() }) {
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
  const waiting = handle.get(`SELECT COUNT(*) AS n FROM learnings WHERE status = 'pending' AND ${pend.sql}`, pend.params).n;
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
  };
}

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** The command (ad memory report, npx agent-daemon-memory report). → exit code */
export async function reportCommand({ cwd = process.cwd(), days = 30, allProjects = false, json = false, share = false, out = (l) => console.log(l) } = {}) {
  const { db } = await import("./episodic.mjs");
  const { hookProjectKeys } = await import("./scope.mjs");
  const handle = await db();
  if (!handle) {
    out("The memory store is unavailable (run doctor).");
    return 1;
  }
  const n = Number(days);
  const r = memoryReport(handle, { keys: allProjects ? null : await hookProjectKeys(cwd), days: Number.isFinite(n) && n > 0 ? Math.min(n, 3650) : 30 });
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
  if (share) lines.push("  (numbers only: no project, path, lesson or session; nothing was sent anywhere)");
  return lines.join("\n");
}

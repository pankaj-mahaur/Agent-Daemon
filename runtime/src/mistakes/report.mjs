// The mistakes report (plan L4a): build it from the typed prompts, then
// render it for the terminal, as a shareable Markdown summary, or as JSON.
// Pure: no reads, no writes. The order follows the plan: what /insights can't
// show first (both agents together, the rule-coverage line, the weekly trend),
// then the totals and the top repeats, then how much history was found, then
// the beta sign-up line.

import path from "node:path";
import { classifyPrompt } from "./classify.mjs";
import { clusterCorrections, clusterLabel } from "./cluster.mjs";
import { redactSentence } from "./redact.mjs";
import { HOSTS } from "./history.mjs";

/** Where beta sign-ups go (a Discussions thread in the product repo once it exists). */
export const BETA_SIGNUP_URL = "https://github.com/pankaj-mahaur/Agent-Daemon/discussions";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
export const WEEKS_SHOWN = 8;
export const TOP_SHOWN = 10;

/** Monday 00:00 UTC of the week holding `ms`. */
export function weekStart(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

/**
 * @param {{prompts:object[], sources:object, stats?:object, retentionDays?:number, coverage?:object|null, now?:number, redact?:object}} input
 */
export function buildReport({ prompts, sources, stats = {}, retentionDays = 30, coverage = null, now = Date.now(), redact = {} }) {
  const corrections = [];
  const hosts = {};
  for (const h of Object.keys(HOSTS)) hosts[h] = { sessions: new Set(), prompts: 0, corrections: 0, firstTs: null, lastTs: null };
  for (const p of prompts) {
    const h = hosts[p.host];
    h.prompts++;
    h.sessions.add(p.session);
    if (p.ts != null) {
      h.firstTs = h.firstTs == null ? p.ts : Math.min(h.firstTs, p.ts);
      h.lastTs = h.lastTs == null ? p.ts : Math.max(h.lastTs, p.ts);
    }
    const c = classifyPrompt(p.text);
    if (!c.correction) continue;
    h.corrections++;
    corrections.push({ host: p.host, ts: p.ts, sentence: c.sentence });
  }
  const clusters = clusterCorrections(corrections);
  const repeated = clusters.filter((c) => c.count >= 2);

  // The weeks from the first prompt to now, at most WEEKS_SHOWN.
  const thisWeek = weekStart(now);
  const first = prompts.reduce((m, p) => (p.ts != null && p.ts < m ? p.ts : m), now);
  const weeksBack = Math.min(WEEKS_SHOWN - 1, Math.max(0, Math.round((thisWeek - weekStart(first)) / WEEK)));
  const weekly = [];
  for (let i = weeksBack; i >= 0; i--) weekly.push({ weekStart: thisWeek - i * WEEK, total: 0, byHost: {} });
  for (const c of corrections) {
    if (c.ts == null) continue;
    const w = weekly.find((x) => x.weekStart === weekStart(c.ts));
    if (!w) continue;
    w.total++;
    w.byHost[c.host] = (w.byHost[c.host] ?? 0) + 1;
  }

  const hostOut = {};
  for (const [h, v] of Object.entries(hosts)) {
    hostOut[h] = {
      name: HOSTS[h],
      sessions: v.sessions.size,
      prompts: v.prompts,
      corrections: v.corrections,
      firstTs: v.firstTs,
      lastTs: v.lastTs,
      days: v.firstTs == null ? 0 : Math.max(1, Math.ceil((now - v.firstTs) / DAY)),
    };
  }

  return {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    // The folder's name only: a full path names the account and the folders above.
    scope: { allProjects: sources.root == null, project: sources.root ? path.basename(sources.root) : null, folderOnly: Boolean(sources.exactFolder) },
    hosts: hostOut,
    prompts: prompts.length,
    corrections: corrections.length,
    repeats: repeated.length,
    repeated3: clusters.filter((c) => c.count >= 3).length,
    bothAgents: repeated.filter((c) => (c.hosts.claude ?? 0) > 0 && (c.hosts.codex ?? 0) > 0).length,
    top: repeated.slice(0, TOP_SHOWN).map((c) => ({
      id: c.id,
      count: c.count,
      hosts: c.hosts,
      sentence: redactSentence(clusterLabel(c.sentences), redact),
      firstTs: c.firstTs,
      lastTs: c.lastTs,
    })),
    // Clusters seen once: a count only (a hash of a two-word rule can be guessed).
    singles: clusters.filter((c) => c.count === 1).length,
    weekly,
    coverage: coverage && {
      claudeRules: coverage.claudeRules,
      agentsRules: coverage.agentsRules,
      codexMissing: coverage.codexMissing,
      claudeMissing: coverage.claudeMissing,
      claudeFiles: coverage.claudeFiles.length,
      agentsFiles: coverage.agentsFiles.length,
    },
    retentionDays,
    skipped: {
      compressed: sources.codex?.compressed ?? 0,
      unreadable: (stats.claude?.unreadable ?? 0) + (stats.codex?.unreadable ?? 0),
      duplicates: stats.duplicates ?? 0,
      automated: stats.automated ?? 0,
    },
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDate = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function hostSplit(hosts) {
  return Object.keys(HOSTS)
    .filter((h) => hosts[h])
    .map((h) => `${HOSTS[h]} ${hosts[h]}`)
    .join(" · ");
}

/** The coverage line, or null when it says nothing. */
export function coverageLine(cov, report) {
  if (!cov) return null;
  const usesCodex = report.hosts.codex.prompts > 0 || cov.agentsFiles > 0;
  const usesClaude = report.hosts.claude.prompts > 0 || cov.claudeFiles > 0;
  const lines = [];
  if (usesCodex && cov.claudeRules > 0 && cov.codexMissing > 0) {
    lines.push(cov.codexMissing === cov.claudeRules ? `Codex sees none of your ${plural(cov.claudeRules, "CLAUDE.md rule")}.` : `Codex doesn't see ${cov.codexMissing} of your ${plural(cov.claudeRules, "CLAUDE.md rule")}.`);
  }
  if (usesClaude && cov.agentsRules > 0 && cov.claudeMissing > 0) {
    lines.push(cov.claudeMissing === cov.agentsRules ? `Claude Code sees none of your ${plural(cov.agentsRules, "AGENTS.md rule")}.` : `Claude Code doesn't see ${cov.claudeMissing} of your ${plural(cov.agentsRules, "AGENTS.md rule")}.`);
  }
  return lines.length ? lines.join(" ") : null;
}

/** "27 days of Claude Code history (it keeps 30 by default; …)" lines. */
function historyLines(report, { claudeSettings }) {
  const out = [];
  for (const h of Object.keys(HOSTS)) {
    const v = report.hosts[h];
    if (!v.prompts) continue;
    out.push(`${v.name}: ${plural(v.days, "day")} of history, ${plural(v.sessions, "session")}, ${plural(v.prompts, "typed prompt")}.`);
  }
  const cc = report.hosts.claude;
  if (cc.prompts && cc.days >= report.retentionDays - 1) {
    out.push(`Claude Code deletes transcripts after ${report.retentionDays} days${report.retentionDays === 30 ? " by default" : ""}; raise "cleanupPeriodDays" in ${claudeSettings} to keep more.`);
  }
  if (report.skipped.automated) out.push(`Left out ${plural(report.skipped.automated, "prompt")} from scripted runs (claude -p, codex exec).`);
  if (report.skipped.compressed) out.push(`Skipped ${plural(report.skipped.compressed, "compressed Codex session")} (this Node can't read .zst; Node 22.15+ can).`);
  if (report.skipped.unreadable) out.push(`Skipped ${plural(report.skipped.unreadable, "unreadable file")}.`);
  return out;
}

const bar = (n, max, width = 24) => (n === 0 ? "" : "█".repeat(Math.max(1, Math.round((n / Math.max(1, max)) * width))));

/** The terminal report. */
export function renderText(report, { projectName = null, claudeSettings = "settings.json" } = {}) {
  const out = [];
  const name = projectName ?? report.scope.project;
  const scope = report.scope.allProjects ? "all projects" : `${report.scope.folderOnly ? "this folder" : "this project"}${name ? ` (${name})` : ""}`;
  out.push(`Mistakes report: ${scope}. Offline: no model call, nothing stored.`);
  out.push("");
  if (!report.prompts) {
    out.push("No typed prompts found in this history.");
    if (!report.scope.allProjects) out.push("Run with --all-projects to look at every project.");
    return out.join("\n") + "\n";
  }
  const both = report.hosts.claude.prompts > 0 && report.hosts.codex.prompts > 0;
  if (both) {
    out.push(
      report.bothAgents
        ? `Claude Code and Codex together: ${report.bothAgents} of your repeated corrections came up in both.`
        : "Claude Code and Codex together: no repeated correction came up in both yet.",
    );
  }
  const cov = coverageLine(report.coverage, report);
  if (cov) out.push(cov);
  if (both || cov) out.push("");

  const max = Math.max(...report.weekly.map((w) => w.total));
  out.push("Corrections per week");
  for (const w of report.weekly) out.push(`  ${fmtDate(w.weekStart).padEnd(6)} ${String(w.total).padStart(3)} ${bar(w.total, max)}`.trimEnd());
  out.push("");

  out.push(`You corrected your agents ${plural(report.corrections, "time")} in ${plural(report.prompts, "typed prompt")}; ${plural(report.repeated3, "correction")} repeated 3+ times.`);
  if (report.top.length) {
    out.push("");
    out.push("Your top repeated corrections");
    const w = `×${report.top[0].count}`.length;
    for (const t of report.top) out.push(`  ${`×${t.count}`.padEnd(w)} ${t.sentence}${both ? `  (${hostSplit(t.hosts)})` : ""}`);
  } else {
    out.push("No correction came up twice.");
  }
  out.push("");
  for (const l of historyLines(report, { claudeSettings })) out.push(l);
  out.push("");
  out.push(`Want these to stop repeating? The beta turns repeats into rules your agents follow: ${BETA_SIGNUP_URL}`);
  return out.join("\n") + "\n";
}

const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");

/** `--share`: a redacted Markdown summary with no paths or project names. */
export function renderShare(report) {
  const out = [];
  const both = report.hosts.claude.prompts > 0 && report.hosts.codex.prompts > 0;
  const agents = Object.keys(HOSTS).filter((h) => report.hosts[h].prompts).map((h) => HOSTS[h]).join(" + ") || "no agent";
  const days = Math.max(0, ...Object.values(report.hosts).map((h) => h.days));
  out.push(`## My coding agents' repeated mistakes (${plural(days, "day")} of history)`);
  out.push("");
  out.push(`- **Corrections:** ${report.corrections} in ${plural(report.prompts, "typed prompt")} (${agents})`);
  out.push(`- **Repeated 3+ times:** ${report.repeated3}`);
  if (both) out.push(`- **Came up in both agents:** ${report.bothAgents}`);
  const cov = coverageLine(report.coverage, report);
  if (cov) out.push(`- **Rules:** ${cov}`);
  if (report.top.length) {
    out.push("");
    out.push(both ? "| Times | Correction | Agents |" : "| Times | Correction |");
    out.push(both ? "|---|---|---|" : "|---|---|");
    for (const t of report.top) out.push(both ? `| ${t.count} | ${cell(t.sentence)} | ${cell(hostSplit(t.hosts))} |` : `| ${t.count} | ${cell(t.sentence)} |`);
  }
  out.push("");
  out.push("_Made offline with `ad mistakes`. Secrets, paths, e-mail addresses and the account name are redacted automatically; names of people are not, so read it before you post._");
  return out.join("\n") + "\n";
}

/** `--json`: the report without session sets or raw text. */
export function renderJson(report) {
  return JSON.stringify(report, null, 2) + "\n";
}

export const projectLabel = (root) => (root ? path.basename(root) : null);

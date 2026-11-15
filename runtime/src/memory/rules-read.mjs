// What `report` says about rules (MCP launch plan L7, design D20). Pure: the caller reads the
// store (rules, pauses, accepted learnings without a rule) and the rule events log, and this
// counts them. Stoppable: a learning with a rule (asked about or stopped where the host can);
// reminded: an accepted learning without one (recalled and counted). L8 owns the rest of report.

/** The copy line and its limits line (L7 Done-when 9), shown wherever rules are counted. */
export const RULES_COPY = "Command and file repeats are asked about or stopped where the host can; other corrections are recalled and counted.";
export const RULES_LIMITS = "File rules see edits made with the agent's file tools, not shell redirects; MCP tools and nested agents with their own settings aren't checked.";

const live = (p, now) => Boolean(p && typeof p === "object" && typeof p.at === "string" && (p.until === null || Date.parse(p.until) > now));

/**
 * @param {{rules?: object[], reminded?: number, events?: object[], paused?: {all: object|null, projects: object},
 *   projectId?: string|null, all?: boolean, days?: number, now?: number}} o
 *   rules: listRules rows (decision, orphaned_at, project_id, scope); events: readRuleEvents
 * @returns {{rules: number, stop: number, ask: number, orphaned: number, reminded: number,
 *   paused: {all: string|null|false, project: string|null|false}, asked: number, stopped: number,
 *   passes: number, selfProtect: {stopped: number, asked: number}}}
 *   paused.*: false (not paused), null (until resumed) or the until time
 */
export function rulesSection({ rules = [], reminded = 0, events = [], paused = { all: null, projects: {} }, projectId = null, all = false, days = 30, now = Date.now() } = {}) {
  const list = Array.isArray(rules) ? rules.filter((r) => r && typeof r === "object") : [];
  const since = now - days * 86_400_000;
  const out = {
    rules: list.length,
    stop: list.filter((r) => r.decision === "deny").length,
    ask: list.filter((r) => r.decision !== "deny").length,
    orphaned: list.filter((r) => r.orphaned_at).length,
    reminded: Number.isFinite(reminded) ? reminded : 0,
    paused: { all: false, project: false },
    asked: 0,
    stopped: 0,
    passes: 0,
    selfProtect: { stopped: 0, asked: 0 },
  };
  if (live(paused?.all, now)) out.paused.all = paused.all.until;
  const mine = projectId ? paused?.projects?.[projectId] : null;
  if (!all && live(mine, now)) out.paused.project = mine.until;
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== "object") continue;
    const t = Date.parse(e.at);
    if (!Number.isFinite(t) || t < since || t > now) continue;
    // Self-protection guards ad's own state: counted in every project (the log has no project for it).
    if (e.decision === "self-protect") {
      if (e.outcome === "deny") out.selfProtect.stopped++;
      else if (e.outcome === "ask") out.selfProtect.asked++;
      continue;
    }
    if (!all && (!projectId || e.project !== projectId)) continue;
    if (e.decision === "asked") out.asked++;
    else if (e.decision === "stopped") out.stopped++;
    else if (e.decision === "passed") out.passes++;
  }
  return out;
}

const until = (u) => (u === null ? "until you resume them" : `until ${String(u).slice(0, 16).replace("T", " ")}`);

/** The section's lines (indented like the rest of report). No command is named: an agent's shell may print it (S4). */
export function rulesLines(s, { share = false } = {}) {
  const lines = [`  Rules                       ${s.rules} (stop ${s.stop}, ask ${s.ask})${s.orphaned ? `, ${s.orphaned} whose learning is gone` : ""}`];
  lines.push(`    stoppable / reminded      ${s.rules} / ${s.reminded}`);
  lines.push(`    asked / stopped           ${s.asked} / ${s.stopped}${s.passes ? `   (allowed once ${s.passes})` : ""}`);
  if (s.selfProtect.stopped || s.selfProtect.asked) lines.push(`    ad's own files guarded    ${s.selfProtect.stopped} stopped, ${s.selfProtect.asked} asked (every project)`);
  if (!share && s.paused.all !== false) lines.push(`    paused everywhere ${until(s.paused.all)}`);
  else if (!share && s.paused.project !== false) lines.push(`    paused in this project ${until(s.paused.project)}`);
  lines.push(`    ${RULES_COPY}`);
  lines.push(`    ${RULES_LIMITS}`);
  return lines;
}

// `rules` (MCP launch plan L7, design D19): the package's `rules` verb and `ad rules`.
//
//   rules list [--json]                                   no token
//   rules add <learning-id> [--pattern "…"] [--all-projects] [--block]   the review token
//   rules rm <id>                                         token + typed code (D16)
//   rules pause [--all] [--for 30m|1h|2d|--until-resume]  token + typed code (default 1 hour)
//   rules resume [--all]                                  token
//   rules allow-once <rule> [<callId>] [--pick N] [--minutes N]   token + typed code
//
// Every write ends with rebuildGuards and the rule switch (D13). From the agent's
// shell (AD_TOOL_SHELL=1, no terminal) the writes refuse and name no command; help and
// usage there name only `rules list` (S4).

import { PRODUCT } from "../product.mjs";

const LOWERING = new Set(["rm", "pause", "allow-once"]);
const WRITES = new Set(["add", "rm", "pause", "resume", "allow-once"]);

export const rulesUsage = ({ fromAgent = false, command = (v) => `ad ${v}` } = {}) =>
  fromAgent
    ? `usage: ${command("rules list")} [--json]`
    : [
        `usage: ${command("rules list")} [--json]`,
        `       ${command("rules add")} <learning-id> [--pattern "<program> <sub>|… [on <branch>]" | "write <glob>"] [--all-projects] [--block]`,
        `       ${command("rules rm")} <id>`,
        `       ${command("rules pause")} [--all] [--for 30m|1h|2d | --until-resume]`,
        `       ${command("rules resume")} [--all]`,
        `       ${command("rules allow-once")} <rule> [<call-id>] [--pick N] [--minutes N]`,
      ].join("\n");

/** "30m" | "1h" | "2d" → ms, or null. */
export function parseFor(s) {
  const m = /^(\d{1,4})\s*(m|min|h|d)$/i.exec(String(s ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const ms = n * (unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000);
  return ms > 0 && ms <= 30 * 86_400_000 ? ms : null;
}

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === "--json" || a === "--all" || a === "--all-projects" || a === "--block" || a === "--until-resume") flags[a.slice(2)] = true;
    else if (["--pattern", "--for", "--minutes", "--pick"].includes(a)) {
      if (i + 1 >= argv.length) return { error: `${a} needs a value` };
      flags[a.slice(2)] = String(argv[++i]);
    } else if (/^--(pattern|for|minutes|pick)=/.test(a)) {
      const [k, ...v] = a.slice(2).split("=");
      flags[k] = v.join("=");
    } else if (a.startsWith("--")) return { error: `unknown option ${a}` };
    else pos.push(a);
  }
  return { flags, pos };
}

const ago = (iso, now) => {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return null;
  const m = Math.max(0, Math.round((now - t) / 60_000));
  return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

/**
 * → exit code.
 * @param {string[]} argv
 * @param {{out?:Function, ask?:Function, env?:object, isTTY?:Function, handle?:any, root?:string, cwd?:string,
 *   token?:Function, command?:(v:string)=>string, cmdName?:string|null, now?:Date, confirm?:Function, projectId?:string|null}} [o]
 */
export async function rulesMain(argv = [], o = {}) {
  const out = o.out ?? ((l) => console.log(l));
  const env = o.env ?? process.env;
  const isTTY = o.isTTY ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY));
  const command = o.command ?? ((v) => `npx -y ${PRODUCT.package} ${v}`);
  const name = PRODUCT.displayName;
  const fromAgent = env.AD_TOOL_SHELL === "1" || !isTTY();
  const sub = argv[0] ?? "list";
  if (sub === "--help" || sub === "-h" || sub === "help") {
    out(rulesUsage({ fromAgent, command }));
    return 0;
  }
  const parsed = parseArgs(argv.slice(1));
  if (!["list", ...WRITES].includes(sub) || parsed.error) {
    if (parsed.error) out(`${name}: ${parsed.error}`);
    out(rulesUsage({ fromAgent, command }));
    return 1;
  }
  const { flags, pos } = parsed;
  if (WRITES.has(sub) && fromAgent) {
    // S4: no command here; the user decides in their own terminal.
    out(`${name}: rules are changed by the user, in their own terminal. Nothing changed.`);
    return 1;
  }
  const { adRoot } = await import("../ad-root.mjs");
  const root = o.root ?? adRoot({ env });
  const cwd = o.cwd ?? process.cwd();
  const now = o.now ?? new Date();
  const ep = await import("./episodic.mjs");
  const handle = o.handle ?? (await ep.db().catch(() => null));
  if (!handle) {
    out(`${name}: the memory store can't be opened.`);
    return 1;
  }
  const svc = await import("./rules-service.mjs");
  const props = await import("./rule-proposals.mjs");
  const projectId = o.projectId !== undefined ? o.projectId : (await import("./projects.mjs")).projectIdOf(cwd);

  if (sub === "list") {
    const { readRuleEvents } = await import("../hooks/rule-events.mjs");
    return listMain({ handle, root, out, svc, props, json: flags.json, fromAgent, command, now: now.getTime(), name, readEvents: () => readRuleEvents({ root }) });
  }

  // Writes: the review token first.
  const rs = await import("./review-service.mjs");
  const ask = o.ask ?? askLine;
  const t = await (o.token ?? (() => rs.reviewToken({ ask, out })))();
  if (!t?.token || !rs.isReviewToken(t.token)) {
    out(`${name}: nothing changed: this needs your own terminal (${t?.refused ?? "not your own terminal"}).`);
    return 1;
  }
  const token = t.token;
  const { confirmLowering } = await import("./rule-removal.mjs");
  const code = (what) => confirmLowering({ what, tty: o.tty, confirm: o.confirm, proven: t.dialogProven === true });
  const { rebuildGuards } = await import("./guards-build.mjs");
  const cmd = o.cmdName ?? null;
  // Rebuild; a drop this run didn't name is shown and needs the code again (D3).
  // Then the rule switch (D13): ad's tool.before entries follow the rules (CLI-side only).
  const rebuild = async (extra = {}) => {
    let built;
    try {
      built = await rebuildGuards(handle, { root, token, now, cmd, ...extra });
    } catch (e) {
      if (e?.code !== "UNEXPECTED_DROP") throw e;
      out(`${name}: ${String(e.message).replace(/^rebuildGuards: /, "")}`);
      const c = await code("Rebuild the rules file anyway");
      if (!c.ok) throw new Error(`the rules file wasn't rebuilt (${c.text ?? "not confirmed"})`);
      built = await rebuildGuards(handle, { root, token, now, cmd, ...extra, confirmed: true });
    }
    const { switchAfterRules } = await import("../memory-install/rule-switch.mjs");
    return { ...built, switch: await switchAfterRules({ root, token, now: now.getTime() }) };
  };
  const done = (r) => {
    if (r?.switch?.why) out(r.switch.why);
    for (const l of r?.switch?.codex ?? []) out(l.trim()); // Codex on Windows: the entry's cost and the /hooks step
    return 0;
  };
  try {
    if (sub === "add") {
      const id = Number(pos[0]);
      if (!Number.isInteger(id) || pos.length !== 1) {
        out(rulesUsage({ command }));
        return 1;
      }
      const { ruleProposalSql } = await import("./trust.mjs");
      const row = handle.get(`SELECT id, text, project_id FROM learnings WHERE id = ? AND ${ruleProposalSql()}`, [id]);
      if (!row) {
        out(`${name}: #${id} isn't an accepted learning in use, so it can't become a rule.`);
        return 1;
      }
      const p = flags.pattern !== undefined ? props.parsePatternText(flags.pattern) : props.proposalFor(row.text);
      if (!p || p.error) {
        out(`${name}: ${p?.error ?? `#${id} doesn't name a command or a file a rule can match; give one with --pattern`}.`);
        return 1;
      }
      const decision = flags.block ? "deny" : "ask";
      const scope = flags["all-projects"] ? "all" : "project";
      const ruleId = svc.addRule(handle, token, { learningId: id, projectId: row.project_id, scope, kind: p.kind, decision, pattern: p.pattern, reason: row.text, now });
      out(`${name}: rule ${ruleId} ${props.ruleSummary(p.kind, p.pattern, decision)} (${scope === "all" ? "all projects" : "this project"}).`);
      return done(await rebuild());
    }
    if (sub === "rm") {
      const id = Number(pos[0]);
      const rule = Number.isInteger(id) && pos.length === 1 ? svc.listRules(handle).find((r) => r.id === id) : null;
      if (!rule) {
        out(Number.isInteger(id) && pos.length === 1 ? `${name}: there is no rule ${id}.` : rulesUsage({ command }));
        return 1;
      }
      const c = await code(`Remove rule ${id} (${props.ruleSummary(rule.kind, rule.pattern, rule.decision)})`);
      if (!c.ok) {
        out(`${name}: nothing changed (${c.text ?? "not confirmed"}).`);
        return 1;
      }
      svc.removeRule(handle, token, id, { now });
      out(`${name}: rule ${id} removed.`);
      return done(await rebuild({ expected: { rules: [id] } }));
    }
    if (sub === "pause") {
      if (pos.length || (flags.for !== undefined && flags["until-resume"])) {
        out(rulesUsage({ command }));
        return 1;
      }
      const ms = flags["until-resume"] ? null : flags.for !== undefined ? parseFor(flags.for) : 3_600_000;
      if (ms === null && !flags["until-resume"]) {
        out(`${name}: --for takes minutes, hours or days (30m, 1h, 2d; up to 30 days).`);
        return 1;
      }
      const target = flags.all ? null : projectId;
      if (!flags.all && !target) {
        out(`${name}: this folder isn't a project; pause every rule with --all.`);
        return 1;
      }
      const until = ms === null ? null : new Date(now.getTime() + ms);
      const n = svc.listRules(handle, target ? { projectId: target } : {}).length;
      const span = until ? `until ${until.toISOString().slice(0, 16).replace("T", " ")} UTC` : "until you resume them";
      const c = await code(`Pause ${flags.all ? `all ${n}` : `${n}`} rule${n === 1 ? "" : "s"}${flags.all ? "" : " in this project"} ${span}`);
      if (!c.ok) {
        out(`${name}: nothing changed (${c.text ?? "not confirmed"}).`);
        return 1;
      }
      svc.pauseRules(handle, token, { projectId: target, until, now });
      out(`${name}: rules paused ${flags.all ? "everywhere" : "in this project"} ${span}. Self-protection still runs. Resume: \`${command(`rules resume${flags.all ? " --all" : ""}`)}\``);
      return done(await rebuild({ expected: { pause: true } }));
    }
    if (sub === "resume") {
      if (pos.length) {
        out(rulesUsage({ command }));
        return 1;
      }
      const target = flags.all ? null : projectId;
      if (!flags.all && !target) {
        out(`${name}: this folder isn't a project; resume every rule with --all.`);
        return 1;
      }
      const had = svc.resumeRules(handle, token, { projectId: target, now });
      out(`${name}: ${had ? `rules resumed ${flags.all ? "everywhere" : "in this project"}` : "nothing was paused there"}.`);
      return done(await rebuild());
    }
    // allow-once
    const rule = Number(pos[0]);
    if (!Number.isInteger(rule) || pos.length > 2) {
      out(rulesUsage({ command }));
      return 1;
    }
    const found = svc.findAllowable({ root, rule, callId: pos[1] ?? null, pick: flags.pick ?? null, now: now.getTime() });
    if (found.refused) {
      out(`${name}: ${found.refused}.`);
      for (const ch of found.choices ?? []) out(`  ${ch.number}. ${ch.callId} ${ch.at} ${ch.view}`);
      if (found.choices?.length) out(`  pick one: \`${command(`rules allow-once ${rule} --pick <number>`)}\``);
      return 1;
    }
    const minutes = flags.minutes !== undefined ? Number(flags.minutes) : 5;
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 30) {
      out(`${name}: --minutes is 1 to 30.`);
      return 1;
    }
    const c = await code(`Allow once: ${found.view}`);
    if (!c.ok) {
      out(`${name}: nothing changed (${c.text ?? "not confirmed"}).`);
      return 1;
    }
    const tok = await svc.grantAllowOnce(handle, token, found.entry, { root, minutes, now: now.getTime() });
    out(`${name}: the agent may run that call once in the next ${minutes} minute${minutes === 1 ? "" : "s"} (rule ${tok.rules.join(", rule ")}).`);
    return 0;
  } catch (e) {
    out(`${name}: ${String(e?.message ?? e).replace(/^rules: /, "")}`);
    return 1;
  }
}

function listMain({ handle, out, svc, props, json, fromAgent, command, now, name, readEvents }) {
  const rules = svc.listRules(handle);
  const paused = svc.pausedState(handle);
  const waiting = new Map(svc.rulesAwaitingRemoval(handle).map((w) => [w.id, w.why]));
  const last = new Map();
  try {
    for (const e of readEvents()) {
      for (const r of e?.rules ?? []) {
        if (!Number.isInteger(r?.id)) continue;
        const l = last.get(r.id) ?? {};
        if (e.decision === "asked") l.asked = e.at;
        else if (e.decision === "stopped") l.stopped = e.at;
        last.set(r.id, l);
      }
    }
  } catch {
    // no log yet
  }
  const live = (p) => p && (p.until === null || Date.parse(p.until) > now);
  const rows = rules.map((r) => {
    const p = live(paused.all) ? paused.all : live(paused.projects[r.project_id]) && r.scope !== "all" ? paused.projects[r.project_id] : null;
    return {
      id: r.id,
      decision: r.decision,
      scope: r.scope,
      kind: r.kind,
      pattern: props.patternText(r.kind, r.pattern),
      reason: r.reason,
      source: r.source,
      learning: r.learning_id,
      paused: p ? { until: p.until } : null,
      orphaned: waiting.has(r.id) ? waiting.get(r.id) : null,
      lastAsked: last.get(r.id)?.asked ?? null,
      lastStopped: last.get(r.id)?.stopped ?? null,
    };
  });
  if (json) {
    out(JSON.stringify({ rules: rows, paused: { all: live(paused.all) ? paused.all : null } }, null, 2));
    return 0;
  }
  if (!rows.length) {
    out(`${name}: no rules yet. A correction becomes a rule at review.`);
    return 0;
  }
  out(`${name} rules (Claude Code asks; bypass and don't-ask modes and Codex stop the call):`);
  for (const r of rows) {
    const bits = [r.decision === "deny" ? "blocks" : "asks", r.scope === "all" ? "all projects" : "this project", r.pattern];
    const extra = [
      r.paused && `paused ${r.paused.until ? `until ${r.paused.until.slice(0, 16).replace("T", " ")} UTC` : "until resumed"}`,
      r.lastStopped && `last stopped ${ago(r.lastStopped, now)}`,
      r.lastAsked && `last asked ${ago(r.lastAsked, now)}`,
    ].filter(Boolean);
    out(`  ${r.id}  ${bits.join(" · ")}  — ${r.reason}${extra.length ? ` (${extra.join(", ")})` : ""}`);
    if (r.orphaned) out(`      rule ${r.id}'s learning is ${r.orphaned === "orphaned" ? "gone" : r.orphaned}: keep it${fromAgent ? " (the user can settle this in their own terminal)" : ` or \`${command(`rules rm ${r.id}`)}\``}`);
  }
  return 0;
}

async function askLine(q) {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(q);
  } finally {
    rl.close();
  }
}

export { LOWERING };

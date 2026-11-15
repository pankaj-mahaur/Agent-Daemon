// Rule proposals at review (MCP launch plan L7, design D4, D17–D18). Reads only.
//
//   proposalFor(text)       an accepted learning's words → {kind, pattern} through L4c's
//                           deriveRule plus branchesOf (D6), or null (not a rule)
//   ruleOffers(handle, o)   at most 3 learnings to offer a rule for: the rows this run just
//                           accepted first, then older accepted, active ones of the project with
//                           a proposal, no rule, not declined (unless the correction repeated
//                           since), not deferred in the last 14 days and deferred under twice
//   patternText / parsePatternText
//                           the one-line grammar of the review row's `e`:
//                           `<program> [<sub>|…] [<flag>|…] [on <branch>,…]` or `write <glob> …`
//   ruleSummary(kind, pattern, decision)
//                           "asks before `npm install|ci`" — the words `rules list` and the
//                           removal confirmation use
//   previewCounts(rule, calls, o)
//                           what the rule would have done on this project's last 30 days
//                           (exact counts, two examples); the calls come from
//                           readPreviewCalls (rule-preview.mjs)

import { deriveRule } from "../rules/derive.mjs";
import { branchesOf } from "../rules/branches.mjs";
import { replayMatches } from "../rules/replay.mjs";
import { validPattern } from "./rules-service.mjs";
import { ruleProposalSql } from "./trust.mjs";
import { projectClause } from "./projects.mjs";

export const MAX_OFFERS = 3;
export const DEFER_DAYS = 14;
export const MAX_DEFERS = 2;
export const PREVIEW_DAYS = 30;

/** → {kind, pattern} or null. */
export function proposalFor(text) {
  const r = deriveRule(String(text ?? ""));
  if (r.type !== "command" && r.type !== "write") return null;
  const pattern = { ...r };
  if (r.type === "command") {
    const b = branchesOf(text, r);
    if (b) pattern.branches = b;
  }
  try {
    return { kind: r.type, pattern: validPattern(r.type, pattern) };
  } catch {
    return null; // names ad, or not a pattern a rule can hold
  }
}

const tryAll = (handle, sql, params = []) => {
  try {
    return handle.all(sql, params);
  } catch {
    return [];
  }
};

/**
 * @param {any} handle
 * @param {{keys:string[], justAccepted?:number[], now?:Date, max?:number}} o
 * @returns {{learningId:number, projectId:string|null, text:string, kind:string, pattern:object, fresh:boolean}[]}
 */
export function ruleOffers(handle, { keys, justAccepted = [], now = new Date(), max = MAX_OFFERS } = {}) {
  if (!Array.isArray(keys) || !keys.length) return [];
  const scope = projectClause("", keys);
  // Proposals come only from ruleProposalSql rows (D4): accepted and active, never pending or provisional.
  const rows = tryAll(handle, `SELECT id, text, project_id FROM learnings WHERE ${ruleProposalSql()} AND ${scope.sql} AND id NOT IN (SELECT learning_id FROM rules WHERE learning_id IS NOT NULL) ORDER BY id DESC LIMIT 400`, scope.params);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => "?").join(",");
  const events = tryAll(handle, `SELECT learning_id AS id, kind, at FROM events WHERE kind IN ('rule-declined', 'rule-deferred', 'repeated') AND learning_id IN (${marks}) ORDER BY at, id`, ids);
  const facts = new Map();
  for (const e of events) {
    const f = facts.get(e.id) ?? { declinedAt: null, repeatedAt: null, defers: 0, deferredAt: null };
    if (e.kind === "rule-declined") f.declinedAt = e.at;
    else if (e.kind === "repeated") f.repeatedAt = e.at;
    else {
      f.defers++;
      f.deferredAt = e.at;
    }
    facts.set(e.id, f);
  }
  const fresh = new Set(justAccepted.map(Number));
  const cutoff = new Date(now.getTime() - DEFER_DAYS * 86_400_000).toISOString();
  const eligible = (r) => {
    const f = facts.get(r.id);
    if (!f) return true;
    if (f.declinedAt && !(f.repeatedAt && f.repeatedAt > f.declinedAt)) return false;
    if (f.defers >= MAX_DEFERS) return false; // after two deferrals: only `rules add`
    if (f.deferredAt && f.deferredAt > cutoff) return false;
    return true;
  };
  const ordered = [...rows.filter((r) => fresh.has(r.id)), ...rows.filter((r) => !fresh.has(r.id))];
  const out = [];
  for (const r of ordered) {
    if (out.length >= max) break;
    if (!eligible(r)) continue;
    const p = proposalFor(r.text);
    if (!p) continue;
    out.push({ learningId: r.id, projectId: r.project_id ?? null, text: r.text, kind: p.kind, pattern: p.pattern, fresh: fresh.has(r.id) });
  }
  return out;
}

/** The one-line text of a pattern (the review row, `rules list`). */
export function patternText(kind, p) {
  if (kind === "write" || p?.type === "write") return `write ${(p?.globs ?? []).join(" ")}`;
  if (p?.type === "policy") return `starter safety policy: ${p.family}`;
  const words = [p?.program, (p?.subcommands ?? []).join("|"), (p?.flags ?? []).join("|")].filter(Boolean);
  return words.join(" ") + (p?.branches?.length ? ` on ${p.branches.join(",")}` : "");
}

/**
 * Parse the review row's edit back into a pattern (validated by validPattern). → {kind, pattern}
 * or {error}. Flags are the words that start with "-"; the rest after the program are
 * subcommands; `on a,b` at the end names branches.
 */
export function parsePatternText(text) {
  const s = String(text ?? "").trim();
  if (!s || s.length > 400) return { error: "type a pattern on one line" };
  const words = s.split(/\s+/);
  try {
    if (words[0].toLowerCase() === "write") {
      const globs = words.slice(1);
      if (!globs.length) return { error: "write needs at least one file pattern" };
      return { kind: "write", pattern: validPattern("write", { type: "write", globs }) };
    }
    let branches = null;
    const on = words.findIndex((w, i) => i > 0 && w.toLowerCase() === "on");
    let body = words;
    if (on > 0) {
      branches = words.slice(on + 1).join(",").split(",").map((b) => b.trim()).filter(Boolean);
      if (!branches.length) return { error: "name the branches after on" };
      body = words.slice(0, on);
    }
    const [program, ...rest] = body;
    const alts = rest.flatMap((w) => w.split("|")).filter(Boolean);
    const flags = alts.filter((w) => w.startsWith("-"));
    const subs = alts.filter((w) => !w.startsWith("-"));
    const pattern = { type: "command", program, subcommands: subs.length ? subs : null, flags: flags.length ? flags : null };
    if (branches) pattern.branches = branches;
    const clean = validPattern("command", pattern);
    if (branches && !clean.branches) return { error: "branch names are letters, digits and . / - _" };
    return { kind: "command", pattern: clean };
  } catch (e) {
    return { error: String(e?.message ?? e).replace(/^rules: /, "") };
  }
}

/** "asks before `npm install|ci`" / "stops writes to `migrations/**`". */
export function ruleSummary(kind, pattern, decision = "ask") {
  const verb = decision === "deny" ? "stops" : "asks before";
  if (kind === "write" || pattern?.type === "write") return `${verb} ${decision === "deny" ? "writes to" : "writing"} \`${(pattern?.globs ?? []).join(" ")}\``;
  return `${verb} \`${patternText(kind, pattern)}\``;
}

const shortCall = (c) => {
  const cmd = c?.input?.command;
  const text = Array.isArray(cmd) ? cmd.join(" ") : typeof cmd === "string" ? cmd : c?.input?.file_path ?? c?.input?.path ?? "";
  return String(text).replace(/[\u{0}-\u{1f}\u{7f}-\u{9f}\u{200b}-\u{200f}\u{2028}-\u{202e}\u{2066}-\u{2069}]+/gu, " ").trim().slice(0, 60);
};

/**
 * What the rule would have done over these calls (already this project's, last 30 days).
 * → {count, examples: string[]}
 */
export function previewCounts(rule, calls, { rootOf } = {}) {
  const hits = [...replayMatches(rule, calls ?? [], rootOf ? { rootOf } : {})];
  const examples = [];
  for (const i of hits) {
    const t = shortCall(calls[i]);
    if (t && !examples.includes(t)) examples.push(t);
    if (examples.length >= 2) break;
  }
  return { count: hits.length, examples };
}

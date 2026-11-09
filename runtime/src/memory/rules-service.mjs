// The review service's rule writes (MCP launch plan L7, design D2; 02 §2.2): the only
// code that adds or removes a rule, pauses or resumes rules, or settles the rules of a
// learning the user changed. Every write needs a review token (review-service.mjs:
// the user's own terminal) and records an event in the same transaction.
//
// A rule comes only from an accepted, active learning of the same project (trust.mjs
// ruleProposalSql): never a provisional, pending or forget-requested one. The rule's
// reason is the learning's own words, neutralised. guards.json is projected from this
// store afterwards (memory/guards-build.mjs); nothing here touches it.

import { isReviewToken } from "./review-service.mjs";
import { ruleProposalSql } from "./trust.mjs";
import { recordEvent, getSetting, putSetting } from "./l5-tables.mjs";
import { noRulesTable } from "./rules-tables.mjs";
import { neutralText } from "../rules/neutral.mjs";
import { createHash, randomBytes } from "node:crypto";
import { readRuleEvents } from "../hooks/rule-events.mjs";
import { allowability, allowOnceView } from "../hooks/allow-once.mjs";
import { rebuildGuards } from "./guards-build.mjs";

const iso = (now) => (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();

function must(token) {
  if (!isReviewToken(token)) throw new Error("rules: this needs a review token (run it yourself, in your own terminal)");
}

/** The learning's words as a rule's reason: one line, no control characters, no ad commands, ≤ 120 characters (S4). */
export const ruleReason = (text) => neutralText(text);

const isText = (s) => typeof s === "string" && s.trim().length > 0;
const list = (v) => (Array.isArray(v) ? v : null);

/** Is this glob a project-relative path pattern a write rule may hold? */
function goodGlob(g) {
  if (!isText(g) || g.length > 300) return false;
  const s = g.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  if (!s || s.startsWith("/") || /^[A-Za-z]:/.test(s) || s.startsWith("~")) return false; // absolute: rules are per project
  const parts = s.split("/").filter(Boolean);
  if (parts.includes("..")) return false; // escapes the project
  // Every file (**, */**, **/*, **/*.*, *.*): not a rule, a lockout.
  if (parts.every((p) => /^\*+(?:\.\*+)?$/.test(p) || p === ".")) return false;
  return true;
}

/** Validate a neutral-schema pattern for a rule kind. Throws on a bad one; → the clean pattern. */
export function validPattern(kind, pattern) {
  const p = pattern && typeof pattern === "object" ? pattern : {};
  if (kind === "command" && p.type === "command" && isText(p.program) && !/[\s/\\]/.test(p.program.trim()) && p.program.length <= 80) {
    const subs = list(p.subcommands);
    const flags = list(p.flags);
    if ((subs ?? []).every(isText) && (flags ?? []).every(isText)) {
      const out = { type: "command", program: p.program.trim(), subcommands: subs?.length ? subs.map((s) => s.trim()) : null, flags: flags?.length ? flags.map((s) => s.trim()) : null };
      const branches = list(p.branches);
      if (branches?.length && branches.every((b) => isText(b) && /^[\w./-]{1,100}$/.test(b))) out.branches = branches;
      return out;
    }
  }
  if (kind === "write" && p.type === "write") {
    const globs = list(p.globs);
    if (globs?.length && globs.every(goodGlob)) return { type: "write", globs: globs.map((g) => g.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "")) };
  }
  throw new Error(`rules: not a usable pattern for a ${kind} rule: ${JSON.stringify(pattern)}`);
}

/**
 * Add a rule from an accepted learning. → the rule id.
 * @param {{learningId:number|null, projectId:string, scope?:"project"|"all", kind:"command"|"write",
 *   decision?:"ask"|"deny", pattern:object, reason:string, now?:Date, source?:string}} o
 */
export function addRule(handle, token, o) {
  must(token);
  const { learningId = null, projectId, scope = "project", kind, decision = "ask", reason, now, source = "learning" } = o ?? {};
  if (!["project", "all"].includes(scope)) throw new Error(`rules: unknown scope ${scope}`);
  if (!["ask", "deny"].includes(decision)) throw new Error(`rules: unknown decision ${decision}`);
  if (!["command", "write"].includes(kind)) throw new Error(`rules: unknown kind ${kind}`);
  if (!["learning", "policy"].includes(source)) throw new Error(`rules: unknown source ${source}`);
  if (!isText(projectId)) throw new Error("rules: a rule belongs to a project (its learning's)");
  const pattern = validPattern(kind, o.pattern);
  return handle.transaction(() => {
    if (source === "learning") {
      const row = handle.get(`SELECT id, project_id FROM learnings WHERE id = ? AND ${ruleProposalSql()}`, [learningId]);
      if (!row) throw new Error(`rules: learning #${learningId} isn't an accepted, active learning`);
      if (row.project_id !== projectId) throw new Error(`rules: learning #${learningId} belongs to another project`);
    }
    const id = Number(handle.run(
      "INSERT INTO rules (learning_id, project_id, scope, kind, decision, pattern, reason, approved_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [learningId, projectId, scope, kind, decision, JSON.stringify(pattern), ruleReason(reason), iso(now), source]
    ).lastInsertRowid);
    recordEvent(handle, { kind: "rule-on", learningId, projectId, actor: "review", detail: { rule: id, kind, decision, scope }, at: now });
    return id;
  });
}

/** Remove one rule. → true when it existed. */
export function removeRule(handle, token, id, { now, why = "removed" } = {}) {
  must(token);
  return handle.transaction(() => {
    const row = handle.get("SELECT id, learning_id, project_id FROM rules WHERE id = ?", [Number(id)]);
    if (!row) return false;
    handle.run("DELETE FROM rules WHERE id = ?", [row.id]);
    recordEvent(handle, { kind: "rule-off", learningId: row.learning_id, projectId: row.project_id, actor: "review", detail: { rule: row.id, why }, at: now });
    return true;
  });
}

const PAUSE_KEY = "rules_paused";

/** The pause state: {all: {at, until}|null, projects: {<id>: {at, until}}} (until null = until resumed). */
export function pausedState(handle) {
  let v = null;
  try {
    v = JSON.parse(getSetting(handle, PAUSE_KEY) ?? "null");
  } catch {
    v = null; // a damaged value pauses nothing (rules stay enforced)
  }
  const ok = (x) => x && typeof x === "object" && typeof x.at === "string" && (x.until === null || typeof x.until === "string");
  const projects = {};
  for (const [id, x] of Object.entries(v?.projects ?? {})) if (ok(x)) projects[id] = { at: x.at, until: x.until };
  return { all: ok(v?.all) ? { at: v.all.at, until: v.all.until } : null, projects };
}

/** Pause rules in one project (projectId) or everywhere (null) until `until` (a Date, or null for until resumed). */
export function pauseRules(handle, token, { projectId = null, until = null, now } = {}) {
  must(token);
  return handle.transaction(() => {
    const s = pausedState(handle);
    const entry = { at: iso(now), until: until ? iso(until) : null };
    if (projectId) s.projects[projectId] = entry;
    else s.all = entry;
    putSetting(handle, PAUSE_KEY, JSON.stringify(s), { now });
    recordEvent(handle, { kind: "rules-paused", projectId, actor: "review", detail: { all: !projectId, until: entry.until }, at: now });
    return entry;
  });
}

/** Resume rules in one project, or the all-projects pause (projectId null). → true when a pause ended. */
export function resumeRules(handle, token, { projectId = null, now } = {}) {
  must(token);
  return handle.transaction(() => {
    const s = pausedState(handle);
    const had = projectId ? Boolean(s.projects[projectId]) : Boolean(s.all);
    if (projectId) delete s.projects[projectId];
    else s.all = null;
    putSetting(handle, PAUSE_KEY, JSON.stringify(s), { now });
    recordEvent(handle, { kind: "rules-resumed", projectId, actor: "review", detail: { all: !projectId }, at: now });
    return had;
  });
}

/**
 * The rules whose learning is gone or set aside (archived, rejected, deleted): each stays
 * enforced until the user confirms its removal with the typed code (design D2). → rows
 * {id, learning_id, project_id, why: "archived"|"rejected"|"orphaned", reason}
 */
export function rulesAwaitingRemoval(handle, { projectId = null } = {}) {
  try {
    const rows = handle.all(
      `SELECT r.id, r.learning_id, r.project_id, r.reason, CASE WHEN r.learning_id IS NULL THEN 'orphaned' ELSE l.status END AS why
         FROM rules r LEFT JOIN learnings l ON l.id = r.learning_id
        WHERE (r.learning_id IS NULL AND r.orphaned_at IS NOT NULL) OR l.status IN ('archived', 'rejected')
        ORDER BY r.id`
    );
    return projectId ? rows.filter((r) => r.project_id === projectId) : rows;
  } catch (e) {
    if (noRulesTable(e)) return []; // an older store
    throw e;
  }
}

/**
 * Settle the rules of learnings the user changed, in a token-holding run (design D2): a
 * superseded learning's rules move to the learning that replaced it, when the user
 * accepted that one. A rule whose
 * learning was archived, rejected or deleted ends only when `confirmed` holds its id (the
 * run showed "also removes rule 7" and took the typed code); otherwise it stays, listed by
 * rulesAwaitingRemoval. A quarantined learning keeps its rules (a screen is not the user's
 * decision). → {moved, removed, pending} (rule ids)
 */
export function maintainRules(handle, token, { now, confirmed = [] } = {}) {
  must(token);
  const yes = new Set([confirmed].flat().map(Number));
  return handle.transaction(() => {
    const moved = [];
    const removed = [];
    const pending = [];
    for (const r of rulesAwaitingRemoval(handle)) {
      if (!yes.has(r.id)) {
        pending.push(r.id);
        continue;
      }
      handle.run("DELETE FROM rules WHERE id = ?", [r.id]);
      recordEvent(handle, { kind: "rule-off", learningId: r.learning_id, projectId: r.project_id, actor: "review", detail: { rule: r.id, why: r.why }, at: now });
      removed.push(r.id);
    }
    const rows = handle.all(
      "SELECT r.id, r.learning_id, r.project_id, l.status, l.superseded_by FROM rules r JOIN learnings l ON l.id = r.learning_id WHERE l.status = 'superseded' ORDER BY r.id"
    );
    for (const r of rows) {
      // Follow the chain to the learning in use now; a broken chain keeps the rule where it is.
      let to = r.superseded_by;
      for (let i = 0; to && i < 20; i++) {
        const next = handle.get("SELECT id, status, superseded_by FROM learnings WHERE id = ?", [to]);
        if (!next) {
          to = null;
          break;
        }
        if (next.status !== "superseded" || !next.superseded_by) break;
        to = next.superseded_by;
      }
      // Only to a learning the user accepted: a merge into a pending twin keeps the rule
      // where it is (still enforced, D2).
      const accepted = to && handle.get("SELECT 1 AS x FROM learnings WHERE id = ? AND accepted_by IS NOT NULL", [to]);
      if (accepted && to !== r.learning_id) {
        handle.run("UPDATE rules SET learning_id = ? WHERE id = ?", [to, r.id]);
        recordEvent(handle, { kind: "rule-on", learningId: to, projectId: r.project_id, actor: "review", detail: { rule: r.id, movedFrom: r.learning_id }, at: now });
        moved.push(r.id);
      }
    }
    return { moved, removed, pending };
  });
}

/** Every rule (newest last), parsed. Tokenless: a read. */
export function listRules(handle, { projectId = null } = {}) {
  let rows = [];
  try {
    rows = projectId
      ? handle.all("SELECT * FROM rules WHERE project_id = ? OR scope = 'all' ORDER BY id", [projectId])
      : handle.all("SELECT * FROM rules ORDER BY id");
  } catch (e) {
    if (noRulesTable(e)) return []; // an older store with no rules table
    throw e;
  }
  return rows.map((r) => ({ ...r, pattern: safeJson(r.pattern) }));
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** How far back a stop can be allowed once. */
export const ALLOW_ONCE_WINDOW_MS = 30 * 60_000;
const NOT_ALLOWABLE = {
  long: "it is too long to show in full",
  chars: "it holds characters that could make it look like something else",
  secret: "it holds what looks like a secret",
};

/**
 * Find the stop the user wants to allow once (design D9). Tokenless: it only reads the
 * protected log and shows what it found. → {entry, view} or {refused, choices?}
 * @param {{root:string, rule:number, callId?:string|null, now?:number, windowMs?:number}} o
 */
export function findAllowable({ root, rule, callId = null, pick = null, now = Date.now(), windowMs = ALLOW_ONCE_WINDOW_MS } = {}) {
  const ruleId = Number(rule);
  const since = now - windowMs;
  const stops = readRuleEvents({ root }).filter((e) => e?.decision === "stopped" && Date.parse(e.at) >= since && (e.rules ?? []).some((r) => r?.id === ruleId));
  if (!stops.length) return { refused: `rule ${ruleId} hasn't stopped anything in the last ${Math.round(windowMs / 60_000)} minutes` };
  let found = stops;
  // Every list shown numbers the stops the same way: by their place among this rule's
  // stops in the window (one per distinct call), so a number picked means what it showed.
  const listed = latestPer(stops);
  const choice = (e) => ({ number: listed.findIndex((x) => x.callHash === e.callHash) + 1, callId: e.callId, callHash: e.callHash, at: e.at, view: e.call ? allowOnceView(e) : `(not allowable: ${NOT_ALLOWABLE[e.notAllowable] ?? "no text"})` });
  if (pick !== null && pick !== undefined && pick !== "") {
    // The user's pick from a list we showed: its full hash (preferred) or its number.
    const p = String(pick).toLowerCase();
    found = /^[0-9a-f]{64}$/.test(p) ? stops.filter((e) => e.callHash === p) : /^\d+$/.test(p) && listed[Number(p) - 1] ? [listed[Number(p) - 1]] : [];
    if (!found.length) return { refused: `no stop of rule ${ruleId} matches ${pick}`, choices: listed.map(choice) };
  } else if (callId) {
    found = stops.filter((e) => e.callId === String(callId).toLowerCase());
    if (!found.length) return { refused: `no stop of rule ${ruleId} has the call id ${callId}` };
    const distinct = new Set(found.map((e) => e.callHash));
    if (distinct.size > 1) return { refused: `two different stops share the call id ${callId}: pick one by its number`, choices: latestPer(found).map(choice) };
  } else {
    const distinct = new Set(stops.map((e) => e.callHash));
    if (distinct.size > 1) return { refused: `rule ${ruleId} stopped ${distinct.size} different calls: name one by its call id`, choices: latestPer(stops).map(choice) };
  }
  const entry = found[found.length - 1];
  if (entry.notAllowable || typeof entry.call !== "string") return { refused: `this call can't be allowed once (${NOT_ALLOWABLE[entry.notAllowable] ?? "it wasn't recorded"}): run it yourself` };
  // What the prompt shows is what the token binds: recompute the hash from it.
  if (allowability(entry.call)) return { refused: "this call can't be shown faithfully: run it yourself" };
  if (createHash("sha256").update(entry.call).digest("hex") !== entry.callHash) return { refused: "the recorded call doesn't match its hash: run it yourself" };
  return { entry, view: allowOnceView(entry) };
}

const latestPer = (stops) => [...new Map(stops.map((e) => [e.callHash, e])).values()];

/**
 * Write the single-use token for a stop findAllowable returned (the review service: token;
 * the CLI takes the typed code first, D16). Every rule that stopped the call is covered.
 * → the token written
 */
export async function grantAllowOnce(handle, token, entry, { root, minutes = 5, now = Date.now(), expected = {}, confirmed = false } = {}) {
  must(token);
  if (!entry?.callHash || typeof entry.call !== "string") throw new Error("allow-once: no allowable stop");
  // The token binds what the user was shown: re-check it here too, whoever built the entry.
  if (allowability(entry.call)) throw new Error("allow-once: this call can't be shown faithfully");
  if (createHash("sha256").update(entry.call).digest("hex") !== entry.callHash) throw new Error("allow-once: the call doesn't match its hash");
  const m = Math.min(30, Math.max(1, Math.round(Number(minutes) || 5)));
  const tok = {
    callHash: entry.callHash,
    rules: [...new Set((entry.rules ?? []).map((r) => r.id).filter((id) => Number.isInteger(id)))],
    project: entry.project ?? null,
    nonce: randomBytes(16).toString("hex"),
    expires: new Date(now + m * 60_000).toISOString(),
  };
  // The token lands first; the event records only a grant that happened.
  await rebuildGuards(handle, { root, token, now: new Date(now), addAllowOnce: [tok], expected, confirmed });
  handle.transaction(() => recordEvent(handle, { kind: "allow-once", projectId: tok.project, actor: "review", detail: { rules: tok.rules, callId: entry.callId, minutes: m } }));
  return tok;
}

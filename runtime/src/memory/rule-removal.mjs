// "Also removes rule 7" (MCP launch plan L7, design D2): a learning the user forgets,
// deletes, archives or rejects keeps its rule until the user confirms the removal with the
// typed code (D16). The checklist and the CLI show each such rule after the run and ask once;
// a declined or failed code keeps the rule (orphaned or with its archived learning), listed by
// `rules list` and `doctor`.
//
//   ruleOwners(handle)                   rule id → learning id, taken before the run
//   rulesLeftBy(handle, before, ids)     the rules whose learning in `ids` this run took away
//   confirmRemovals(o)                   show them, take the code → the confirmed rule ids
//   confirmLowering(o)                   the typed code (D16)

import { listRules, rulesAwaitingRemoval } from "./rules-service.mjs";
import { ruleSummary } from "./rule-proposals.mjs";

/** rule id → learning id (rules with a learning), before a run changes learnings. */
export function ruleOwners(handle) {
  const m = new Map();
  for (const r of listRules(handle)) if (r.learning_id != null) m.set(r.id, r.learning_id);
  return m;
}

/** The rules a run left without a usable learning, among the learnings it changed (`ids`). */
export function rulesLeftBy(handle, before, ids) {
  const gone = new Set([ids ?? []].flat().map(Number));
  if (!gone.size) return [];
  const all = new Map(listRules(handle).map((r) => [r.id, r]));
  return rulesAwaitingRemoval(handle)
    .filter((w) => gone.has(Number(w.learning_id ?? before.get(w.id))))
    .map((w) => ({ ...all.get(w.id), why: w.why, learningId: w.learning_id ?? before.get(w.id) ?? null }))
    .filter((r) => r.id != null);
}

/**
 * The typed confirmation code (D16) for a step that lowers enforcement, read from the
 * controlling terminal (P3-2 confirmTypedCode). → {ok, text?}
 * @param {{what:string, proven?:boolean, tty?:{ask:Function}, code?:string, confirm?:Function}} o  tty, code, confirm: test seams
 */
export async function confirmLowering(o) {
  if (typeof o.confirm === "function") return o.confirm({ what: o.what });
  const { confirmTypedCode } = await import("./typed-code.mjs");
  return confirmTypedCode({ what: o.what, proven: o.proven === true, tty: o.tty, code: o.code });
}

/**
 * Show "also removes rule 7 (asks before `npm install`)" for each rule and take the code once.
 * → confirmed rule ids ([] when declined).
 */
export async function confirmRemovals({ rules, out, tty, confirm, proven = false, command = (v) => `ad ${v}`, verb = "Forgetting" }) {
  if (!rules?.length) return [];
  for (const r of rules) out(`${verb} #${r.learningId ?? "?"} also removes rule ${r.id} (${ruleSummary(r.kind, r.pattern, r.decision)}).`);
  const ids = rules.map((r) => r.id);
  const what = `Remove rule${ids.length === 1 ? "" : "s"} ${ids.join(", ")}`;
  const c = await confirmLowering({ what, tty, confirm, proven });
  if (c.ok) return ids;
  out(`${ids.length === 1 ? "Rule" : "Rules"} ${ids.join(", ")} stay${ids.length === 1 ? "s" : ""} (${c.text ?? "not confirmed"}): keep ${ids.length === 1 ? "it" : "them"}, or \`${command(`rules rm ${ids[0]}`)}\` later.`);
  return [];
}

/**
 * The end of a token run that changed learnings (D2): confirm the removal of the rules it
 * left without a learning, then afterReview (move, end what was confirmed, rebuild). Never
 * throws: a failed rebuild keeps the stricter snapshot and says so. → the confirmed rule ids
 */
export async function settleRun({ handle, token, before = null, changed = [], out, tty, confirm, proven = false, command, root, verb, cmdName = null }) {
  let confirmed = [];
  try {
    const left = before ? rulesLeftBy(handle, before, changed) : [];
    confirmed = await confirmRemovals({ rules: left, out, tty, confirm, proven, command, verb });
    const { afterReview } = await import("./rules-finish.mjs");
    const r = await afterReview(handle, token, { confirmed, cmd: cmdName, ...(root ? { root } : {}) });
    if (r?.switch?.why) out(r.switch.why);
  } catch (e) {
    out(`The rules file wasn't rebuilt (${e?.message ?? e}); it keeps the rules it had until the next review.`);
  }
  return confirmed;
}

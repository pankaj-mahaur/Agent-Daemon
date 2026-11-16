// The starter safety policy (MCP launch plan L7b; D18, D41): off by default; turned on or
// off only through the review service (D3: the user's own terminal). On, it is four rules in
// L7's store — source 'policy', every project, ask — one per family (rules/policy.mjs), so
// guards.json, the fail-closed switch, allow-once and pause treat them as rules. Nothing in
// a repository can turn it off: it lives only in the user's store (D18: the user level
// wins; a project's own rules can only add to it).

import { addRule, removeRule, pausedState } from "./rules-service.mjs";
import { rebuildGuards } from "./guards-build.mjs";
import { noRulesTable } from "./rules-tables.mjs";
import { FAMILIES, FAMILY_TEXT } from "../rules/policy.mjs";

export { FAMILIES as POLICY_FAMILIES, FAMILY_TEXT };

/** The project id policy rules carry (they apply everywhere: scope 'all'). */
export const POLICY_PROJECT = "_policy";

/** The words every policy surface uses: it asks before, it doesn't protect (D3, 04 §L7b). */
export const POLICY_COPY = Object.freeze({
  offer: "Ask before four kinds of catastrophic commands? (y/N)",
  limits: "A gate against accidents, not a sandbox: a command hidden in a script, a variable or eval isn't seen.",
});

/** The policy's rows in the store, oldest first. */
export function policyRules(handle) {
  try {
    return handle.all("SELECT id, decision, scope, pattern, approved_at FROM rules WHERE source = 'policy' ORDER BY id");
  } catch (e) {
    if (noRulesTable(e)) return [];
    throw e;
  }
}

const familyOf = (row) => {
  try {
    return JSON.parse(row.pattern)?.family ?? null;
  } catch {
    return null;
  }
};

/** → {state: "on"|"some"|"off", families: [{family, text, rule: id|null}], paused: {at, until}|null} */
export function policyState(handle) {
  const rows = policyRules(handle);
  const families = FAMILIES.map((family) => ({ family, text: FAMILY_TEXT[family], rule: rows.find((r) => familyOf(r) === family)?.id ?? null }));
  const n = families.filter((f) => f.rule !== null).length;
  let paused = null;
  try {
    paused = pausedState(handle).all ?? null;
  } catch {
    paused = null;
  }
  return { state: n === FAMILIES.length ? "on" : n === 0 ? "off" : "some", families, paused };
}

/** Add the families that are missing (review token). → {added: [rule ids]} */
export function policyOn(handle, token, { now } = {}) {
  const have = new Set(policyRules(handle).map(familyOf));
  const added = [];
  for (const family of FAMILIES) {
    if (have.has(family)) continue;
    added.push(addRule(handle, token, { learningId: null, projectId: POLICY_PROJECT, scope: "all", kind: "command", decision: "ask", pattern: { type: "policy", family }, reason: `starter safety policy: ${FAMILY_TEXT[family]}`, source: "policy", now }));
  }
  return { added };
}

/** Remove every policy rule (review token). → {removed: [rule ids]} */
export function policyOff(handle, token, { now } = {}) {
  const removed = [];
  for (const r of policyRules(handle)) if (removeRule(handle, token, r.id, { now, why: "starter safety policy off" })) removed.push(r.id);
  return { removed };
}

/**
 * Turn the policy on or off and rebuild guards.json with the same token (only the rules
 * this run removed may leave the snapshot: L7 D3's expected list).
 * → {added|removed: ids, ruleCount, switch: the rule switch's result (L7 D13)}
 */
export async function setPolicy(handle, token, on, { root, now = new Date(), cmd = null } = {}) {
  const change = on ? policyOn(handle, token, { now }) : policyOff(handle, token, { now });
  const built = await rebuildGuards(handle, { root, token, now, cmd, expected: { rules: change.removed ?? [] } });
  // L7 D13: ad's rules check follows the rules (the installer's code: never in a hook's graph).
  const { switchAfterRules } = await import("../memory-install/rule-switch.mjs");
  const switched = await switchAfterRules({ root, token, now: now.getTime() });
  return { ...change, ruleCount: built?.ruleCount ?? null, switch: switched };
}

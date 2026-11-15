// The end of every token-holding run (MCP launch plan L7, design D2–D3): settle the rules
// of learnings the user changed in it (maintainRules: superseded → moved; archived,
// rejected or deleted → ended only when the run confirmed it) and project the store into
// guards.json again. Cheap when the store has no rules and the snapshot none (nothing to do).

import { maintainRules } from "./rules-service.mjs";
import { rebuildGuards } from "./guards-build.mjs";
import { loadGuards } from "../hooks/guards.mjs";
import { adRoot } from "../ad-root.mjs";

const storeHasRules = (handle) => {
  try {
    return Boolean(handle.get("SELECT 1 AS x FROM rules LIMIT 1"));
  } catch {
    return false; // an older store
  }
};

/**
 * @param {any} handle the store
 * @param {object} token the run's review token
 * @param {{root?:string, cmd?:string|null, now?:Date, confirmed?:number[]}} [o] confirmed: rule ids whose
 *   removal the run showed and the user confirmed with the typed code
 * @returns {Promise<{moved:number[], removed:number[], pending:number[], generation?:number, ruleCount?:number, switch?:object}|null>} null when nothing to do
 */
export async function afterReview(handle, token, { root = adRoot(), cmd = null, now = new Date(), confirmed = [] } = {}) {
  const snapshotRules = (loadGuards({ root }).snapshot?.ruleCount ?? 0) > 0;
  if (!storeHasRules(handle) && !snapshotRules) {
    // No rules left, but the switch that lowers ad's rules check may still be owed (L7 D13: a
    // tokened lowering that failed). This run has the token: it retries.
    const { readSwitchRecord, switchDue, switchAfterRules } = await import("../memory-install/rule-switch.mjs");
    const rec = readSwitchRecord(root);
    if (!rec || !(rec.pendingLower || switchDue(root, now.getTime()))) return null;
    return { moved: [], removed: [], pending: [], switch: await switchAfterRules({ root, token, now: now.getTime() }) };
  }
  const settled = maintainRules(handle, token, { now, confirmed });
  // Only what this run settled may change; anything else surfaces as UNEXPECTED_DROP (S1).
  const built = await rebuildGuards(handle, { root, token, now, cmd, expected: { rules: [...settled.removed, ...settled.moved] } });
  // L7 D13: ad's rules check follows the rules (the installer's code: never in a hook's graph).
  const { switchAfterRules } = await import("../memory-install/rule-switch.mjs");
  return { ...settled, ...built, switch: await switchAfterRules({ root, token, now: now.getTime() }) };
}

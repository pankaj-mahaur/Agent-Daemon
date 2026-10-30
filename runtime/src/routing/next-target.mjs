// Which target continues the task next (P4.4; called by P4.5 and P4.7). Pure apart from
// reading the quota store, which other windows write too.
//
//   nextTarget(policy, ctx, { accounts, catalog, now, root })
//     ctx: { from: {account, model}, failure, tried: ["account:model"], hops, switchesLastHour,
//            sessionLimitedProviders: Map<benchKey, untilMs> }
//     → { target, index, info, why } | { none: true, reason?, skipped: [{ target, index, reasons }] }
//   reasonsNow(policy, target, { accounts, catalog, now, root }) → why it can't continue now ([] when it can)
//
// Order: the policy's order after `from`, wrapping once, never `from` or a tried target. Then
// eligibility (P4.3), the cost rule, the trial rule, the provider bench (every window's) and
// this session's own limited providers: a provider that just hit a limit is never continued
// on another of its accounts (D09, T3-H5).

import { eligibility } from "../providers/catalog.mjs";
import { benchKey } from "../providers/quota.mjs";
import { costAllows, FALLBACK_ON, targetInfo, targetKey } from "./policy.mjs";

const LIMITS = new Set(["rateLimit", "quotaExhausted"]);

function reasonsFor(t, info, policy, { limited = new Map(), now, root }) {
  if (!info.account) return ["account-removed"];
  const entry = info.entry ? { ...info.entry, accountId: info.account.id, provider: info.account.provider, billing: info.billing } : null;
  // Cost and trial are this policy's rules, so eligibility checks the rest.
  const reasons = eligibility({ entry, account: info.account }, {}, { now, root }).reasons.filter((r) => r !== "trial-endpoint-no-consent");
  const cost = policy.cost ?? "noExtraSpend";
  if (!costAllows(cost, info)) {
    if (info.free === false) reasons.push(cost === "freeOnly" ? "not-free" : "paid-not-allowed");
    else if (info.billing === "unknown" && !info.entry?.price) reasons.push("unknown-billing");
    else reasons.push(info.zero ? "price-stale" : "price-unknown");
  }
  const rule = policy.dataRules?.trialEndpoints ?? "ask";
  if (info.trial && (rule === "never" || (rule === "ask" && t.trialConsent !== true))) reasons.push("trial-endpoint-no-consent");
  // Limited unless its reset is known and past: an unknown or unreadable reset never frees it.
  const key = benchKey(info.account.provider, info.account.id);
  const until = limited.get(key);
  if (limited.has(key) && !(Number.isFinite(until) && until <= now) && !reasons.includes("provider-benched-until")) reasons.push("provider-limited-this-session");
  return reasons;
}

/** Why one target can't continue a task now ([] when it can), as `ad fallback` lists it. */
export function reasonsNow(policy, t, { accounts = [], catalog = () => null, now = Date.now(), root } = {}) {
  return reasonsFor(t, targetInfo(t, { accounts, catalog, now }), policy, { now, root });
}

export function nextTarget(policy, ctx = {}, { accounts = [], catalog = () => null, now = Date.now(), root } = {}) {
  const { from = null, failure = null, tried = [], hops = 0, switchesLastHour = 0 } = ctx;
  const allowed = (policy.on ?? FALLBACK_ON).filter((c) => FALLBACK_ON.includes(c));
  if (!allowed.includes(failure)) return { none: true, reason: "not-on", skipped: [] };
  if (hops >= (policy.maxHops ?? 3)) return { none: true, reason: "max-hops", skipped: [] };
  if (switchesLastHour >= (policy.maxSwitchesPerHour ?? 6)) return { none: true, reason: "too-often", skipped: [] };

  const opts = { accounts, catalog, now };
  const limited = new Map(ctx.sessionLimitedProviders ?? []);
  const fromAccount = from ? accounts.find((a) => a.id === from.account) : null;
  if (fromAccount && LIMITS.has(failure)) limited.set(benchKey(fromAccount.provider, fromAccount.id), Infinity);

  const targets = policy.targets ?? [];
  const at = from ? targets.findIndex((t) => targetKey(t) === targetKey(from)) : -1;
  const order = [...targets.keys()].map((i) => (at + 1 + i) % targets.length).filter((i) => i !== at);
  const done = new Set(tried);
  const skipped = [];
  for (const index of order) {
    const target = targets[index];
    if (done.has(targetKey(target))) {
      skipped.push({ target, index, reasons: ["tried"] });
      continue;
    }
    const info = targetInfo(target, opts);
    const reasons = reasonsFor(target, info, policy, { limited, now, root });
    if (reasons.length) {
      skipped.push({ target, index, reasons });
      continue;
    }
    const why = ["next-in-order", info.billing === "local" ? "local" : info.free === true ? "free" : "your-plan"];
    return { target, index, info, why, skipped };
  }
  return { none: true, skipped };
}

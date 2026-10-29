// The fallback preview (P4.4): what ad would do if a target failed now, and why, in the
// words the TUI and `ad fallback preview` show. Pure apart from reading the quota store.
//
//   explain(policy, { from, failure }, { accounts, catalog, now, root }) → lines
//   reasonText(code, info, { now, root }) → "needs signing in again"

import { providerDisplay } from "../auth/accounts/target.mjs";
import { benchedUntil, benchKey, readStore, stateAt, limitState } from "../providers/quota.mjs";
import { nextTarget, reasonsNow } from "./next-target.mjs";
import { IDENTITY_UNKNOWN, targetInfo, targetKey } from "./policy.mjs";

const FAILURE = { quotaExhausted: "runs out of its limit", rateLimit: "hits a rate limit", transientNetwork: "can't be reached", provider5xx: "has a provider error" };
const NONE = { "not-on": "fallback isn't switched on for this kind of error", "max-hops": "it has already switched as many times as your order allows", "too-often": "fallback is switching too often" };
const COST = { freeOnly: "free only", noExtraSpend: "no extra spend" };
const WINDOW = { day: "today", secondary: "weekly", primary: "5 h", minute: "this minute" };

const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
export function ago(iso, now) {
  const ms = now - Date.parse(iso ?? "");
  if (!Number.isFinite(ms)) return null;
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
}

// The account's trusted observations, worst first.
function trusted(accountId, { now, root }) {
  const rank = { exhausted: 4, limited: 3, near: 2, ok: 1 };
  return Object.values(readStore({ root }).observations)
    .filter((o) => o.accountId === accountId)
    .map((o) => ({ o, s: stateAt(o, now) }))
    .filter((x) => rank[x.s])
    .sort((a, b) => rank[b.s] - rank[a.s]);
}

/** "today 120/1500" or "weekly 64% used", from the worst trusted observation. */
export function limitDetail(accountId, { now, root }) {
  for (const { o } of trusted(accountId, { now, root })) {
    const win = WINDOW[o.window] ? `${WINDOW[o.window]} ` : "";
    if (o.used !== null && o.used !== undefined && o.limit) return `${win}${o.used}/${o.limit}`;
    if (o.usedPercent !== null && o.usedPercent !== undefined) return `${win}${o.usedPercent}% used`;
  }
  return null;
}

const resetOf = (accountId, states, { now, root }) => {
  const at = trusted(accountId, { now, root })
    .filter((x) => states.includes(x.s))
    .map((x) => Date.parse(x.o.resetsAt ?? ""))
    .filter(Number.isFinite);
  return at.length ? Math.max(...at) : null;
};

export function reasonText(code, info, { now = Date.now(), root } = {}) {
  const a = info.account;
  const provider = a ? providerDisplay(a.provider) : "";
  const at = (ms, word) => (ms ? ` (${word} ${hhmm(ms)})` : "");
  switch (code) {
    case "tried":
      return "already tried for this task";
    case "account-removed":
      return "its account was removed";
    case "account-needs-sign-in":
      return "needs signing in again";
    case "account-disabled":
      return "isn't ready";
    case "model-not-listed":
      return "its model list doesn't have this model";
    case "no-tools":
      return "can't call tools";
    case "context-too-small":
      return "its context is too small";
    case "not-free":
      return "isn't free";
    case "paid-not-allowed":
      return "bills per use";
    case "price-stale":
      return "its free price wasn't checked in the last day";
    case "price-unknown":
      return "its price isn't known";
    case "unknown-billing":
      return "ad doesn't know how it bills";
    case "quota-exhausted-until":
      return `its limit is used up${at(resetOf(a.id, ["exhausted"], { now, root }), "resets")}`;
    case "rate-limited-until":
      return `it's rate limited${at(resetOf(a.id, ["limited"], { now, root }), "until")}`;
    case "provider-benched-until":
      return `${provider} hit its limit${at(benchedUntil(benchKey(a.provider, a.id), { now, root }), "until")}`;
    case "provider-limited-this-session":
      return `${provider} hit its limit in this session`;
    case "trial-endpoint-no-consent":
      return "a trial endpoint you haven't confirmed";
    default:
      return code;
  }
}

function costWhy(info, policy, now) {
  const rule = `"${COST[policy.cost ?? "noExtraSpend"]}" allows it`;
  if (info.billing === "local") return `it runs on your machine (${rule})`;
  if (info.free === true) {
    const when = ago(info.entry?.price?.observedAt, now);
    return `it's free (${when ? `price checked ${when}; ` : ""}${rule})`;
  }
  return `it's your plan (${rule})`;
}
const shortCost = (info) => (info.billing === "local" ? "your machine" : info.free === true ? "free" : "your plan");

export function explain(policy, { from = null, failure = "quotaExhausted" } = {}, { accounts = [], catalog = () => null, now = Date.now(), root } = {}) {
  const opts = { accounts, catalog, now, root };
  const start = from ?? policy.targets?.[0] ?? null;
  const fromLabel = start ? targetInfo(start, opts).label : "the current model";
  const head = `If ${fromLabel} ${FAILURE[failure] ?? "fails"} now, ad would`;
  const tried = start ? [targetKey(start)] : []; // the target that failed is never tried again
  let last = start;
  const limited = new Map(); // as a session would: every provider that hit a limit on the way
  const lines = [];
  const skips = new Map(); // every target skipped along the chain, with its first reason
  for (let hops = 0; ; hops++) {
    const lastAccount = last ? accounts.find((a) => a.id === last.account) : null;
    if (lastAccount && (failure === "quotaExhausted" || failure === "rateLimit")) limited.set(benchKey(lastAccount.provider, lastAccount.id), Infinity);
    const r = nextTarget(policy, { from: last, failure, tried, hops, sessionLimitedProviders: limited }, opts);
    for (const s of r.skipped) if (!s.reasons.includes("tried") && !skips.has(targetKey(s.target))) skips.set(targetKey(s.target), s);
    if (r.none) {
      if (hops === 0) lines.push(`${head} stop and ask you: ${NONE[r.reason] ?? "no target in your order can continue now"}.`);
      else lines.push("Then ad stops and asks you.");
      break;
    }
    const limit = limitDetail(r.target.account, { now, root });
    if (hops === 0) {
      const state = limitState(r.target.account, { now, root });
      const skippedBefore = r.skipped.some((s) => !s.reasons.includes("tried"));
      const limits = state === "near" ? `its limits are nearly used up${limit ? ` (${limit})` : ""}` : state === "ok" ? `its limits look fine${limit ? ` (${limit})` : ""}` : "ad hasn't seen its limits yet";
      lines.push(`${head} try ${r.info.label} next:`, `it's next in your order${skippedBefore ? " (after the skipped ones below)" : ""}, ${costWhy(r.info, policy, now)}, and ${limits}.`);
    } else {
      lines.push(`If that fails too: ${r.info.label} (${[shortCost(r.info), limit].filter(Boolean).join("; ")}).`);
    }
    tried.push(targetKey(r.target));
    last = r.target;
  }
  for (const s of skips.values()) {
    if (tried.includes(targetKey(s.target))) continue;
    const info = targetInfo(s.target, opts);
    lines.push(`Skipped now: ${info.label}: ${reasonText(s.reasons[0], info, { now, root })}.`);
  }
  return lines;
}

// ---- What `ad fallback` and /fallback show -------------------------------------------------

export const ON_WORDS = Object.freeze({ quotaExhausted: "limit used up", rateLimit: "rate limit", transientNetwork: "network error", provider5xx: "provider error" });
export const COST_WORDS = COST;
const TRIAL_WORDS = { ask: "ask", never: "never", allow: "allowed" };

export const giveUpText = (ms) => (ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`);

/** "free (checked 3 min ago)", "your plan", "bills per use", "price unknown". */
export function costText(info, now) {
  if (info.billing === "local") return "local";
  if (info.billing === "subscription") return "your plan";
  if (info.free === true) {
    const when = ago(info.entry?.price?.observedAt, now);
    return when ? `free (checked ${when})` : "free";
  }
  if (info.free === false) return "bills per use";
  return info.zero ? "free? (price not checked lately)" : "price unknown";
}

/** One row per target: its words, its cost and limits, and whether it can continue now. */
export function rowsOf(policy, { accounts = [], catalog = () => null, now = Date.now(), root } = {}) {
  return (policy.targets ?? []).map((target, index) => {
    const info = targetInfo(target, { accounts, catalog, now });
    const reasons = reasonsNow(policy, target, { accounts, catalog, now, root });
    return {
      index,
      target,
      label: `${info.label}${target.effort ? ` ${target.effort}` : ""}`,
      cost: costText(info, now),
      limits: info.account ? limitDetail(info.account.id, { now, root }) : null,
      ok: reasons.length === 0,
      reasons,
      why: reasons.length ? reasonText(reasons[0], info, { now, root }) : null,
    };
  });
}

export function rulesLines(policy) {
  const order = Object.keys(ON_WORDS);
  const on = [...(policy.on ?? [])].sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((c) => ON_WORDS[c] ?? c).join(" \u{b7} ");
  const keep = policy.allowRunningBackground?.length ? `   Keep running: ${policy.allowRunningBackground.join(", ")}` : "";
  return [`Switch on: ${on || "nothing"}`, `Cost: ${COST[policy.cost] ?? policy.cost}   Moves per task: ${policy.maxHops} (${policy.maxSwitchesPerHour} an hour)   Give up after: ${giveUpText(policy.recoveryBudgetMs)}   Trial endpoints: ${TRIAL_WORDS[policy.dataRules?.trialEndpoints ?? "ask"]}${keep}`];
}

function dataLine(info) {
  const host = info.account?.provider === "custom" ? hostOf(info.account.endpoint) : null;
  const name = host ?? (info.account ? providerDisplay(info.account.provider) : "its provider");
  if (info.billing === "local") return "runs on your machine; nothing leaves it";
  if (info.billing === "subscription") return `your ${name} plan`;
  if (info.trial) return `${info.free === true ? "free tier" : "trial"}; ${info.note ?? "its provider may keep what you send"}`;
  if (info.free === true) return `free; your prompts and code go to ${name}${info.account?.provider === "openrouter" ? " and the model's host" : ""}`;
  return info.free === false ? "bills per use" : "price not known: skipped until checked";
}

const BILLING_SET = { subscription: "a plan you pay for", local: "a server on your machine", metered: "billed per use" };
const hostOf = (endpoint) => {
  try {
    return new URL(typeof endpoint === "string" ? endpoint : endpoint?.baseUrl).host;
  } catch {
    return null;
  }
};
const isSignIn = (a) => a?.method === "engine-login" || a?.credential?.kind === "engine-home";

/** One destination as the consent shows it: every fact the confirmation is tied to. */
function consentLine(t, info) {
  const host = info.account?.endpoint ? hostOf(info.account.endpoint) : null;
  const facts = [dataLine(info)];
  if (t.billing) facts.push(`you set it as ${BILLING_SET[t.billing] ?? t.billing}`);
  if (isSignIn(info.account) && !info.account.identity) facts.push(IDENTITY_UNKNOWN);
  return `${info.label}${t.effort ? ` ${t.effort}` : ""}${host ? ` (${host})` : ""}: ${facts.join("; ")}`;
}

/** The consent text (final words, P4.4): every destination and what it does with your data. */
export function consentText(policy, ctx = {}) {
  const lines = [
    "Turn on automatic fallback?",
    "When a model's limit runs out or its provider fails, ad continues the task after the turn ends, on the next target below, in this order, without asking:",
  ];
  for (const [i, t] of (policy.targets ?? []).entries()) {
    const info = targetInfo(t, ctx);
    lines.push(`  ${i + 1}. ${consentLine(t, info)}`);
  }
  lines.push(
    "The conversation and the files it reads go to whichever target continues the task. This also applies to ad run, ad loop, schedules and team workers when you turn fallback on for them.",
    "ad never moves to another account of a provider that just hit a limit, never switches on sign-in or policy errors, and never uses a target that isn't listed here.",
  );
  if (policy.allowRunningBackground?.length) lines.push(`It may also switch while these keep running: ${policy.allowRunningBackground.join(", ")}.`);
  lines.push("Every switch is shown. /fallback off stops it for a window; ad fallback disable turns it off.");
  return lines;
}

// The fallback policy (P4.4): where ad may continue a task when a limit runs out, and on
// what rules. Pure: validation, the cost rules, the consent hash. ~/.agent-daemon/
// fallback.json is store.mjs's; the choice of a next target is next-target.mjs's.
//
//   DEFAULT_POLICY                      off, no targets, "no extra spend"
//   validatePolicy(p, { accounts, catalog, now, enabling }) → { errors, warnings }
//     catalog(accountId, model) → the catalog's entry or null (P4.3)
//   targetInfo(t, { accounts, catalog, now }) → { account, label, billing, free, trial, note, entry }
//   costAllows(cost, info) → boolean      keepRunningMatches(prefixes, command) → boolean
//   consentHash(p, accounts) → "sha256:…"   every destination fact the user confirmed
//
// Unknown billing is eligible in no cost mode; a subscription is never "free".

import { createHash } from "node:crypto";
import { accountName, providerDisplay } from "../auth/accounts/target.mjs";
import { freeOf } from "../providers/catalog.mjs";
import { presetFor } from "../providers/registry.mjs";

export const FALLBACK_ON = Object.freeze(["rateLimit", "quotaExhausted", "transientNetwork", "provider5xx"]);
export const COSTS = Object.freeze(["freeOnly", "noExtraSpend"]);
export const TRIAL_RULES = Object.freeze(["ask", "never", "allow"]);
export const DEFAULT_POLICY = Object.freeze({
  schemaVersion: 1,
  revision: 0,
  enabled: false,
  targets: [],
  on: [...FALLBACK_ON],
  maxHops: 3,
  perTargetRetries: 1,
  recoveryBudgetMs: 120_000,
  maxSwitchesPerHour: 6,
  cost: "noExtraSpend",
  dataRules: { trialEndpoints: "ask" },
  allowRunningBackground: [],
  consent: null,
});

const TOP = new Set(Object.keys(DEFAULT_POLICY));
const TARGET_KEYS = new Set(["account", "model", "effort", "billing", "trialConsent"]);
const BILLINGS = new Set(["metered", "subscription", "local"]);
const BOUNDS = { maxHops: [1, 5], perTargetRetries: [0, 3], recoveryBudgetMs: [10_000, 600_000], maxSwitchesPerHour: [1, 20] };
const BOUND_TEXT = {
  maxHops: "Moves per task (max-hops) must be a whole number from 1 to 5.",
  perTargetRetries: "perTargetRetries must be a whole number from 0 to 3.",
  recoveryBudgetMs: "Give up after (give-up) must be between 10 and 600 seconds.",
  maxSwitchesPerHour: "Switches per hour (max-switches) must be a whole number from 1 to 20.",
};
// Keep-running prefixes that would allow almost anything: a launcher alone, a launcher with
// only a flag or "run", code passed inline (-c, -e, /c, -Command), or a wrapper in front.
const LAUNCHERS = new Set(["sh", "bash", "zsh", "fish", "dash", "pwsh", "powershell", "cmd", "node", "deno", "bun", "python", "python3", "py", "perl", "ruby", "php", "npx", "npm", "yarn", "pnpm", "uv", "uvx", "pipx", "make", "go", "cargo", "java", "dotnet"]);
// "/bin/bash", "C:\Windows\System32\cmd.exe" and "npm.cmd" are what they name.
const programOf = (w) => w.toLowerCase().replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|ps1)$/, "");
const WRAPPERS = new Set(["sudo", "doas", "env", "nohup", "start", "exec", "xargs", "time", "nice", "call", "runas"]);
const EVAL_FLAGS = new Set(["-c", "/c", "/k", "-e", "--eval", "-p", "--print", "-command", "-encodedcommand", "-r", "-x"]);
function tooBroad(words) {
  const a = programOf(words[0]);
  const b = words[1]?.toLowerCase();
  if (WRAPPERS.has(a)) return true;
  if (!LAUNCHERS.has(a)) return false;
  if (words.length === 1 || EVAL_FLAGS.has(b)) return true;
  return words.length === 2 && (/^[-/]/.test(b) || ["run", "exec", "x", "dlx", "run-script"].includes(b));
}
const DAY = 86_400_000;

export const targetKey = (t) => `${t.account}:${t.model ?? ""}`;
const presetOf = (provider) => {
  try {
    return presetFor(provider);
  } catch {
    return null;
  }
};
const isEngineAccount = (a) => a?.method === "engine-login" || a?.credential?.kind === "engine-home";

/** What ad knows of one target now: its account, words, billing, free state, trial terms. */
export function targetInfo(t, { accounts = [], catalog = () => null, now = Date.now() } = {}) {
  const account = accounts.find((a) => a.id === t.account) ?? null;
  const label = account ? `${accountName(account)}${t.model ? ` \u{b7} ${t.model}` : ""}` : `${t.account}${t.model ? ` \u{b7} ${t.model}` : ""}`;
  const entry = account ? catalog(account.id, t.model) : null;
  const preset = account ? presetOf(account.provider) : null;
  const billing = t.billing ?? (isEngineAccount(account) ? "subscription" : preset?.local ? "local" : (entry?.billing ?? "unknown"));
  const free = freeOf(entry?.price ?? null, { now, billing }).value;
  const terms = entry?.data && (entry.data.trial !== null || entry.data.trainsOnData) ? entry.data : preset?.privacy ? { trial: preset.privacy.trial, trainsOnData: preset.privacy.trainsOnData, note: preset.privacy.notice } : {};
  const trial = terms.trial === true || terms.trainsOnData === "free tier" || terms.trainsOnData === "yes";
  const zero = !!entry?.price && Number(entry.price.input) === 0 && Number(entry.price.output) === 0;
  return { account, label, entry, billing, free, zero, trial, note: terms.note ? String(terms.note).replace(/\.$/, "") : null };
}

/** freeOnly: a fresh zero price or a local server; noExtraSpend: that, or a plan you pay for. */
export function costAllows(cost, info) {
  if (info.billing === "unknown") return false; // never in any mode, even at a zero price
  if (info.free === true) return true;
  return cost === "noExtraSpend" && info.billing === "subscription";
}

/** A confirmed long-running command: the prefix's whole tokens start the command line. */
export function keepRunningMatches(prefixes = [], command = "") {
  const words = String(command).trim().split(/\s+/);
  return prefixes.some((p) => {
    const want = String(p).trim().split(/\s+/).filter(Boolean);
    return want.length > 0 && want.every((w, i) => words[i] === w);
  });
}

const typeOk = (k, v) => {
  switch (k) {
    case "enabled":
      return typeof v === "boolean";
    case "targets":
    case "on":
    case "allowRunningBackground":
      return Array.isArray(v);
    case "cost":
      return COSTS.includes(v);
    case "dataRules":
      return v && typeof v === "object" && !Array.isArray(v);
    case "consent":
      return v === null || (v && typeof v === "object");
    default:
      return typeof v === "number" && Number.isFinite(v);
  }
};
const K = (n) => `${Math.floor(n / 1000)}K`;

export function validatePolicy(p, { accounts = [], catalog = () => null, now = Date.now(), enabling = false } = {}) {
  const errors = [];
  const warnings = [];
  const err = (code, text, path = null) => errors.push({ code, text, ...(path ? { path } : {}) });
  const warn = (code, index, text) => warnings.push({ code, index, text });
  if (!p || typeof p !== "object") return { errors: [{ code: "schema", text: "the policy isn't an object." }], warnings };

  for (const [k, v] of Object.entries(p)) {
    if (!TOP.has(k)) err("schema", `${k}: unknown field.`, k);
    else if (!typeOk(k, v)) err("schema", `${k}: ${k === "cost" ? `must be one of ${COSTS.join(", ")}` : "wrong type"}.`, k);
  }
  for (const [k, [lo, hi]] of Object.entries(BOUNDS)) if (typeof p[k] === "number" && (!Number.isInteger(p[k]) || p[k] < lo || p[k] > hi)) err("bounds", BOUND_TEXT[k], k);
  const targets = Array.isArray(p.targets) ? p.targets : [];
  if (targets.length > 8) err("bounds", "targets must be between 1 and 8.", "targets");
  if (enabling && targets.length < 1) err("bounds", "targets must be between 1 and 8.", "targets");
  const removed = (Array.isArray(p.on) ? p.on : []).filter((c) => !FALLBACK_ON.includes(c));
  if (enabling && Array.isArray(p.on) && !p.on.some((c) => FALLBACK_ON.includes(c))) err("bounds", "Choose at least one kind of failure to switch on.", "on");
  if (removed.length) err("never-on", `ad never switches on sign-in, policy or eligibility problems: those need you (removed: ${removed.join(", ")}).`, "on");
  const trialRule = p.dataRules?.trialEndpoints ?? "ask";
  if (p.dataRules && typeof p.dataRules === "object") for (const k of Object.keys(p.dataRules)) if (k !== "trialEndpoints") err("schema", `dataRules.${k}: unknown field.`, `dataRules.${k}`);
  if (p.dataRules && !TRIAL_RULES.includes(trialRule)) err("schema", `dataRules.trialEndpoints: must be one of ${TRIAL_RULES.join(", ")}.`, "dataRules.trialEndpoints");
  for (const [i, prefix] of (Array.isArray(p.allowRunningBackground) ? p.allowRunningBackground : []).entries()) {
    const words = String(prefix ?? "").trim().split(/\s+/).filter(Boolean);
    if (typeof prefix !== "string" || words.length === 0) err("schema", `allowRunningBackground[${i}]: must be a command.`, `allowRunningBackground[${i}]`);
    else if (tooBroad(words)) err("keep-running-too-broad", "That would allow almost any command. Use the full command, e.g. npm run dev.", `allowRunningBackground[${i}]`);
  }

  const seen = new Map();
  const infos = [];
  for (const [i, t] of targets.entries()) {
    const path = `targets[${i}]`;
    if (!t || typeof t !== "object" || typeof t.account !== "string") {
      err("schema", `${path}.account: required.`, `${path}.account`);
      infos.push(null);
      continue;
    }
    for (const k of Object.keys(t)) if (!TARGET_KEYS.has(k)) err("schema", `${path}.${k}: unknown field.`, `${path}.${k}`);
    if (t.billing !== undefined && !BILLINGS.has(t.billing)) err("schema", `${path}.billing: must be metered, subscription or local.`, `${path}.billing`);
    const info = targetInfo(t, { accounts, catalog, now });
    infos.push(info);
    if (!info.account) {
      err("unknown-account", `No account ${t.account} (removed?). Remove this target.`, path);
      continue;
    }
    const key = targetKey(t);
    if (seen.has(key)) err("duplicate-target", `${info.label} is listed twice.`, path);
    seen.set(key, i);
    if (info.entry?.caps?.tools === false) err("no-tools", `${t.model ?? info.label} can't call tools, so it can't continue a coding task.`, path);
    if (t.billing === "local" && !presetOf(info.account.provider)?.local) err("billing-override", `${info.label}: only a server on your machine can be set as local.`, path);
    if (p.cost === "freeOnly" && info.free === false) err("not-free-under-freeOnly", `${info.label} isn't free (${info.billing === "subscription" ? "it's your plan" : "it bills per use"}). With 'free only' ad would always skip it: remove it or choose 'no extra spend'.`, path);
    if ((p.cost ?? "noExtraSpend") === "noExtraSpend" && info.billing === "metered" && info.free === false) err("metered-under-noExtraSpend", `${info.label} bills per use. 'No extra spend' allows free models and plans you already pay for.`, path);
    if (info.trial && trialRule === "never") err("trial-never", `${info.label} is a trial endpoint, and your rule says never.`, path);
    else if (info.trial && trialRule === "ask" && t.trialConsent !== true) err("trial-no-consent", `${info.label} is a trial endpoint: ${info.note ?? "its provider may keep what you send"}. Confirm it to keep it in the order.`, path);

    // Warnings, on this row.
    if (isEngineAccount(info.account) && !info.account.identity) warn("identity-unknown", i, IDENTITY_UNKNOWN);
    if (info.account.status === "needs-sign-in") warn("needs-sign-in", i, `${accountName(info.account)} needs signing in again`);
    const earlier = infos.slice(0, i).filter(Boolean);
    if (earlier.some((x) => x.account && x.account.provider === info.account.provider && x.account.id !== info.account.id)) warn("same-provider-accounts", i, `Used only while ${providerDisplay(info.account.provider)} hasn't hit a limit (until it resets).`);
    if (info.zero && earlier.some((x) => x.account?.id === info.account.id && x.zero)) warn("same-limit", i, `both use ${accountName(info.account)}'s free daily limit`);
    const prevCtx = earlier.at(-1)?.entry?.caps?.contextWindow;
    const ctx = info.entry?.caps?.contextWindow;
    if (prevCtx && ctx && ctx < prevCtx) warn("smaller-context", i, `${K(prevCtx)} vs ${K(ctx)}: long conversations are trimmed when they move here`);
    if (info.free === null && info.billing === "metered") {
      const at = Date.parse(info.entry?.price?.observedAt ?? "");
      warn("free-unknown", i, Number.isFinite(at) ? `price not checked in ${Math.max(1, Math.floor((now - at) / DAY))} days: skipped until checked` : "price not checked: skipped until checked");
    }
  }
  if (enabling && targets.length && !infos.some((x) => x && costAllows(p.cost ?? "noExtraSpend", x))) {
    err("no-eligible-target", `None of these targets fits '${p.cost === "freeOnly" ? "free only" : "no extra spend"}' right now, so fallback would never switch. Add a free model or change the cost rule.`, "targets");
  }
  return { errors, warnings };
}

// An account as the user confirmed it: who it is (masked e-mail and plan, or the key's last
// four), its endpoint and its credential's revision (a re-key or re-sign-in bumps it).
// A sign-in whose identity ad hasn't recorded yet (no writer before P3.7) is hashed by its
// home only: the consent text and a warning say so.
const fingerprint = (a) => (a?.identity ? `${a.identity.email ?? ""}|${a.identity.plan ?? ""}|${a.identity.workspace ?? ""}` : (a?.keyHint ?? ""));
export const IDENTITY_UNKNOWN = "ad can't tell yet which account is signed in here, so signing in there as someone else won't turn fallback off by itself";

const tupleOf = (t, a) => [t.account, t.model ?? null, t.effort ?? null, t.billing ?? null, t.trialConsent ?? null, a?.provider ?? null, a?.endpoint ?? null, fingerprint(a), a?.credentialRevision ?? null, a?.credential?.home ?? a?.credential?.ref ?? null];
const sha = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
// Unkeyed on purpose (P4.5's decision): a process that can write ~/.agent-daemon runs as the
// user, and as the user it can read ad's secret store too (DPAPI, libsecret, the file), so
// an HMAC key would stop nothing it couldn't take. What holds instead: the engine's sandbox
// keeps ~/.agent-daemon out of a workspace-write agent's reach, and every automatic decision
// re-validates the file against its own rules (a forged hash still meets the cost rules).

/** Every destination fact the user confirmed; a change leaves fallback off until confirmed again. */
export function consentHash(p, accounts = []) {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const canon = {
    targets: (p.targets ?? []).map((t) => tupleOf(t, byId.get(t.account))),
    on: [...(p.on ?? [])].sort(),
    cost: p.cost ?? null,
    dataRules: { trialEndpoints: p.dataRules?.trialEndpoints ?? "ask" },
    allowRunningBackground: [...(p.allowRunningBackground ?? [])],
  };
  return `sha256:${sha(canon)}`;
}

/** Each target's own part of the hash, so a refusal can name the account that changed. */
export function consentParts(p, accounts = []) {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return Object.fromEntries((p.targets ?? []).map((t) => [targetKey(t), sha(tupleOf(t, byId.get(t.account))).slice(0, 16)]));
}

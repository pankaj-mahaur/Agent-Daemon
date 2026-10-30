// Which account and model a conversation runs on (P3.4), resolved before any engine
// starts, and which engine serves it. No engine imports.
//
//   resolveTarget({ explicit, window, env, project, projectTrusted, doc, legacyConfig })
//     → { account, model, effort, source, notes }   (account null: nothing names one, and
//       3.0's default home has no account yet: start as 3.0 did)
//   engineIdFor(account, doc)        "api" | the account id (an account home: ChatGPT, or an
//                                    OpenAI key the default engine keeps)
//   engineParamsFor(target, doc)     → { engineId, modelProvider, model, effort }
//   engineHomeFor(engineId, doc)     "@default" | "api" | { account home } (P3.7)
//   accountForProviderId(doc, id)    a thread's provider entry → its account
//   targetKey(target)                "<accountId>/<provider>/<model|->/<effort|->" (P4.1)
//
// Precedence, highest first: 1 a flag or command (--account/--model, /model, /account);
// 2 this window's choice; 3 AD_ACCOUNT/AD_MODEL (a launch default); 4 the project's
// selector (.agent-daemon/config.json `target`), only in a folder the user trusted;
// 5 the registry's default target; 6 3.0 behaviour (the default home's model_provider).
// The level that names the account also bounds the model: a model from a lower level
// was meant for another account. A target is captured when a thread starts (D08).

import { findAccount } from "./registry.mjs";
import { providerName } from "../../providers/registry.mjs";

// Display names come from the provider registry (P3.5); ChatGPT accounts are "ChatGPT".
const DISPLAY_OVERRIDES = { openai: "OpenAI", chatgpt: "ChatGPT" };
export const providerDisplay = (id) => DISPLAY_OVERRIDES[id] ?? providerName(id);

/** "OpenRouter · work" */
export const accountName = (a) => `${providerDisplay(a.provider)} · ${a.label}`;

export const TARGET_TEXTS = Object.freeze({
  TARGET_NOT_READY: (a) =>
    a.status === "needs-sign-in"
      ? `ad auth: ${accountName(a)} needs ${a.method === "api-key" ? "its key" : "a sign-in"} again: ad auth login ${a.provider}${a.method === "openrouter-oauth" ? " --oauth" : ""} --label ${a.label}`
      : `ad auth: ${accountName(a)} isn't ready (${a.status}). See: ad auth status`,
  PROJECT_PICKS: (a) => `This project picks ${accountName(a)} (.agent-daemon/config.json).`,
  ACCOUNT_IGNORED: (source, ref, why) => `ad ignored ${source === "env" ? "AD_ACCOUNT" : "this window's account"} ${JSON.stringify(ref)}: ${why}`,
  PROJECT_IGNORED: (why) => `ad ignored this project's account choice (.agent-daemon/config.json): ${why}.`,
});

const SELECTOR_KEYS = new Set(["provider", "label", "model", "effort"]);
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

// A project selector: only the user's own ready accounts match, only known fields.
function projectLevel(project, doc, notes) {
  if (!project || typeof project !== "object") return null;
  const extra = Object.keys(project).filter((k) => !SELECTOR_KEYS.has(k));
  if (extra.length) {
    notes.push({ code: "PROJECT_IGNORED", text: TARGET_TEXTS.PROJECT_IGNORED(`it may only name provider, label, model and effort (not ${extra.join(", ")})`) });
    return null;
  }
  const provider = str(project.provider)?.toLowerCase();
  const label = str(project.label)?.toLowerCase();
  if (!provider) return { model: str(project.model), effort: str(project.effort) };
  const a = (doc.accounts ?? []).find((x) => x.provider === provider && (label === undefined || String(x.label).toLowerCase() === label) && x.status === "ready");
  if (!a) {
    notes.push({ code: "PROJECT_IGNORED", text: TARGET_TEXTS.PROJECT_IGNORED(`no ready account matches ${provider}${label ? `/${label}` : ""}`) });
    return null;
  }
  notes.push({ code: "PROJECT_PICKS", text: TARGET_TEXTS.PROJECT_PICKS(a) });
  return { account: a, model: str(project.model), effort: str(project.effort) };
}

function legacyAccount(doc, legacyConfig) {
  const byFrom = (from) => (doc.accounts ?? []).find((a) => a.migratedFrom === from);
  if (legacyConfig?.model_provider === "openrouter") return byFrom("3.0-openrouter") ?? null;
  return byFrom("3.0-default-home") ?? null;
}

/**
 * @param {{ explicit?: { account?: string, model?: string, effort?: string },
 *   window?: { account?: string, model?: string, effort?: string },
 *   env?: Record<string, string | undefined>, project?: any, projectTrusted?: boolean,
 *   doc: any, legacyConfig?: any }} o
 */
export function resolveTarget({ explicit = {}, window = {}, env = {}, project = null, projectTrusted = false, doc, legacyConfig = null }) {
  const notes = [];
  // A flag naming no account is the user's error; a launch default or a window's choice
  // that no longer matches (removed, renamed) is skipped with a note.
  const lenient = (r, source) => {
    if (str(r) === undefined) return undefined;
    try {
      return findAccount(doc, str(r));
    } catch (e) {
      if (e.code !== "ACCOUNT_NOT_FOUND" && e.code !== "ACCOUNT_AMBIGUOUS") throw e;
      notes.push({ code: "ACCOUNT_IGNORED", text: TARGET_TEXTS.ACCOUNT_IGNORED(source, str(r), e.message) });
      return null;
    }
  };
  const level = (source, account, model, effort) => (account === null ? { source } : { source, account, model, effort });
  // Levels are read top-down and only until one names the account: a lower level is
  // never looked at (and can't fail) once a higher one decides.
  const levels = [
    () => level("flag", str(explicit?.account) === undefined ? undefined : findAccount(doc, str(explicit.account)), str(explicit?.model), str(explicit?.effort)),
    () => level("window", lenient(window?.account, "window"), str(window?.model), str(window?.effort)),
    () => level("env", lenient(env?.AD_ACCOUNT, "env"), str(env?.AD_MODEL), undefined),
    // The trust gate: a selector in a folder the user hasn't trusted is never read.
    () => {
      const sel = projectTrusted ? projectLevel(project, doc, notes) : null;
      return sel ? { source: "project", ...sel } : null;
    },
    () => {
      const t = doc.defaults?.target;
      return t ? { source: "global", account: t.account ? (doc.accounts ?? []).find((a) => a.id === t.account) : undefined, model: str(t.model), effort: str(t.effort) } : null;
    },
    () => {
      const legacy = legacyAccount(doc, legacyConfig);
      return { source: "legacy", account: legacy ?? undefined, model: legacy ? str(legacyConfig?.model) : undefined, effort: undefined };
    },
  ];
  const seen = [];
  let won = null;
  for (const read of levels) {
    const l = read();
    if (!l) continue;
    seen.push(l);
    if (l.account) {
      won = l;
      break;
    }
  }
  const pick = (k) => seen.find((l) => l[k] !== undefined)?.[k];
  const account = won?.account ?? null;
  if (account && account.status !== "ready") throw fail("TARGET_NOT_READY", TARGET_TEXTS.TARGET_NOT_READY(account), { account });
  return { account, model: pick("model") ?? account?.defaultModel ?? undefined, effort: pick("effort"), source: won?.source ?? "legacy", notes };
}

/** The account keeps its own engine home (a sign-in or key the engine holds). */
const ownsHome = (a) => a?.method === "engine-login" || a?.credential?.kind === "engine-home";

export function engineIdFor(account) {
  return ownsHome(account) ? account.id : "api";
}

/** Where an engine runs: "@default" (the default home), "api" (<root>/api) or an account home. */
export function engineHomeFor(engineId, doc) {
  // Not known yet (no engine on the default home has said who is signed in there): api/,
  // so new API work never starts next to a ChatGPT sign-in (D15).
  if (engineId === "api") return doc.engines?.api?.home ?? "api";
  const a = (doc.accounts ?? []).find((x) => x.id === engineId);
  return a?.credential?.home ?? "@default";
}

export function engineParamsFor(target, doc) {
  const a = target.account;
  const engineId = a ? engineIdFor(a, doc) : "api";
  // An account home signs in with the engine's built-in "openai" provider (ChatGPT or a key
  // the engine keeps); an API account is its gateway entry. Always explicit: a home may
  // also carry a default provider (-c model_provider) for another account.
  const modelProvider = !a ? undefined : ownsHome(a) ? "openai" : a.providerEntry ?? undefined;
  return { engineId, modelProvider, model: target.model, effort: target.effort };
}

/** A thread's provider entry → its account (3.0's "openrouter" → the adopted key; "openai" → @default). */
export function accountForProviderId(doc, providerId) {
  const all = doc.accounts ?? [];
  const byEntry = all.find((a) => a.providerEntry && a.providerEntry === providerId);
  if (byEntry) return byEntry;
  if (providerId === "openrouter") return all.find((a) => a.migratedFrom === "3.0-openrouter") ?? null;
  if (providerId === "openai") return all.find((a) => a.migratedFrom === "3.0-default-home") ?? null;
  return null;
}

/** A stable key for a target: ids, never labels, so it survives a rename. */
export function targetKey(target) {
  const a = target.account;
  return `${a?.id ?? "-"}/${a?.provider ?? "-"}/${target.model ?? "-"}/${target.effort ?? "-"}`;
}

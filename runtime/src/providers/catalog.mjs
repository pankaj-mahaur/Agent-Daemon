// What each account's models can do and cost (P4.3), as last seen: ~/.agent-daemon/catalog/
// <accountId>.json, a cache filled on demand (never polled), at most once per 10 minutes per
// account. Unknown stays unknown: a price, a tool flag or a free flag nobody observed is null.
//
//   refresh(account, { key, preset, fetch, now, force }) → { accountId, observedAt, entries }
//   readCatalog(accountId) → that, or null
//   entriesFrom(account, json, { preset, now }) → [CatalogEntry]   (pure)
//   priceOf(pricing, observedAt) → price | null     freeOf(price, { now, billing, id }) → free
//   familyOf(modelId)   eligibility({ entry, account }, policy, { now }) → { eligible, reasons }
//
// Free (D12): every price field present is an exact zero, observed under 24 h ago, or the
// server is local. A ":free" id alone is only a hint (null). A subscription is never free.

import fs from "node:fs";
import path from "node:path";
import { adRoot } from "../ad-root.mjs";
import { writeJsonAtomicSync } from "../atomic-json.mjs";
import { providerRequest } from "./http.mjs";
import { presetFor } from "./registry.mjs";
import { benchKey, benchedUntil, limitState } from "./quota.mjs";
import { today } from "./spend.mjs";

export const FRESH_MS = 24 * 60 * 60_000;
const REFRESH_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 5000;

const dirOf = (root) => path.join(root, "catalog");
const fileOf = (root, id) => path.join(dirOf(root), `${String(id).replace(/[^\w.-]/g, "_")}.json`);
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// A price field: a numeric string (or number) → its value; anything else → NaN (unknown).
const NUMERIC = /^\s*\d+(\.\d+)?(e-?\d+)?\s*$/i;
const field = (v) => (v === undefined || v === null || v === "" ? undefined : typeof v === "number" || (typeof v === "string" && NUMERIC.test(v)) ? String(v).trim() : "?");

/** A provider's pricing ({ prompt, completion, request }) as ad keeps it, or null. */
export function priceOf(pricing, observedAt, source = "provider") {
  if (!pricing || typeof pricing !== "object") return null;
  const input = field(pricing.prompt ?? pricing.input);
  const output = field(pricing.completion ?? pricing.output);
  const request = field(pricing.request);
  if (input === undefined && output === undefined) return null;
  return { input: input ?? null, output: output ?? null, request: request ?? null, currency: "USD", source, observedAt: iso(observedAt) };
}

export function freeOf(price, { now = Date.now(), billing = "unknown", id = "" } = {}) {
  if (billing === "local") return { value: true, basis: "local", observedAt: null };
  if (billing === "subscription") return { value: false, basis: null, observedAt: null };
  if (!price) return { value: null, basis: null, observedAt: null }; // ":free" in the id is only a hint
  // Both prices, both numbers: anything else is unknown (a missing output price isn't zero).
  if (typeof price.input !== "string" || typeof price.output !== "string") return { value: null, basis: null, observedAt: price.observedAt };
  const fields = [price.input, price.output, price.request].filter((v) => v !== null && v !== undefined);
  if (fields.some((v) => typeof v !== "string" || !NUMERIC.test(v))) return { value: null, basis: null, observedAt: price.observedAt };
  const zero = fields.length > 0 && fields.every((v) => Number(v) === 0);
  if (!zero) return { value: false, basis: null, observedAt: price.observedAt };
  const at = Date.parse(price.observedAt ?? "");
  if (!Number.isFinite(at) || now - at >= FRESH_MS) return { value: null, basis: null, observedAt: price.observedAt }; // a stale zero
  void id;
  return { value: true, basis: "zeroPrice", observedAt: price.observedAt };
}

/** "qwen/qwen3-coder:free" → "qwen"; "gpt-5" → "gpt"; "gemini-2.5-pro" → "gemini". */
export function familyOf(id) {
  const s = String(id ?? "").toLowerCase();
  const tail = s.includes("/") ? s.split("/").pop() : s;
  const m = /^([a-z]+)/.exec(tail.replace(/^models\//, ""));
  if (!m) return null;
  const f = m[1];
  if (f === "o" || /^o\d/.test(tail)) return "gpt"; // o3, o4-mini: OpenAI's reasoning line
  if (f === "chatgpt") return "gpt";
  return f;
}

const routeOf = (account, preset) => (account.method === "engine-login" || account.credential?.kind === "engine-home" ? "engine" : preset?.mode && preset.mode !== "passthrough" && preset.mode !== "per-model" ? "bridged" : "direct");
const billingOf = (account, preset) => (preset?.local ? "local" : account.method === "engine-login" || account.credential?.kind === "engine-home" ? "subscription" : preset?.billing ?? "metered");

export function entriesFrom(account, json, { preset = presetFor(account.provider), now = Date.now() } = {}) {
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models.map((x) => ({ ...x, id: String(x?.name ?? "").replace(/^models\//, ""), name: x?.displayName })) : Array.isArray(json) ? json : [];
  const route = routeOf(account, preset);
  const billing = billingOf(account, preset);
  return rows
    .filter((m) => m && typeof m.id === "string")
    .map((m) => {
      const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : null;
      const modalities = Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities : null;
      const price = priceOf(m.pricing, now);
      const ctx = Number(m.context_length ?? m.inputTokenLimit ?? preset?.contextWindows?.[m.id]) || null;
      return {
        accountId: account.id,
        provider: account.provider,
        model: m.id,
        displayName: typeof m.name === "string" ? m.name : m.id,
        family: familyOf(m.id),
        route,
        caps: {
          tools: params ? params.includes("tools") : null,
          images: modalities ? modalities.includes("image") : null,
          reasoning: params ? params.includes("reasoning") || params.includes("include_reasoning") : null,
          efforts: null,
          contextWindow: ctx,
          structuredHistory: preset?.structuredHistory ?? null,
          callIdPattern: null,
          usageReported: preset?.usageReported ?? null,
        },
        price,
        free: freeOf(price, { now, billing, id: m.id }),
        billing,
        data: { trial: preset?.privacy?.trial ?? null, trainsOnData: preset?.privacy?.trainsOnData ?? null, note: preset?.privacy?.notice ?? null, source: preset?.privacy ? `preset ${preset.id}` : null },
        observedAt: iso(now),
        source: "provider /models",
      };
    });
}

export const catalogFile = (accountId, { root = adRoot() } = {}) => fileOf(root, accountId);

export function readCatalog(accountId, { root = adRoot() } = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(root, accountId), "utf8"));
    return j && Array.isArray(j.entries) ? j : null;
  } catch {
    return null;
  }
}

/** On demand: the account's model list from the provider (never through the engine). */
export async function refresh(account, { key = null, preset = presetFor(account.provider), fetch, clientVersion, now = Date.now(), force = false, root = adRoot() } = {}) {
  const prev = readCatalog(account.id, { root });
  const seen = Date.parse(prev?.observedAt ?? "");
  if (prev && !force && Number.isFinite(seen) && now - seen < REFRESH_MS) return prev;
  const base = account.endpoint ?? preset.upstreamBase;
  const url = account.endpoint ? `${base}${preset.modelsPath}` : (preset.modelsUrl ?? `${base}${preset.modelsPath}`);
  // Only the provider's own host, no redirect (a key never follows one), 5 s.
  const r = await providerRequest({ url, key: preset.auth === "none" ? null : key, keyHeader: preset.authHeader ?? null, headers: { ...(preset.headers ?? {}) }, fetch, clientVersion, timeoutMs: PROBE_TIMEOUT_MS, insecure: Boolean(account.insecure) });
  if (r.status !== 200) throw Object.assign(new Error(`The provider answered HTTP ${r.status} for its model list.`), { code: "MODELS_FAILED", status: r.status });
  const doc = { v: 1, accountId: account.id, observedAt: iso(now), entries: entriesFrom(account, r.json, { preset, now }) };
  fs.mkdirSync(dirOf(root), { recursive: true, mode: 0o700 });
  writeJsonAtomicSync(fileOf(root, account.id), doc);
  return doc;
}

/**
 * Whether a target may take work automatically (P4.4/P4.5). policy: { freeOnly, allowPaid
 * (default true), dailyBudgetUsd, needTools (default true), minContext, trialConsent }.
 * A price, a free flag or a limit nobody observed never counts as fine where the policy
 * depends on it; unknown tools or context don't block (only a provider saying "no" does).
 */
export function eligibility({ entry, account }, policy = {}, { now = Date.now(), root = adRoot() } = {}) {
  const reasons = [];
  if (account?.status === "needs-sign-in") reasons.push("account-needs-sign-in");
  else if (account?.status && account.status !== "ready") reasons.push("account-disabled");
  if (!entry) {
    reasons.push("model-not-listed");
    return { eligible: false, reasons };
  }
  const needTools = policy.needTools !== false;
  if (needTools && entry.caps?.tools === false) reasons.push("no-tools");
  if (policy.minContext && entry.caps?.contextWindow && entry.caps.contextWindow < policy.minContext) reasons.push("context-too-small");
  // Free as of now, not as of the fetch: a zero ages out after 24 h.
  const free = entry.billing === "local" || entry.billing === "subscription" || entry.price ? freeOf(entry.price, { now, billing: entry.billing }) : (entry.free ?? { value: null });
  const zeroButStale = free.value === null && entry.price && [entry.price.input, entry.price.output].every((v) => typeof v === "string" && NUMERIC.test(v) && Number(v) === 0);
  if (policy.freeOnly) {
    if (free.value === false) reasons.push("not-free");
    else if (free.value === null) reasons.push(zeroButStale ? "price-stale" : "price-unknown");
  } else if (policy.allowPaid === false && free.value !== true) {
    reasons.push(free.value === false ? "paid-not-allowed" : zeroButStale ? "price-stale" : "price-unknown");
  }
  if ((policy.freeOnly || policy.dailyBudgetUsd != null) && entry.billing === "unknown") reasons.push("unknown-billing");
  if (policy.dailyBudgetUsd != null && free.value !== true && entry.billing === "metered") {
    const t = today(entry.accountId, { now, root });
    if (t.usd >= policy.dailyBudgetUsd) reasons.push("budget-reached");
    else if (t.unpriced > 0 || !entry.price) reasons.push("usage-unknown-under-budget");
  }
  const limit = limitState(entry.accountId, { now, root });
  if (limit === "exhausted") reasons.push("quota-exhausted-until");
  else if (limit === "limited") reasons.push("rate-limited-until");
  if (benchedUntil(benchKey(entry.provider, entry.accountId), { now, root })) reasons.push("provider-benched-until");
  if (entry.data?.trial === true && !policy.trialConsent) reasons.push("trial-endpoint-no-consent");
  return { eligible: reasons.length === 0, reasons };
}

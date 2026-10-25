// An account's models (P3.5), from ad's own GET {upstream}/models (never through the engine),
// cached 10 minutes in memory.
//
//   listModels(account, { key, preset, fetch, now, clientVersion, refresh })
//     → [{ id, name, free, local, priceObservedAt, dataNote }]
//   isFree(model, { observedAt, now })   only from a fresh price (D12): an OpenRouter
//     /models answer under 24 hours old with prompt and completion priced "0". A ":free"
//     id alone never counts.

import { presetFor } from "./registry.mjs";
import { providerRequest } from "./http.mjs";

export const FREE_TTL_MS = 24 * 60 * 60_000;
const CACHE_MS = 10 * 60_000;
// Wording checked against OpenRouter's free-model docs at execution (unverified today).
export const FREE_DATA_NOTE = "Free models may log or train on prompts, depending on the provider behind them.";
export const COMING_LATER = "not available in ad yet (coming later)";

const cache = new Map(); // accountId → { at, models }

export function isFree(model, { observedAt, now = Date.now() } = {}) {
  if (!observedAt || now - observedAt >= FREE_TTL_MS) return false;
  const p = model?.pricing;
  const zero = (v) => (typeof v === "string" || typeof v === "number") && Number(v) === 0 && String(v).trim() !== "";
  return Boolean(p) && zero(p.prompt) && zero(p.completion);
}

export async function listModels(account, { key = null, preset = presetFor(account.provider), fetch, now = () => Date.now(), clientVersion, refresh = false } = {}) {
  const hit = cache.get(account.id);
  if (!refresh && hit && now() - hit.at < CACHE_MS) return hit.models;
  const base = account.endpoint ?? preset.upstreamBase;
  const url = account.endpoint ? `${base}${preset.modelsPath}` : (preset.modelsUrl ?? `${base}${preset.modelsPath}`);
  const r = await providerRequest({ url, key: preset.auth === "none" ? null : key, fetch, clientVersion, insecure: Boolean(account.insecure) });
  if (r.status !== 200) throw Object.assign(new Error(`The provider answered HTTP ${r.status} for its model list.`), { code: "MODELS_FAILED", status: r.status });
  const observedAt = now();
  const rows = Array.isArray(r.json?.data) ? r.json.data : Array.isArray(r.json) ? r.json : [];
  const models = rows
    .filter((m) => m && typeof m.id === "string")
    .map((m) => {
      const free = preset.freeSource === "openrouter-pricing" ? isFree(m, { observedAt, now: observedAt }) : false;
      // A per-model provider (OpenCode Go): each model's wire from the preset's dated table;
      // one ad can't speak yet (messages, gemini) is listed as coming later, not offered.
      const wire = preset.wires ? (preset.wires[m.id] ?? "unknown") : null;
      const later = wire === "messages" || wire === "gemini";
      return {
        id: m.id,
        name: typeof m.name === "string" ? m.name : m.id,
        free,
        local: Boolean(preset.local),
        priceObservedAt: preset.freeSource ? observedAt : null,
        dataNote: later ? COMING_LATER : free ? FREE_DATA_NOTE : null,
        ...(wire ? { wire, observedAt, available: !later } : {}),
      };
    });
  cache.set(account.id, { at: observedAt, models });
  return models;
}

/** Tests: forget the cached lists. */
export const clearModelCache = () => cache.clear();

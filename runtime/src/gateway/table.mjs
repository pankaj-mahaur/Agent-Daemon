// What the gateway routes and what the engine gets (P3.3).
//
//   gatewayTable(doc, { presets })   ready API accounts → Map<providerEntry, route>
//   engineProviderArgs(table, { gateway, doc })  → ["-c", "model_providers.<entry>={…}", …]:
//                                    one entry per account, plus the 3.0 alias
//                                    `openrouter` → the adopted account's route, so 3.0
//                                    conversations resume through the gateway
//   apiEngineArgs(doc, table)        the api engine only (P3.4): default target and retry
//                                    settings; a ChatGPT engine never gets them
//   engineEnvFor({ gateway, env })   → { AD_GATEWAY_TOKEN, NO_PROXY, no_proxy }: never a key
// Nothing here is written to config.toml: the port changes every run.

import { createRequire } from "node:module";
import { PROVIDER_PRESETS, providerName } from "../providers/registry.mjs";

// ad's own User-Agent, for providers that ask each client to name itself (OpenCode Go):
// never the engine's, never another product's.
const AD_UA = `ad/${createRequire(import.meta.url)("../../package.json").version}`;

// The provider registry's presets (P3.5), as the gateway needs them: name and upstream.
// A custom endpoint has no preset base: its account's endpoint is used.
// A translated preset (mode "chat", P6.1) also brings its upstream path, quirks and model
// capabilities; headers it requires go on every request.
export const PRESETS = Object.freeze(
  Object.fromEntries(
    PROVIDER_PRESETS.filter((p) => p.upstreamBase).map((p) => [
      p.id,
      Object.freeze({ name: p.name, baseUrl: p.upstreamBase, mode: p.mode, upstreamPath: p.upstreamPath, quirks: p.quirks ?? [], model: p.capabilities ?? null, headers: { ...(p.headers ?? {}), ...(p.ownUserAgent ? { "user-agent": AD_UA } : {}) }, wires: p.wires ?? null, modelQuirks: p.modelQuirks ?? null, contextWindows: p.contextWindows ?? null, compactCap: p.compactCap ?? null, dailyLimitHeaders: p.dailyLimitHeaders ?? null, sessionHeader: p.sessionHeader ?? null, quotaErrors: p.quotaErrors ?? [] }),
    ]),
  ),
);

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;
const toml = (s) => JSON.stringify(String(s));

/** Ready API-key (and keyless local) accounts → routes, keyed by their provider entry. */
export function gatewayTable(doc, { presets = PRESETS } = {}) {
  const table = new Map();
  for (const a of doc.accounts ?? []) {
    if (a.status !== "ready" || !a.providerEntry) continue;
    // A key from OpenRouter's own sign-in is an ordinary OpenRouter key.
    if (!["api-key", "openrouter-oauth", "none"].includes(a.method)) continue;
    const preset = presets[a.provider];
    const upstreamBase = a.endpoint ?? preset?.baseUrl;
    if (!upstreamBase) continue;
    // A custom endpoint that speaks only Chat Completions (its sign-in found it) is translated.
    const mode = a.provider === "custom" && a.wire === "chat" ? "chat" : (preset?.mode ?? "passthrough");
    table.set(a.providerEntry, {
      accountId: a.id,
      provider: a.provider,
      upstreamBase,
      mode,
      ...(mode === "passthrough" ? {} : { upstreamPath: a.wire === "chat" ? "/chat/completions" : preset.upstreamPath, quirks: [...(preset?.quirks ?? [])], model: preset?.model ?? {} }),
      ...(mode === "per-model" ? { wires: { ...(preset.wires ?? {}) }, modelQuirks: Object.fromEntries(Object.entries(preset.modelQuirks ?? {}).map(([k, v]) => [k, [...v]])) } : {}),
      ...(preset?.contextWindows ? { contextWindows: { ...preset.contextWindows } } : {}),
      ...(preset?.compactCap ? { compactCap: preset.compactCap } : {}),
      ...(preset?.dailyLimitHeaders ? { dailyLimitHeaders: [...preset.dailyLimitHeaders] } : {}),
      ...(preset?.sessionHeader ? { sessionHeader: preset.sessionHeader } : {}),
      ...(preset?.quotaErrors?.length ? { quotaErrors: [...preset.quotaErrors] } : {}),
      auth: a.method === "none" ? { kind: "none" } : { kind: "static-key", scheme: "bearer" },
      headers: { ...(preset?.headers ?? {}) },
      strip: [],
      label: preset?.name ?? providerName(a.provider),
      allowHttp: LOOPBACK.test(upstreamBase) || Boolean(a.insecure),
      displayName: `${preset?.name ?? providerName(a.provider)} · ${a.label}`,
    });
  }
  return table;
}

const providerEntry = (name, display, baseUrl) => `model_providers.${name}={ name = ${toml(display)}, base_url = ${toml(baseUrl)}, env_key = "AD_GATEWAY_TOKEN", wire_api = "responses", supports_websockets = false, request_max_retries = 1, stream_max_retries = 1 }`;

export function engineProviderArgs(table, { gateway, doc = null } = {}) {
  const args = [];
  for (const [entry, r] of table) args.push("-c", providerEntry(entry, r.displayName ?? r.label, gateway.baseUrlFor(entry)));
  // 3.0 conversations used the provider name `openrouter`: point it at the adopted account.
  const adopted = doc?.accounts?.find((a) => a.migratedFrom === "3.0-openrouter" && a.providerEntry && table.has(a.providerEntry));
  if (adopted) args.push("-c", providerEntry("openrouter", `OpenRouter · ${adopted.label}`, gateway.baseUrlFor(adopted.providerEntry)));
  return args;
}

/** The api engine only: threads without a provider go through the gateway; no endless retries. */
export function apiEngineArgs(doc, table) {
  const args = ["-c", "features.unbounded_connection_retries=false"];
  const t = doc?.defaults?.target;
  const acct = t?.account && doc.accounts.find((a) => a.id === t.account);
  if (acct?.providerEntry && table.has(acct.providerEntry)) {
    args.push("-c", `model_provider=${toml(acct.providerEntry)}`);
    const model = t.model ?? acct.defaultModel;
    if (model) {
      args.push("-c", `model=${toml(model)}`);
      // Threads started on this default without naming a model still get its window.
      const w = threadConfigFor(table, { model, modelProvider: acct.providerEntry });
      if (w) args.push("-c", `model_context_window=${w.model_context_window}`, "-c", `model_auto_compact_token_limit=${w.model_auto_compact_token_limit}`);
    }
  }
  return args;
}

// The token lets anything holding it spend the accounts' quota through the gateway: the
// engine needs it, the commands it runs don't. Merged into the user's own
// shell_environment_policy (a `set` entry), never replacing it.
export const TOKEN_HIDDEN_ARGS = Object.freeze(["-c", 'shell_environment_policy.set.AD_GATEWAY_TOKEN=""']);

/**
 * A thread's config for its model on a route ad translates for (P6.2): the model's context
 * window, so the engine compacts before the provider's limit (it would assume 272K for a
 * slug it doesn't know). Null for passthrough routes and models without a known window.
 */
export function threadConfigFor(table, { model, modelProvider } = {}) {
  const r = modelProvider ? table?.get(modelProvider) : null;
  const w = r && model ? r.contextWindows?.[model] : null;
  if (!Number.isInteger(w) || w <= 0) return null;
  // A provider whose per-minute token limit is far below the window (Gemini's free tier)
  // caps when the engine compacts, so one turn never needs more than a minute's tokens.
  const at = Math.floor(w * 0.8);
  return { model_context_window: w, model_auto_compact_token_limit: Number.isInteger(r.compactCap) ? Math.min(at, r.compactCap) : at };
}

export function engineEnvFor({ gateway, env = process.env }) {
  const add = (v) => {
    const parts = String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    for (const h of ["127.0.0.1", "localhost"]) if (!parts.includes(h)) parts.push(h);
    return parts.join(",");
  };
  const np = add(env.NO_PROXY ?? env.no_proxy);
  return { AD_GATEWAY_TOKEN: gateway.token, NO_PROXY: np, no_proxy: np };
}

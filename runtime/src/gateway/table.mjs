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

export const PRESETS = Object.freeze({
  openrouter: { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  openai: { name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
});

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;
const toml = (s) => JSON.stringify(String(s));

/** Ready API-key (and keyless local) accounts → routes, keyed by their provider entry. */
export function gatewayTable(doc, { presets = PRESETS } = {}) {
  const table = new Map();
  for (const a of doc.accounts ?? []) {
    if (a.status !== "ready" || !a.providerEntry) continue;
    if (!["api-key", "none"].includes(a.method)) continue;
    const preset = presets[a.provider];
    const upstreamBase = a.endpoint ?? preset?.baseUrl;
    if (!upstreamBase) continue;
    table.set(a.providerEntry, {
      accountId: a.id,
      upstreamBase,
      mode: "passthrough",
      auth: a.method === "none" ? { kind: "none" } : { kind: "static-key", scheme: "bearer" },
      headers: {},
      strip: [],
      label: preset?.name ?? a.provider,
      allowHttp: LOOPBACK.test(upstreamBase) || Boolean(a.insecure),
      displayName: `${preset?.name ?? a.provider} · ${a.label}`,
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
    if (t.model ?? acct.defaultModel) args.push("-c", `model=${toml(t.model ?? acct.defaultModel)}`);
  }
  return args;
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

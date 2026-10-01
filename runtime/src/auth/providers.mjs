// Model providers the harness can run Codex against.
//
//   openai      built into Codex. Auth = ChatGPT login or OpenAI API key,
//               both owned by Codex (tokens live in the harness CODEX_HOME).
//   openrouter  Responses-API endpoint (beta, stateless) — reaches Claude,
//               Gemini and others with one key. Key lives in our secret
//               store and is injected as an env var at spawn; config.toml
//               only names the variable.

import { createSecretStore } from "./secrets.mjs";

export const PROVIDERS = {
  openai: {
    id: "openai",
    label: "OpenAI (ChatGPT login or API key)",
    builtIn: true,
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter (Claude, Gemini, … via one key)",
    secret: "openrouter",
    envKey: "OPENROUTER_API_KEY",
    requiresModel: true,
    codexConfig: {
      name: "OpenRouter",
      base_url: "https://openrouter.ai/api/v1",
      env_key: "OPENROUTER_API_KEY",
      wire_api: "responses",
      supports_websockets: false,
    },
  },
};

// Env vars carrying stored provider keys, for the Codex child process.
// A secret that can't be read (corrupt, other user's DPAPI blob) is skipped
// with a warning — it must not block runs that don't need it.
export function providerEnv(store = createSecretStore(), warn = (m) => process.stderr.write(`[agent-daemon] ${m}\n`)) {
  const env = {};
  for (const p of Object.values(PROVIDERS)) {
    if (!p.secret) continue;
    try {
      const value = store.get(p.secret);
      if (value) env[p.envKey] = value;
    } catch (err) {
      warn(`could not read stored ${p.id} key (${err.message.split("\n")[0]}); re-add it with: ad auth login ${p.id} --model <slug>`);
    }
  }
  return env;
}

// Env var names Codex must strip from the agent's shell commands. Codex
// keeps *KEY*/*SECRET*/*TOKEN* vars by default (ignore_default_excludes =
// true), so without this a prompt-injected `printenv` would leak the key.
export const PROVIDER_ENV_KEYS = Object.values(PROVIDERS).filter((p) => p.envKey).map((p) => p.envKey);

// Config edits that make `provider` the active one.
export function useProviderEdits(providerId, { model } = {}) {
  const p = PROVIDERS[providerId];
  if (!p) throw new Error(`unknown provider: ${providerId} (known: ${Object.keys(PROVIDERS).join(", ")})`);
  if (p.requiresModel && !model) throw new Error(`${providerId} needs --model <slug> (e.g. the model id shown on openrouter.ai)`);
  const edits = [];
  if (p.codexConfig) edits.push([`model_providers.${p.id}`, p.codexConfig]);
  if (p.envKey) edits.push([`shell_environment_policy.filters.${p.envKey}`, "exclude"]);
  edits.push(["model_provider", p.id]);
  // A model id is provider-specific; a stale one from the other provider
  // would fail every turn, so clear it unless a new one is given.
  edits.push(["model", model ?? null]);
  return edits;
}

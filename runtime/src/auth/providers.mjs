// Model providers the harness can run the engine against.
//
//   openai      built into the engine. Auth = ChatGPT login or OpenAI API key,
//               both owned by the engine (tokens live in the engine home).
//   openrouter  Responses-API endpoint (beta, stateless) — reaches Claude,
//               Gemini and others with one key. Key lives in our secret
//               store; ad's gateway adds it on the way out (P3.3).

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
    engineConfig: {
      name: "OpenRouter",
      base_url: "https://openrouter.ai/api/v1",
      env_key: "OPENROUTER_API_KEY",
      wire_api: "responses",
      supports_websockets: false,
    },
  },
};

// Keys never go into an engine's environment (P3.3): ad's gateway adds them on the way
// out (gateway/), and the engine holds only a per-run token.

// Config edits that make `provider` the active one.
export function useProviderEdits(providerId, { model } = {}) {
  const p = PROVIDERS[providerId];
  if (!p) throw new Error(`unknown provider: ${providerId} (known: ${Object.keys(PROVIDERS).join(", ")})`);
  if (p.requiresModel && !model) throw new Error(`${providerId} needs --model <slug> (e.g. the model id shown on openrouter.ai)`);
  const edits = [];
  if (p.engineConfig) edits.push([`model_providers.${p.id}`, p.engineConfig]);
  if (p.envKey) edits.push([`shell_environment_policy.filters.${p.envKey}`, "exclude"]);
  edits.push(["model_provider", p.id]);
  // A model id is provider-specific; a stale one from the other provider
  // would fail every turn, so clear it unless a new one is given.
  edits.push(["model", model ?? null]);
  return edits;
}

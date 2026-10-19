// The providers ad can add accounts for (P3.5, wave 1): data, routed through ad's gateway
// (P3.3). Every wave-1 preset speaks the Responses API as is (mode "passthrough").
//
//   PROVIDER_PRESETS            the presets (fields below)
//   presetFor(id)               a preset, or UNKNOWN_PROVIDER listing the ids
//   signInMethods(id)           methods of a supported or experimental preset ([] otherwise)
//   visiblePresets({ env })     what pickers and `ad auth login --help` list: supported and
//                               experimental; candidates only with AD_SHOW_CANDIDATES=1
//   UNAVAILABLE                 sign-ins ad doesn't offer, each with the open alternative
//
// Preset: { id, name, methods, upstreamBase, upstreamPath, mode, auth: "bearer"|"none",
//   keyTest: "models"|"key-endpoint"|"probe"|"none", modelsPath, freeSource, headers, strip,
//   models: { contextWindow }, local, status: "candidate"|"experimental"|"supported"|"blocked",
//   acceptance: null | "<record path>", docs: [urls], checkedAt: "YYYY-MM-DD" }
// "supported" needs an acceptance record (scripts/provider-accept.mjs on a real key);
// "experimental" means mock contract tests plus one real task with known gaps.

const preset = (p) =>
  Object.freeze({
    upstreamPath: "/responses",
    mode: "passthrough",
    auth: "bearer",
    keyTest: "models",
    modelsPath: "/models",
    freeSource: null,
    headers: Object.freeze({}),
    strip: Object.freeze([]),
    models: Object.freeze({ contextWindow: null }),
    local: false,
    status: "candidate",
    acceptance: null,
    ...p,
    methods: Object.freeze([...p.methods]),
    docs: Object.freeze([...(p.docs ?? [])]),
  });

export const PROVIDER_PRESETS = Object.freeze([
  preset({ id: "openai", name: "OpenAI API", methods: ["api-key"], upstreamBase: "https://api.openai.com/v1", docs: ["https://platform.openai.com/docs/api-reference/responses"], checkedAt: "2026-10-19" }),
  preset({
    id: "openrouter",
    name: "OpenRouter",
    methods: ["api-key", "openrouter-oauth"],
    upstreamBase: "https://openrouter.ai/api/v1",
    // /models is public on OpenRouter: the key is tested on its own endpoint.
    keyTest: "key-endpoint",
    freeSource: "openrouter-pricing",
    docs: ["https://openrouter.ai/docs/api-reference/responses-api/overview", "https://openrouter.ai/docs/use-cases/oauth-pkce"],
    checkedAt: "2026-10-19",
  }),
  preset({ id: "kimi-code", name: "Kimi Code", methods: ["api-key"], upstreamBase: "https://api.kimi.ai/coding/v1", docs: ["https://platform.moonshot.ai/docs"], checkedAt: "2026-10-19" }),
  preset({ id: "moonshot", name: "Moonshot (Kimi API)", methods: ["api-key"], upstreamBase: "https://api.moonshot.ai/v1", docs: ["https://platform.moonshot.ai/docs"], checkedAt: "2026-10-19" }),
  preset({ id: "xai", name: "xAI", methods: ["api-key"], upstreamBase: "https://api.x.ai/v1", docs: ["https://docs.x.ai/docs/api-reference"], checkedAt: "2026-10-19" }),
  preset({ id: "fireworks", name: "Fireworks", methods: ["api-key"], upstreamBase: "https://api.fireworks.ai/inference/v1", docs: ["https://docs.fireworks.ai/api-reference"], checkedAt: "2026-10-19" }),
  // The user's own endpoint: upstreamBase is the account's (endpoint). Its contract tests
  // (mock) are the acceptance: probe asks before spending a token.
  preset({ id: "custom", name: "Your own endpoint", methods: ["api-key", "none"], upstreamBase: null, keyTest: "probe", status: "experimental", docs: [], checkedAt: "2026-10-19" }),
  preset({ id: "ollama", name: "Ollama (local)", methods: ["none"], upstreamBase: "http://localhost:11434/v1", auth: "none", local: true, docs: ["https://github.com/ollama/ollama/blob/main/docs/openai.md"], checkedAt: "2026-10-19" }),
  preset({ id: "lmstudio", name: "LM Studio (local)", methods: ["none"], upstreamBase: "http://localhost:1234/v1", auth: "none", local: true, docs: ["https://lmstudio.ai/docs/app/api/endpoints/openai"], checkedAt: "2026-10-19" }),
]);

const byId = new Map(PROVIDER_PRESETS.map((p) => [p.id, p]));

export const PROVIDER_TEXTS = Object.freeze({
  UNKNOWN_PROVIDER: (id) => `ad doesn't know the provider ${JSON.stringify(id)}. Providers: ${PROVIDER_PRESETS.map((p) => p.id).join(", ")} (and chatgpt).`,
});

export function presetFor(id) {
  const p = byId.get(String(id ?? "").toLowerCase());
  if (!p) throw Object.assign(new Error(PROVIDER_TEXTS.UNKNOWN_PROVIDER(id)), { code: "UNKNOWN_PROVIDER" });
  return p;
}

const listed = (p) => p.status === "supported" || p.status === "experimental";

export function signInMethods(id) {
  const p = byId.get(id);
  return p && listed(p) ? [...p.methods] : [];
}

/** What pickers and help list; a candidate preset only with AD_SHOW_CANDIDATES=1. */
export function visiblePresets({ env = process.env } = {}) {
  return PROVIDER_PRESETS.filter((p) => listed(p) || (env.AD_SHOW_CANDIDATES === "1" && p.status === "candidate"));
}

/** Sign-ins ad doesn't offer (D13, R5.9), each naming what works instead. */
export const UNAVAILABLE = Object.freeze([
  Object.freeze({ id: "claude", text: "Claude Pro/Max sign-in: Anthropic doesn't allow other apps to use it. Claude models work now through OpenRouter; an Anthropic API key comes later." }),
  Object.freeze({ id: "gemini", text: "Gemini CLI sign-in: Google doesn't allow other apps to use it. Gemini models work now through OpenRouter; a Gemini API key comes later." }),
  Object.freeze({ id: "copilot", text: "GitHub Copilot and xAI SuperGrok sign-in: only partner apps may use them. Use an xAI API key." }),
  Object.freeze({ id: "nous", text: "Nous Portal: not available yet (Nous hasn't published a way for other apps to sign in). Hermes models are open: run them with Ollama, or use them through OpenRouter." }),
]);

/** "OpenRouter" for a provider id (an unknown id is shown as is). */
export const providerName = (id) => byId.get(id)?.name ?? (id === "chatgpt" ? "ChatGPT" : id);

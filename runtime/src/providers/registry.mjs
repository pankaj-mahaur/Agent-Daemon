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
//   keyTest: "models"|"key-endpoint"|"probe"|"empty-chat"|"none", modelsPath, freeSource, headers, strip,
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
    // Per-model routing (P3.6): mode "per-model" picks passthrough or chat by each model's
    // wire; an unlisted model is tried on chat. sessionHeader: a stable id per conversation;
    // ownUserAgent: the gateway sends ad/<version> (the provider asked for the client's own).
    wires: null,
    modelQuirks: null,
    // Context windows per model (tokens), dated with the preset: until a catalog observes them.
    contextWindows: null,
    compactCap: null,
    // Response headers holding the provider's daily request counter ("0" left → a daily limit).
    dailyLimitHeaders: null,
    modelsUrl: null,
    sessionHeader: null,
    ownUserAgent: false,
    quotaErrors: Object.freeze([]),
    quirks: Object.freeze([]),
    capabilities: null,
    // The key's own header (Anthropic x-api-key, Gemini x-goog-api-key) instead of a Bearer.
    authHeader: null,
    pickerHint: null,
    // Data terms: trial (development use only), trainsOnData ("no" | "free tier" | "unknown"),
    // notice (asked once at sign-in, before anything is sent).
    privacy: null,
    keyTestModel: null,
    blockedReason: null,
    status: "candidate",
    acceptance: null,
    ...p,
    methods: Object.freeze([...p.methods]),
    docs: Object.freeze([...(p.docs ?? [])]),
  });

// A Chat Completions provider (P6.2): translated by the gateway, checked on 25 Oct 2026.
const chatPreset = (p) => preset({ methods: ["api-key"], mode: "chat", upstreamPath: "/chat/completions", checkedAt: "2026-10-25", ...p });

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
  // OpenCode Go (P3.6): OpenCode's paid plan, open to other coding agents that identify
  // themselves and send x-opencode-session (it refuses requests without it). Its wire per
  // model is OpenCode's own table (docs, checked below); messages and gemini models wait
  // for P6.4. The model list is public, so the key is tested with an empty chat request
  // (401 for a wrong key, no tokens spent).
  preset({
    id: "opencode-go",
    name: "OpenCode Go",
    methods: ["api-key"],
    upstreamBase: "https://opencode.ai/inference/go/openai/v1",
    upstreamPath: "/chat/completions",
    mode: "per-model",
    modelsUrl: "https://opencode.ai/inference/go/v1/models",
    keyTest: "empty-chat",
    sessionHeader: "x-opencode-session",
    ownUserAgent: true,
    quotaErrors: Object.freeze(["GoUsageLimitError"]),
    pickerHint: "OpenCode's paid plan; works in other apps",
    // Chat models take JSON formats and parallel calls; DeepSeek's want their reasoning back.
    capabilities: Object.freeze({ jsonFormat: true, parallelTools: true }),
    modelQuirks: Object.freeze({ "deepseek-v4-pro": Object.freeze(["deepseek"]), "deepseek-v4.1-flash": Object.freeze(["deepseek"]) }),
    wires: Object.freeze({
      "grok-4.7": "responses", "gpt-6-luna": "responses", "gpt-5.6-luna": "responses", "muse-spark-1.3-contributor": "responses", "muse-spark-1.2-contributor": "responses",
      "glm-5.3-flash": "chat", "glm-5.3": "chat", "glm-5.2": "chat", "kimi-k3.1-pro": "chat", "kimi-k3": "chat", "kimi-k2.7-code": "chat", "longcat-2.0": "chat",
      "deepseek-v4.1-flash": "chat", "deepseek-v4-pro": "chat", "mimo-v2.6-flash": "chat", "mimo-v2.6-pro": "chat", "mimo-v2.5": "chat", "mimo-v2.5-pro": "chat",
      "minimax-m3.1-flash": "chat", "hy4-preview": "chat", "hy3": "chat", "step-5-preview": "chat", "beam-free": "chat",
      "claude-haiku-5-5": "messages", "minimax-m3": "messages", "qwen3.8-max": "messages", "qwen3.8-flash": "messages", "qwen3.7-plus": "messages",
      "gemini-4-argon": "gemini",
    }),
    docs: ["https://opencode.ai/docs/go"],
    checkedAt: "2026-10-25",
  }),
  preset({ id: "fireworks", name: "Fireworks", methods: ["api-key"], upstreamBase: "https://api.fireworks.ai/inference/v1", docs: ["https://docs.fireworks.ai/api-reference"], checkedAt: "2026-10-19" }),
  // The user's own endpoint: upstreamBase is the account's (endpoint). Its contract tests
  // (mock) are the acceptance: probe asks before spending a token.
  preset({ id: "custom", name: "Your own endpoint", methods: ["api-key", "none"], upstreamBase: null, keyTest: "probe", status: "experimental", docs: [], checkedAt: "2026-10-19" }),
  preset({ id: "ollama", name: "Ollama (local)", methods: ["none"], upstreamBase: "http://localhost:11434/v1", auth: "none", local: true, docs: ["https://github.com/ollama/ollama/blob/main/docs/openai.md"], checkedAt: "2026-10-19" }),
  preset({ id: "lmstudio", name: "LM Studio (local)", methods: ["none"], upstreamBase: "http://localhost:1234/v1", auth: "none", local: true, docs: ["https://lmstudio.ai/docs/app/api/endpoints/openai"], checkedAt: "2026-10-19" }),
  // Wave 2 (P6.2): Chat Completions providers, through the gateway's translation. Facts from
  // each provider's docs on 25 Oct 2026 (context windows, quota codes, data terms); each stays
  // a candidate until a real-key acceptance run is recorded. Free tiers and the best-known first.
  chatPreset({
    id: "gemini",
    name: "Gemini API",
    // Native (P6.4b): streamGenerateContent with the key in x-goog-api-key, never the URL.
    // Thought signatures ride with their function calls.
    mode: "gemini",
    upstreamBase: "https://generativelanguage.googleapis.com/v1beta",
    upstreamPath: "/models",
    authHeader: "x-goog-api-key",
    capabilities: Object.freeze({ effort: true, jsonFormat: true, vision: true }),
    // The free tier's per-minute token limit is far below the 1M window: compact earlier.
    compactCap: 250000,
    contextWindows: Object.freeze({ "gemini-3.8-flash": 1048576, "gemini-3.6-flash": 1048576, "gemini-3.5-flash-lite": 1048576, "gemini-4-argon": 1048576 }),
    privacy: Object.freeze({ trial: false, trainsOnData: "free tier", notice: "With a free Gemini API key, Google may use what you send to improve its products, and people may read it. Use a paid key for code you can't share." }),
    pickerHint: "Google AI Studio API key; free tier",
    docs: ["https://ai.google.dev/api/generate-content", "https://ai.google.dev/gemini-api/docs/thinking", "https://ai.google.dev/gemini-api/terms"],
  }),
  chatPreset({
    id: "groq",
    name: "Groq",
    upstreamBase: "https://api.groq.com/openai/v1",
    // x-ratelimit-*-requests is Groq's per-day request counter.
    dailyLimitHeaders: Object.freeze(["x-ratelimit-remaining-requests"]),
    contextWindows: Object.freeze({ "openai/gpt-oss-120b": 131072, "openai/gpt-oss-20b": 131072, "qwen/qwen3.8-27b": 131072, "llama-3.3-70b-versatile": 131072, "llama-3.1-8b-instant": 131072 }),
    pickerHint: "free tier with daily limits",
    docs: ["https://console.groq.com/docs/openai", "https://console.groq.com/docs/rate-limits"],
  }),
  chatPreset({
    id: "cerebras",
    name: "Cerebras",
    upstreamBase: "https://api.cerebras.ai/v1",
    // The free trial's windows (paid accounts get more).
    contextWindows: Object.freeze({ "gpt-oss-120b": 65536, "qwen-3.8-27b": 65536 }),
    capabilities: Object.freeze({ strictTools: true }),
    pickerHint: "trial credits",
    docs: ["https://inference-docs.cerebras.ai/resources/openai", "https://inference-docs.cerebras.ai/support/rate-limits"],
  }),
  chatPreset({
    id: "mistral",
    name: "Mistral",
    upstreamBase: "https://api.mistral.ai/v1",
    quirks: Object.freeze(["mistral"]),
    contextWindows: Object.freeze({ "mistral-medium-latest": 256000, "mistral-small-latest": 256000, "mistral-large-4": 1000000, "codestral-latest": 128000, "devstral-latest": 256000 }),
    pickerHint: "free mode for trying it",
    docs: ["https://docs.mistral.ai/api", "https://docs.mistral.ai/admin/user-management-finops/tier"],
  }),
  chatPreset({
    id: "nvidia",
    name: "NVIDIA API catalog",
    upstreamBase: "https://integrate.api.nvidia.com/v1",
    // Its model list answers without a key: the key is tested with an empty chat request.
    keyTest: "empty-chat",
    keyTestModel: "openai/gpt-oss-20b",
    privacy: Object.freeze({ trial: true, trainsOnData: "unknown", notice: "NVIDIA's hosted models are for trial use. Don't send personal or confidential code." }),
    pickerHint: "trial use",
    docs: ["https://docs.api.nvidia.com/nim/reference/llm-apis"],
  }),
  chatPreset({
    id: "anthropic",
    name: "Anthropic API",
    // Native (P6.4a): the Messages API, extended thinking kept across tool loops.
    mode: "anthropic",
    upstreamBase: "https://api.anthropic.com/v1",
    upstreamPath: "/messages",
    authHeader: "x-api-key",
    headers: Object.freeze({ "anthropic-version": "2023-06-01" }),
    contextWindows: Object.freeze({ "claude-fable-5-1": 1000000, "claude-opus-5-5": 1000000, "claude-sonnet-5-5": 1000000, "claude-haiku-5-5": 1000000 }),
    // Forced tool use errors on the newest models (docs): auto and none only.
    capabilities: Object.freeze({ effort: true, parallelTools: true, vision: true, toolChoices: Object.freeze(["auto", "none"]) }),
    quotaErrors: Object.freeze(["enforced_spend_limit_reached"]),
    pickerHint: "Claude (Anthropic API key)",
    docs: ["https://docs.claude.com/en/api/messages", "https://docs.claude.com/en/docs/build-with-claude/extended-thinking", "https://docs.claude.com/en/api/errors"],
  }),
  chatPreset({
    id: "deepseek",
    name: "DeepSeek",
    upstreamBase: "https://api.deepseek.com",
    quirks: Object.freeze(["deepseek"]),
    contextWindows: Object.freeze({ "deepseek-flash": 1048576, "deepseek-v4-pro": 1048576 }),
    docs: ["https://api-docs.deepseek.com/guides/thinking_mode", "https://api-docs.deepseek.com/quick_start/error_codes"],
  }),
  chatPreset({
    id: "together",
    name: "Together AI",
    upstreamBase: "https://api.together.ai/v1",
    contextWindows: Object.freeze({ "deepseek-ai/DeepSeek-V4.1-Flash": 1000000, "deepseek-ai/DeepSeek-V4-Pro-0813": 1048576, "zai-org/GLM-5.3": 1048575, "zai-org/GLM-5.3-Flash": 1048575, "MiniMaxAI/MiniMax-M3": 524288, "openai/gpt-oss-120b": 131072 }),
    docs: ["https://docs.together.ai/docs/openai-api-compatibility", "https://docs.together.ai/docs/error-codes"],
  }),
  chatPreset({
    id: "zai",
    name: "Z.ai",
    upstreamBase: "https://api.z.ai/api/paas/v4",
    contextWindows: Object.freeze({ "glm-5.3": 1000000, "glm-5.2": 1000000, "glm-4.7-flash": 202752, "glm-4.6": 200000 }),
    capabilities: Object.freeze({ toolChoices: Object.freeze(["auto"]) }),
    // A used-up balance is a 429 with business code 1113.
    quotaErrors: Object.freeze(["1113"]),
    docs: ["https://docs.z.ai/api-reference/llm/chat-completion", "https://docs.z.ai/api-reference/api-code"],
  }),
  chatPreset({
    id: "zai-coding",
    name: "Z.ai Coding Plan",
    upstreamBase: "https://api.z.ai/api/coding/paas/v4",
    status: "blocked",
    blockedReason: "Z.ai Coding Plan — not available yet: its plan allows only Z.ai's listed coding tools. Use a standard Z.ai key, or another provider.",
    docs: ["https://docs.z.ai/devpack/usage-policy"],
  }),
  chatPreset({
    id: "huggingface",
    name: "Hugging Face",
    upstreamBase: "https://router.huggingface.co/v1",
    // Its model list answers without a key.
    keyTest: "empty-chat",
    keyTestModel: "openai/gpt-oss-120b",
    contextWindows: Object.freeze({ "deepseek-ai/DeepSeek-V4.1-Flash-1017": 1048576, "zai-org/GLM-5.3": 1048576, "MiniMaxAI/MiniMax-M3": 1000000, "openai/gpt-oss-120b": 131072, "Qwen/Qwen3.8-27B": 1000000, "meta-llama/Llama-3.3-70B-Instruct": 131072 }),
    pickerHint: "the provider after ':' in a model id receives your prompts",
    docs: ["https://huggingface.co/docs/inference-providers/tasks/chat-completion", "https://huggingface.co/docs/inference-providers/index"],
  }),
  chatPreset({
    id: "nebius",
    name: "Nebius Token Factory",
    upstreamBase: "https://api.tokenfactory.nebius.com/v1",
    contextWindows: Object.freeze({ "meta-llama/Llama-3.3-70B-Instruct": 131072, "openai/gpt-oss-120b": 131072, "meta-llama/Meta-Llama-3.1-8B-Instruct-fast": 131072 }),
    docs: ["https://docs.tokenfactory.nebius.com/quickstart", "https://docs.tokenfactory.nebius.com/legal/legal-quick-guide"],
  }),
  chatPreset({
    id: "minimax",
    name: "MiniMax",
    upstreamBase: "https://api.minimax.io/v1",
    // Its models want their reasoning back with the history, like DeepSeek's.
    quirks: Object.freeze(["deepseek"]),
    contextWindows: Object.freeze({ "MiniMax-M3.1-Flash": 1000000, "MiniMax-M3": 1000000 }),
    capabilities: Object.freeze({ toolChoices: Object.freeze(["auto", "none"]) }),
    quotaErrors: Object.freeze(["1008", "2062"]),
    docs: ["https://platform.minimax.io/docs/api-reference/text-openai-api", "https://platform.minimax.io/docs/api-reference/errorcode"],
  }),
  chatPreset({
    id: "sambanova",
    name: "SambaNova",
    upstreamBase: "https://api.sambanova.ai/v1",
    dailyLimitHeaders: Object.freeze(["x-ratelimit-remaining-requests-day"]),
    // Its model list answers without a key.
    keyTest: "empty-chat",
    keyTestModel: "Meta-Llama-3.3-70B-Instruct",
    contextWindows: Object.freeze({ "DeepSeek-V3.1": 131072, "DeepSeek-V3.2": 32768, "Meta-Llama-3.3-70B-Instruct": 131072, "gpt-oss-120b": 131072, "gemma-4-31B-it": 262144 }),
    pickerHint: "free tier with daily limits",
    docs: ["https://docs.sambanova.ai/docs/en/features/openai-compatibility", "https://docs.sambanova.ai/docs/en/models/rate-limits"],
  }),
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
  Object.freeze({ id: "opencode-zen", text: "OpenCode Zen free models: OpenCode allows them only in its own app, so ad doesn't offer them. Free alternatives in ad: OpenRouter's free models and local models (Ollama, LM Studio)." }),
  Object.freeze({ id: "nous", text: "Nous Portal: not available yet (Nous hasn't published a way for other apps to sign in). Hermes models are open: run them with Ollama, or use them through OpenRouter." }),
]);

/** "OpenRouter" for a provider id (an unknown id is shown as is). */
export const providerName = (id) => byId.get(id)?.name ?? (id === "chatgpt" ? "ChatGPT" : id);

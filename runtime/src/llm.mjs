// One entry point for Agent Daemon's own LLM calls (digest fallback, GEPA
// reflect / generate / evaluate), with a selectable backend:
//
//   claude  headless `claude` CLI (runtime/src/claude.mjs) — the original path
//   codex   the harness Codex engine (engine/index.mjs complete())
//   auto    claude, falling back to codex when the claude binary is missing
//
// Pick with AD_LLM_BACKEND or opts.backend; default is auto. Both backends
// return callHeadlessClaude's result shape, so callers don't care which ran.

import { callHeadlessClaude } from "./claude.mjs";

const BACKENDS = new Set(["claude", "codex", "auto"]);

export function llmBackend(opts = {}, env = process.env) {
  const b = opts.backend ?? env.AD_LLM_BACKEND ?? "auto";
  if (!BACKENDS.has(b)) throw new Error(`unknown LLM backend "${b}" (use claude, codex or auto)`);
  return b;
}

// OpenAI structured output requires every object to list all its properties
// as required and forbid extras. A schema that doesn't meet that is embedded
// in the prompt instead, and the JSON parsed from the reply.
export function isStrictSchema(schema) {
  if (!schema || typeof schema !== "object") return true;
  if (schema.type === "object" || schema.properties) {
    const keys = Object.keys(schema.properties ?? {});
    if (schema.additionalProperties !== false) return false;
    if (!keys.every((k) => schema.required?.includes(k))) return false;
    if (!Object.values(schema.properties ?? {}).every(isStrictSchema)) return false;
  }
  if (schema.items && !isStrictSchema(schema.items)) return false;
  for (const k of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(schema[k]) && !schema[k].every(isStrictSchema)) return false;
  return true;
}

// End index (inclusive) of the balanced {...} starting at `start`, skipping
// braces inside JSON strings; -1 if unbalanced.
function balancedEnd(s, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

// The first top-level JSON object in a reply — fenced ```json blocks first,
// then any balanced {...} that parses. Prose with stray braces around it,
// or a second object after it, doesn't break it.
export function parseJsonReply(text) {
  if (typeof text !== "string") return null;
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (const src of [...fences, text]) {
    for (let start = src.indexOf("{"); start !== -1; start = src.indexOf("{", start + 1)) {
      const end = balancedEnd(src, start);
      if (end === -1) continue;
      try {
        const v = JSON.parse(src.slice(start, end + 1));
        if (v && typeof v === "object" && !Array.isArray(v)) return v;
      } catch {
        // not JSON at this brace — keep scanning
      }
    }
  }
  return null;
}

function withParsedJson(result, { schema } = {}) {
  if (result.ok && result.parsedJson == null) {
    const parsed = parseJsonReply(result.result);
    if (parsed) return { ...result, parsedJson: parsed };
    // Callers read parsedJson; say why it's missing instead of a bare ok.
    if (schema) return { ...result, ok: false, error: "the reply contained no JSON object" };
  }
  return result;
}

// Claude aliases ("haiku") mean nothing to Codex; AD_CODEX_LLM_MODEL picks
// the Codex model for these background calls (e.g. a cheaper one).
export function codexModelFor(model, env = process.env) {
  if (!model || ["haiku", "sonnet", "opus"].includes(model)) return env.AD_CODEX_LLM_MODEL || undefined;
  return model;
}

async function callCodex(opts, { engineFactory } = {}) {
  const [{ createEngine }, { providerEnv }] = await Promise.all([import("./engine/index.mjs"), import("./auth/providers.mjs")]);
  const factory = engineFactory ?? ((o) => createEngine({ env: providerEnv(), ...o }));
  let engine;
  try {
    engine = await factory({});
    const acct = await engine.account();
    if (acct.requiresOpenaiAuth && !acct.account) return { ok: false, error: "codex backend not logged in (run: ad auth login chatgpt)" };
    const schema = opts.jsonSchema ?? opts.schema;
    const strict = schema && isStrictSchema(schema);
    const userMessage = schema && !strict
      ? `${opts.userMessage}\n\nRespond with ONLY a JSON object (no prose) matching this JSON Schema:\n${JSON.stringify(schema)}`
      : opts.userMessage;
    const r = await engine.complete({ ...opts, userMessage, model: codexModelFor(opts.model), jsonSchema: strict ? schema : undefined, schema: undefined });
    return withParsedJson(r, { schema });
  } catch (err) {
    return { ok: false, error: `codex backend: ${err.message}` };
  } finally {
    await engine?.close();
  }
}

export async function callLlm(opts, deps = {}) {
  const backend = llmBackend(opts);
  if (backend === "codex") return callCodex(opts, deps);
  const claude = deps.callClaude ?? callHeadlessClaude;
  const r = withParsedJson(await claude(opts), { schema: opts.jsonSchema });
  if (backend === "auto" && !r.ok && /spawn failed: .*ENOENT/.test(r.error ?? "")) {
    if (opts.verbose) process.stderr.write("[agent-daemon] claude CLI not found; using the Codex engine\n");
    return callCodex(opts, deps);
  }
  return r;
}

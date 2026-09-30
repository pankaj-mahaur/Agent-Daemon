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

// First JSON object in a reply (bare, or inside a ```json fence).
export function parseJsonReply(text) {
  if (typeof text !== "string") return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf("{");
    const end = c.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1));
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function withParsedJson(result) {
  if (result.ok && result.parsedJson == null) {
    const parsed = parseJsonReply(result.result);
    if (parsed) return { ...result, parsedJson: parsed };
  }
  return result;
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
    const r = await engine.complete({ ...opts, userMessage, jsonSchema: strict ? schema : undefined, schema: undefined });
    return withParsedJson(r);
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
  const r = withParsedJson(await claude(opts));
  if (backend === "auto" && !r.ok && /spawn failed: .*ENOENT/.test(r.error ?? "")) {
    if (opts.verbose) process.stderr.write("[agent-daemon] claude CLI not found; using the Codex engine\n");
    return callCodex(opts, deps);
  }
  return r;
}

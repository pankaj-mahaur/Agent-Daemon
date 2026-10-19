// Adding accounts (P3.5): an API key, your own endpoint, a local server. The official
// method only: an API key everywhere (OpenRouter's own sign-in is signInOpenRouter, P3.5b).
//
//   refuseKeyArgs({ values, positionals })   a key on the command line is refused, never echoed
//   checkKeyText(key)                         a key is printable ASCII without spaces
//   testKey(preset, { key, endpoint, fetch, clientVersion, insecure, probe, model })
//     → { status: "ready" | "refused" | "unreachable" | "chat-only" | "wrong-address", detail, http? }
//   signInApiKey({ service, provider, label, owner, readKey, endpoint, defaultModel, fetch, clientVersion })
//   signInCustom({ service, baseUrl, label, owner, readKey, noKey, insecure, confirmProbe, model, fetch, clientVersion })
//   signInLocal({ service, provider, label, fetch, clientVersion })
//     → the account record (ready, or "error" when the provider couldn't be reached: the
//       key is kept and `ad auth test` checks it later). A refused key is never kept.
// Keys come only from readKey (a hidden prompt, or the first line of piped stdin), asked
// for after the label and address are known to be fine.

import { presetFor } from "../../providers/registry.mjs";
import { HTTP_TEXTS, isLoopback, providerRequest } from "../../providers/http.mjs";
import { registerSecret } from "../redact.mjs";
import { readRegistry } from "./registry.mjs";

export const SIGNIN_TEXTS = Object.freeze({
  KEY_ON_COMMAND_LINE: (provider = "<provider>") => `ad never takes a key on the command line: it would stay in your shell history. Type it at the hidden prompt, or pipe it: … | ad auth login ${provider} --stdin`,
  KEY_REFUSED: (http, provider, label) => `The key was refused (HTTP ${http}), so it wasn't saved. Check it and add it again: ad auth login ${provider} --label ${label}`,
  KEY_TEXT: "That doesn't look like a key: it has spaces or characters a key can't have. Copy it again.",
  UNREACHABLE_SAVED: (why, ref) => `${why} The key is saved; test it later: ad auth test ${ref}`,
  CHAT_ONLY: "This endpoint speaks only Chat Completions. ad's engine needs the Responses API; chat-only endpoints work once ad's chat bridge ships. Meanwhile use OpenRouter, or a server with the Responses API (Ollama 0.13.3+, LM Studio, vLLM).",
  WRONG_ADDRESS: (host, http) => `${host} answered HTTP ${http} for its model list and to a Responses request: check the address (it usually ends in /v1).`,
  NOT_CHECKED: (host, http) => `${host} answered HTTP ${http} for its model list. Check the address (it usually ends in /v1), or let ad test it with a one-token request.`,
  LOCAL_DOWN: (name, hostPort, start) => `${name} isn't answering on ${hostPort}. Start it (${start}) and try again.`,
  NO_KEY_REMOTE: "--no-key is only for an endpoint on this machine (localhost, 127.0.0.1 or [::1]).",
  BAD_URL: (why) => `ad can't use that address: ${why}.`,
  PROBE_ASK: "Test the endpoint with a one-token request? It may cost a fraction of a cent. [Y/n] ",
  NO_KEY: "No key entered.",
});

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

// Flags that would carry a key, in any case (--key, --Key=…, --api-key, --token, --secret…).
const KEY_FLAG = /^(key|api[-_]?key|token|secret|password|access[-_]?token)$/i;
// A value that looks like a key: a known prefix, or 32+ key characters in one word.
const KEY_SHAPED = /^(sk|xai|fw|or)[-_]|^[A-Za-z0-9_\-.]{32,}$/;

/** Refuses key flags and any key-shaped positional (the provider id's place too); the value is never shown. */
export function refuseKeyArgs({ values = {}, positionals = [] } = {}, provider) {
  const flagged = Object.keys(values).some((k) => KEY_FLAG.test(k) && values[k] !== undefined && values[k] !== false);
  if (flagged || positionals.some((p) => KEY_SHAPED.test(String(p)))) {
    throw fail("KEY_ON_COMMAND_LINE", SIGNIN_TEXTS.KEY_ON_COMMAND_LINE(provider && !KEY_SHAPED.test(String(provider)) ? provider : undefined));
  }
}

/** A key is printable ASCII without spaces; anything else is refused before any request. */
export function checkKeyText(key) {
  if (!key) throw fail("NO_KEY", SIGNIN_TEXTS.NO_KEY);
  if (!/^[\x21-\x7e]+$/.test(key)) throw fail("KEY_TEXT", SIGNIN_TEXTS.KEY_TEXT);
  registerSecret(key, "key"); // from here on, no output can show it
  return key;
}

const START_HINT = { ollama: "ollama serve", lmstudio: "lms server start" };

/**
 * One check that a key works, with ad's own request (never through the engine).
 * probe (custom endpoints, after asking): a one-token Responses request as well. A
 * custom endpoint whose model list doesn't answer 200 is ready only after a probe passes.
 */
export async function testKey(preset, { key = null, endpoint = null, fetch, clientVersion, insecure = false, probe = false, model = null } = {}) {
  const base = String(endpoint ?? preset.upstreamBase).replace(/\/+$/, "");
  const host = new URL(base).host;
  const ask = (path, o = {}) => providerRequest({ url: `${base}${path}`, key, fetch, clientVersion, insecure, ...o });
  try {
    if (preset.keyTest === "none") return { status: "ready", detail: null };
    const r = await ask(preset.keyTest === "key-endpoint" ? "/key" : preset.modelsPath);
    if (r.status === 401 || r.status === 403) return { status: "refused", http: r.status, detail: null };
    if (r.status >= 500) return { status: "unreachable", detail: `${host} answered HTTP ${r.status}.` };
    if (preset.keyTest !== "probe") return r.status === 200 ? { status: "ready", detail: null } : { status: "unreachable", detail: `${host} answered HTTP ${r.status}.` };
    if (!probe) return r.status === 200 ? { status: "ready", detail: null } : { status: "wrong-address", detail: SIGNIN_TEXTS.NOT_CHECKED(host, r.status) };
    const m = model ?? (Array.isArray(r.json?.data) ? r.json.data.find((x) => typeof x?.id === "string")?.id : null) ?? "default";
    const p = await ask(preset.upstreamPath, { method: "POST", body: { model: m, input: "ping", max_output_tokens: 1, stream: false } });
    if (p.status === 401 || p.status === 403) return { status: "refused", http: p.status, detail: null };
    if (p.status === 404 || p.status === 405) return r.status === 200 ? { status: "chat-only", detail: SIGNIN_TEXTS.CHAT_ONLY } : { status: "wrong-address", detail: SIGNIN_TEXTS.WRONG_ADDRESS(host, r.status) };
    if (p.status >= 400) return { status: "unreachable", detail: `${host} answered HTTP ${p.status} to a Responses request.` };
    return { status: "ready", detail: null };
  } catch (e) {
    if (e.code === "PROVIDER_REDIRECT" || e.code === "INSECURE_URL") throw e;
    if (e.code === "PROVIDER_UNREACHABLE") return { status: "unreachable", detail: e.message };
    throw e;
  }
}

/** The label a new account gets: the one asked for, else `default` for a provider's first. */
export function labelFor(provider, label, { doc } = {}) {
  if (label) return label;
  doc ??= readRegistry();
  return doc.accounts.some((a) => a.provider === provider) ? null : "default";
}

const LABEL_NEEDED = (provider) => `${provider} already has an account. Name the new one: ad auth login ${provider} --label <label>`;
const labelOrFail = (provider, label) => {
  const l = labelFor(provider, label);
  if (!l) throw fail("LABEL_NEEDED", LABEL_NEEDED(provider));
  // Taken already: said before the key is asked for.
  if (readRegistry().accounts.some((a) => a.provider === provider && String(a.label).toLowerCase() === String(l).toLowerCase())) throw fail("LABEL_TAKEN", `${provider} already has an account labelled "${l}". Pick another label.`);
  return l;
};

// addApiKey's test: refused → thrown (not saved); unreachable → kept as "error".
function keyVerdict(preset, provider, label, opts) {
  return async (key) => {
    const v = await testKey(preset, { ...opts, key });
    if (v.status === "refused") throw fail("KEY_REFUSED", SIGNIN_TEXTS.KEY_REFUSED(v.http, provider, label));
    if (v.status === "chat-only") throw fail("CHAT_ONLY", SIGNIN_TEXTS.CHAT_ONLY);
    if (v.status === "wrong-address") throw fail("WRONG_ADDRESS", v.detail);
    if (v.status === "unreachable") return { status: "error", detail: SIGNIN_TEXTS.UNREACHABLE_SAVED(v.detail, `${provider}/${label}`) };
    return null;
  };
}

// The service wraps a failed test as KEY_TEST_FAILED; ad's own texts stay as they are.
async function addKey(service, o, verdict) {
  let own = null;
  try {
    return await service.addApiKey({
      ...o,
      test: async (key) => {
        try {
          return await verdict(key);
        } catch (e) {
          own = e;
          throw e;
        }
      },
    });
  } catch (e) {
    throw own ?? e;
  }
}

export async function signInApiKey({ service, provider, label, owner = "", readKey, endpoint = null, defaultModel = null, fetch, clientVersion }) {
  const preset = presetFor(provider);
  if (!preset.methods.includes("api-key")) throw fail("NO_KEY_METHOD", `${preset.name} doesn't use an API key.`);
  label = labelOrFail(provider, label);
  const key = checkKeyText(await readKey());
  return addKey(service, { provider, label, owner, endpoint, key, defaultModel }, keyVerdict(preset, provider, label, { endpoint, fetch, clientVersion }));
}

/** A base URL ad accepts: https, or http on loopback (or with --insecure); no userinfo, fragment or query. */
export function normalizeBaseUrl(raw, { insecure = false } = {}) {
  let u;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    throw fail("BAD_URL", SIGNIN_TEXTS.BAD_URL("it isn't a URL (example: https://llm.example.com/v1)"));
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw fail("BAD_URL", SIGNIN_TEXTS.BAD_URL("only http and https"));
  if (u.username || u.password) throw fail("BAD_URL", SIGNIN_TEXTS.BAD_URL("a user name or password in the address would be sent everywhere; ad asks for the key separately"));
  if (u.hash) throw fail("BAD_URL", SIGNIN_TEXTS.BAD_URL("it has a #fragment"));
  // ad appends paths (/models, /responses) to the base: a query would break them, and could hold a key.
  if (u.search || u.href.includes("?")) throw fail("BAD_URL", SIGNIN_TEXTS.BAD_URL("it has a query (?…); give the base address only, ending in /v1"));
  if (u.protocol === "http:" && !isLoopback(u.href) && !insecure) throw fail("INSECURE_URL", HTTP_TEXTS.INSECURE_URL);
  return u.href.replace(/\/+$/, "");
}

export async function signInCustom({ service, baseUrl, label, owner = "", readKey = async () => null, noKey = false, insecure = false, confirmProbe = async () => false, model = null, fetch, clientVersion }) {
  const preset = presetFor("custom");
  const endpoint = normalizeBaseUrl(baseUrl, { insecure });
  label = labelOrFail("custom", label);
  if (noKey && !isLoopback(endpoint)) throw fail("NO_KEY_REMOTE", SIGNIN_TEXTS.NO_KEY_REMOTE);
  const key = noKey ? null : checkKeyText(await readKey());
  const probe = Boolean(await confirmProbe());
  if (noKey) {
    const v = await testKey(preset, { endpoint, fetch, clientVersion, insecure, probe, model });
    if (v.status === "chat-only") throw fail("CHAT_ONLY", SIGNIN_TEXTS.CHAT_ONLY);
    if (v.status === "wrong-address") throw fail("WRONG_ADDRESS", v.detail);
    if (v.status === "unreachable") throw fail("PROVIDER_UNREACHABLE", v.detail);
    const { id, attemptId } = await service.reserve({ provider: "custom", label, owner, method: "none", endpoint, defaultModel: model });
    return service.finalize(id, attemptId, { credential: { kind: "none" }, ...(insecure ? { insecure: true } : {}), ...(probe ? { probed: true } : {}) });
  }
  return addKey(service, { provider: "custom", label, owner, endpoint, key, defaultModel: model, extra: { ...(insecure ? { insecure: true } : {}), ...(probe ? { probed: true } : {}) } }, keyVerdict(preset, "custom", label, { endpoint, fetch, clientVersion, insecure, probe, model }));
}

export async function signInLocal({ service, provider, label, fetch, clientVersion }) {
  const preset = presetFor(provider);
  if (!preset.local) throw fail("NOT_LOCAL", `${preset.name} isn't a local server.`);
  label = labelOrFail(provider, label);
  const r = await providerRequest({ url: `${preset.upstreamBase}${preset.modelsPath}`, fetch, clientVersion, timeoutMs: 5000 }).catch(() => null);
  if (!r || r.status !== 200) {
    const host = new URL(preset.upstreamBase).host;
    throw fail("LOCAL_DOWN", SIGNIN_TEXTS.LOCAL_DOWN(preset.name.replace(/ \(local\)$/, ""), host, START_HINT[provider] ?? "its server"));
  }
  const { id, attemptId } = await service.reserve({ provider, label, owner: "", method: "none" });
  return service.finalize(id, attemptId, { credential: { kind: "none" } });
}

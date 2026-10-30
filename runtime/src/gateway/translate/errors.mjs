// Upstream failures for translated routes (P6.1 §6): only codes the engine knows reach it,
// so it never re-sends to an exhausted provider; the real reason goes to the side channel
// (the gateway's observation event) for ad's own wording.
//
//   httpFailure(status, text, { retryAfter, capS, label }) → {
//     http: { status, body, headers } | null      an HTTP answer before any stream
//     sse:  { code, message } | null              or a 200 stream ending in response.failed
//     side: { kind, message, period?, retryAfterS? }
//   }
//   streamFailure(error, { capS, label }) → { code, message, side }   an error inside the stream
// side.kind: quotaExhausted | rateLimit | contextOverflow | provider5xx | authExpired |
//            authRevoked | transientNetwork | invalidConfig | truncated | contentPolicy | unknown

import { redact } from "../../auth/redact.mjs";

const CONTEXT = /context[ _-]?(length|window)|maximum context|too many tokens|prompt is too long|input is too long|token limit|exceeds the (model'?s )?(maximum|limit)|reduce the length/i;
// A limit with a period (the day's or the month's) or no credit left: over until it resets.
// Anything else is a wait, even when its text mentions quota or billing (Groq's TPM and
// Gemini's per-minute bodies both do).
const DAY = /(per[ _-]?day|daily|\bTPD\b|\bRPD\b|PerDay|per_day|free-models-per-day)/i;
const MONTH = /(monthly|per[ _-]?month|PerMonth)/i;
const NO_CREDIT = /insufficient[_ ]quota|insufficient[_ ]credits|insufficient[_ ]balance|out of credits|no credits|credit balance is too low/i;
const DEFAULT_WAIT_S = 10;

function parseError(text) {
  try {
    const j = JSON.parse(text);
    if (j?.base_resp && Number(j.base_resp.status_code) !== 0) return { code: String(j.base_resp.status_code), type: null, message: String(j.base_resp.status_msg ?? ""), details: null };
    const e = Array.isArray(j) ? j[0]?.error : j?.error;
    if (e && typeof e === "object") return { code: e.code ?? e.status ?? null, type: e.type ?? null, message: String(e.message ?? ""), details: e.details ?? null };
    if (typeof e === "string") return { message: e };
    if (j?.message) return { message: String(j.message) };
  } catch {
    // not JSON
  }
  return { message: String(text ?? "") };
}

/** Seconds to wait, from a Retry-After value, "try again in 7s", or Gemini's retryDelay "36s". */
export function waitSeconds(retryAfter, err) {
  if (retryAfter !== null && retryAfter !== undefined && retryAfter !== "") {
    const n = Number(retryAfter);
    if (Number.isFinite(n)) return Math.ceil(n);
  }
  const m = /try again in ([\d.]+)\s*(ms|s|m)\b/i.exec(err?.message ?? "");
  if (m) return Math.ceil(Number(m[1]) * (m[2] === "ms" ? 0.001 : m[2] === "m" ? 60 : 1));
  for (const d of Array.isArray(err?.details) ? err.details : []) {
    const r = /^([\d.]+)s$/.exec(String(d?.retryDelay ?? ""));
    if (r) return Math.ceil(Number(r[1]));
  }
  return null;
}

const msg = (s) => redact(String(s ?? "")).slice(0, 300);
const quotaPeriod = (text) => (DAY.test(text) ? "day" : MONTH.test(text) ? "month" : null);
const errBody = (type, code, message) => ({ error: { type, code, message } });

function rateOrQuota(text, wait, { capS, label, dayExhausted = false }) {
  // dayExhausted: the provider's own daily counter said 0 left (its header), whatever the text.
  const periodic = dayExhausted || DAY.test(text) || MONTH.test(text) || NO_CREDIT.test(text);
  if (!periodic && wait === null) wait = DEFAULT_WAIT_S;
  if (periodic || wait > capS) {
    const period = dayExhausted ? "day" : quotaPeriod(text);
    const message = period ? `${label}: the ${period === "day" ? "daily" : "monthly"} limit is used up.` : `${label}: the quota is used up.`;
    return { quota: true, message, side: { kind: "quotaExhausted", message, period, retryAfterS: wait } };
  }
  const message = `${label} is rate limited. Please try again in ${wait}s.`;
  return { quota: false, message, side: { kind: "rateLimit", message, retryAfterS: wait } };
}

/** A provider's own usage-limit error (OpenCode's GoUsageLimitError): over until its reset. */
function usageLimit(err, quotaNames, retryAfter, label) {
  if (!quotaNames?.length || ![err?.type, err?.code, err?.details?.error_code].some((v) => quotaNames.includes(String(v ?? "")))) return null;
  const wait = waitSeconds(retryAfter, err);
  const at = wait !== null ? new Date(Date.now() + wait * 1000) : null;
  const hhmm = at ? `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}` : null;
  const message = hhmm ? `${label}'s usage limit is reached. It resets at ${hhmm}; until then pick another account with /model.` : `${label}'s usage limit is reached. Until it resets, pick another account with /model.`;
  return { message, side: { kind: "quotaExhausted", message, period: null, retryAfterS: wait } };
}

export function httpFailure(status, text, { retryAfter = null, capS = 60, label = "The provider", quotaNames = [], dayExhausted = false } = {}) {
  const err = parseError(text);
  const named = usageLimit(err, quotaNames, retryAfter, label);
  if (named) return { http: { status: 429, body: errBody("insufficient_quota", "insufficient_quota", named.message), headers: { "retry-after": "0" } }, sse: null, side: named.side };
  const all = `${err.code ?? ""} ${err.type ?? ""} ${err.message} ${JSON.stringify(err.details ?? "")}`;
  const provider = msg(err.message) || `HTTP ${status}`;
  if (status === 401 || status === 403) {
    const kind = status === 401 ? "authExpired" : "authRevoked";
    return { http: { status, body: errBody("invalid_request_error", status === 401 ? "invalid_api_key" : "forbidden", `${label}: ${provider}`), headers: {} }, sse: null, side: { kind, message: provider } };
  }
  if (status === 402) {
    const message = `${label}: no credit left on this account.`;
    return { http: { status: 429, body: errBody("insufficient_quota", "insufficient_quota", message), headers: { "retry-after": "0" } }, sse: null, side: { kind: "quotaExhausted", message, period: null } };
  }
  if ((status === 400 || status === 413 || status === 422) && CONTEXT.test(all)) {
    // Always the stream form: an HTTP 400 with this code reaches the engine as "other".
    return { http: null, sse: { code: "context_length_exceeded", message: `${label}: the conversation is longer than this model takes.` }, side: { kind: "contextOverflow", message: provider } };
  }
  if (status === 429) {
    const r = rateOrQuota(all, waitSeconds(retryAfter, err), { capS, label, dayExhausted });
    if (r.quota) return { http: { status: 429, body: errBody("insufficient_quota", "insufficient_quota", r.message), headers: { "retry-after": "0" } }, sse: null, side: r.side };
    return { http: { status: 429, body: errBody("rate_limit_exceeded", "rate_limit_exceeded", r.message), headers: { "retry-after": String(r.side.retryAfterS) } }, sse: null, side: r.side };
  }
  if (status >= 500) return { http: { status: 503, body: errBody("server_error", "server_is_overloaded", `${label} is having trouble (${status}).`), headers: {} }, sse: null, side: { kind: "provider5xx", message: provider } };
  // No credit said in a 400 (Anthropic's "credit balance is too low"): a quota, not a bad request.
  if (status === 400 && NO_CREDIT.test(all)) {
    const message = `${label}: no credit left on this account.`;
    return { http: { status: 429, body: errBody("insufficient_quota", "insufficient_quota", message), headers: { "retry-after": "0" } }, sse: null, side: { kind: "quotaExhausted", message, period: null } };
  }
  return { http: { status: 400, body: errBody("invalid_request_error", "invalid_request", `${label}: ${provider}`), headers: {} }, sse: null, side: { kind: "unknown", message: provider } };
}

/** An error object inside a 200 stream (Chat providers send {"error": {...}} as a data line). */
export function streamFailure(error, { capS = 60, label = "The provider", quotaNames = [] } = {}) {
  const e = typeof error === "object" && error ? error : { message: String(error ?? "") };
  const named = usageLimit(e, quotaNames, null, label);
  if (named) return { code: "insufficient_quota", message: named.message, side: named.side };
  const all = `${e.code ?? ""} ${e.type ?? ""} ${e.message ?? ""} ${JSON.stringify(e.details ?? "")}`;
  if (CONTEXT.test(all)) return { code: "context_length_exceeded", message: `${label}: the conversation is longer than this model takes.`, side: { kind: "contextOverflow", message: msg(e.message) } };
  if (/\brate[ _-]?limit|\b429\b|\bquota\b|too many requests|RESOURCE_EXHAUSTED/i.test(all) || DAY.test(all) || MONTH.test(all) || NO_CREDIT.test(all)) {
    const r = rateOrQuota(all, waitSeconds(null, e), { capS, label });
    return r.quota ? { code: "insufficient_quota", message: r.message, side: r.side } : { code: "rate_limit_exceeded", message: r.message, side: r.side };
  }
  // Anything else mid-stream: one engine retry, no tool ran.
  return { code: "ad_upstream_disconnected", message: `${label} stopped answering mid-way.`, side: { kind: "transientNetwork", message: msg(e.message) } };
}

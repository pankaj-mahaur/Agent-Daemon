// What a failed turn's failure was (P4.3), from what was really seen: the gateway's
// observation of the provider's answer (Table A: API targets, full status, headers and the
// body facts the gateway keeps) or, without one, the engine's turn error (Table B: the
// engine's own codes; it drops provider bodies and Retry-After). Pure.
//
//   classifyUpstream(observation, { probe, now })  → Failure | null (a success)
//   classifyEngine({ info, message, accountKind, rateLimits })  → Failure
//   classifyTurnError({ error, status, observation, accountKind, rateLimits, fallbackInterrupt, now })
//   Failure = { class, period, retryAfterMs, resetsAt, source, reason, notice? }
//
// One rule: only rateLimit, quotaExhausted, transientNetwork and provider5xx can move work
// to another target, and only when placed for sure; anything else is unknown, which never
// does. Retry-After and reset times come from the gateway, a probe or a rate-limit read,
// never from the engine's text, which is never parsed for what the engine dropped.

import { redact } from "../auth/redact.mjs";

export const FALLBACK_CLASSES = new Set(["rateLimit", "quotaExhausted", "transientNetwork", "provider5xx"]);
export const UNCONFIRMED_LIMIT = "ChatGPT says the usage limit is reached, but its limits don't show it; switch by hand with /model if needed.";

const QUOTA_CODES = /^(insufficient_quota|credit_balance_exhausted|organization_usage_limit_exceeded|\w*_spend_limit_exceeded)$/;
const QUOTA_TYPES = new Set(["FreeUsageLimitError", "GoUsageLimitError", "CreditLimitExceeded"]);
const CONTEXT = /context[_ ]length|context[_ ]window|maximum context|too many tokens|token limit|prompt is too long/i;
const CONTENT = /content[_ ]filter|content[_ ]policy|safety|moderation|flagged/i;
const UNSUPPORTED = /not supported|unsupported|does not support/i;
const DAY = /\((TPD|RPD)\)|per[ -]day|daily/i;
const MINUTE = /\((TPM|RPM)\)|per[ -]minute/i;
const NETWORK = /^(ECONN\w+|EPIPE|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR\w*|timed out|network error)$/i;
const REASON_CAP = 300;

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const reasonOf = (s) => redact(String(s ?? "")).slice(0, REASON_CAP);
const failure = (cls, o = {}) => ({ class: cls, period: o.period ?? null, retryAfterMs: o.retryAfterMs ?? null, resetsAt: o.resetsAt ?? null, source: o.source ?? null, reason: reasonOf(o.reason), ...(o.notice ? { notice: o.notice } : {}) });

// "36s", "1.5s" (Google's retryDelay) → ms.
function delayMs(s) {
  const m = /^(\d+(?:\.\d+)?)s$/.exec(String(s ?? "").trim());
  return m ? Math.round(Number(m[1]) * 1000) : null;
}
const nextUtcMidnight = (now) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

/** The engine's error info → { name, status }: a plain string, or one key holding { httpStatusCode }. */
export function engineInfo(info) {
  if (!info) return { name: null, status: null };
  if (typeof info === "string") return { name: info, status: null };
  if (typeof info === "object") {
    const name = Object.keys(info)[0] ?? null;
    const v = name ? info[name] : null;
    return { name, status: Number.isInteger(v?.httpStatusCode) ? v.httpStatusCode : null };
  }
  return { name: null, status: null };
}

/**
 * Table A. obs: the gateway's event { status, at, provider?, retryAfterS, error: { status, type,
 * code, message, statusText, quotaIds, retryDelay, limitSource }, translate, local }.
 * probe: OpenRouter's /key answer after a 429 ({ freeDaily: { used, limit, remaining } }).
 */
export function classifyUpstream(obs, { probe = null, now = Date.now() } = {}) {
  if (!obs) return null;
  const e = obs.error ?? {};
  const status = obs.status ?? e.status ?? null;
  const at = Date.parse(obs.at ?? "") || now;
  const src = { source: "gateway", reason: e.message || (status ? `HTTP ${status}` : "") };
  const retryAfterMs = Number.isFinite(obs.retryAfterS) && obs.retryAfterS !== null ? obs.retryAfterS * 1000 : null;
  const withRetry = (o = {}) => ({ ...src, retryAfterMs, resetsAt: retryAfterMs !== null ? iso(at + retryAfterMs) : null, ...o });
  const code = String(e.code ?? "");
  const type = String(e.type ?? "");
  const msg = String(e.message ?? "");
  const has = (re) => re.test(code) || re.test(type) || re.test(msg);

  // A translated route's own verdict (P6.1/P6.2 read the provider's body for it).
  const kind = obs.translate?.kind;
  if (kind && kind !== "unknown") return failure(kind, withRetry({ reason: obs.translate.message ?? src.reason }));

  // A stream that failed after a 200 (response.failed): its code is the provider's.
  if (status !== null && status < 300 && !code && !msg) return null;
  if (status !== null && status < 300) {
    if (has(CONTEXT)) return failure("contextOverflow", src);
    if (code === "server_is_overloaded" || code === "server_error") return failure("provider5xx", src);
    if (QUOTA_CODES.test(code)) return failure("quotaExhausted", src);
    if (code === "rate_limit_exceeded") return failure("rateLimit", withRetry());
    return failure("unknown", src);
  }

  // A1, A3: a named quota (OpenAI's is never retryable).
  if ((status === 429 || status === 400 || status === 403) && (QUOTA_CODES.test(code) || QUOTA_CODES.test(type))) return failure("quotaExhausted", src);
  if (QUOTA_TYPES.has(type) || QUOTA_TYPES.has(code)) return failure("quotaExhausted", src);
  // A2: payment required, except OpenRouter's in-flight budget (it frees up shortly).
  if (status === 402) return e.limitSource === "openrouter_in_flight_budget" ? failure("rateLimit", withRetry()) : failure("quotaExhausted", src);
  // A4: Google's RESOURCE_EXHAUSTED, by its quota ids (a day's quota even with a short retryDelay).
  if (e.statusText === "RESOURCE_EXHAUSTED" || (Array.isArray(e.quotaIds) && e.quotaIds.length)) {
    const ids = (e.quotaIds ?? []).join(" ");
    if (/PerDay/.test(ids)) return failure("quotaExhausted", { ...src, period: "day" }); // its reset isn't stated: the bench's default
    if (/PerMonth/.test(ids)) return failure("quotaExhausted", { ...src, period: "month" });
    if (/PerMinute/.test(ids)) {
      const d = delayMs(e.retryDelay) ?? retryAfterMs;
      return failure("rateLimit", { ...src, period: "minute", retryAfterMs: d, resetsAt: d !== null ? iso(at + d) : null });
    }
  }
  if (status === 429) {
    // A6: OpenRouter's free daily requests (its /key read, or the counter its body carries).
    // (Its documented reset: 00:00 UTC.) The body's own counter is per-minute as often as per-day.
    if (probe?.freeDaily?.remaining === 0) return failure("quotaExhausted", { ...src, period: "day", resetsAt: iso(nextUtcMidnight(now)) });
    // A5: the period named in the message.
    if (MINUTE.test(msg)) return failure("rateLimit", withRetry({ period: "minute" }));
    if (DAY.test(msg)) return failure("quotaExhausted", { ...src, period: "day" });
    // A7: any other 429 (the provider's original Retry-After, even when the gateway capped it).
    return failure("rateLimit", withRetry());
  }
  // A9: the gateway couldn't reach the provider.
  if (status === 502 && (NETWORK.test(code) || /^couldn't reach/.test(msg))) return failure("transientNetwork", src);
  if ([500, 502, 503, 504, 529].includes(status)) return failure("provider5xx", withRetry()); // A8
  if (status === 401) return failure("authExpired", src); // A10
  if (status === 403) return failure("authRevoked", src); // A11 (eligibility, policy)
  if (status >= 400 && status < 500) {
    if (has(CONTEXT)) return failure("contextOverflow", src); // A12
    if (has(CONTENT)) return failure("contentPolicy", src); // A13
    if (status === 400 || status === 404 || status === 422) return failure(UNSUPPORTED.test(msg) ? "unsupportedFeature" : "invalidConfig", src); // A14
  }
  return failure("unknown", src); // A15
}

// A ChatGPT rate-limit read that shows the limit for sure → its reset (ms), true, or false.
const FRESH_READ_MS = 2 * 60_000;
function confirmedExhausted(rl, { at = null, now = Date.now() } = {}) {
  if (!rl || typeof rl !== "object" || !Number.isFinite(at) || now - at > FRESH_READ_MS) return false;
  // Every limit the account has (an update may carry another limit id), never one past its reset.
  const snaps = rl.byLimit ? Object.values(rl.byLimit) : [rl];
  const live = (w) => !Number.isFinite(Number(w?.resetsAt)) || Number(w.resetsAt) * 1000 > now;
  const windows = snaps.flatMap((s) => [s.primary, s.secondary]).filter((w) => w && live(w));
  const full = windows.filter((w) => Number(w.usedPercent) >= 100);
  if (full.length) {
    const resets = full.map((w) => Number(w.resetsAt)).filter(Number.isFinite);
    return resets.length ? Math.max(...resets) * 1000 : true;
  }
  if (snaps.some((s) => s.rateLimitReachedType || s.spendControlReached || s.ordinaryUsageAllowed === false)) return true;
  return false;
}

/**
 * Table B: the engine's turn error. accountKind "chatgpt" | "api" | "unknown"; rateLimitsAt: when
 * the ChatGPT limits were read (B3 trusts only a read under 2 minutes old).
 */
export function classifyEngine({ info, message = "", accountKind = "unknown", rateLimits = null, rateLimitsAt = null, now = Date.now() } = {}) {
  const { name, status } = engineInfo(info);
  const src = { source: "engine", reason: message };
  const byStatus = (s) => {
    if (s === 401) return failure("authExpired", src);
    if (s === 403) return failure("authRevoked", src);
    if (s === 429) return failure("rateLimit", src);
    if (s !== null && s >= 500) return failure("provider5xx", src);
    if (s === null) return failure("transientNetwork", src);
    return failure("unknown", src);
  };
  switch (name) {
    case "usageLimitExceeded": {
      // B1: the plan doesn't include it: not a limit to wait out or work around.
      if (/with your ChatGPT plan, upgrade to Plus/.test(message)) return failure("authRevoked", src);
      // B2: API credits.
      if (/^Quota exceeded\. Check your plan and billing details/.test(message) && accountKind !== "chatgpt") return failure("quotaExhausted", src);
      // B3: a ChatGPT limit, only when a fresh read of its limits shows it.
      if (accountKind === "chatgpt") {
        const c = confirmedExhausted(rateLimits, { at: rateLimitsAt, now });
        if (!c) return failure("unknown", { ...src, notice: UNCONFIRMED_LIMIT });
        return failure("quotaExhausted", { ...src, source: "chatgpt:rateLimits/read", resetsAt: typeof c === "number" ? iso(c) : null });
      }
      // A usage limit on an account ad can't place: unknown, never a guess.
      return failure(accountKind === "api" ? "quotaExhausted" : "unknown", src);
    }
    case "rateLimitExceeded":
      return failure("rateLimit", src); // B4
    case "serverOverloaded":
    case "internalServerError":
    case "flexUnavailable":
      return failure("provider5xx", src); // B5
    case "httpConnectionFailed":
    case "responseStreamConnectionFailed":
    case "responseTooManyFailedAttempts":
      return byStatus(status); // B6, B7
    case "unauthorized":
      return failure("authExpired", src); // B8
    case "contextWindowExceeded":
      return failure("contextOverflow", src); // B9
    case "cyberPolicy":
    case "misalignmentPolicyViolation":
      return failure("contentPolicy", src); // B10
    default:
      return failure("unknown", src); // B11
  }
}

/**
 * A turn's failure: the gateway's observation of this account's route during the turn wins
 * (API targets); else the engine's error. An interrupted turn is cancelled, unless ad
 * interrupted it for a fallback (P4.5): then the cause it recorded.
 * error: the turn's normalized error { message, info } (the engine's events module).
 */
const FROM_UPSTREAM = new Set([null, "other", "badRequest", "usageLimitExceeded", "rateLimitExceeded", "serverOverloaded", "internalServerError", "httpConnectionFailed", "responseStreamConnectionFailed", "responseTooManyFailedAttempts"]);

export function classifyTurnError({ error = null, status = "failed", observation = null, probe = null, accountKind = "unknown", rateLimits = null, rateLimitsAt = null, fallbackInterrupt = null, now = Date.now() } = {}) {
  if (status === "interrupted") return fallbackInterrupt?.cause ?? failure("cancelled", { source: "engine", reason: "interrupted" });
  // ad's own refusals (its caps, a missing key) aren't the provider's answer.
  // An observation found by account (not by this conversation) may be a subagent's: it counts
  // only when it agrees with the HTTP status the engine reported, if it reported one.
  const said = engineInfo(error?.info);
  const agrees = !observation || observation.by !== "account" || said.status === null || observation.status === said.status;
  if (observation && !observation.local && accountKind !== "chatgpt" && FROM_UPSTREAM.has(said.name) && agrees) {
    const f = classifyUpstream(observation, { probe, now });
    if (f) return f;
  }
  return classifyEngine({ info: error?.info ?? null, message: error?.message ?? "", accountKind, rateLimits, rateLimitsAt, now });
}

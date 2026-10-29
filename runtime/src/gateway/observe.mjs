// What the gateway sees of a provider's answer (P3.3): limits from headers, usage and
// failures from the stream, the error class. Never request or response content beyond
// these fields, never a key or the token.

import { redact } from "../auth/redact.mjs";

/** Retry-After in seconds (delta-seconds or an HTTP date), or null. */
export function retryAfterSeconds(value, now = Date.now()) {
  if (value === undefined || value === null || value === "") return null;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.ceil(Number(s));
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.max(0, Math.ceil((t - now) / 1000));
}

const LIMIT_HEADERS = /^(x-ratelimit-|ratelimit-|x-request-id$|request-id$|openai-processing-ms$)/;
/** The allowlisted headers of an upstream answer. */
export function observedHeaders(headers) {
  const out = {};
  for (const [k, v] of headers) if (k === "retry-after" || LIMIT_HEADERS.test(k)) out[k] = v;
  return out;
}

/**
 * 03-ARCH §H classes: auth | payment | quota | rate-limit | server | bad-request | unknown.
 * @param {number} status
 * @param {{ code?: string, type?: string, message?: string } | null} error
 */
export function classifyProviderError(status, error) {
  const text = `${error?.code ?? ""} ${error?.type ?? ""} ${error?.message ?? ""}`.toLowerCase();
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "payment";
  if (status === 429) return /insufficient_quota|quota|free-models|credits|billing/.test(text) ? "quota" : "rate-limit";
  if (status >= 500) return "server";
  if (status >= 400) return "bad-request";
  return "unknown";
}

/** The error object of a non-2xx JSON body (redacted, message ≤ 300 characters). */
export function errorFromBody(status, text) {
  let e = null;
  try {
    const j = JSON.parse(text);
    e = typeof j?.error === "object" && j.error ? j.error : typeof j?.error === "string" ? { message: j.error } : j?.message ? { message: j.message } : null;
  } catch {
    e = text ? { message: text } : null;
  }
  const message = redact(String(e?.message ?? "")).slice(0, 300);
  const error = { status, type: e?.type ?? null, code: e?.code === undefined ? null : String(e.code), message, ...bodyFacts(e) };
  return { ...error, class: classifyProviderError(status, error) };
}

const short = (v) => (typeof v === "string" || typeof v === "number" ? redact(String(v)).slice(0, 120) : null);
// The few facts a failure's class needs (P4.3), never more of the body: Google's status,
// quota ids and retry delay; OpenRouter's limit source (its remaining-requests header in the
// body is per minute as often as per day, so ad asks /key instead).
function bodyFacts(e) {
  if (!e || typeof e !== "object") return {};
  const out = {};
  if (typeof e.status === "string") out.statusText = short(e.status);
  const details = Array.isArray(e.details) ? e.details : [];
  const quotaIds = details.flatMap((d) => (Array.isArray(d?.violations) ? d.violations.map((v) => short(v?.quotaId)).filter(Boolean) : [])).slice(0, 8);
  if (quotaIds.length) out.quotaIds = quotaIds;
  const delay = details.find((d) => typeof d?.retryDelay === "string")?.retryDelay;
  if (delay) out.retryDelay = short(delay);
  const meta = e.metadata && typeof e.metadata === "object" ? e.metadata : null;
  if (meta?.limit_source) out.limitSource = short(meta.limit_source);
  return out;
}

const EVENT_CAP = 1024 * 1024;
/**
 * A tap on a Responses SSE stream: parses only response.completed (usage) and
 * response.failed / error events; holds at most one event (≤ 1 MB) at a time.
 */
export function sseTap() {
  const decoder = new TextDecoder();
  let buf = "";
  const seen = { usage: null, error: null };
  const handle = (block) => {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (!data || !/"type":"(response\.completed|response\.failed|error)"/.test(data)) return;
    try {
      const e = JSON.parse(data);
      if (e.type === "response.completed") seen.usage = e.response?.usage ?? null;
      else seen.error = errorFromBody(200, JSON.stringify({ error: e.response?.error ?? e.error ?? { message: e.message } }));
    } catch {
      // a malformed event: the engine reports it; the gateway only observes
    }
  };
  return {
    push(chunk) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const m = /\r?\n\r?\n/.exec(buf.slice(i));
        handle(buf.slice(0, i));
        buf = buf.slice(i + m[0].length);
      }
      if (buf.length > EVENT_CAP) buf = "";
    },
    result: () => seen,
  };
}

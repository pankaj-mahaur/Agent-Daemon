// ad's own requests to a provider (P3.5): key tests, model lists, the OpenRouter key
// exchange. Never through the engine. Rules: User-Agent ad/<version>; a key goes only to
// https (or a loopback address); a redirect is never followed with a key; 15 s for the
// whole answer, body included.
//
//   providerRequest({ url, method, key, body, headers, fetch, clientVersion, timeoutMs })
//     → { status, json, text, headers }   or throws PROVIDER_UNREACHABLE / PROVIDER_REDIRECT
// An error never carries the runtime's own message: it can quote a header, the key with it.

export const HTTP_TEXTS = Object.freeze({
  PROVIDER_REDIRECT: "The server redirected; ad doesn't send keys across redirects.",
  PROVIDER_UNREACHABLE: (host, why) => `Couldn't reach ${host} (${why}).`,
  INSECURE_URL: "http:// sends your key unencrypted. Use https, or --insecure for a host you control.",
});

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
export const isLoopback = (u) => {
  try {
    return LOOPBACK_HOSTS.has(new URL(u).hostname);
  } catch {
    return false;
  }
};

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
// Only a system error code (ECONNREFUSED, ENOTFOUND…) or ad's own words.
const reasonOf = (e, aborted) => {
  if (aborted) return "timed out";
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,40}$/.test(code) ? code : "network error";
};

export async function providerRequest({ url, method = "GET", key = null, body, headers = {}, fetch: f = globalThis.fetch, clientVersion = "dev", timeoutMs = 15_000, insecure = false }) {
  const u = new URL(url);
  if (key && u.protocol !== "https:" && !isLoopback(url) && !insecure) throw fail("INSECURE_URL", HTTP_TEXTS.INSECURE_URL);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await f(url, {
        method,
        redirect: "manual",
        signal: ac.signal,
        headers: { "user-agent": `ad/${clientVersion}`, accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw fail("PROVIDER_UNREACHABLE", HTTP_TEXTS.PROVIDER_UNREACHABLE(u.host, reasonOf(e, ac.signal.aborted)), { host: u.host });
    }
    if (res.status >= 300 && res.status < 400) throw fail("PROVIDER_REDIRECT", HTTP_TEXTS.PROVIDER_REDIRECT, { status: res.status });
    let text;
    try {
      text = await res.text();
    } catch (e) {
      throw fail("PROVIDER_UNREACHABLE", HTTP_TEXTS.PROVIDER_UNREACHABLE(u.host, reasonOf(e, ac.signal.aborted)), { host: u.host });
    }
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

// The provider gateway's loopback server (P3.3, D18). Runs inside the gateway child
// (main.mjs); keys arrive over IPC and live only in this process's memory.
//
// Per request, in order:
//   1. the capability token (SHA-256 digests compared in constant time); 401 with no
//      detail otherwise, before anything else is looked at
//   2. the raw path /p/<entry>/v1/<rest>: dot segments, %2e, %2f, %5c, backslashes and
//      empty segments → 400; a query string only on GET models
//   3. only POST responses and GET models → else 403 (the engine calls nothing else,
//      S-GATEWAY G4); unknown entry → 404 with ad's text
//   4. body cap → 413; in-flight cap → 503
//   5. the route's upstream (passthrough), with the account's auth and
//      accept-encoding: identity; a body the provider compressed anyway is decoded and
//      sent on without content-encoding (the engine doesn't decompress, S-GATEWAY G11)
//   6. never a redirect (502); never plain http unless the route allows it; an
//      unreachable upstream → 502 (the engine retries an HTTP error a bounded number of
//      times, a refused connection without end)
//   7. a 429/503 asking to wait longer than the cap → an immediate 429 the engine treats
//      as final for the turn, so no turn sleeps for an hour; the real wait goes to the event
// Exactly one onUpstream event per request (status, limits, usage, classified error,
// timings) when it ends or fails: never content, a key or the token.

import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { ulid } from "../ids.mjs";
import { errorFromBody, observedHeaders, retryAfterSeconds, sseTap } from "./observe.mjs";
import { TRANSLATED_MODES, failedStream, failure, pipeAnswer, prepare, refusalBody } from "./translate/index.mjs";

// Per-model routes (P3.6): a model the provider serves on another wire answers like this.
// The refusal must be about the model (not a parameter: "reasoning_effort is not
// supported for this endpoint" leaves the wire alone).
const ENDPOINT_REFUSAL = /\bmodel\b[^.]*\bnot (available|supported) (on|for|via) this endpoint/i;
const notYet = (route) => `This ${route.label ?? "provider's"} model isn't available to ad yet. Pick another with /model.`;
// The engine's conversation id, from the request's metadata.
const threadOf = (j) => {
  const m = j?.client_metadata && typeof j.client_metadata === "object" ? j.client_metadata : {};
  return typeof m.thread_id === "string" ? m.thread_id : typeof m.session_id === "string" ? m.session_id : null;
};
// A provider's own quota error by name (OpenCode's GoUsageLimitError) in an error body.
const namedQuota = (text, names) => names.some((n) => new RegExp(`"(type|code|error_code)"\\s*:\\s*"${n}"`).test(text));

// A translated route's side-channel kind → the observation's error class (03-ARCH §H).
const KIND_CLASS = { quotaExhausted: "quota", rateLimit: "rate-limit", provider5xx: "server", transientNetwork: "server", authExpired: "auth", authRevoked: "auth", contextOverflow: "bad-request", invalidConfig: "bad-request", unknown: "unknown" };

const ENTRY_RE = /^[a-z0-9-]{1,64}$/;
const HOP = new Set(["authorization", "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "accept-encoding", "expect"]);
const OUT_DROP = new Set(["connection", "keep-alive", "transfer-encoding", "set-cookie", "content-encoding", "content-length", "upgrade", "trailer"]);
const REFRESH_MARGIN_MS = 60_000;
const ERROR_BODY_CAP = 1024 * 1024;
const JSON_ANSWER_CAP = 16 * 2 ** 20;

const digest = (s) => createHash("sha256").update(String(s)).digest();
const json = (res, status, body, headers = {}) => {
  if (res.headersSent) return void res.destroy();
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
};
const adError = (res, status, message, extra = {}) => json(res, status, { error: { type: status >= 500 ? "server_error" : "invalid_request_error", message, ...extra } });

/** The rest of a /p/<entry>/v1/<rest> path, or a refusal. */
export function parseTarget(rawUrl) {
  const q = rawUrl.indexOf("?");
  const pathPart = q >= 0 ? rawUrl.slice(0, q) : rawUrl;
  const query = q >= 0 ? rawUrl.slice(q) : "";
  const m = /^\/p\/([^/]+)\/v1\/(.*)$/.exec(pathPart);
  if (!m) return { error: 404 };
  const [, entry, rest] = m;
  if (!ENTRY_RE.test(entry)) return { error: 400 };
  if (/\\/.test(pathPart) || /%(2e|2f|5c)/i.test(pathPart)) return { error: 400 };
  const segs = rest.split("/");
  if (!rest || segs.some((s) => s === "" || s === "." || s === "..")) return { error: 400 };
  return { entry, rest, query };
}

/**
 * @param {{ token: string, table: Map<string, any>, keys: Record<string,string>, onUpstream?: (e:any)=>void,
 *           retryAfterCapS?: number, maxInFlight?: number, maxBodyBytes?: number, idleTimeoutMs?: number,
 *           connectTimeoutMs?: number, fetchImpl?: typeof fetch }} o
 */
export function createGatewayServer({ token, table, keys = {}, onUpstream = () => {}, retryAfterCapS = 60, maxInFlight = 16, maxBodyBytes = 64 * 2 ** 20, idleTimeoutMs = 300_000, connectTimeoutMs = 15_000, fetchImpl = fetch, sealKey = null, translate = true, sessionId = randomUUID() }) {
  // The reasoning envelope's key: 32 bytes, or their base64 (as it crosses IPC).
  const seal = !sealKey ? null : typeof sealKey === "string" ? Buffer.from(sealKey, "base64") : Buffer.from(sealKey);
  const salt = token.slice(0, 16); // per run: Mistral's call ids are derived within one request anyway
  const tokenDigest = digest(token);
  let routes = table;
  let keyMap = new Map(Object.entries(keys));
  const tokens = new Map(); // route entry → { token, expiresAt } (token-provider auth)
  let inFlight = 0;

  async function authHeader(entry, route, { force = false } = {}) {
    const a = route.auth ?? { kind: "static-key", scheme: "bearer" };
    if (a.kind === "none") return {};
    if (a.kind === "static-key") {
      const key = keyMap.get(route.accountId);
      if (!key) return null;
      return a.scheme === "header" ? { [a.header]: key } : { authorization: `Bearer ${key}` };
    }
    if (a.kind === "token-provider") {
      let t = tokens.get(entry);
      if (!t && !force) t = await a.provider.getToken({ force: false });
      // Forced (a 401), or close to expiry (also a token that arrives that way): refresh.
      if (force || !t || t.expiresAt - Date.now() < REFRESH_MARGIN_MS) t = await a.provider.getToken({ force: true });
      tokens.set(entry, t);
      return { authorization: `Bearer ${t.token}` };
    }
    return null;
  }

  // Any failure inside one request ends that request, never the gateway (every account's).
  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) adError(res, 502, "ad: the gateway failed on this request");
      else res.destroy();
    });
  });

  async function handle(req, res) {
    // 1. The token, first.
    const m = /^Bearer\s+(.+)$/.exec(String(req.headers.authorization ?? ""));
    if (!m || !timingSafeEqual(digest(m[1]), tokenDigest)) return void res.writeHead(401).end();
    // 2-3. The path.
    const t = parseTarget(req.url ?? "");
    if (t.error === 400) return void adError(res, 400, "ad: this path isn't allowed");
    if (t.error) return void adError(res, 404, "ad: this account isn't available any more");
    const isResponses = req.method === "POST" && t.rest === "responses";
    const isModels = req.method === "GET" && t.rest === "models";
    if (t.query && !isModels) return void adError(res, 400, "ad: this path isn't allowed");
    if (!isResponses && !isModels) return void adError(res, 403, "ad: the gateway doesn't forward this request");
    const route = routes.get(t.entry);
    if (!route) return void adError(res, 404, "ad: this account isn't available any more");
    // per-model (OpenCode Go): passthrough or chat by the requested model's wire, below.
    const perModel = route.mode === "per-model";
    let translated = TRANSLATED_MODES.includes(route.mode);
    if (route.mode !== "passthrough" && !translated && !perModel) return void adError(res, 502, "ad: this version can't talk to this provider's API yet");
    if (translated && !translate) return void adError(res, 502, "ad: providers that need translation are turned off (AD_TRANSLATE=0)");

    const at = new Date();
    const ev = { requestId: ulid(), upstreamRequestId: null, at: at.toISOString(), accountId: route.accountId, providerEntry: t.entry, path: t.rest, status: null, headers: {}, retryAfterS: null, rateLimit: {}, usage: null, error: null, firstByteMs: null, durationMs: null, aborted: false };
    let emitted = false;
    const emit = () => {
      if (emitted) return;
      emitted = true;
      ev.durationMs = Date.now() - at.getTime();
      try {
        onUpstream(ev);
      } catch {
        // an observer's failure never touches the request
      }
    };

    // 4. Caps.
    if (inFlight >= maxInFlight) {
      ev.status = 503;
      emit();
      return void adError(res, 503, "ad: too many requests at once");
    }
    inFlight++;
    const done = () => {
      inFlight--;
      emit();
    };
    let body = Buffer.alloc(0);
    let prepared = null;
    let conversation = null; // the engine's thread: the session header's value
    let reqModel = "";
    let wire = null;
    let tRoute = route; // the route as this request's model needs it (per-model quirks)
    if (isResponses) {
      const chunks = [];
      let size = 0;
      let over = false;
      for await (const c of req) {
        size += c.length;
        if (size > maxBodyBytes) {
          over = true;
          break;
        }
        chunks.push(c);
      }
      if (over) {
        ev.status = 413;
        done();
        return void adError(res, 413, "ad: the request is too large");
      }
      body = Buffer.concat(chunks);
      if (perModel || route.sessionHeader) {
        let j = null;
        try {
          j = JSON.parse(body.toString("utf8"));
        } catch {
          j = null;
        }
        conversation = threadOf(j);
        reqModel = typeof j?.model === "string" ? j.model : "";
      }
      if (perModel) {
        wire = route.learned?.get(reqModel) ?? route.wires?.[reqModel] ?? "chat";
        if (wire !== "responses" && wire !== "chat") {
          const message = notYet(route);
          ev.status = 400;
          ev.translate = { kind: "invalidConfig", message };
          ev.error = { status: 400, type: null, code: "invalid_request", message, class: "bad-request" };
          done();
          return void json(res, 400, { error: { type: "invalid_request_error", code: "invalid_request", param: "model", message } });
        }
        translated = wire === "chat";
        // A model's own rules (DeepSeek's reasoning replay on OpenCode Go's DeepSeek models).
        const own = route.modelQuirks?.[reqModel];
        if (own?.length) tRoute = { ...route, quirks: [...(route.quirks ?? []), ...own] };
        if (translated && !translate) {
          ev.status = 502;
          done();
          return void adError(res, 502, "ad: providers that need translation are turned off (AD_TRANSLATE=0)");
        }
      }
      if (translated) {
        // Responses → Chat; what can't be carried is refused here, before any upstream call.
        try {
          prepared = prepare(body, tRoute, { sealKey: seal, salt });
          body = prepared.body;
          ev.threadId = prepared.threadId;
        } catch (e) {
          const refused = e?.code === "TRANSLATE_REFUSED";
          ev.status = refused ? 400 : 502;
          ev.translate = { kind: "invalidConfig", message: String(e?.message ?? e) };
          ev.error = { status: ev.status, type: null, code: refused ? "invalid_request" : "translate_config", message: ev.translate.message.slice(0, 300), class: "bad-request" };
          done();
          return void (refused ? json(res, 400, refusalBody(e)) : adError(res, 502, `ad: ${ev.translate.message}`));
        }
      } else if (route.strip?.length) {
        try {
          const j = JSON.parse(body.toString("utf8"));
          for (const k of route.strip) delete j[k];
          body = Buffer.from(JSON.stringify(j));
        } catch {
          // not JSON: forwarded as it is; the provider answers
        }
      }
    }

    // 5. Upstream.
    let target;
    try {
      // A translated request goes to the preset's path (never one from the request).
      const rest = prepared ? String(prepared.path).replace(/^\/+/, "") : t.rest;
      target = new URL(`${String(route.upstreamBase).replace(/\/+$/, "")}/${rest}${prepared ? "" : t.query}`);
    } catch {
      ev.status = 502;
      done();
      return void adError(res, 502, "ad: this account's endpoint isn't a valid address");
    }
    // A key never travels in an address (logs and proxies keep URLs): any key-like query
    // parameter is refused, whoever put it there.
    if ([...target.searchParams.keys()].some((k) => /^(key|api[_-]?key|access[_-]?token|token)$/i.test(k))) {
      ev.status = 502;
      done();
      return void adError(res, 502, "ad: a key in a request address is never sent");
    }
    if (target.protocol !== "https:" && !route.allowHttp) {
      ev.status = 502;
      done();
      return void adError(res, 502, `ad: ${target.host} isn't https, so ad won't send a key to it (add the account with --insecure if it is local)`);
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
    headers["accept-encoding"] = "identity";
    if (prepared) {
      headers["content-type"] = "application/json";
      headers.accept = "text/event-stream";
    }
    Object.assign(headers, route.headers ?? {});
    // A stable id per conversation (the provider routes and caches by it); outside a
    // conversation (the model list), this gateway's own.
    if (route.sessionHeader) headers[route.sessionHeader] = conversation ?? sessionId;

    const ac = new AbortController();
    let clientGone = false;
    res.on("close", () => {
      if (!res.writableFinished) {
        clientGone = true;
        ev.aborted = true;
        ac.abort();
      }
    });
    const send = async (auth) => {
      const connect = setTimeout(() => ac.abort(new Error("connect timeout")), connectTimeoutMs);
      try {
        return await fetchImpl(target, { method: req.method, headers: { ...headers, ...auth }, body: isResponses ? body : undefined, redirect: "manual", signal: ac.signal });
      } finally {
        clearTimeout(connect);
      }
    };

    let up;
    try {
      let auth = await authHeader(t.entry, route);
      if (!auth) {
        ev.status = 502;
        done();
        return void adError(res, 502, "ad: this account's key isn't available (run: ad auth status)");
      }
      up = await send(auth);
      // token-provider: one refresh and one retry on 401, then the 401 passes through.
      if (up.status === 401 && route.auth?.kind === "token-provider") {
        await up.body?.cancel().catch(() => {});
        auth = await authHeader(t.entry, route, { force: true });
        up = await send(auth);
      }
    } catch (e) {
      ev.status = 502;
      if (clientGone) {
        done();
        return;
      }
      const reason = e?.cause?.code ?? e?.code ?? (String(e?.message ?? e).includes("timeout") ? "timed out" : "network error");
      ev.error = { status: 502, type: "server_error", code: String(reason), message: `couldn't reach ${target.host}`, class: "server" };
      done();
      return void adError(res, 502, `ad: couldn't reach ${target.host} (${reason})`);
    }
    ev.firstByteMs = Date.now() - at.getTime();
    ev.status = up.status;
    ev.headers = observedHeaders(up.headers);
    ev.upstreamRequestId = up.headers.get("x-request-id") ?? up.headers.get("request-id") ?? null;
    ev.retryAfterS = retryAfterSeconds(up.headers.get("retry-after"));
    for (const [k, v] of Object.entries(ev.headers)) if (/ratelimit/.test(k)) ev.rateLimit[k] = v;

    // 6. Never a redirect with a key.
    if (up.status >= 300 && up.status < 400) {
      await up.body?.cancel().catch(() => {});
      ev.error = { status: up.status, type: null, code: "redirect", message: "redirect refused", class: "server" };
      done();
      return void adError(res, 502, "ad: the provider redirected; ad doesn't send keys across redirects");
    }

    const outHeaders = {};
    for (const [k, v] of up.headers) if (!OUT_DROP.has(k)) outHeaders[k] = v;

    // Errors: read (≤ 1 MB), observe, then cap or forward.
    if (up.status >= 400) {
      let text = "";
      try {
        const buf = Buffer.from(await up.arrayBuffer());
        text = buf.subarray(0, ERROR_BODY_CAP).toString("utf8");
      } catch {
        text = "";
      }
      ev.error = errorFromBody(up.status, text);
      if (perModel && (up.status === 400 || up.status === 404) && ENDPOINT_REFUSAL.test(String(ev.error?.message ?? ""))) {
        // The model lives on the other wire, said plainly. Only a model the dated table
        // doesn't list is tried on the other wire for the rest of this run; a listed one
        // keeps its wire (a parameter error must never move it).
        if (!route.wires?.[reqModel]) (route.learned ??= new Map()).set(reqModel, wire === "responses" ? "chat" : "responses");
        const message = notYet(route);
        ev.translate = { kind: "invalidConfig", message };
        done();
        return void json(res, 400, { error: { type: "invalid_request_error", code: "invalid_request", param: "model", message } });
      }
      if (prepared || (route.quotaErrors?.length && namedQuota(text, route.quotaErrors))) {
        // Only codes the engine knows; the real reason goes to the event.
        const f = failure(up.status, text, { retryAfter: up.headers.get("retry-after"), route, capS: retryAfterCapS, headers: up.headers });
        ev.translate = f.side;
        ev.error = { ...ev.error, class: KIND_CLASS[f.side.kind] ?? ev.error.class };
        done();
        if (f.sse) return void failedStream(res, f.sse);
        return void json(res, f.http.status, f.http.body, f.http.headers);
      }
      // 7. The Retry-After cap.
      if ((up.status === 429 || up.status === 503) && ev.retryAfterS !== null && ev.retryAfterS > retryAfterCapS) {
        const mins = Math.ceil(ev.retryAfterS / 60);
        const until = new Date(Date.now() + ev.retryAfterS * 1000);
        const hhmm = `${String(until.getHours()).padStart(2, "0")}:${String(until.getMinutes()).padStart(2, "0")}`;
        done();
        return void json(res, 429, { error: { type: "insufficient_quota", code: "insufficient_quota", message: `${route.label ?? "The provider"} asks to wait ${mins} min (until ${hhmm}).` } }, { "retry-after": "0" });
      }
      done();
      return void res.writeHead(up.status, outHeaders).end(text);
    }

    if (prepared) {
      // Success on a translated route: Chat stream → Responses stream, with the idle timeout.
      let idle = setTimeout(() => ac.abort(new Error("idle")), idleTimeoutMs);
      const isJson = /application\/json/i.test(up.headers.get("content-type") ?? "");
      async function* watched() {
        if (isJson) {
          // A provider that ignored stream: true answers with one JSON completion: read (capped)
          // and handed on as one compact event; unreadable or too large reads as a cut-off.
          const chunks = [];
          let size = 0;
          for await (const c of Readable.fromWeb(up.body)) {
            size += c.length;
            if (size > JSON_ANSWER_CAP) return;
            chunks.push(c);
          }
          let one;
          try {
            one = JSON.stringify(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            return;
          }
          yield Buffer.from(`data: ${one}\n\ndata: [DONE]\n\n`);
          return;
        }
        if (!up.body) return;
        for await (const chunk of Readable.fromWeb(up.body)) {
          clearTimeout(idle);
          idle = setTimeout(() => ac.abort(new Error("idle")), idleTimeoutMs);
          yield chunk;
        }
      }
      // The observation goes out before the engine reads the turn's end, so ad's reason is
      // there when the turn's failure is shown.
      const observe = (r) => {
        ev.usage = r.usage;
        if (r.side) {
          ev.translate = r.side;
          if (KIND_CLASS[r.side.kind]) ev.error = { status: 200, type: null, code: r.side.kind, message: String(r.side.message ?? "").slice(0, 300), class: KIND_CLASS[r.side.kind] };
        }
        if (clientGone) ev.aborted = true;
        emit();
      };
      try {
        observe(await pipeAnswer(watched(), res, { turn: prepared.turn, route: tRoute, sealKey: seal, capS: retryAfterCapS, signal: ac.signal, onTerminal: observe }));
      } finally {
        clearTimeout(idle);
        done();
      }
      return;
    }

    // Success: stream with backpressure; tap the events; idle timeout.
    res.writeHead(up.status, outHeaders);
    const tap = sseTap();
    let idle = setTimeout(() => ac.abort(new Error("idle")), idleTimeoutMs);
    const stream = up.body ? Readable.fromWeb(up.body) : null;
    if (!stream) {
      clearTimeout(idle);
      res.end();
      return void done();
    }
    stream.on("data", (chunk) => {
      clearTimeout(idle);
      idle = setTimeout(() => ac.abort(new Error("idle")), idleTimeoutMs);
      tap.push(chunk);
      if (!res.write(chunk)) {
        stream.pause();
        res.once("drain", () => stream.resume());
      }
    });
    stream.on("end", () => {
      clearTimeout(idle);
      const seen = tap.result();
      ev.usage = seen.usage;
      if (seen.error) ev.error = seen.error;
      res.end();
      done();
    });
    stream.on("error", () => {
      clearTimeout(idle);
      if (clientGone) ev.aborted = true;
      res.destroy();
      done();
    });
  }

  return {
    listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))),
    /** A new table and the keys of its accounts; keys of accounts that left are dropped. */
    setTable(nextTable, nextKeys = {}) {
      routes = nextTable;
      keyMap = new Map(Object.entries(nextKeys));
      for (const e of [...tokens.keys()]) if (!routes.has(e)) tokens.delete(e);
    },
    keyCount: () => keyMap.size,
    close: () => {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// The S-GATEWAY prototype (P3.1, D18): a loopback HTTP gateway between the engine and
// API providers, so no provider key is ever in the engine's process tree. Test-only;
// P3.3 builds the real gateway in runtime/src.
//
//   startGatewayProto({ entries: { <entry>: { upstream, key } }, token })
//     → { origin, token, providerConfig(entry), seen, close }
//
// The engine gets AD_GATEWAY_TOKEN=<token> and, per entry,
//   -c model_providers.<entry>={ base_url = "<origin>/p/<entry>/v1", env_key = "AD_GATEWAY_TOKEN", ... }
// A request to /p/<entry>/v1/<rest> must carry `Bearer <token>`; the gateway swaps it
// for the entry's key, asks the upstream for an uncompressed body, streams the answer
// back unchanged, and aborts the upstream request when the engine hangs up. `seen`
// records what the gateway observed (status, Retry-After, x-ratelimit-*, the usage of
// response.completed, error bodies): what the engine itself drops.

import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes } from "node:crypto";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

const HOP = new Set(["host", "connection", "authorization", "content-length", "accept-encoding", "keep-alive", "transfer-encoding"]);

export async function startGatewayProto({ entries = {}, token = randomBytes(32).toString("hex") } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    const m = /^\/p\/([a-z0-9-]+)\/v1(\/[^?]*)?(\?.*)?$/.exec(req.url ?? "");
    const entry = m && entries[m[1]];
    if (!entry) return void res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "gateway: no such entry" } }));
    if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "gateway: wrong token" } }));
    const target = new URL(`${entry.upstream.replace(/\/$/, "")}${m[2] ?? ""}${m[3] ?? ""}`);
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.has(k)));
    headers.authorization = `Bearer ${entry.key}`;
    headers["accept-encoding"] = "identity";
    const rec = { entry: m[1], method: req.method, path: m[2] ?? "/", status: null, retryAfter: null, rateLimit: {}, usage: null, errorBody: null, firstByteMs: null };
    seen.push(rec);
    const t0 = Date.now();
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const up = send(target, { method: req.method, headers }, (upRes) => {
      rec.status = upRes.statusCode;
      rec.retryAfter = upRes.headers["retry-after"] ?? null;
      for (const [k, v] of Object.entries(upRes.headers)) if (k.startsWith("x-ratelimit-")) rec.rateLimit[k] = v;
      const out = Object.fromEntries(Object.entries(upRes.headers).filter(([k]) => !["connection", "transfer-encoding", "content-encoding", "content-length"].includes(k)));
      res.writeHead(upRes.statusCode ?? 502, out);
      // An upstream that compresses although asked not to (S-GATEWAY G11): decode here,
      // since the content-encoding header no longer reaches the engine.
      const enc = String(upRes.headers["content-encoding"] ?? "").toLowerCase();
      const body = enc === "gzip" ? upRes.pipe(createGunzip()) : enc === "br" ? upRes.pipe(createBrotliDecompress()) : enc === "deflate" ? upRes.pipe(createInflate()) : upRes;
      let tail = "";
      body.on("data", (chunk) => {
        if (rec.firstByteMs === null) rec.firstByteMs = Date.now() - t0;
        res.write(chunk);
        // Observe without buffering the stream: the completed event's usage, error bodies.
        tail = (tail + chunk.toString("utf8")).slice(-65536);
        const done = /"type":"response\.completed".*?"usage":(\{[^}]*\})/s.exec(tail);
        if (done) {
          try {
            rec.usage = JSON.parse(done[1]);
          } catch {
            // a usage block split across chunks: the next chunk retries
          }
        }
      });
      body.on("end", () => {
        if ((upRes.statusCode ?? 0) >= 400) rec.errorBody = tail.slice(0, 4096);
        res.end();
      });
      body.on("error", () => res.destroy());
    });
    up.on("error", (e) => {
      rec.status = 502;
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `gateway: upstream unreachable (${e.code ?? e.message})` } }));
      else res.destroy();
    });
    // The engine hung up (an interrupt): abort the upstream request too.
    res.on("close", () => {
      if (!res.writableEnded) {
        rec.aborted = true;
        up.destroy();
      }
    });
    req.pipe(up);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    token,
    seen,
    /** The -c value for this entry (an inline TOML table). */
    providerConfig: (entry, name = entry) => `model_providers.${entry}={ name = "${name}", base_url = "${origin}/p/${entry}/v1", env_key = "AD_GATEWAY_TOKEN", wire_api = "responses", supports_websockets = false, request_max_retries = 0, stream_max_retries = 0 }`,
    close: () => {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

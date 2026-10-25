// A scripted provider for the native adapters (P6.4): Anthropic's Messages stream (named
// SSE events) and Gemini's streamGenerateContent (data-only SSE). The script answers each
// request; what was sent is recorded (method, the full request line, headers, body), so
// tests can check that a key never travels in an address.
//
//   startMockNative({ script }) → { url, requests, close() }
//   script(req, { count }) → { events: [{ event?, data }], destroy? } | { status, json, headers? }

import { createServer } from "node:http";

export const anthropicSse = (events) => events.map((e) => ({ event: e.type, data: e }));

export async function startMockNative({ script }) {
  const requests = [];
  let count = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = { invalid: true };
      }
      const r = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(r);
      const out = script(r, { count: ++count });
      if (out.status) {
        res.writeHead(out.status, { "content-type": "application/json", ...(out.headers ?? {}) });
        return void res.end(JSON.stringify(out.json ?? {}));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const e of out.events) res.write(`${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`);
      if (out.destroy) return void res.socket?.destroy();
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close() {
      server.closeAllConnections?.();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

// Tests for `ad web` (harness/web.mjs) against the fake app-server.
// Security properties first: token required, non-loopback Host rejected,
// strict CSP with a nonce. Then a chat turn with an approval answered over
// HTTP while events stream over SSE.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isLoopbackHost, recentLoops, startWebServer, tokenOk } from "../src/harness/web.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };

function req(port, method, path, { token, host = `127.0.0.1:${port}`, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path, headers: { host, ...(token ? { "x-ad-token": token } : {}), "content-type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data, json: () => JSON.parse(data) }));
    });
    r.on("error", reject);
    r.end(body ? JSON.stringify(body) : undefined);
  });
}

function sse(port, token, onEvent) {
  return new Promise((resolve) => {
    const r = http.get({ host: "127.0.0.1", port, path: `/api/events?t=${token}`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let buf = "";
      res.on("data", (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (chunk.startsWith("data: ")) onEvent(JSON.parse(chunk.slice(6)));
        }
      });
      resolve(r);
    });
  });
}

async function withWeb(fn) {
  const root = mkdtempSync(join(tmpdir(), "ad-web-"));
  const web = await startWebServer({ cwd: root, userHome: root, engineOpts: { home: join(root, "home"), command, store: { get: () => null } }, err: { write: () => true } });
  try {
    await fn(web, root);
  } finally {
    await web.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("helpers: loopback host check and constant-time token compare", () => {
  assert.ok(isLoopbackHost("127.0.0.1:4800", 4800));
  assert.ok(isLoopbackHost("localhost:4800", 4800));
  assert.ok(!isLoopbackHost("evil.example:4800", 4800), "DNS rebinding host");
  assert.ok(!isLoopbackHost("127.0.0.1:1", 4800));
  assert.ok(tokenOk("abc", "abc"));
  assert.ok(!tokenOk("abd", "abc"));
  assert.ok(!tokenOk(undefined, "abc"));
});

test("API needs the token; a foreign Host is refused; the page has a nonce CSP", async () => {
  await withWeb(async (web) => {
    assert.equal((await req(web.port, "GET", "/api/overview")).status, 401);
    assert.equal((await req(web.port, "GET", "/api/overview", { token: "wrong" })).status, 401);
    assert.equal((await req(web.port, "GET", "/api/overview", { token: web.token, host: "evil.example" })).status, 421);
    const page = await req(web.port, "GET", "/");
    assert.equal(page.status, 200);
    const csp = page.headers["content-security-policy"];
    const nonce = csp.match(/'nonce-([^']+)'/)[1];
    assert.ok(page.body.includes(`<script nonce="${nonce}">`));
    assert.ok(!csp.includes("script-src 'unsafe-inline'"));
    assert.ok(!page.body.includes(web.token), "the token is never baked into the page");
  });
});

test("overview reports login, threads, schedules and loops", async () => {
  await withWeb(async (web, root) => {
    mkdirSync(join(root, ".agent-daemon", "loops"), { recursive: true });
    writeFileSync(join(root, ".agent-daemon", "loops", "t-1.jsonl"), JSON.stringify({ ts: "2026-10-01T00:00:00Z", turnStatus: "completed", status: { progress: "did it" } }) + "\n");
    const o = (await req(web.port, "GET", "/api/overview", { token: web.token })).json();
    assert.equal(o.login, "ChatGPT plus");
    assert.equal(o.threads[0].id, "thread-old");
    assert.deepEqual(o.loops, [{ threadId: "t-1", iterations: 1, last: { ts: "2026-10-01T00:00:00Z", turnStatus: "completed", progress: "did it" } }]);
    assert.deepEqual(recentLoops(join(root, "nope")), []);
  });
});

test("chat streams over SSE and an approval is answered over HTTP", async () => {
  await withWeb(async (web) => {
    const events = [];
    let resolveDone;
    const done = new Promise((r) => (resolveDone = r));
    const stream = await sse(web.port, web.token, async (ev) => {
      events.push(ev);
      if (ev.type === "approval") await req(web.port, "POST", "/api/approval", { token: web.token, body: { id: ev.id, answer: "y" } });
      if (ev.type === "done") resolveDone();
    });
    await new Promise((r) => setTimeout(r, 50));
    const r = await req(web.port, "POST", "/api/chat", { token: web.token, body: { text: "do it" } });
    assert.equal(r.status, 200);
    await done;
    stream.destroy();
    assert.equal(events[0].type, "user");
    const approval = events.find((e) => e.type === "approval");
    assert.equal(approval.command, "rm -rf /");
    assert.equal(events.filter((e) => e.type === "delta").map((e) => e.text).join(""), "pong[accept]");
    assert.equal(events.at(-1).status, "completed");
    assert.equal((await req(web.port, "POST", "/api/chat", { token: web.token, body: { text: "" } })).status, 400);
  });
});

test("with no page connected, approvals are declined", async () => {
  await withWeb(async (web) => {
    await req(web.port, "POST", "/api/chat", { token: web.token, body: { text: "do it" } });
    await new Promise((r) => setTimeout(r, 1500));
    const o = (await req(web.port, "GET", "/api/overview", { token: web.token })).json();
    assert.equal(o.running, false, "turn finished instead of waiting forever");
  });
});

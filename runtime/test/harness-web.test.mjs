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
import { waitFor } from "../testkit/wait.mjs";
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
    await waitFor(async () => !(await req(web.port, "GET", "/api/overview", { token: web.token })).json().running, { what: "turn to finish instead of waiting forever" });
  });
});

test("the only page disconnecting mid-approval declines it; the server keeps working", async () => {
  await withWeb(async (web) => {
    let approvalSeen;
    const seen = new Promise((r) => (approvalSeen = r));
    const stream = await sse(web.port, web.token, (ev) => ev.type === "approval" && approvalSeen(ev));
    await new Promise((r) => setTimeout(r, 50));
    await req(web.port, "POST", "/api/chat", { token: web.token, body: { text: "do it" } });
    await seen;
    stream.destroy(); // page closed / reloaded
    let o;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      o = (await req(web.port, "GET", "/api/overview", { token: web.token })).json();
      if (!o.running) break;
    }
    assert.equal(o.running, false, "turn finished with a decline instead of wedging");
    assert.equal((await req(web.port, "POST", "/api/new", { token: web.token })).status, 200);
  });
});

test("a pending approval is replayed to a page that connects later, with file paths", async () => {
  await withWeb(async (web) => {
    const first = [];
    const s1 = await sse(web.port, web.token, (ev) => first.push(ev));
    await new Promise((r) => setTimeout(r, 50));
    await req(web.port, "POST", "/api/chat", { token: web.token, body: { text: "edit-file" } });
    await waitFor(() => first.some((e) => e.type === "approval"), { what: "the approval" });
    const second = [];
    const s2 = await sse(web.port, web.token, (ev) => second.push(ev));
    const replayed = await waitFor(() => second.find((e) => e.type === "approval"), { what: "late page to see the waiting approval" });
    assert.deepEqual(replayed.paths, ["src/app.js"]);
    await req(web.port, "POST", "/api/approval", { token: web.token, body: { id: replayed.id, answer: "y" } });
    await waitFor(() => first.some((e) => e.type === "approvalResolved" && e.id === replayed.id), { what: "approvalResolved" });
    s1.destroy();
    s2.destroy();
  });
});

test("concurrent chats: exactly one starts; bad bodies are 400/413", async () => {
  await withWeb(async (web) => {
    const [a, b] = await Promise.all([
      req(web.port, "POST", "/api/chat", { token: web.token, body: { text: "hang" } }),
      req(web.port, "POST", "/api/chat", { token: web.token, body: { text: "hang" } }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    await req(web.port, "POST", "/api/interrupt", { token: web.token });
    const raw = (body) => new Promise((resolve) => {
      const r = http.request({ host: "127.0.0.1", port: web.port, method: "POST", path: "/api/chat", headers: { host: `127.0.0.1:${web.port}`, "x-ad-token": web.token } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      r.on("error", () => resolve("reset"));
      r.end(body);
    });
    assert.equal(await raw("{not json"), 400);
    assert.equal(await raw("[1,2]"), 400);
    assert.ok([413, "reset"].includes(await raw("x".repeat(70_000))));
  });
});

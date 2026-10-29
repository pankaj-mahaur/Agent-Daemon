// P8.4b E1 on the pinned engine (AD_REAL_ENGINE=1): with ad's privacy settings, a turn against a
// local mock model reaches no other host. Every outbound connection goes through a recording
// proxy (HTTP(S)_PROXY), which answers each one with a refusal and notes its host.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { CodexAppServer, resolveCodexCommand } from "../src/engine/codex/app-server.mjs";
import { startMockResponses, writeMockCodexHome } from "../testkit/mock-responses.mjs";
import { ENGINE_PRIVACY } from "../src/harness/setup.mjs";

const skip = process.env.AD_REAL_ENGINE === "1" ? false : "set AD_REAL_ENGINE=1 to run the real engine";

async function recorder() {
  const hosts = [];
  const server = http.createServer((req, res) => {
    hosts.push(new URL(req.url, "http://x").host || req.headers.host);
    res.writeHead(403).end();
  });
  server.on("connect", (req, socket) => {
    hosts.push(req.url);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { hosts, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(() => r())) };
}

async function turnThrough(proxy, extra = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-engine-net-"));
  const mock = await startMockResponses();
  const home = path.join(root, "home");
  writeMockCodexHome(home, { url: mock.url });
  // The update check on, as a real home has it unless ad turns it off.
  fs.writeFileSync(path.join(home, "config.toml"), fs.readFileSync(path.join(home, "config.toml"), "utf8").replace("check_for_update_on_startup = false", "check_for_update_on_startup = true"));
  const env = { CODEX_HOME: home, HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, https_proxy: proxy.url, http_proxy: proxy.url, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
  const app = new CodexAppServer({ command: resolveCodexCommand({}), cwd: root, env, codexArgs: extra, clientVersion: "test", initTimeoutMs: 120_000, onServerRequest: async () => "decline" });
  try {
    await app.start();
    const { thread } = await app.request("thread/start", { cwd: root });
    const done = new Promise((resolve) => app.on("notification", ({ method, params }) => method === "turn/completed" && params.threadId === thread.id && resolve()));
    await app.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "PING" }] });
    await done;
    await new Promise((r) => setTimeout(r, 4000)); // anything sent after the turn
  } finally {
    await app.close().catch(() => {});
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

const offArgs = [...ENGINE_PRIVACY({}).flatMap(([k, v]) => ["-c", `${k}=${JSON.stringify(v)}`]), "-c", "check_for_update_on_startup=false"];

test("with ad's privacy settings, a turn reaches only the model provider: no other host", { skip, timeout: 300_000 }, async () => {
  const proxy = await recorder();
  try {
    await turnThrough(proxy, offArgs);
    assert.deepEqual([...new Set(proxy.hosts)], [], `the engine tried: ${proxy.hosts.join(", ")}`);
  } finally {
    await proxy.close();
  }
});

test("for the record: what the engine tries without them (never fails; printed for docs/privacy.md)", { skip, timeout: 300_000 }, async (t) => {
  const proxy = await recorder();
  try {
    await turnThrough(proxy, []);
    t.diagnostic(`hosts without ad's settings: ${[...new Set(proxy.hosts)].join(", ") || "none"}`);
  } finally {
    await proxy.close();
  }
});

// The engine trusts the proxy variables (the recorder works): a plain request through it is seen.
test("the recorder sees a request sent through it", async () => {
  const proxy = await recorder();
  try {
    await new Promise((resolve) => {
      const s = net.connect(Number(new URL(proxy.url).port), "127.0.0.1", () => s.write("CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\n\r\n"));
      s.on("data", () => (s.destroy(), resolve()));
    });
    assert.deepEqual(proxy.hosts, ["example.invalid:443"]);
  } finally {
    await proxy.close();
  }
});

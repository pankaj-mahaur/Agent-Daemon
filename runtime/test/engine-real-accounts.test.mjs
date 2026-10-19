// P3.1 permanent real-engine cases (AD_REAL_ENGINE=1): providers behind ad's loopback
// gateway (the S-GATEWAY prototype in testkit), against the pinned engine.
//   - two threads on two providers each reach their own upstream with their own key
//   - no probe (tool shell, command hook, MCP server) sees a provider key; a control
//     with the key in the engine's environment shows the hook probe can see one
//   - a subscribed thread ignores a new provider on resume, and the response says so

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServer, resolveCodexCommand } from "../src/engine/codex/app-server.mjs";
import { approvalResponse, isApprovalMethod } from "../src/engine/codex/approvals.mjs";
import { writeMockCodexHome } from "../testkit/mock-responses.mjs";
import { startMockProvider } from "../testkit/mock-providers.mjs";
import { startGatewayProto } from "../testkit/gateway-proto.mjs";
import * as probes from "../testkit/probes.mjs";

const skip = process.env.AD_REAL_ENGINE === "1" ? false : "set AD_REAL_ENGINE=1 to run the real engine";
const TIMEOUT = 300_000;
const KEY_A = ["sk", "test", "AAAAaaaa1111AAAAaaaa1111"].join("-");
const KEY_B = ["sk", "test", "BBBBbbbb2222BBBBbbbb2222"].join("-");

async function withEngine(fn, { args = [], env = {}, setup } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ad-real-acct-"));
  const home = join(root, "home");
  const cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
  const A = await startMockProvider({ keys: [KEY_A] });
  const B = await startMockProvider({ keys: [KEY_B] });
  const gw = await startGatewayProto({ entries: { "ad-aaaa": { upstream: A.url, key: KEY_A }, "ad-bbbb": { upstream: B.url, key: KEY_B } } });
  writeMockCodexHome(home, { url: A.url, approvalPolicy: "never", sandboxMode: "read-only" });
  const ctx = { root, home, cwd, A, B, gw };
  const extra = setup ? await setup(ctx) : {};
  const notes = [];
  const server = new CodexAppServer({
    command: resolveCodexCommand({}),
    cwd,
    env: { CODEX_HOME: home, AD_GATEWAY_TOKEN: gw.token, ...env, ...(extra.env ?? {}) },
    clientVersion: "test",
    codexArgs: ["-c", gw.providerConfig("ad-aaaa"), "-c", gw.providerConfig("ad-bbbb"), "-c", "thread_unload_delay_secs=0", ...args, ...(extra.args ?? [])],
    initTimeoutMs: 120_000,
    onServerRequest: async ({ method, params }) => {
      if (isApprovalMethod(method)) return approvalResponse(method, params, "accept");
      const e = new Error(`unhandled ${method}`);
      e.code = -32601;
      throw e;
    },
  });
  server.on("notification", (n) => notes.push(n));
  const turn = async (threadId, text) => {
    const from = notes.length;
    const done = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`turn timed out: ${text}`)), 90_000);
      const iv = setInterval(() => {
        const c = notes.slice(from).find((n) => n.method === "turn/completed" && n.params?.threadId === threadId);
        if (c) {
          clearTimeout(t);
          clearInterval(iv);
          resolve(c);
        }
      }, 50);
    });
    await server.request("turn/start", { threadId, input: [{ type: "text", text }] });
    return done;
  };
  try {
    await server.start();
    await fn({ ...ctx, server, turn, notes });
  } finally {
    await server.close().catch(() => {});
    for (const m of [A, B, gw]) await m.close();
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
}

test("S-THREADCFG: two threads on two providers each reach their own upstream through the gateway", { skip, timeout: TIMEOUT }, async () => {
  await withEngine(async ({ server, turn, cwd, A, B }) => {
    const t1 = (await server.request("thread/start", { cwd, modelProvider: "ad-aaaa" })).thread;
    const t2 = (await server.request("thread/start", { cwd, modelProvider: "ad-bbbb" })).thread;
    await Promise.all([turn(t1.id, "PING one"), turn(t2.id, "PING two")]);
    assert.deepEqual([...new Set(A.requests.map((r) => r.auth.matchesKey))], [0], "A: only its own key");
    assert.deepEqual([...new Set(B.requests.map((r) => r.auth.matchesKey))], [0], "B: only its own key");
    assert.ok(A.requests.some((r) => r.text === "PING one") && !A.requests.some((r) => r.text === "PING two"));
    assert.ok(B.requests.some((r) => r.text === "PING two") && !B.requests.some((r) => r.text === "PING one"));
  });
});

test("S-THREADCFG Q5: a subscribed thread ignores a new provider on resume and the response says so", { skip, timeout: TIMEOUT }, async () => {
  await withEngine(async ({ server, turn, cwd, A, B }) => {
    const t = (await server.request("thread/start", { cwd, modelProvider: "ad-aaaa" })).thread;
    await turn(t.id, "PING first");
    const r = await server.request("thread/resume", { threadId: t.id, modelProvider: "ad-bbbb" });
    assert.equal(r.thread?.modelProvider ?? r.modelProvider, "ad-aaaa", "the response reports the provider the thread kept");
    const before = B.requests.length;
    await turn(t.id, "PING second");
    assert.equal(B.requests.length, before, "the next turn still goes to A");
    assert.ok(A.requests.some((x) => x.text === "PING second"));
    // Unsubscribed and idle: applied.
    await server.request("thread/unsubscribe", { threadId: t.id });
    await new Promise((res) => setTimeout(res, 1500));
    const r2 = await server.request("thread/resume", { threadId: t.id, modelProvider: "ad-bbbb" });
    assert.equal(r2.thread?.modelProvider ?? r2.modelProvider, "ad-bbbb");
    await turn(t.id, "PING third");
    assert.ok(B.requests.some((x) => x.text === "PING third"));
  });
});

// G7: where a key must never appear. The gateway keeps keys out of the engine entirely;
// the control proves the hook probe would see one if it were there.
async function probeRun({ keyInEngine }) {
  let found = null;
  await withEngine(
    async ({ server, turn, cwd, A, home, root }) => {
      const probeDir = join(root, "probe");
      try {
        const listed = await server.request("hooks/list", { cwds: [cwd] });
        for (const h of (listed?.data ?? []).flatMap((d) => d.hooks ?? []).filter((x) => x.trustStatus !== "trusted" && x.currentHash)) {
          await server.request("config/value/write", { keyPath: `hooks.state.${JSON.stringify(h.key)}.trusted_hash`, value: h.currentHash, mergeStrategy: "upsert" }).catch(() => {});
        }
      } catch {
        // an engine without hooks/list: the hook probe reports "not run"
      }
      A.setScript(probes.probeTurnScript(probes.probeShellCommands()));
      const provider = keyInEngine ? "direct" : "ad-aaaa";
      const t = (await server.request("thread/start", { cwd, modelProvider: provider })).thread;
      await turn(t.id, "run the probes");
      await new Promise((r) => setTimeout(r, 1500));
      const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : null);
      found = {
        shell: A.requests.flatMap((r) => r.functionOutputs.map((f) => f.output)).join("\n"),
        hook: read(join(probeDir, "hook.UserPromptSubmit.json")) ?? read(join(probeDir, "hook.SessionStart.json")),
        mcpDefault: read(join(probeDir, "mcp-default.json")),
        mcpNamed: read(join(probeDir, "mcp-named.json")),
      };
      void home;
    },
    {
      setup: ({ root, home, A }) => {
        const probeDir = join(root, "probe");
        const script = probes.writeEnvDumpScript(probeDir);
        writeFileSync(join(home, "hooks.json"), JSON.stringify(probes.envDumpHooks({ script, outFile: join(probeDir, "hook") }), null, 2));
        const mcp = (name, file, extra = []) => ["-c", `mcp_servers.${name}.command=${JSON.stringify(process.execPath)}`, "-c", `mcp_servers.${name}.args=[${JSON.stringify(script)}, ${JSON.stringify(file)}, "--mcp"]`, ...extra];
        const args = [...mcp("probe1", join(probeDir, "mcp-default.json")), ...mcp("probe2", join(probeDir, "mcp-named.json"), ["-c", `mcp_servers.probe2.env_vars=["AD_GATEWAY_TOKEN"]`])];
        if (!keyInEngine) return { args };
        // The control: the old way, the key in the engine's environment.
        appendFileSync(join(home, "config.toml"), `\n[model_providers.direct]\nname = "direct"\nbase_url = "${A.url}"\nenv_key = "AD_TEST_PROVIDER_KEY"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\nsupports_websockets = false\n`);
        return { args, env: { AD_TEST_PROVIDER_KEY: KEY_A } };
      },
    }
  );
  return found;
}

test("S-GATEWAY: no probe (tool shell, hook, MCP server) sees the key; the no-gateway control shows the key in the hook env", { skip, timeout: TIMEOUT * 2 }, async () => {
  const via = await probeRun({ keyInEngine: false });
  for (const [where, text] of Object.entries(via)) {
    if (text === null) continue;
    assert.deepEqual(probes.scanForSecrets(text, [KEY_A, KEY_B]), [], `${where} saw a provider key`);
  }
  assert.ok(via.shell.length > 0, "the tool shell probe ran");
  assert.ok(via.mcpDefault !== null, "the MCP probe ran");
  const control = await probeRun({ keyInEngine: true });
  assert.ok(control.hook !== null, "the hook probe ran");
  assert.deepEqual(probes.scanForSecrets(control.hook, [KEY_A]), [0], "the control: a key in the engine's environment reaches a hook");
});

// S-OAUTH (offline): two engine homes keep their sign-ins apart.
async function withHomes(fn) {
  const root = mkdtempSync(join(tmpdir(), "ad-real-oauth-"));
  const cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
  // The default (OpenAI) provider: only then does the engine report OpenAI sign-ins.
  const home = (name) => {
    const d = join(root, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "config.toml"), ["check_for_update_on_startup = false", 'cli_auth_credentials_store = "file"', "", "[features]", "plugins = false", "apps = false", ""].join("\n"));
    return d;
  };
  const servers = [];
  const start = async (h) => {
    const notes = [];
    const s = new CodexAppServer({ command: resolveCodexCommand({}), cwd, env: { CODEX_HOME: h }, clientVersion: "test", initTimeoutMs: 120_000 });
    s.on("notification", (n) => notes.push(n));
    await s.start();
    s.notes = notes;
    servers.push(s);
    return s;
  };
  try {
    await fn({ home, start });
  } finally {
    for (const s of servers) await s.close().catch(() => {});
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
}
const filesOf = (dir) => {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!/sqlite|\.db|\.wal|\.shm|\.log$/.test(e.name)) out[p] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
};

test("S-OAUTH: an API-key login in one home is invisible to another; logout in one leaves the other", { skip, timeout: TIMEOUT }, async () => {
  await withHomes(async ({ home, start }) => {
    const h1 = home("h1");
    const h2 = home("h2");
    const s1 = await start(h1);
    const s2 = await start(h2);
    await s1.request("account/login/start", { type: "apiKey", apiKey: KEY_A });
    await new Promise((r) => setTimeout(r, 800));
    assert.equal((await s1.request("account/read", {})).account?.type, "apiKey");
    assert.equal((await s2.request("account/read", {})).account, null);
    const before = filesOf(h2);
    assert.ok(!JSON.stringify(before).includes(KEY_A), "the key never lands in the other home");
    await s1.request("account/logout", {});
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(filesOf(h2), before, "H2 byte-identical after H1's logout");
  });
});

test("S-OAUTH: two browser logins from two processes: the second takes the port and the first is cancelled", { skip, timeout: TIMEOUT }, async () => {
  await withHomes(async ({ home, start }) => {
    const s1 = await start(home("h1"));
    const s2 = await start(home("h2"));
    const l1 = await s1.request("account/login/start", { type: "chatgpt" });
    await new Promise((r) => setTimeout(r, 1500));
    const l2 = await s2.request("account/login/start", { type: "chatgpt" });
    for (let i = 0; i < 60 && !s1.notes.some((n) => n.method === "account/login/completed" && n.params?.loginId === l1.loginId); i++) await new Promise((r) => setTimeout(r, 100));
    const first = s1.notes.find((n) => n.method === "account/login/completed" && n.params?.loginId === l1.loginId);
    assert.equal(first?.params?.success, false, "the first login is cancelled");
    assert.match(first.params.error, /cancel/i);
    assert.match(l2.authUrl, /localhost%3A1455|localhost:1455|127\.0\.0\.1%3A1455/, "the second holds the port");
    await s2.request("account/login/cancel", { loginId: l2.loginId }).catch(() => {});
  });
});

// P3.3: the real gateway (gateway/client.mjs, a child process), not the prototype.
async function withRealGateway(fn, { upstream, accountKey = KEY_A, entry = "ad-openrouter-aaaa1111" }) {
  const { startGateway } = await import("../src/gateway/client.mjs");
  const { engineProviderArgs, engineEnvFor } = await import("../src/gateway/table.mjs");
  const table = new Map([[entry, { accountId: "acct-x", upstreamBase: upstream, mode: "passthrough", auth: { kind: "static-key", scheme: "bearer" }, headers: {}, strip: [], label: "OpenRouter", allowHttp: true, displayName: "OpenRouter · default" }]]);
  const gw = await startGateway({ table, getKeys: async () => ({ "acct-x": accountKey }) });
  const doc = { accounts: [{ id: "acct-x", migratedFrom: "3.0-openrouter", providerEntry: entry, label: "default" }] };
  try {
    await fn({ gw, args: engineProviderArgs(table, { gateway: gw, doc }), env: engineEnvFor({ gateway: gw, env: {} }) });
  } finally {
    await gw.close();
  }
}

test("P3.3: a 3.0 conversation resumes through the real gateway's openrouter alias with the adopted key", { skip, timeout: TIMEOUT }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ad-real-gw30-"));
  const home = join(root, "home");
  const cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
  const up = await startMockProvider({ personality: "openrouter", keys: [KEY_A] });
  writeMockCodexHome(home, { url: up.url });
  appendFileSync(join(home, "config.toml"), `\n[model_providers.openrouter]\nname = "OpenRouter"\nbase_url = "${up.url}"\nenv_key = "OPENROUTER_API_KEY"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\nsupports_websockets = false\n`);
  const start = async (env, args = []) => {
    const notes = [];
    const s = new CodexAppServer({ command: resolveCodexCommand({}), cwd, env: { CODEX_HOME: home, ...env }, clientVersion: "test", codexArgs: args, initTimeoutMs: 120_000 });
    s.on("notification", (n) => notes.push(n));
    await s.start();
    s.turn = async (threadId, text) => {
      const from = notes.length;
      const done = new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("turn timeout")), 90_000);
        const iv = setInterval(() => {
          const c = notes.slice(from).find((n) => n.method === "turn/completed" && n.params?.threadId === threadId);
          if (c) {
            clearTimeout(t);
            clearInterval(iv);
            resolve(c);
          }
        }, 50);
      });
      await s.request("turn/start", { threadId, input: [{ type: "text", text }] });
      return done;
    };
    return s;
  };
  try {
    // ad 3.0: the key in the engine's environment.
    let s = await start({ OPENROUTER_API_KEY: KEY_A });
    const t = (await s.request("thread/start", { cwd, modelProvider: "openrouter" })).thread;
    await s.turn(t.id, "PING from 3.0");
    await s.close();
    // ad now: no key in the engine; the alias through the gateway.
    await withRealGateway(async ({ args, env, gw }) => {
      s = await start(env, args);
      try {
        await s.request("thread/resume", { threadId: t.id });
        const before = up.requests.length;
        await s.turn(t.id, "PING after the upgrade");
        assert.ok(up.requests.length > before, "the next turn reached the provider");
        assert.equal(up.requests.at(-1).auth.matchesKey, 0, "with the adopted key, added by the gateway");
        assert.ok(up.requests.at(-1).userTexts.join("|").includes("3.0"), "history kept");
        assert.equal(gw.last("acct-x")?.status, 200);
      } finally {
        await s.close();
      }
    }, { upstream: up.url });
  } finally {
    await up.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("P3.3: an unreachable provider fails the turn with ad's message, no endless retry", { skip, timeout: TIMEOUT }, async () => {
  const dead = (await import("node:http")).createServer();
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const port = dead.address().port;
  await new Promise((r) => dead.close(r));
  await withRealGateway(async ({ args, env }) => {
    await withEngine(async ({ server, turn, cwd }) => {
      const t = (await server.request("thread/start", { cwd, modelProvider: "ad-openrouter-aaaa1111" })).thread;
      const t0 = Date.now();
      const done = await turn(t.id, "PING nobody home");
      assert.ok(Date.now() - t0 < 60_000, "bounded");
      assert.equal(done.params?.turn?.status, "failed");
    }, { args: [...args, "-c", "features.unbounded_connection_retries=false"], env });
  }, { upstream: `http://127.0.0.1:${port}/v1` });
});

// P3.4: an account switch within one provider forks the conversation onto the new
// account: the history comes along, the new key serves the next turn, an active goal is
// paused and moved, and the old thread is let go.
test("P3.4: a same-provider switch by fork continues with the history on the new key", { skip, timeout: TIMEOUT }, async () => {
  const { createEngine, switchThread } = await import("../src/engine/index.mjs");
  const root = mkdtempSync(join(tmpdir(), "ad-real-switch-"));
  const home = join(root, "home");
  const cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
  const A = await startMockProvider({ keys: [KEY_A] });
  const B = await startMockProvider({ keys: [KEY_B] });
  const gw = await startGatewayProto({ entries: { "ad-aaaa": { upstream: A.url, key: KEY_A }, "ad-bbbb": { upstream: B.url, key: KEY_B } } });
  writeMockCodexHome(home, { url: A.url, approvalPolicy: "never", sandboxMode: "read-only" });
  let engine;
  try {
    engine = await createEngine({ home, cwd, command: resolveCodexCommand({}), clientVersion: "test", experimental: true, env: { AD_GATEWAY_TOKEN: gw.token }, engineArgs: ["-c", gw.providerConfig("ad-aaaa"), "-c", gw.providerConfig("ad-bbbb")] });
    const { threadId } = await engine.startThread({ cwd, modelProvider: "ad-aaaa", approvalPolicy: "never", sandbox: "read-only" });
    const first = await engine.turn({ threadId, text: "PING remember the word banana", timeoutMs: 90_000 });
    assert.equal(first.status, "completed");
    await engine.threads.goal.set(threadId, "finish the fruit list", { status: "paused" });
    const r = await switchThread({ engine, threadId, target: { modelProvider: "ad-bbbb" } });
    assert.notEqual(r.threadId, threadId);
    assert.equal(r.goalMoved, true);
    assert.equal((await engine.threads.goal.get(r.threadId))?.status, "paused");
    const before = A.requests.length;
    const next = await engine.turn({ threadId: r.threadId, text: "PING after the switch", timeoutMs: 90_000 });
    assert.equal(next.status, "completed");
    const onB = B.requests.find((x) => x.text === "PING after the switch");
    assert.ok(onB, "the new account's key served the turn");
    assert.equal(onB.auth.matchesKey, 0);
    assert.ok(onB.userTexts.some((t) => t.includes("banana")), "the history came along");
    assert.equal(A.requests.length, before, "nothing more on the old account");
    assert.ok(!(await engine.threads.loaded()).includes(threadId), "the old thread was let go");
  } finally {
    await engine?.close().catch(() => {});
    for (const m of [A, B, gw]) await m.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

// P3.1 permanent real-engine cases (AD_REAL_ENGINE=1): providers behind ad's loopback
// gateway (the S-GATEWAY prototype in testkit), against the pinned engine.
//   - two threads on two providers each reach their own upstream with their own key
//   - no probe (tool shell, command hook, MCP server) sees a provider key; a control
//     with the key in the engine's environment shows the hook probe can see one
//   - a subscribed thread ignores a new provider on resume, and the response says so

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
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

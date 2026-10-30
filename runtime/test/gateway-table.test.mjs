// P3.3: what the engine gets from the gateway (provider entries, the 3.0 alias, env)
// and the gateway child process (keys over IPC only; it ends with ad).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { gatewayTable, engineProviderArgs, apiEngineArgs, engineEnvFor } from "../src/gateway/table.mjs";
import { startGateway, gatewayEnv } from "../src/gateway/client.mjs";
import { newAccount, emptyRegistry } from "../src/auth/accounts/registry.mjs";
import { startMockProvider } from "../testkit/mock-providers.mjs";

const KEY = ["sk", "or", "v1", "ffffffffffffffff7777"].join("-");
const closers = [];
after(async () => {
  for (const c of closers) await c();
});

function doc() {
  const d = emptyRegistry();
  const ready = (o) => {
    const a = newAccount(o);
    a.status = "ready";
    d.accounts.push(a);
    return a;
  };
  const or = ready({ provider: "openrouter", label: "default", method: "api-key", credential: { kind: "secret", ref: "openrouter" }, migratedFrom: "3.0-openrouter", defaultModel: "qwen/x:free" });
  const work = ready({ provider: "openrouter", label: "work", method: "api-key" });
  const local = ready({ provider: "custom", label: "lab", method: "none", endpoint: "http://127.0.0.1:1234/v1" });
  const pending = newAccount({ provider: "openrouter", label: "half", method: "api-key" });
  d.accounts.push(pending);
  const gone = ready({ provider: "openrouter", label: "old", method: "api-key" });
  gone.status = "needs-sign-in";
  const chat = ready({ provider: "chatgpt", label: "default", method: "engine-login", credential: { kind: "engine-home", home: "@default" } });
  d.defaults.target = { account: or.id, model: null, effort: null };
  return { d, or, work, local, pending, gone, chat };
}
const fakeGateway = { token: "tok", baseUrlFor: (e) => `http://127.0.0.1:9/p/${e}/v1` };

test("ready API accounts get routes; pending, needs-sign-in and sign-in accounts get none", () => {
  const { d, or, work, local } = doc();
  const t = gatewayTable(d);
  assert.deepEqual([...t.keys()].sort(), [or.providerEntry, work.providerEntry, local.providerEntry].sort());
  assert.equal(t.get(local.providerEntry).allowHttp, true, "loopback endpoints may be http");
  assert.equal(t.get(or.providerEntry).allowHttp, false);
  assert.equal(t.get(or.providerEntry).upstreamBase, "https://openrouter.ai/api/v1");
  assert.deepEqual(t.get(local.providerEntry).auth, { kind: "none" });
});

test("-c entries carry base_url and env_key, never a key; the 3.0 openrouter alias points at the adopted account", () => {
  const { d, or } = doc();
  const args = engineProviderArgs(gatewayTable(d), { gateway: fakeGateway, doc: d });
  const text = args.join(" ");
  assert.ok(!text.includes(KEY));
  assert.match(text, /env_key = "AD_GATEWAY_TOKEN"/);
  assert.match(text, /request_max_retries = 1, stream_max_retries = 1/);
  const alias = args.find((a) => a.startsWith("model_providers.openrouter="));
  assert.ok(alias, "the 3.0 alias");
  assert.ok(alias.includes(`/p/${or.providerEntry}/v1`));
  for (let i = 0; i < args.length; i += 2) assert.equal(args[i], "-c");
});

test("the api engine's extras turn off unbounded connection retries and set the default target", () => {
  const { d, or } = doc();
  const args = apiEngineArgs(d, gatewayTable(d));
  assert.deepEqual(args.slice(0, 2), ["-c", "features.unbounded_connection_retries=false"]);
  assert.ok(args.includes(`model_provider=${JSON.stringify(or.providerEntry)}`));
  assert.ok(args.includes('model="qwen/x:free"'));
});

test("engine env holds only AD_GATEWAY_TOKEN and NO_PROXY with the user's value kept", () => {
  const env = engineEnvFor({ gateway: fakeGateway, env: { NO_PROXY: "corp.local", OPENROUTER_API_KEY: KEY } });
  assert.deepEqual(Object.keys(env).sort(), ["AD_GATEWAY_TOKEN", "NO_PROXY", "no_proxy"]);
  assert.equal(env.NO_PROXY, "corp.local,127.0.0.1,localhost");
  assert.ok(!JSON.stringify(env).includes(KEY));
});

test("the child's env drops keys and ad's variables; a CA set for the engine carries over", () => {
  const env = gatewayEnv({ PATH: "/bin", OPENROUTER_API_KEY: KEY, AD_GATEWAY_TOKEN: "x", CODEX_HOME: "/h", HTTPS_PROXY: "http://p:8080", CODEX_CA_CERTIFICATE: "/ca.pem" });
  assert.deepEqual(env, { PATH: "/bin", HTTPS_PROXY: "http://p:8080", NODE_EXTRA_CA_CERTS: "/ca.pem" });
});

test("the gateway child: keys arrive over IPC, never in its env or argv; it serves; closing ad's end ends it", async () => {
  const up = await startMockProvider({ keys: [KEY] });
  closers.push(() => up.close());
  const table = new Map([["ad-mock-aaaa", { accountId: "acct-x", upstreamBase: up.url, mode: "passthrough", auth: { kind: "static-key", scheme: "bearer" }, headers: {}, strip: [], label: "Mock", allowHttp: true }]]);
  const events = [];
  const gw = await startGateway({ table, getKeys: async (ids) => Object.fromEntries(ids.map((id) => [id, KEY])), onUpstream: (e) => events.push(e), env: { ...process.env, OPENROUTER_API_KEY: "should-not-pass" } });
  assert.ok(!gw.child.spawnargs.join(" ").includes(KEY), "not in argv");
  const r = await fetch(`${gw.baseUrlFor("ad-mock-aaaa")}/responses`, { method: "POST", headers: { authorization: `Bearer ${gw.token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "m", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "PING" }] }] }) });
  assert.equal(r.status, 200);
  await r.text();
  for (let i = 0; i < 50 && !events.length; i++) await new Promise((res) => setTimeout(res, 20));
  assert.equal(events.length, 1);
  assert.equal(gw.last("acct-x").status, 200);
  assert.equal(up.requests.at(-1).auth.matchesKey, 0);
  // A new table drops the route.
  await gw.setTable(new Map());
  assert.equal((await fetch(`${gw.baseUrlFor("ad-mock-aaaa")}/responses`, { method: "POST", headers: { authorization: `Bearer ${gw.token}` }, body: "{}" })).status, 404);
  // ad's end of the IPC channel closes → the child ends.
  const exited = new Promise((res) => gw.child.once("exit", res));
  gw.child.disconnect();
  gw.child.stdin.end();
  const code = await Promise.race([exited, new Promise((res) => setTimeout(() => res("still running"), 5000))]);
  assert.notEqual(code, "still running");
});

// Launch (P3.4, T2-H5): every entry point resolves the account first, then starts the
// engine that serves it, and starts threads with that account's provider. Against the
// fake app-server, in a throwaway HOME / AD_ROOT (never the user's own folders).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-launch-"));
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, AD_ROOT: process.env.AD_ROOT, AD_ACCOUNT: process.env.AD_ACCOUNT };
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;
process.env.AD_ROOT = path.join(TMP, ".agent-daemon");
delete process.env.AD_ACCOUNT;

const { launchHarness, closeHarnessEngines, homeArgs, readProjectSelector, resumeHint, removedAccountText, findThreadHome } = await import("../src/harness/engines.mjs");
const { closeGateway } = await import("../src/harness/gateway-runtime.mjs");
const reg = await import("../src/auth/accounts/registry.mjs");
const { createSecretStore, fileBackend } = await import("../src/auth/secrets.mjs");
const { cmdRun } = await import("../src/harness/run.mjs");
const { recordFile } = await import("../src/harness/settings-sync.mjs");

after(async () => {
  await closeHarnessEngines();
  await closeGateway();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };
const KEY = ["sk", "or", "v1", "dddddddddddddddd4444"].join("-");
const sink = () => {
  const chunks = [];
  return { write: (s) => (chunks.push(String(s)), true), text: () => chunks.join("") };
};

fs.mkdirSync(path.join(process.env.AD_ROOT, "secrets"), { recursive: true });
const store = createSecretStore(fileBackend(path.join(process.env.AD_ROOT, "secrets")));
const work = reg.newAccount({ provider: "openrouter", label: "work", method: "api-key", defaultModel: "or/work-model" });
const old = reg.newAccount({ provider: "openrouter", label: "old", method: "api-key" });
store.set(work.credential.ref, KEY);
await reg.transact((doc) => {
  doc.accounts.push({ ...work, status: "ready", keyHint: "4444" }, { ...old, status: "needs-sign-in" });
  doc.engines.api.home = "api";
});
const project = path.join(TMP, "work", "shop-app");
fs.mkdirSync(path.join(project, ".agent-daemon"), { recursive: true });
const debug = (engine, m = "debug/state") => engine.testRequest(m, {});

test("--account openrouter/work: the api home's engine, with the account's provider entry on every new thread", async () => {
  const err = sink();
  const r = await launchHarness({ cwd: project, account: "openrouter/work", command, store, err });
  assert.ok(r.engine, err.text());
  try {
    assert.equal(r.homeKey, "api");
    assert.equal(path.resolve(r.engine.home), path.resolve(process.env.AD_ROOT, "api"));
    assert.equal(r.params.modelProvider, work.providerEntry);
    assert.equal(r.params.model, "or/work-model");
    const { argv } = await debug(r.engine, "debug/processCwd");
    assert.ok(argv.some((a) => a.startsWith(`model_providers.${work.providerEntry}=`)), "the gateway entry is passed");
    assert.ok(!argv.join(" ").includes(KEY), "never the key");
    await r.engine.startThread({ cwd: project, modelProvider: r.params.modelProvider, model: r.params.model });
    assert.equal((await debug(r.engine)).lastParams["thread/start"].modelProvider, work.providerEntry);
  } finally {
    await r.release();
  }
  assert.equal(r.engine.running, false, "a one-shot launch stops its engine at release");
});

test("an account that needs its key again fails before any engine starts", async () => {
  const err = sink();
  const r = await launchHarness({ cwd: project, account: "openrouter/old", command, store, err });
  assert.equal(r.engine, null);
  assert.equal(r.code, 2);
  assert.match(r.error, /OpenRouter · old needs its key again: ad auth login openrouter --label old/);
});

test("ad run --account runs its turn on that account", async () => {
  const out = sink();
  const err = sink();
  const code = await cmdRun("hello", { cwd: project, account: "openrouter/work", effort: "high", command, store, stdout: out, stderr: err, json: true });
  assert.equal(code, 0, err.text());
  const j = JSON.parse(out.text());
  assert.equal(j.status, "completed");
  // P4.2: the target, with its effort, is named on stderr and in --json.
  assert.equal(j.target, "OpenRouter · work · or/work-model high");
  assert.ok(err.text().split("\n").includes("target: OpenRouter · work · or/work-model high"), err.text());
});

test("ad run --account: an unknown account and an ambiguous label exit 2 before any engine starts, saying what to type", async () => {
  const err = sink();
  assert.equal(await cmdRun("hello", { cwd: project, account: "nope", command, store, stdout: sink(), stderr: err }), 2);
  assert.ok(err.text().includes('No account matches "nope". See: ad auth status'), err.text());
  const other = reg.newAccount({ provider: "xai", label: "work", method: "api-key" });
  await reg.transact((doc) => void doc.accounts.push({ ...other, status: "ready", keyHint: "5555" }));
  try {
    const err2 = sink();
    assert.equal(await cmdRun("hello", { cwd: project, account: "work", command, store, stdout: sink(), stderr: err2 }), 2);
    assert.ok(err2.text().includes('2 accounts match "work". Name one as <provider>/<label>, or by its id'), err2.text());
  } finally {
    await reg.transact((doc) => {
      doc.accounts = doc.accounts.filter((x) => x.id !== other.id);
    });
  }
});

test("a project selector counts only in a folder the settings record trusts", async () => {
  fs.writeFileSync(path.join(project, ".agent-daemon", "config.json"), JSON.stringify({ target: { provider: "openrouter", label: "work", model: "or/project-model" } }));
  assert.equal(readProjectSelector(path.join(project, "src")).dir, project);
  // Not trusted yet: the registry's default (none here) → 3.0 behaviour on the default home.
  let r = await launchHarness({ cwd: project, command, store, err: sink() });
  assert.equal(r.target.source, "legacy");
  await r.release();
  fs.mkdirSync(path.dirname(recordFile()), { recursive: true });
  fs.writeFileSync(recordFile(), JSON.stringify({ revision: 1, tui: {}, projects: { [project]: { trust_level: "trusted" } }, pending: [] }));
  const err = sink();
  r = await launchHarness({ cwd: project, command, store, err });
  try {
    assert.equal(r.target.source, "project");
    assert.equal(r.params.model, "or/project-model");
    assert.equal(r.homeKey, "api");
    assert.match(err.text(), /This project picks OpenRouter · work/);
  } finally {
    await r.release();
    fs.rmSync(path.join(project, ".agent-daemon", "config.json"));
  }
});

test("the home folder's own .agent-daemon/config.json is never a project selector", () => {
  fs.mkdirSync(path.join(TMP, ".agent-daemon"), { recursive: true });
  fs.writeFileSync(path.join(TMP, ".agent-daemon", "config.json"), JSON.stringify({ target: { provider: "openrouter", label: "work" } }));
  assert.equal(readProjectSelector(path.join(TMP, "work")), null);
});

test("homeArgs: the API home gets every entry and the default target; a ChatGPT default home only 3.0's alias", () => {
  const gateway = { baseUrlFor: (e) => `http://127.0.0.1:1/p/${e}/v1` };
  const a = { ...work, status: "ready", migratedFrom: "3.0-openrouter" };
  const doc = { accounts: [a], engines: { api: { home: "api" } }, defaults: { target: { account: a.id } } };
  const table = new Map([[a.providerEntry, { accountId: a.id, label: "OpenRouter", displayName: "OpenRouter · work" }]]);
  const api = homeArgs("api", { table, gateway, doc }).join(" ");
  assert.match(api, new RegExp(`model_providers\\.${a.providerEntry}=`));
  assert.match(api, /model_provider="ad-openrouter-/);
  const chatgptDefault = homeArgs("@default", { table, gateway, doc });
  assert.equal(chatgptDefault.length, 2);
  assert.match(chatgptDefault[1], /^model_providers\.openrouter=/);
  // An OpenRouter-only 3.0 user: the default home serves API work.
  doc.engines.api.home = "@default";
  assert.match(homeArgs("@default", { table, gateway, doc }).join(" "), /model_provider="ad-openrouter-/);
  assert.deepEqual(homeArgs("a/h1", { table, gateway, doc }), []);
});

test("the exit hint names the account when it isn't the default one; a removed account's thread gets the removed-account text", () => {
  const doc = reg.readRegistry();
  assert.equal(resumeHint("thread-9", work.providerEntry, { doc }), "ad tui --resume thread-9 --account openrouter/work");
  assert.equal(resumeHint("thread-9", work.providerEntry, { doc: { ...doc, defaults: { target: { account: work.id } } } }), "ad tui --resume thread-9");
  assert.equal(resumeHint("thread-9", undefined, { doc }), "ad tui --resume thread-9");
  assert.equal(removedAccountText(work.providerEntry, { doc }), null);
  assert.match(removedAccountText("ad-openrouter-gone0000", { doc }), /This conversation used an account you removed \(ad-openrouter-gone0000\)/);
  assert.equal(removedAccountText("openai", { doc }), null);
});

test("--resume <tid> from the default home looks in the api home (a launched manager only)", async () => {
  const r = await launchHarness({ cwd: project, command, store, err: sink(), idleMs: 0 });
  try {
    assert.equal(r.homeKey, "@default");
    const found = await findThreadHome("thread-1", { currentKey: "@default", cwd: project });
    assert.equal(found?.homeKey, "api");
    assert.equal(path.resolve(found.engine.home), path.resolve(process.env.AD_ROOT, "api"));
    await found.release();
  } finally {
    await r.release();
  }
});

test("the api home needs no engine sign-in: its accounts are ad's", async () => {
  await closeHarnessEngines(); // a fresh manager with this environment
  const err = sink();
  const r = await launchHarness({ cwd: project, account: "openrouter/work", command, store, err, env: { FAKE_LOGGED_OUT: "1" } });
  try {
    assert.ok(r.engine, `started without a sign-in: ${r.error ?? ""} ${err.text()}`);
    assert.equal(r.homeKey, "api");
  } finally {
    if (r.engine) await r.release();
    await closeHarnessEngines();
  }
});

test("homeArgs: while ad doesn't know who is signed in to the default home, it gets only 3.0's alias (N4)", () => {
  const gateway = { baseUrlFor: (e) => `http://127.0.0.1:1/p/${e}/v1` };
  const a = { ...work, status: "ready", migratedFrom: "3.0-openrouter" };
  const doc = { accounts: [a], engines: { api: { home: null } }, defaults: { target: { account: a.id } } };
  const table = new Map([[a.providerEntry, { accountId: a.id, label: "OpenRouter", displayName: "OpenRouter · work" }]]);
  const args = homeArgs("@default", { table, gateway, doc });
  assert.equal(args.length, 2);
  assert.match(args[1], /^model_providers\.openrouter=/);
  assert.ok(!args.join(" ").includes("unbounded_connection_retries"), "no API retry settings");
  // ...and the api home, where API targets go meanwhile, gets every entry and the defaults.
  const api = homeArgs("api", { table, gateway, doc }).join(" ");
  assert.match(api, new RegExp(`model_providers.${a.providerEntry}=`));
  assert.match(api, /unbounded_connection_retries/);
});

test("ad's own folder's config.json is never a project selector, even outside the home folder", () => {
  const root = path.join(TMP, "elsewhere", ".agent-daemon");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ target: { provider: "openrouter", label: "work" } }));
  assert.equal(readProjectSelector(path.join(TMP, "elsewhere", "proj"), { root }), null);
  assert.ok(readProjectSelector(path.join(TMP, "elsewhere", "proj"), { root: path.join(TMP, "other-root") }), "the same file in a project counts");
});

test("two callers with different start options in one process get separate engines on one home", async () => {
  const a = await launchHarness({ cwd: project, account: "openrouter/work", command, store, err: sink(), env: { AD_WORKER: "1" } });
  const b = await launchHarness({ cwd: project, account: "openrouter/work", command, store, err: sink() });
  const c = await launchHarness({ cwd: project, account: "openrouter/work", command, store, err: sink() });
  try {
    assert.notEqual(a.engine, b.engine);
    assert.equal(b.engine, c.engine, "the same options share one");
  } finally {
    await a.release();
    await b.release();
    await c.release();
  }
});

test("homeArgs with fallback on: a sign-in's engine stops reconnecting forever; the API engine keeps its own limits; off adds nothing", () => {
  const gateway = { baseUrlFor: (e) => `http://127.0.0.1:1/p/${e}/v1` };
  const a = { ...work, status: "ready", migratedFrom: "3.0-openrouter" };
  const doc = { accounts: [a], engines: { api: { home: "api" } }, defaults: { target: { account: a.id } } };
  const table = new Map([[a.providerEntry, { accountId: a.id, label: "OpenRouter", displayName: "OpenRouter · work" }]]);
  const bounded = ["-c", "features.unbounded_connection_retries=false"];
  assert.deepEqual(homeArgs("a/h1", { table, gateway, doc }, { fallbackOn: true }), bounded, "an account's own (ChatGPT) home");
  assert.deepEqual(homeArgs("@default", { table, gateway, doc }, { fallbackOn: true }).slice(-2), bounded, "the default ChatGPT home");
  assert.deepEqual(homeArgs("a/h1", { table, gateway, doc }), [], "fallback off: unchanged");
  assert.deepEqual(homeArgs("api", { table, gateway, doc }, { fallbackOn: true }), homeArgs("api", { table, gateway, doc }), "the API engine already bounds its retries (its own args)");
});

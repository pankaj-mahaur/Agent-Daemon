// `ad auth` (P3.8a): list, use with scopes, rename, logout, remove, status, test, the
// tool-shell gate and --json. A throwaway HOME / AD_ROOT, a file store, the fake engine.

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-auth-cli-"));
const saved = { AD_ROOT: process.env.AD_ROOT, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, AD_TOOL_SHELL: process.env.AD_TOOL_SHELL };
process.env.AD_ROOT = path.join(TMP, ".agent-daemon");
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;
delete process.env.AD_TOOL_SHELL;
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const { cmdAuth } = await import("../src/harness/auth.mjs");
const { AUTH_HELP } = await import("../src/harness/auth-texts.mjs");
const reg = await import("../src/auth/accounts/registry.mjs");
const { createSecretStore, fileBackend } = await import("../src/auth/secrets.mjs");

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };
fs.mkdirSync(path.join(process.env.AD_ROOT, "secrets"), { recursive: true });
const store = createSecretStore(fileBackend(path.join(process.env.AD_ROOT, "secrets")));
const sink = () => {
  const s = { text: "", write: (c) => ((s.text += c), true) };
  return s;
};
const auth = async (sub, args = [], extra = {}) => {
  const stdout = sink();
  const stderr = sink();
  const code = await cmdAuth(sub, args, { command, store, stdout, stderr, clientVersion: "3.1.0", width: 80, ...extra });
  return { code, out: stdout.text, err: stderr.text };
};

const keys = {};
let ids = {};
// Five accounts: two ChatGPT (records only), two OpenRouter keys, one custom endpoint.
async function seed() {
  fs.rmSync(path.join(process.env.AD_ROOT, "accounts"), { recursive: true, force: true });
  const mk = (o, key) => {
    const a = reg.newAccount(o);
    if (key) {
      store.set(a.credential.ref, key);
      keys[o.label] = key;
    }
    return { ...a, status: "ready", keyHint: key ? key.slice(-4) : null };
  };
  const personal = { ...mk({ provider: "chatgpt", label: "personal", method: "engine-login", credential: { kind: "engine-home", home: "@default" }, migratedFrom: "3.0-default-home" }), identity: { email: "sam@example.com", plan: "plus" } };
  const work = { ...mk({ provider: "chatgpt", label: "work", method: "engine-login", credential: { kind: "engine-home", home: "a/h1" } }), identity: { email: "alex@example.com", plan: "team", key: "secret-identity-hash" } };
  const def = mk({ provider: "openrouter", label: "default", method: "api-key" }, ["sk", "or", "v1", "dddd0000dddd0000d9f3"].join("-"));
  const client = { ...mk({ provider: "openrouter", label: "client-a", owner: "Sam's key", method: "api-key" }, ["sk", "or", "v1", "cccc0000cccc0000a1b2"].join("-")), attempt: null };
  const lab = mk({ provider: "custom", label: "lab", method: "none", endpoint: "http://127.0.0.1:9/v1" });
  await reg.transact((doc) => {
    doc.accounts.push(personal, work, def, client, lab);
    doc.defaults.target = { account: personal.id, model: null, effort: null };
  });
  ids = { personal: personal.id, work: work.id, default: def.id, client: client.id, lab: lab.id };
}
beforeEach(seed);
const acct = (label) => reg.readRegistry().accounts.find((a) => a.label === label);

test("help text matches exactly; `ad auth` alone shows it", async () => {
  let r = await auth(undefined, [], { help: true });
  assert.equal(r.out, AUTH_HELP);
  r = await auth("login", [], { help: true });
  assert.match(r.out, /openrouter {3}OpenRouter: an API key, --oauth: sign in in the browser|Also \(not yet checked/);
  assert.match(r.out, /Claude models work now through OpenRouter/);
});

test("list groups by provider, marks the default, fits 80 columns; no key, ref, home path or full email", async () => {
  const r = await auth("list");
  assert.equal(r.code, 0, r.err);
  for (const l of r.out.split("\n")) assert.ok([...l].length <= 80, l);
  assert.match(r.out, /^ChatGPT$/m);
  assert.match(r.out, /^● personal/m);
  assert.match(r.out, /client-a {5}Sam's key/);
  assert.match(r.out, /key …a1b2/);
  for (const bad of [...Object.values(keys), "secret-identity-hash", "sam@example.com", "a/h1", acct("client-a").credential.ref]) assert.ok(!r.out.includes(bad), bad);
});

test("list --json has exactly the documented keys; credential, salt, identity.key and attempt never appear", async () => {
  const r = await auth("list", [], { json: true });
  const j = JSON.parse(r.out);
  assert.equal(j.schemaVersion, 1);
  assert.equal(j.accounts.length, 5);
  assert.deepEqual(Object.keys(j.accounts[0]).sort(), ["createdAt", "credentialRevision", "defaultModel", "endpoint", "id", "identity", "isDefault", "keyHint", "label", "lastUpstream", "lastUsedAt", "method", "owner", "provider", "providerName", "quota", "status", "statusDetail"].sort());
  const work = j.accounts.find((a) => a.label === "work");
  assert.deepEqual(work.identity, { email: "a***@example.com", plan: "team", workspace: null });
  for (const bad of ["credential\"", "salt", "secret-identity-hash", "attempt", ...Object.values(keys), "alex@example.com"]) assert.ok(!r.out.includes(bad), bad);
  assert.equal(j.defaults.target.account, ids.personal);
});

test("resolution: id, provider/label, a provider with one account, a label used once; ambiguous and unknown say what exists", async () => {
  for (const ref of [ids.lab, "custom/lab", "custom", "client-a"]) {
    const r = await auth("status", [ref]);
    assert.equal(r.code, 0, `${ref}: ${r.err}`);
  }
  let r = await auth("status", ["openrouter"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /"openrouter" matches 2 accounts: openrouter\/default, openrouter\/client-a\. Name it as provider\/label\./);
  r = await auth("status", ["nope"]);
  assert.match(r.err, /no account matches "nope"\. Your accounts: .*openrouter\/client-a.* \(ad auth list\)\./);
  r = await auth("status", ["nope"], { json: true });
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.out).error.code, "ACCOUNT_NOT_FOUND");
});

test("a label equal to a provider id is refused, so `logout chatgpt` can never hit an OpenRouter key", async () => {
  const r = await auth("rename", ["openrouter/client-a", "chatgpt"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /names a provider/);
  assert.equal(acct("client-a").label, "client-a");
});

test("use --global prints the scope text; --project writes names only and mentions trust; --session writes nothing; not ready → TARGET_NOT_READY", async () => {
  let r = await auth("use", ["openrouter/client-a"], { model: "qwen/qwen3-coder:free", fetch: async () => { throw new Error("offline"); } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "ad now uses OpenRouter · client-a (model qwen/qwen3-coder:free) for new sessions. Open windows keep their own choice.\n");
  assert.equal(reg.readRegistry().defaults.target.account, ids.client);
  const proj = path.join(TMP, "work", "shop-app");
  fs.mkdirSync(proj, { recursive: true });
  const prev = process.cwd();
  process.chdir(proj);
  try {
    r = await auth("use", ["openrouter/default"], { scope: "project", fetch: async () => { throw new Error("offline"); } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /once you trust the folder/);
    const sel = JSON.parse(fs.readFileSync(path.join(proj, ".agent-daemon", "config.json"), "utf8"));
    assert.deepEqual(sel.target, { provider: "openrouter", label: "default" });
    assert.ok(!JSON.stringify(sel).includes("acct_"));
  } finally {
    process.chdir(prev);
  }
  const before = fs.readFileSync(path.join(process.env.AD_ROOT, "accounts", "registry.json"), "utf8");
  r = await auth("use", ["openrouter/client-a"], { scope: "session", fetch: async () => { throw new Error("offline"); } });
  assert.equal(r.code, 0);
  assert.match(r.out, process.platform === "win32" ? /AD_ACCOUNT( = "|=)openrouter\/client-a/ : /export AD_ACCOUNT='?openrouter\/client-a'?/);
  assert.equal(fs.readFileSync(path.join(process.env.AD_ROOT, "accounts", "registry.json"), "utf8"), before, "nothing written");
  await reg.transact((doc) => {
    doc.accounts.find((a) => a.label === "default").status = "needs-sign-in";
  });
  r = await auth("use", ["openrouter/default"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /OpenRouter · default needs its key again: ad auth login openrouter --label default/);
});

test("use --digest sets the account ad's own digests may use", async () => {
  const r = await auth("use", ["openrouter/client-a"], { scope: "digest" });
  assert.equal(r.code, 0, r.err);
  assert.equal(reg.readRegistry().defaults.digest, ids.client);
  assert.match(r.out, /Your conversations' summaries go to that account/);
});

test("rename keeps id, entry and credentialRevision", async () => {
  const before = acct("client-a");
  const r = await auth("rename", ["openrouter/client-a", "acme"], { owner: "Acme Ltd" });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "Renamed: OpenRouter · acme (owner: Acme Ltd).\n");
  const x = acct("acme");
  assert.deepEqual([x.id, x.providerEntry, x.credentialRevision, x.credential.ref], [before.id, before.providerEntry, before.credentialRevision, before.credential.ref]);
});

test("signing out one account leaves the others: only its key goes, the record stays needs-sign-in", async () => {
  const r = await auth("logout", ["openrouter/client-a"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Signed out: OpenRouter · client-a \(its key is deleted from this computer; it still works at OpenRouter until you revoke it there\)\. Other accounts stay signed in\.$/m);
  assert.equal(store.get(acct("client-a").credential.ref), null);
  assert.equal(acct("client-a").status, "needs-sign-in");
  assert.equal(store.get(acct("default").credential.ref), keys.default, "the other OpenRouter key stays");
  assert.equal(acct("default").status, "ready");
});

test("remove: non-TTY needs --yes; a TTY asks; a removed default clears with the note; the main folder's ChatGPT is refused", async () => {
  let r = await auth("remove", ["openrouter/client-a"], { stdin: { isTTY: false } });
  assert.equal(r.code, 1);
  assert.match(r.err, /removing an account needs a yes\. Re-run with --yes\./);
  r = await auth("remove", ["openrouter/client-a"], { stdin: { isTTY: true }, ask: async () => false });
  assert.equal(r.code, 1);
  assert.ok(acct("client-a"));
  await reg.transact((doc) => {
    doc.defaults.target = { account: doc.accounts.find((a) => a.label === "client-a").id, model: null, effort: null };
  });
  const ref = acct("client-a").credential.ref;
  r = await auth("remove", ["openrouter/client-a"], { yes: true });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Removed: OpenRouter · client-a\.\nIt was your default; ad will ask next time, or run: ad auth use <account>\./);
  assert.equal(acct("client-a"), undefined);
  assert.equal(store.get(ref), null);
  assert.equal(reg.readRegistry().defaults.target, null);
  r = await auth("remove", ["chatgpt/personal"], { yes: true });
  assert.equal(r.code, 1);
  assert.match(r.err, /can't be removed here; sign it out with: ad auth logout/);
});

test("account changes refuse in a tool shell; list, status and test still work", async () => {
  const env = { ...process.env, AD_TOOL_SHELL: "1" };
  for (const [sub, args] of [["login", ["openrouter"]], ["use", ["custom/lab"]], ["rename", ["custom/lab", "x"]], ["logout", ["openrouter/default"]], ["remove", ["custom/lab"]]]) {
    const r = await auth(sub, args, { env, yes: true, readKey: async () => assert.fail("must not prompt") });
    assert.equal(r.code, 2, sub);
    assert.match(r.err, /account changes can't run from the agent's own shell\. Run this in your terminal\./, sub);
  }
  assert.equal(acct("default").status, "ready");
  assert.equal((await auth("list", [], { env })).code, 0);
  assert.equal((await auth("status", ["custom/lab"], { env })).code, 0);
});

test("status prints harness home and active first, then the account summary", async () => {
  const r = await auth("status");
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split("\n");
  assert.match(lines[0], /^harness home: {3}/);
  assert.match(lines[1], /^active: {9}ChatGPT · personal \(global default\)$/);
  assert.match(lines[2], /^accounts: {7}5 \(5 ready\)\. List them: ad auth list$/);
  assert.match(lines[3], /^secret store: {3}file$/);
});

test("3.0 compatibility: `use openrouter` with two accounts asks for a label; `logout openrouter` with one signs it out", async () => {
  let r = await auth("use", ["openrouter"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /matches 2 accounts/);
  await auth("remove", ["openrouter/client-a"], { yes: true });
  r = await auth("logout", ["openrouter"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Signed out: OpenRouter · default/);
});

test("repair refuses in a tool shell too", async () => {
  const { cmdAuthRepair } = await import("../src/harness/auth-repair.mjs");
  const err = sink();
  assert.equal(await cmdAuthRepair({ store, out: sink(), err, env: { AD_TOOL_SHELL: "1" } }), 2);
  assert.match(err.text, /account changes can't run from the agent's own shell/);
});

test("review: signing out the main folder's ChatGPT by name is 3.0's logout; another ChatGPT account waits for P3.7", async () => {
  let r = await auth("logout", ["chatgpt/personal"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /logged out of ChatGPT \/ OpenAI/);
  r = await auth("logout", ["chatgpt/work"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /several ChatGPT accounts/);
  // Two ChatGPT accounts: "logout chatgpt" is ambiguous, never a guess.
  r = await auth("logout", ["chatgpt"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /matches 2 accounts/);
});

test("review: the tool-shell gate covers 3.0's engine paths too, and --json keeps exit 2", async () => {
  const env = { ...process.env, AD_TOOL_SHELL: "1" };
  for (const args of [["chatgpt"], []]) {
    const r = await auth(args.length ? "login" : "logout", args, { env });
    assert.equal(r.code, 2, args.join(" "));
  }
  const r = await auth("remove", ["custom/lab"], { env, json: true, yes: true });
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.out).error.code, "TOOL_SHELL");
});

test("review: --session prints both Windows shells (and Git Bash's) with quoted values; export elsewhere", async () => {
  const { shellLines } = await import("../src/harness/auth-commands.mjs");
  assert.deepEqual(shellLines("AD_ACCOUNT", "openrouter/client a", { platform: "linux", env: {} }), ["export AD_ACCOUNT='openrouter/client a'"]);
  const win = shellLines("AD_ACCOUNT", "openrouter/client a", { platform: "win32", env: { MSYSTEM: "MINGW64" } });
  assert.deepEqual(win, ['PowerShell:  $env:AD_ACCOUNT = "openrouter/client a"', 'cmd:         set "AD_ACCOUNT=openrouter/client a"', "Git Bash:    export AD_ACCOUNT='openrouter/client a'"]);
  const r = await auth("use", ["custom/lab"], { scope: "conflict" });
  assert.equal(r.code, 1);
  assert.match(r.err, /use takes one scope/);
});

test("review: use --project never overwrites a file it can't read, never writes in the home folder, and finds the project's own selector", async () => {
  const proj = path.join(TMP, "work", "p2");
  fs.mkdirSync(path.join(proj, ".agent-daemon"), { recursive: true });
  fs.mkdirSync(path.join(proj, "src", "deep"), { recursive: true });
  const file = path.join(proj, ".agent-daemon", "config.json");
  fs.writeFileSync(file, "{ not json");
  const prev = process.cwd();
  try {
    process.chdir(path.join(proj, "src", "deep"));
    let r = await auth("use", ["custom/lab"], { scope: "project" });
    assert.equal(r.code, 1);
    assert.match(r.err, /isn't a JSON object ad can add to/);
    assert.equal(fs.readFileSync(file, "utf8"), "{ not json", "untouched");
    fs.writeFileSync(file, JSON.stringify({ other: 1 }));
    r = await auth("use", ["custom/lab"], { scope: "project" });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { other: 1, target: { provider: "custom", label: "lab" } });
    assert.ok(!fs.existsSync(path.join(proj, "src", "deep", ".agent-daemon")), "the project's selector, not a new one below it");
    process.chdir(TMP);
    r = await auth("use", ["custom/lab"], { scope: "project" });
    assert.equal(r.code, 1);
    assert.match(r.err, /home folder or ad's own/);
  } finally {
    process.chdir(prev);
  }
});

test("review: remove on a terminal shows the question and keeps the key on no; status and test speak --json", async () => {
  let asked = null;
  let r = await auth("remove", ["openrouter/client-a"], { stdin: { isTTY: true }, ask: async (q) => ((asked = q), false) });
  assert.equal(asked, "Remove OpenRouter · client-a? Its key is deleted from this computer. [y/N] ");
  assert.equal(store.get(acct("client-a").credential.ref), keys["client-a"]);
  r = await auth("status", [], { json: true });
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.accounts.length, 5);
  assert.match(j.harnessHome, /engine/);
  r = await auth("test", ["custom/lab"], { json: true, fetch: async () => { throw Object.assign(new Error("x"), { cause: { code: "ECONNREFUSED" } }); } });
  assert.equal(r.code, 1);
  const t = JSON.parse(r.out);
  assert.equal(t.ok, false);
  assert.match(t.detail, /ECONNREFUSED/);
});

test("review: `logout openrouter` with no OpenRouter account never signs out ChatGPT; a label that looks like a key still works", async () => {
  await auth("remove", ["openrouter/client-a"], { yes: true });
  await auth("remove", ["openrouter/default"], { yes: true });
  const r = await auth("logout", ["openrouter"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /openrouter key removed/);
  assert.ok(!/logged out of ChatGPT/.test(r.out), "ChatGPT stays signed in");
  // A label shaped like a key, that exists, is a reference.
  await auth("rename", ["custom/lab", "or-team"]);
  const u = await auth("use", ["or-team"]);
  assert.equal(u.code, 0, u.err);
});

// ---- P4.6: limits in the list -------------------------------------------------------------
const quotaMod = await import("../src/providers/quota.mjs");
const { cmdList } = await import("../src/harness/auth-commands.mjs");
const resetQuota = () => fs.rmSync(path.join(process.env.AD_ROOT, "quota"), { recursive: true, force: true });
const keyJson = (used, limit = 50) => ({ data: { label: "mock", free_model_daily_requests: { used, limit, remaining: limit - used } } });

test("the list fits 80 columns with limits, in P3.8a's columns: the cell starts at column 67 and is at most 13 characters", async () => {
  resetQuota();
  const now = Date.now();
  await quotaMod.recordObservations([
    ...quotaMod.fromChatgpt({ primary: { usedPercent: 64, windowDurationMins: 300, resetsAt: Math.floor(now / 1000) + 3600 }, secondary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: Math.floor(now / 1000) + 86400 * 3 } }, { accountId: ids.personal, now }),
    ...quotaMod.fromOpenRouterKey(keyJson(41), { accountId: ids.client, now }).observations,
    ...quotaMod.fromOpenRouterKey(keyJson(50), { accountId: ids.default, now }).observations,
  ]);
  const r = await auth("list");
  assert.equal(r.code, 0, r.err);
  for (const l of r.out.split("\n")) assert.ok([...l].length <= 80, `${[...l].length}: ${l}`);
  const row = (label) => r.out.split("\n").find((l) => l.slice(2).startsWith(label));
  assert.equal(row("personal").slice(67), "5h 64% wk 22%");
  assert.equal(row("client-a").slice(67), "today 41/50");
  assert.match(row("default").slice(67), /^out → \d{2}:\d{2}$/);
  assert.equal(row("work").length <= 67, true, "unknown limits are a blank cell, never 0%");
  resetQuota();
});

test("list --json's quota has the documented keys; an account with nothing known has state unknown and no windows", async () => {
  resetQuota();
  await quotaMod.recordObservations(quotaMod.fromOpenRouterKey(keyJson(41), { accountId: ids.client }).observations);
  const j = JSON.parse((await auth("list", [], { json: true })).out);
  const client = j.accounts.find((a) => a.label === "client-a");
  assert.deepEqual(Object.keys(client.quota).sort(), ["benchedUntil", "observedAt", "source", "state", "windows"]);
  assert.deepEqual(Object.keys(client.quota.windows[0]).sort(), ["confidence", "kind", "limit", "remaining", "resetsAt", "state", "usedPercent", "used", "window"].sort());
  assert.deepEqual([client.quota.windows[0].used, client.quota.windows[0].limit], [41, 50]);
  const lab = j.accounts.find((a) => a.label === "lab");
  assert.deepEqual(lab.quota, { state: "unknown", windows: [], benchedUntil: null, observedAt: null, source: null });
  resetQuota();
});

test("--refresh reads OpenRouter's /key for each OpenRouter key now; the key is never printed", async () => {
  resetQuota();
  const asked = [];
  const fetch = async (url, init) => {
    asked.push({ url: String(url), redirect: init?.redirect ?? null, auth: String(init?.headers?.authorization ?? init?.headers?.Authorization ?? "") });
    return new Response(JSON.stringify(keyJson(46)), { status: 200, headers: { "content-type": "application/json" } });
  };
  const r = await auth("list", [], { refresh: true, fetch });
  assert.equal(r.code, 0, r.err);
  assert.equal(asked.length, 2, "both OpenRouter keys, nothing else");
  assert.ok(asked.every((a) => a.url === "https://openrouter.ai/api/v1/key"));
  assert.match(r.out, /client-a.*today 46\/50/);
  assert.match(r.out, /ChatGPT limits come from a running window; ad auth list --refresh=all checks them now\./);
  for (const k of Object.values(keys)) assert.ok(!r.out.includes(k) && !r.err.includes(k));
  resetQuota();
});

test("--refresh=all with a live lease on a ChatGPT home spawns no engine there; a free home is checked, one at a time", async () => {
  resetQuota();
  const { homePathFor } = await import("../src/harness/engines.mjs");
  const { engineHome } = await import("../src/engine/index.mjs");
  const workHome = engineHome.canonical(homePathFor("a/h1")); // work's own home
  const started = [];
  const out = sink();
  await cmdList({
    out,
    refresh: true,
    refreshAll: true,
    provider: "chatgpt",
    store,
    refreshOpts: {
      liveHomes: () => new Set([workHome]),
      readLimits: async (a) => (started.push(a.label), { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } }),
    },
  });
  assert.deepEqual(started, ["personal"], "never the home in use");
  assert.match(out.text, /work: in use in another window; showing the last known\./);
  assert.match(out.text, /Checking ChatGPT · personal \(starts its engine\)…/);
  assert.match(out.text, /personal.*5h 12%/);
  resetQuota();
});

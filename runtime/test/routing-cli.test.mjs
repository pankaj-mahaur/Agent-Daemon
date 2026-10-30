// `ad fallback` (P4.4): each command, the agent-shell guard, enable's confirmation, two
// changes at once, and a live test that never starts an engine. A throwaway AD_ROOT with an
// account list and model catalogs written as ad writes them.

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-fallback-cli-"));
const ROOT = path.join(TMP, ".agent-daemon");
const saved = { AD_ROOT: process.env.AD_ROOT, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, AD_TOOL_SHELL: process.env.AD_TOOL_SHELL };
process.env.AD_ROOT = ROOT;
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

const { cmdFallback, FALLBACK_CLI_TEXTS } = await import("../src/routing/cli.mjs");
const { fallbackFile, readPolicy, FALLBACK_TEXTS } = await import("../src/routing/store.mjs");
const { catalogFile } = await import("../src/providers/catalog.mjs");
const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

const acct = (o) => ({ owner: "", status: "ready", method: "api-key", credential: { kind: "secret", ref: `ad-account-${o.id}` }, keyHint: "1111", credentialRevision: 1, endpoint: null, defaultModel: null, identity: null, ...o });
const ACCOUNTS = [
  acct({ id: "acct_or1", provider: "openrouter", label: "work", defaultModel: "qwen/qwen3-coder:free" }),
  acct({ id: "acct_or2", provider: "openrouter", label: "personal" }),
  acct({ id: "acct_gem", provider: "gemini", label: "personal" }),
  acct({ id: "acct_gpt", provider: "chatgpt", label: "personal", method: "engine-login", credential: { kind: "engine-home", home: "@default" }, keyHint: null, identity: { email: "s***@example.com", plan: "plus" } }),
];
function seed() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, "accounts"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "accounts", "registry.json"), JSON.stringify({ schemaVersion: 1, revision: 1, salt: "b64:AAAA", engines: { api: { home: null } }, accounts: ACCOUNTS, defaults: { target: null, digest: null } }));
  const at = new Date().toISOString();
  const entry = (a, model, o = {}) => ({ accountId: a, provider: ACCOUNTS.find((x) => x.id === a).provider, model, caps: { tools: true, contextWindow: 262144 }, price: { input: "0", output: "0", request: null, currency: "USD", source: "provider", observedAt: at }, billing: "metered", data: {}, ...o });
  const cat = (a, entries) => {
    fs.mkdirSync(path.dirname(catalogFile(a, { root: ROOT })), { recursive: true });
    fs.writeFileSync(catalogFile(a, { root: ROOT }), JSON.stringify({ v: 1, accountId: a, observedAt: at, entries }));
  };
  cat("acct_or1", [entry("acct_or1", "qwen/qwen3-coder:free"), entry("acct_or1", "openai/gpt-5", { price: { input: "0.00000125", output: "0.00001", observedAt: at } })]);
  cat("acct_or2", [entry("acct_or2", "qwen/qwen3-coder:free")]);
  cat("acct_gem", [entry("acct_gem", "gemini-2.5-flash", { caps: { tools: true, contextWindow: 1048576 }, data: { trainsOnData: "free tier", note: "Google may use free-tier data to improve its products." } })]);
}
beforeEach(seed);

const sink = () => {
  const s = { text: "", write: (c) => ((s.text += c), true) };
  return s;
};
const fb = async (sub, args = [], extra = {}) => {
  const out = sink();
  const err = sink();
  const code = await cmdFallback(sub, args, { out, err, isTTY: () => false, env: {}, ...extra });
  return { code, out: out.text, err: err.text };
};
const three = async () => {
  assert.equal((await fb("add", ["openrouter/work"])).code, 0);
  assert.equal((await fb("add", ["gemini:gemini-2.5-flash"], { yes: true, isTTY: () => true })).code, 0);
  assert.equal((await fb("add", ["chatgpt"], { model: "gpt-5.5", effort: "medium" })).code, 0);
};

test("add, list, remove, order, move and set", async () => {
  const first = await fb("add", ["openrouter/work"]);
  assert.equal(first.out, "Added 1. OpenRouter · work · qwen/qwen3-coder:free.\n", "the account's default model");
  await fb("add", ["gemini:gemini-2.5-flash"], { yes: true, isTTY: () => true });
  await fb("add", ["chatgpt"], { model: "gpt-5.5", effort: "medium", at: "2" });
  assert.deepEqual(readPolicy({ root: ROOT }).targets.map((t) => t.model), ["qwen/qwen3-coder:free", "gpt-5.5", "gemini-2.5-flash"]);
  const list = (await fb("list")).out;
  assert.match(list, /^Fallback order: off · no extra spend\n/);
  assert.match(list, / 1 {2}OpenRouter · work · qwen\/qwen3-coder:free +free \(checked \d+ min ago\) {2}✓/);
  assert.match(list, / 2 {2}ChatGPT · personal · gpt-5\.5 medium +your plan {2}✓/);
  assert.match(list, /Switch on: limit used up · rate limit · network error · provider error/);
  const json = JSON.parse((await fb("list", [], { json: true })).out);
  assert.deepEqual(json.rows.map((r) => r.ok), [true, true, true]);
  assert.equal((await fb("order", ["3", "1", "2"])).code, 0);
  assert.deepEqual(readPolicy({ root: ROOT }).targets.map((t) => t.account), ["acct_gem", "acct_or1", "acct_gpt"]);
  assert.equal((await fb("order", ["1", "1", "2"])).code, 2);
  assert.equal((await fb("move", ["3", "1"])).code, 0);
  assert.equal(readPolicy({ root: ROOT }).targets[0].account, "acct_gpt");
  const gone = await fb("remove", ["2"]);
  assert.equal(gone.out, "Removed Gemini API · personal · gemini-2.5-flash.\n");
  assert.equal((await fb("remove", ["7"])).err, `${FALLBACK_CLI_TEXTS.NOT_A_ROW(7, 2)}\n`);
  assert.equal((await fb("set", ["give-up", "90"])).code, 0);
  assert.equal(readPolicy({ root: ROOT }).recoveryBudgetMs, 90_000);
  assert.equal((await fb("set", ["keep-running", "npm run dev"])).code, 0);
  const broad = await fb("set", ["keep-running", "npm"]);
  assert.equal(broad.code, 1);
  assert.match(broad.err, /That would allow almost any command/);
  assert.deepEqual(readPolicy({ root: ROOT }).allowRunningBackground, ["npm run dev"], "an invalid change isn't saved");
  const paid = await fb("set", ["cost", "freeOnly"]);
  assert.equal(paid.code, 1);
  assert.match(paid.err, /ChatGPT · personal · gpt-5\.5 isn't free \(it's your plan\)/);
  assert.equal((await fb("set", ["trial", "sometimes"])).code, 2);
  assert.equal((await fb("frobnicate")).code, 2);
});

test("a metered model is refused under no extra spend; a trial endpoint needs its own yes", async () => {
  const r = await fb("add", ["openrouter/work:openai/gpt-5"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /bills per use/);
  const trial = await fb("add", ["gemini:gemini-2.5-flash"], { yes: true });
  assert.equal(trial.code, 1, "--yes without a terminal doesn't confirm a trial endpoint");
  assert.equal(trial.err, `${FALLBACK_CLI_TEXTS.TRIAL_NEEDS_TTY("Gemini API · personal · gemini-2.5-flash")}\n`);
  const asked = [];
  const no = await fb("add", ["gemini:gemini-2.5-flash"], { isTTY: () => true, ask: async (q) => (asked.push(q), false) });
  assert.equal(no.out, "Not added.\n");
  assert.match(asked[0], /Google may use free-tier data to improve its products\. Keep it in the order\?/);
  await fb("add", ["gemini:gemini-2.5-flash"], { isTTY: () => true, ask: async () => true });
  assert.equal(readPolicy({ root: ROOT }).targets[0].trialConsent, true);
});

test("preview prints the chain; --from and --error choose the case", async () => {
  await three();
  const p = await fb("preview", [], { error: "quotaExhausted" });
  assert.equal(p.code, 0);
  const lines = p.out.trimEnd().split("\n");
  assert.equal(lines[0], FALLBACK_CLI_TEXTS.OFF_PREVIEW);
  assert.equal(lines[1], "If OpenRouter · work · qwen/qwen3-coder:free runs out of its limit now, ad would try Gemini API · personal · gemini-2.5-flash next:");
  assert.equal(lines[3], "If that fails too: ChatGPT · personal · gpt-5.5 (your plan).");
  assert.equal(lines.at(-1), "Then ad stops and asks you.");
  const from2 = await fb("preview", [], { from: "2", error: "rateLimit" });
  assert.match(from2.out, /If Gemini API · personal · gemini-2\.5-flash hits a rate limit now, ad would try ChatGPT/);
  assert.equal((await fb("preview", [], { error: "authExpired" })).code, 2);
});

test("enable without a terminal and without --yes refuses; --yes prints the text to stderr and turns it on", async () => {
  await three();
  const no = await fb("enable");
  assert.equal(no.code, 1);
  assert.match(no.out, /^Turn on automatic fallback\?\n/);
  assert.match(no.out, / {2}2\. Gemini API · personal · gemini-2\.5-flash: free tier; Google may use free-tier data to improve its products\n/);
  assert.match(no.out, / {2}3\. ChatGPT · personal · gpt-5\.5 medium: your ChatGPT plan\n/);
  assert.equal(no.err, `${FALLBACK_CLI_TEXTS.ENABLE_NEEDS_TTY}\n`);
  assert.equal(readPolicy({ root: ROOT }).enabled, false);
  const declined = await fb("enable", [], { isTTY: () => true, ask: async () => false });
  assert.equal(declined.code, 0);
  assert.equal(readPolicy({ root: ROOT }).enabled, false);
  // --yes without a terminal is refused too: an agent in another host has no AD_TOOL_SHELL.
  const agent = await fb("enable", [], { yes: true });
  assert.equal(agent.code, 1);
  assert.equal(agent.err, `${FALLBACK_CLI_TEXTS.ENABLE_NEEDS_TTY}\n`);
  assert.equal(readPolicy({ root: ROOT }).enabled, false);
  const yes = await fb("enable", [], { yes: true, isTTY: () => true });
  assert.equal(yes.code, 0);
  assert.match(yes.err, /^Turn on automatic fallback\?/);
  assert.equal(yes.out, `${FALLBACK_CLI_TEXTS.ENABLED}\n`);
  const p = readPolicy({ root: ROOT });
  assert.equal(p.enabled, true);
  assert.match(p.consent.hash, /^sha256:/);
  // A reorder leaves it off until confirmed again.
  const moved = await fb("move", ["1", "3"]);
  assert.match(moved.out, new RegExp(FALLBACK_TEXTS.CLEARED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(readPolicy({ root: ROOT }).enabled, false);
  assert.equal((await fb("disable")).out, `${FALLBACK_CLI_TEXTS.DISABLED}\n`);
});

test("with AD_TOOL_SHELL=1, add/remove/order/move/set/enable and a live test refuse; list, preview and the dry test work", async () => {
  await three();
  const env = { AD_TOOL_SHELL: "1" };
  for (const [sub, args, extra] of [["add", ["openrouter/personal:qwen/qwen3-coder:free"]], ["remove", ["1"]], ["order", ["3", "2", "1"]], ["move", ["1", "2"]], ["set", ["cost", "freeOnly"]], ["enable", [], { yes: true }], ["test", [], { live: true, yes: true }]]) {
    const r = await fb(sub, args, { env, ...extra });
    assert.equal(r.code, 1, sub);
    assert.equal(r.err, `${FALLBACK_CLI_TEXTS.TOOL_SHELL}\n`, sub);
  }
  assert.equal(readPolicy({ root: ROOT }).revision, 3, "nothing changed");
  assert.equal((await fb("list", [], { env })).code, 0);
  assert.equal((await fb("preview", [], { env })).code, 0);
  assert.equal((await fb("test", [], { env })).code, 0);
  assert.equal((await fb("disable", [], { env })).code, 0, "turning it off is always allowed");
});

test("two ad fallback add at once → both present, revision +2", async () => {
  const [a, b] = await Promise.all([fb("add", ["openrouter/work"]), fb("add", ["openrouter/personal:qwen/qwen3-coder:free"])]);
  assert.equal(a.code + b.code, 0);
  const p = readPolicy({ root: ROOT });
  assert.equal(p.revision, 2);
  assert.deepEqual(p.targets.map((t) => t.account).sort(), ["acct_or1", "acct_or2"]);
});

test("test --live asks first, sends only to API accounts, and never starts an engine for a ChatGPT sign-in", async () => {
  await three();
  assert.equal((await fb("test", [], { live: true })).code, 1, "no terminal, no --yes");
  const sent = [];
  const testTarget = async (account, model) => (sent.push(`${account.id}:${model}`), { ok: true });
  assert.equal((await fb("test", [], { live: true, yes: true, testTarget })).code, 1, "--yes needs a terminal too");
  const r = await fb("test", [], { live: true, yes: true, json: true, testTarget, isTTY: () => true });
  assert.equal(r.code, 0);
  assert.deepEqual(sent, ["acct_or1:qwen/qwen3-coder:free", "acct_gem:gemini-2.5-flash"]);
  const rows = JSON.parse(r.out).rows;
  assert.deepEqual(rows[2].live, { sent: false, detail: FALLBACK_CLI_TEXTS.ENGINE_TEST("ChatGPT · personal") });
  const dry = await fb("test");
  assert.match(dry.out, /3\. ChatGPT · personal · gpt-5\.5 medium\n {3}account: ready · models: the engine's own models · limits: not seen yet\n {3}can continue a task now/);
});

test("the real command in a temp home: three adds, a preview, enable --yes, move clears it, the agent shell is refused", async () => {
  const env = { ...process.env, AD_ROOT: ROOT, HOME: TMP, USERPROFILE: TMP };
  delete env.AD_TOOL_SHELL;
  const ad = (args, extra = {}) => spawnSync(process.execPath, [CLI, "fallback", ...args], { env: { ...env, ...extra }, encoding: "utf8", timeout: 60_000 });
  for (const args of [["add", "openrouter/work"], ["add", "openrouter/personal:qwen/qwen3-coder:free"], ["add", "chatgpt", "--model", "gpt-5.5"]]) assert.equal(ad(args).status, 0, args.join(" "));
  assert.equal(ad(["add", "gemini:gemini-2.5-flash", "--yes"]).status, 1, "a trial endpoint needs a terminal");
  const p = ad(["preview", "--error", "quotaExhausted"]);
  assert.equal(p.status, 0);
  assert.match(p.stdout, /ad would try ChatGPT · personal · gpt-5\.5 next:/);
  assert.equal(ad(["enable", "--yes"], { AD_TOOL_SHELL: "1" }).status, 1);
  // Without a terminal, --yes is refused (the spawned command has none); in a terminal it turns it on.
  const piped = ad(["enable", "--yes"]);
  assert.equal(piped.status, 1);
  assert.match(piped.stderr, /only runs in your own terminal/);
  assert.equal((await fb("enable", [], { yes: true, isTTY: () => true })).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(fallbackFile(ROOT), "utf8")).enabled, true);
  assert.equal(ad(["move", "1", "3"]).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(fallbackFile(ROOT), "utf8")).enabled, false);
});

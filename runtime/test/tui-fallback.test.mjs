// /fallback (P4.4): the editor's keys over a real fallback.json in a temp ad root, and the
// per-window /fallback on|off in the app.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFallbackEditor, fallbackHost, FALLBACK_EDITOR_TEXTS } from "../src/tui/fallback-editor.mjs";
import { enablePolicy, readPolicy, updatePolicy } from "../src/routing/store.mjs";
import { routingContext } from "../src/routing/context.mjs";
import { catalogFile } from "../src/providers/catalog.mjs";

const acct = (o) => ({ owner: "", status: "ready", method: "api-key", credential: { kind: "secret", ref: `ad-account-${o.id}` }, keyHint: "1111", credentialRevision: 1, endpoint: null, defaultModel: null, identity: null, ...o });
const ACCOUNTS = [
  acct({ id: "acct_or1", provider: "openrouter", label: "work" }),
  acct({ id: "acct_gem", provider: "gemini", label: "personal" }),
  acct({ id: "acct_gpt", provider: "chatgpt", label: "personal", method: "engine-login", credential: { kind: "engine-home", home: "@default" }, keyHint: null, identity: { email: "s***@example.com", plan: "plus" } }),
];
const OR1 = { account: "acct_or1", model: "qwen/qwen3-coder:free" };
const GEM = { account: "acct_gem", model: "gemini-2.5-flash" };
const GPT = { account: "acct_gpt", model: "gpt-5.5" };

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-fb-editor-"));
  fs.mkdirSync(path.join(root, "accounts"), { recursive: true });
  fs.writeFileSync(path.join(root, "accounts", "registry.json"), JSON.stringify({ schemaVersion: 1, revision: 1, salt: "b64:AAAA", engines: { api: { home: null } }, accounts: ACCOUNTS, defaults: { target: null, digest: null } }));
  const at = new Date().toISOString();
  const entry = (a, model, o = {}) => ({ accountId: a, provider: ACCOUNTS.find((x) => x.id === a).provider, model, caps: { tools: true, contextWindow: 262144 }, price: { input: "0", output: "0", observedAt: at }, billing: "metered", data: {}, ...o });
  for (const [a, entries] of [["acct_or1", [entry("acct_or1", OR1.model)]], ["acct_gem", [entry("acct_gem", GEM.model, { data: { trainsOnData: "free tier", note: "Google may use free-tier data to improve its products." } })]]]) {
    fs.mkdirSync(path.dirname(catalogFile(a, { root })), { recursive: true });
    fs.writeFileSync(catalogFile(a, { root }), JSON.stringify({ v: 1, accountId: a, observedAt: at, entries }));
  }
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function editorWith(targets, { picks = [], liveTest } = {}) {
  const base = fallbackHost({ root });
  const live = [];
  const host = { ...base, pickTarget: async () => picks.shift() ?? null, liveTest: async (p) => (live.push(p), (liveTest ?? (() => ["sent"]))()) };
  if (targets.length) await updatePolicy((p) => void (p.targets = targets.map((t) => (t === GEM ? { ...t, trialConsent: true } : t))), { ...routingContext({ root }) });
  const ed = createFallbackEditor({ host });
  await ed.open();
  const text = () => ed.render().map((l) => l.text).join("\n");
  return { ed, text, live };
}

test("a adds after the selected row; a trial target asks first", async () => {
  const { ed, text } = await editorWith([OR1], { picks: [structuredClone(GEM), structuredClone(GPT)] });
  await ed.key("a");
  assert.equal(ed.mode, "ask");
  assert.match(text(), /Gemini API · personal · gemini-2\.5-flash is a trial endpoint: Google may use free-tier data to improve its products\. Keep it in the order\? y\/n/);
  await ed.key("y");
  assert.deepEqual(readPolicy({ root }).targets.map((t) => t.account), ["acct_or1", "acct_gem"]);
  assert.equal(readPolicy({ root }).targets[1].trialConsent, true);
  await ed.key("a");
  assert.deepEqual(readPolicy({ root }).targets.map((t) => t.account), ["acct_or1", "acct_gem", "acct_gpt"]);
  assert.match(text(), /› 3 {2}ChatGPT · personal · gpt-5\.5 +your plan {2}✓/);
});

test("] moves the row and marks the policy changed", async () => {
  const { ed, text } = await editorWith([OR1, GPT]);
  await ed.key("e");
  await ed.key("enter"); // [ Turn on ]
  assert.equal(readPolicy({ root }).enabled, true);
  assert.match(text(), /Fallback order +on · no extra spend/);
  await ed.key("up");
  await ed.key("]");
  const p = readPolicy({ root });
  assert.deepEqual(p.targets.map((t) => t.account), ["acct_gpt", "acct_or1"]);
  assert.equal(p.enabled, false);
  assert.ok(text().includes(FALLBACK_EDITOR_TEXTS.CHANGED));
  assert.match(text(), / 2 {2}OpenRouter · work/);
});

test("invalid save shows the error and keeps the draft; esc asks before discarding it", async () => {
  const { ed, text } = await editorWith([OR1, GPT]);
  await ed.key("down");
  await ed.key("down"); // the rules line
  await ed.key("enter");
  assert.equal(ed.mode, "rules");
  for (let i = 0; i < 4; i++) await ed.key("down"); // Cost
  await ed.key("enter");
  assert.match(text(), /! ChatGPT · personal · gpt-5\.5 isn't free \(it's your plan\)/);
  assert.equal(readPolicy({ root }).cost, "noExtraSpend", "not saved");
  assert.equal(ed.draft.cost, "freeOnly", "the draft keeps it");
  await ed.key("esc");
  await ed.key("esc");
  assert.equal(ed.mode, "ask");
  assert.ok(text().includes(FALLBACK_EDITOR_TEXTS.DISCARD));
  assert.equal(await ed.key("y"), "close");
});

test("turn on shows each destination and its data line, with the three buttons", async () => {
  const { ed, text } = await editorWith([OR1, GEM, GPT]);
  await ed.key("e");
  assert.equal(ed.mode, "consent");
  const t = text();
  assert.match(t, /^Turn on automatic fallback\?/);
  assert.match(t, / {2}1\. OpenRouter · work · qwen\/qwen3-coder:free: free; your prompts and code go to OpenRouter and the model's host/);
  assert.match(t, / {2}2\. Gemini API · personal · gemini-2\.5-flash: free tier; Google may use free-tier data to improve its products/);
  assert.match(t, / {2}3\. ChatGPT · personal · gpt-5\.5: your ChatGPT plan/);
  assert.match(t, /\[ Turn on \] +Save, keep off +Cancel/);
  await ed.key("right");
  await ed.key("enter"); // Save, keep off
  assert.equal(readPolicy({ root }).enabled, false);
  await ed.key("e");
  await ed.key("enter");
  assert.equal(readPolicy({ root }).enabled, true);
  await ed.key("e"); // on: e turns it off
  assert.equal(readPolicy({ root }).enabled, false);
});

test("t is dry, l asks first; p previews and tab picks another error", async () => {
  const { ed, text, live } = await editorWith([OR1, GPT]);
  await ed.key("t");
  assert.match(text(), /1\. OpenRouter · work · qwen\/qwen3-coder:free: can continue a task now/);
  assert.equal(live.length, 0);
  await ed.key("esc");
  await ed.key("l");
  assert.ok(text().includes(FALLBACK_EDITOR_TEXTS.LIVE_ASK));
  await ed.key("n");
  assert.equal(live.length, 0, "no means nothing is sent");
  await ed.key("l");
  await ed.key("y");
  assert.equal(live.length, 1);
  assert.match(text(), /^sent/);
  await ed.key("esc");
  await ed.key("p");
  assert.match(text(), /If OpenRouter · work · qwen\/qwen3-coder:free runs out of its limit now, ad would try ChatGPT · personal · gpt-5\.5 next:/);
  await ed.key("tab");
  assert.match(text(), /hits a rate limit now/);
});

// ---- In the app ----------------------------------------------------------------------------

const { createEngine } = await import("../src/engine/index.mjs");
const { createSession } = await import("../src/harness/session.mjs");
const { createApp } = await import("../src/tui/app.mjs");
const { createRenderer } = await import("../src/tui/terminal/renderer.mjs");
const { createInputDecoder } = await import("../src/tui/terminal/input.mjs");
const { modelScreen } = await import("../testkit/screen.mjs");
const { fileURLToPath } = await import("node:url");
const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withApp(fn, { fallbackRun } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-fb-app-"));
  const engine = await createEngine({ home: path.join(dir, "home"), command: { cmd: process.execPath, prefix: [FAKE] } });
  const session = createSession({ engine, cwd: dir, lockDir: path.join(dir, "locks") });
  const scr = modelScreen({ cols: 110, rows: 30 });
  const listeners = new Set();
  const io = { ...scr.io, onInput: (f) => (listeners.add(f), () => listeners.delete(f)) };
  const decoder = createInputDecoder({ onEvent: (e) => listeners.forEach((f) => f(e)), escTimeoutMs: 5 });
  const renderer = createRenderer({ io, reflow: "none" });
  await renderer.start();
  const scrollback = [];
  const commit = renderer.commit.bind(renderer);
  renderer.commit = (lines) => {
    for (const l of lines) scrollback.push((typeof l === "string" ? l : l.map((s) => s.text).join("")).replace(/ +$/, ""));
    return commit(lines);
  };
  const app = createApp({ io, renderer, session, cwd: dir, armMs: 0, actions: { fallback: fallbackHost({ root }), ...(fallbackRun ? { fallbackRun } : {}) } });
  const until = async (pred, what, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred()) return;
      await sleep(20);
    }
    throw new Error(`timed out waiting for ${what}:\n${scr.lines().join("\n")}`);
  };
  try {
    await fn({ app, session, type: (s) => decoder.feed(s), until, screen: () => scr.lines().join("\n"), committed: () => scrollback.join("\n") });
  } finally {
    app.dispose();
    renderer.dispose();
    session.close();
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("/fallback opens the editor below the prompt and takes its keys; esc closes it", async () => {
  await updatePolicy((p) => void (p.targets = [OR1, GPT]), { ...routingContext({ root }) });
  await withApp(async ({ app, type, until, screen }) => {
    type("/fallback\r");
    await until(() => /Fallback order +off · no extra spend/.test(screen()), "the editor");
    assert.match(screen(), /› 1 {2}OpenRouter · work · qwen\/qwen3-coder:free/);
    type("t");
    await until(() => app.state.fallback === "message", "the dry test");
    assert.match(screen(), /2\. ChatGPT · personal · gpt-5\.5: can continue a task now/);
    type("\x1b");
    await until(() => app.state.fallback === "list", "back to the order");
    type("]");
    await until(() => readPolicy({ root }).targets[0].account === "acct_gpt", "the move saved");
    type("\x1b");
    await until(() => app.state.fallback === null, "closed");
    assert.equal(app.state.composer, "", "no key reached the prompt");
  });
});

test("/fallback off affects only this window; on is refused while the saved order is off", async () => {
  await updatePolicy((p) => void (p.targets = [OR1, GPT]), { ...routingContext({ root }) });
  await withApp(async (one) => {
    await withApp(async (two) => {
      one.type("/fallback on\r");
      await one.until(() => /Fallback is off in your settings\. \/fallback opens them\./.test(one.screen()), "the refusal");
      await enablePolicy({ ...routingContext({ root }) });
      one.type("/fallback off\r");
      await one.until(() => one.app.state.fallbackHere === false, "off here");
      assert.equal(two.app.state.fallbackHere, true, "the other window still follows the settings");
      assert.equal(readPolicy({ root }).enabled, true, "nothing saved");
      one.type("/fallback on\r");
      await one.until(() => one.app.state.fallbackHere === true, "on again");
    });
  });
});

test("on, but an account changed since: the header says so and e shows the consent again", async () => {
  const { ed, text } = await editorWith([OR1, GPT]);
  await ed.key("e");
  await ed.key("enter");
  assert.equal(readPolicy({ root }).enabled, true);
  // ChatGPT · personal signed in again as someone else (another window, or ad auth).
  const file = path.join(root, "accounts", "registry.json");
  const reg = JSON.parse(fs.readFileSync(file, "utf8"));
  reg.accounts.find((a) => a.id === "acct_gpt").identity = { email: "o***@example.com", plan: "plus" };
  fs.writeFileSync(file, JSON.stringify(reg));
  const again = createFallbackEditor({ host: fallbackHost({ root }) });
  await again.open();
  assert.match(again.render()[0].text, /Fallback order +off until you confirm again/);
  await again.key("e");
  assert.equal(again.mode, "consent", "not a turn-off");
  await again.key("enter");
  assert.match(again.render()[0].text, /Fallback order +on/);
  void text;
});

test("in the app: keys typed fast are applied in order; Ctrl and Alt chords don't reach the editor", async () => {
  await updatePolicy((p) => void (p.targets = [OR1, { ...GEM, trialConsent: true }, GPT]), { ...routingContext({ root }) });
  await withApp(async ({ app, type, until }) => {
    type("/fallback\r");
    await until(() => app.state.fallback === "list", "the editor");
    type("\x04"); // Ctrl+D
    type("\x1be"); // Alt+E
    type("]]");
    await until(() => readPolicy({ root }).targets.map((t) => t.account).join() === "acct_gem,acct_gpt,acct_or1", "both moves");
    assert.equal(readPolicy({ root }).targets.length, 3, "Ctrl+D removed nothing");
    assert.equal(readPolicy({ root }).enabled, false, "Alt+E turned nothing on");
  });
});

test("a draw while a key's work runs doesn't hide its result (the live test's lines appear)", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { ed, text } = await editorWith([OR1, GPT], { liveTest: () => gate.then(() => ["1. answered"]) });
  await ed.key("l");
  const pending = ed.key("y");
  ed.render(); // the app redraws on its own ticker meanwhile
  release();
  await pending;
  assert.equal(ed.mode, "message");
  assert.match(text(), /^1\. answered/);
});

// ---- Automatic fallback in the app (P4.5 B2) ------------------------------------------------

const stubRun = ({ paused = false, handledAll = false, status = null } = {}) => {
  const calls = [];
  let p = paused;
  return {
    calls,
    run: {
      paused: () => p,
      retry: () => (calls.push("retry"), (p = false), true),
      resume: () => (calls.push("resume"), (p = false)),
      handled: () => handledAll,
      status: () => status,
    },
  };
};

test("/retry says there is nothing to retry when fallback isn't paused; when paused it retries", async () => {
  const idle = stubRun();
  await withApp(async ({ type, until, committed }) => {
    type("/retry\r");
    await until(() => /Nothing to retry: automatic fallback isn't paused\./.test(committed()), "the answer");
    assert.deepEqual(idle.calls, []);
  }, { fallbackRun: idle.run });
  const held = stubRun({ paused: true });
  await withApp(async ({ type, until, committed }) => {
    type("/retry\r");
    await until(() => /Trying again on this model\./.test(committed()), "the retry");
    assert.deepEqual(held.calls, ["retry"]);
  }, { fallbackRun: held.run });
});

test("a prompt typed while fallback is paused ends the pause first", async () => {
  const held = stubRun({ paused: true });
  await withApp(async ({ type, until, session }) => {
    type("early-complete\r");
    await until(() => held.calls.includes("resume"), "the pause ended");
    await until(() => session.state.turns.length > 0, "the prompt sent");
    assert.equal(held.calls[0], "resume");
  }, { fallbackRun: held.run });
});

test("/status shows fallback's switches and the last reason; off in this window after /fallback off", async () => {
  const at = Date.parse("2026-11-02T14:02:00");
  const s = stubRun({ status: { switches: 1, lastSwitch: { at, why: "OpenRouter's daily limit is used up (resets 05:30)" }, paused: null } });
  await withApp(async ({ type, until, committed }) => {
    type("/status\r");
    await until(() => /fallback\s+1 switch this session \(14:02, OpenRouter's daily limit is used up \(resets 05:30\)\)/.test(committed()), "the fallback row");
    type("/fallback off\r");
    await until(() => /Fallback is off for this window/.test(committed()), "off here");
    type("/status\r");
    await until(() => /fallback\s+off in this window \(\/fallback on\)/.test(committed()), "the off row");
  }, { fallbackRun: s.run });
});

test("a failed turn fallback handled shows no \"The turn failed\" line", async () => {
  const s = stubRun({ handledAll: true });
  await withApp(async ({ type, until, session, committed }) => {
    type("fail-turn\r");
    await until(() => session.state.turns.some((t) => t.status === "failed"), "the failed turn");
    await sleep(200);
    assert.doesNotMatch(committed(), /The turn failed/);
  }, { fallbackRun: s.run });
  await withApp(async ({ type, until, committed }) => {
    type("fail-turn\r");
    await until(() => /The turn failed/.test(committed()), "the engine's words when fallback didn't act");
  });
});

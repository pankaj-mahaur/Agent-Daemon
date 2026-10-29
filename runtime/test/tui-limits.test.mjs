// P4.6 in the app: the limits status item, the footer chip, /status and /usage rows, and the
// notices before a limit runs out (once per window and reset period; warnAt "off"; the
// fallback suffix). The quota view is the real one over an in-memory store.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { quotaView } from "../src/providers/quota-view.mjs";
import { fromChatgpt, fromOpenRouterKey } from "../src/providers/quota.mjs";

const { createEngine } = await import("../src/engine/index.mjs");
const { createSession } = await import("../src/harness/session.mjs");
const { createApp } = await import("../src/tui/app.mjs");
const { createRenderer } = await import("../src/tui/terminal/renderer.mjs");
const { createInputDecoder } = await import("../src/tui/terminal/input.mjs");
const { modelScreen } = await import("../testkit/screen.mjs");
const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One account's limits, as main.mjs gives them to the app.
function quotaStub(name = "OpenRouter · work", provider = "openrouter") {
  const store = { observations: {}, bench: {} };
  const seen = {};
  return {
    store,
    seen,
    set(list) {
      store.observations = Object.fromEntries(list.map((o, i) => [String(i), o]));
    },
    actions: {
      view: () => quotaView("acct", { store, provider }),
      name: () => name,
      seen: () => ({ ...seen }),
      mark: (keys) => keys.forEach((k) => (seen[k] = true)),
      refresh: async () => false,
    },
  };
}
const orDay = (used, limit = 50, now = Date.now()) => fromOpenRouterKey({ data: { free_model_daily_requests: { used, limit, remaining: limit - used } } }, { accountId: "acct", now }).observations;

async function withApp(fn, { quota, fallbackRun, accounts, prefs = {}, cols = 110 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-limits-app-"));
  const engine = await createEngine({ home: path.join(dir, "home"), command: { cmd: process.execPath, prefix: [FAKE] } });
  const session = createSession({ engine, cwd: dir, lockDir: path.join(dir, "locks") });
  const scr = modelScreen({ cols, rows: 30 });
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
  const settings = { engine: { get: () => undefined, set: async () => {} }, ad: { get: (k, d) => (k in prefs ? prefs[k] : d), set: (k, v) => (prefs[k] = v) } };
  const app = createApp({ io, renderer, session, cwd: dir, armMs: 0, settings, actions: { ...(quota ? { quota: quota.actions } : {}), ...(fallbackRun ? { fallbackRun } : {}), ...(accounts ? { accounts } : {}) } });
  const until = async (pred, what, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred()) return;
      await sleep(20);
    }
    throw new Error(`timed out waiting for ${what}:\n${scr.lines().join("\n")}\n--- committed ---\n${scrollback.join("\n")}`);
  };
  try {
    await fn({ app, session, type: (s) => decoder.feed(s), until, screen: () => scr.lines().join("\n"), committed: () => scrollback.join("\n"), flat: () => scrollback.join("\n").replace(/\n\s+/g, " ") });
  } finally {
    app.dispose();
    renderer.dispose();
    session.close();
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
const count = (s, re) => (s.match(new RegExp(re.source, "g")) ?? []).length;

test("an OpenRouter account at 46 of 50: today 46/50 on the status line, the footer chip, one 90% notice", async () => {
  const q = quotaStub();
  q.set(orDay(46));
  await withApp(async ({ screen, committed, until, type }) => {
    await until(() => /today 46\/50/.test(screen()), "the status item");
    await until(() => /limit 92% · resets \d{2}:\d{2}/.test(screen()), "the footer chip");
    await until(() => /OpenRouter · work: 92% of today's free requests used \(resets \d{2}:\d{2}\)\./.test(committed()), "the notice");
    // Later draws (3 s apart) never repeat it: the mark is kept.
    await sleep(3200);
    type("x");
    await sleep(200);
    assert.equal(count(committed(), /92% of today's free requests used/), 1);
    assert.equal(Object.keys(q.seen).length, 1, "marked in the store");
  }, { quota: q });
});

test("90% notice once per window, again after the reset; used up gets its own", async () => {
  const q = quotaStub("ChatGPT · personal", "chatgpt");
  const five = (used, resetMin) => fromChatgpt({ primary: { usedPercent: used, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + resetMin * 60 } }, { accountId: "acct" });
  q.set(five(91, 60));
  await withApp(async ({ committed, until, type }) => {
    await until(() => /91% of the 5-hour limit used/.test(committed()), "the first notice");
    q.set(five(100, 60).map((o) => ({ ...o, state: "exhausted" })));
    await sleep(3200);
    type("x");
    await until(() => /ChatGPT · personal: the 5-hour limit is used up \(resets \d{2}:\d{2}\)\./.test(committed()), "used up");
    q.set(five(93, 360)); // the next period
    await sleep(3200);
    type("y");
    await until(() => /93% of the 5-hour limit used/.test(committed()), "again after the reset");
    assert.equal(count(committed(), /of the 5-hour limit used/), 2);
  }, { quota: q });
});

test("limits.warnAt off sends no notice and no 92% chip; a used-up window still shows its chip", async () => {
  const q = quotaStub();
  q.set(orDay(46));
  await withApp(async ({ committed, screen, until, type }) => {
    await until(() => /today 46\/50/.test(screen()), "the status item");
    await sleep(300);
    assert.doesNotMatch(committed(), /free requests used/);
    assert.doesNotMatch(screen(), /limit 92%/);
    q.set(orDay(50));
    type("x"); // a draw: the app redraws on events, not on the store
    await until(() => /limit used up · resets \d{2}:\d{2}/.test(screen()), "the used-up chip");
  }, { quota: q, prefs: { "limits.warnAt": "off" } });
});

test("the fallback suffix names the next target; with fallback off and other accounts, /fallback is suggested", async () => {
  const q = quotaStub();
  q.set(orDay(46));
  await withApp(async ({ flat, until }) => {
    await until(() => /used \(resets \d{2}:\d{2}\)\. If it runs out, ad continues on Gemini API · gemini-2\.5-flash after that turn\./.test(flat()), "the suffix");
  }, { quota: q, fallbackRun: { on: () => true, nextLabel: () => "Gemini API · gemini-2.5-flash", status: () => ({ switches: 0 }) } });
  const q2 = quotaStub();
  q2.set(orDay(46));
  await withApp(async ({ flat, until }) => {
    await until(() => /used \(resets \d{2}:\d{2}\)\. \/fallback can continue on another account when it runs out\./.test(flat()), "the hint");
  }, { quota: q2, fallbackRun: { on: () => false, nextLabel: () => null, status: () => ({ switches: 0 }) }, accounts: { label: () => "OpenRouter · work" } });
});

test("/status rows: OpenRouter's day and credits, nothing reported, and a benched provider", async () => {
  const q = quotaStub();
  const now = Date.now();
  q.set([...orDay(41, 50, now), ...fromOpenRouterKey({ data: { limit_remaining: 3.2 } }, { accountId: "acct", now }).observations]);
  await withApp(async ({ type, committed, until }) => {
    type("/status\r");
    await until(() => /limits\s+free requests today: 41 of 50 \(resets \d{2}:\d{2}, in \d+h( \d+m)?\) · credits \$3\.20 left · checked 1 min ago/.test(committed()), "the OpenRouter row");
    q.set([]);
    type("/status\r");
    await until(() => /limits\s+not reported by this provider/.test(committed()), "unknown");
    q.store.bench.openrouter = { until: new Date(now + 3 * 3_600_000).toISOString(), reason: "quotaExhausted" };
    type("/status\r");
    await until(() => /limits\s+OpenRouter hit a limit; other OpenRouter accounts aren't used automatically until \d{2}:\d{2}/.test(committed()), "benched");
  }, { quota: q, cols: 200 });
});

test("/usage for an API account shows ad's windows; none reported says so", async () => {
  const q = quotaStub();
  q.set(orDay(41));
  await withApp(async ({ type, committed, until }) => {
    type("/usage\r");
    await until(() => /free requests today: 41 of 50/.test(committed()), "the window");
    q.set([]);
    type("/usage\r");
    await until(() => /This provider doesn't report usage to ad\./.test(committed()), "none");
  }, { quota: q });
});

test("a notice isn't repeated while its mark is still being written", async () => {
  const q = quotaStub();
  q.set(orDay(46));
  q.actions.mark = () => new Promise(() => {}); // the store's write never lands
  await withApp(async ({ committed, until, type }) => {
    await until(() => /92% of today's free requests used/.test(committed()), "the notice");
    await sleep(3200);
    type("x");
    await sleep(200);
    assert.equal(count(committed(), /92% of today's free requests used/), 1);
  }, { quota: q });
});

// P4.6: limits as the user reads them (providers/quota-view.mjs): labels by window length,
// reset times, unknown left out, the notices before a limit runs out, and their marks.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inText, limitNotices, mostConstrained, quotaView, resetText } from "../src/providers/quota-view.mjs";
import { fromChatgpt, fromOpenRouterKey, markNoticed, noticesShown, readStore, recordObservations } from "../src/providers/quota.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-quota-view-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// Local times: the reset words are in the user's clock.
const at = (h, m = 0, dayOffset = 0) => {
  const d = new Date(2026, 9, 29 + dayOffset, h, m, 0, 0);
  return d.getTime();
};
const NOW = at(12);
const iso = (ms) => new Date(ms).toISOString();
const store = (list) => ({ observations: Object.fromEntries(list.map((o, i) => [String(i), o])), bench: {} });

test("reset words: 05:30 within a day, a weekday after that, 'in 2h 10m'; unknown is null", () => {
  assert.equal(resetText(iso(at(14, 5)), NOW), "14:05");
  assert.equal(resetText(iso(at(5, 30, 1)), NOW), "05:30");
  assert.match(resetText(iso(at(9, 0, 5)), NOW), /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) 09:00$/);
  assert.equal(resetText(null, NOW), null);
  assert.equal(inText(iso(at(14, 10)), NOW), "in 2h 10m");
  assert.equal(inText(iso(at(12, 45)), NOW), "in 45m");
  assert.equal(inText(iso(at(19)), NOW), "in 7h");
  assert.equal(inText(iso(at(11)), NOW), null, "past");
});

test("labels by window length: 5h 64%, wk 22%, today 41/50, $3.20 left; used up until 05:30", () => {
  const cg = fromChatgpt({ primary: { usedPercent: 64, windowDurationMins: 300, resetsAt: at(14, 5) / 1000 }, secondary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: at(9, 0, 5) / 1000 } }, { accountId: "a", now: NOW });
  assert.deepEqual(quotaView("a", { store: store(cg), now: NOW }).windows.map((w) => w.label), ["5h 64%", "wk 22%"]);
  const or = fromOpenRouterKey({ data: { free_model_daily_requests: { used: 41, limit: 50, remaining: 9 }, limit_remaining: 3.2 } }, { accountId: "o", now: NOW }).observations;
  assert.deepEqual(quotaView("o", { store: store(or), now: NOW }).windows.map((w) => w.label), ["today 41/50", "$3.20 left"]);
  const out = fromOpenRouterKey({ data: { free_model_daily_requests: { used: 50, limit: 50, remaining: 0 } } }, { accountId: "o", now: NOW }).observations;
  const w = quotaView("o", { store: store(out), now: NOW }).windows[0];
  assert.equal(w.state, "exhausted");
  assert.match(w.label, /^used up until \d{2}:\d{2}$/);
  assert.match(w.short, /^out → \d{2}:\d{2}$/);
  assert.ok(w.short.length <= 13, "fits the list's limits cell");
});

test("a window past its reset reads unknown and is left out, never 0%; the view's state is the worst left", () => {
  const cg = fromChatgpt({ primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: at(11) / 1000 }, secondary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: at(9, 0, 5) / 1000 } }, { accountId: "a", now: at(10) });
  const v = quotaView("a", { store: store(cg), now: NOW });
  assert.deepEqual(v.windows.map((w) => w.window), ["week"]);
  assert.equal(v.state, "ok");
  assert.equal(quotaView("nobody", { store: store(cg), now: NOW }).state, "unknown");
  assert.equal(mostConstrained(quotaView("nobody", { store: store(cg), now: NOW })), null);
});

test("an inferred 'used up' with no reset: shown as used up, but it never gives the 90% notice", () => {
  const o = { v: 1, accountId: "a", provider: "openai", scope: "key", window: "unknown", usedPercent: null, used: null, limit: null, remaining: null, resetsAt: null, state: "exhausted", source: "gateway:error", observedAt: iso(NOW - 60_000), confidence: "inferred" };
  const v = quotaView("a", { store: store([o]), now: NOW });
  assert.equal(v.windows[0].label, "used up");
  assert.deepEqual(limitNotices(v, { name: "OpenAI · work", now: NOW }), []);
});

test("the benched text: another window's limit on the provider shows until when", () => {
  const s = { observations: {}, bench: { openrouter: { until: iso(at(5, 30, 1)), reason: "quotaExhausted" } } };
  assert.equal(quotaView("o", { store: s, now: NOW, provider: "openrouter" }).benchedUntil, iso(at(5, 30, 1)));
  assert.equal(quotaView("o", { store: s, now: NOW, provider: "openai" }).benchedUntil, null);
});

test("notices: one at 90% and one when used up, per window and reset period; warnAt off sends none", () => {
  const five = (used, state = "near") => fromChatgpt({ primary: { usedPercent: used, windowDurationMins: 300, resetsAt: at(14, 5) / 1000 } }, { accountId: "a", now: NOW }).map((o) => ({ ...o, state: used >= 100 ? "exhausted" : state }));
  const v = quotaView("a", { store: store(five(91)), now: NOW });
  const n = limitNotices(v, { name: "ChatGPT · personal", now: NOW });
  assert.deepEqual(n.map((x) => x.text), ["ChatGPT · personal: 91% of the 5-hour limit used (resets 14:05)."]);
  const seen = Object.fromEntries(n.map((x) => [x.key, true]));
  assert.deepEqual(limitNotices(v, { name: "ChatGPT · personal", seen, now: NOW }), [], "once");
  const out = limitNotices(quotaView("a", { store: store(five(100)), now: NOW }), { name: "ChatGPT · personal", seen, now: NOW });
  assert.deepEqual(out.map((x) => x.text), ["ChatGPT · personal: the 5-hour limit is used up (resets 14:05)."]);
  const nextPeriod = fromChatgpt({ primary: { usedPercent: 92, windowDurationMins: 300, resetsAt: at(19, 5) / 1000 } }, { accountId: "a", now: NOW });
  assert.equal(limitNotices(quotaView("a", { store: store(nextPeriod), now: NOW }), { name: "x", seen, now: NOW }).length, 1, "again after the reset");
  assert.deepEqual(limitNotices(v, { name: "x", warnAt: "off", now: NOW }), []);
  assert.deepEqual(limitNotices(quotaView("a", { store: store(five(89, "ok")), now: NOW }), { name: "x", now: NOW }), [], "under the threshold");
  const or = fromOpenRouterKey({ data: { free_model_daily_requests: { used: 46, limit: 50, remaining: 4 } } }, { accountId: "o", now: NOW }).observations;
  assert.match(limitNotices(quotaView("o", { store: store(or), now: NOW }), { name: "OpenRouter · work", now: NOW })[0].text, /^OpenRouter · work: 92% of today's free requests used \(resets \d{2}:\d{2}\)\.$/);
});

test("notice marks persist in the QuotaStore (a restart doesn't repeat one) and old marks are dropped", async () => {
  const root = path.join(TMP, "marks");
  await recordObservations(fromChatgpt({ primary: { usedPercent: 95, windowDurationMins: 300, resetsAt: at(14) / 1000 } }, { accountId: "a", now: NOW }), { root });
  await markNoticed(["old"], { root, now: NOW - 9 * 24 * 3_600_000 });
  await markNoticed(["a|5h||x|90"], { root, now: NOW });
  assert.deepEqual(Object.keys(noticesShown({ root })), ["a|5h||x|90"]);
  assert.equal(Object.keys(readStore({ root }).observations).length, 1, "observations untouched");
});

test("the list cell stays within 13 characters: a long count becomes a percentage", async () => {
  const { listCell } = await import("../src/providers/quota-view.mjs");
  const big = fromOpenRouterKey({ data: { free_model_daily_requests: { used: 999, limit: 1000, remaining: 1 } } }, { accountId: "o", now: NOW }).observations;
  const v = quotaView("o", { store: store(big), now: NOW });
  assert.equal(v.windows[0].label, "today 999/1000", "the status line keeps the count");
  assert.equal(listCell(v, NOW), "today 99%", "rounded down: not used up yet");
  const small = fromOpenRouterKey({ data: { free_model_daily_requests: { used: 41, limit: 50, remaining: 9 } } }, { accountId: "o", now: NOW }).observations;
  assert.equal(listCell(quotaView("o", { store: store(small), now: NOW }), NOW), "today 41/50");
});

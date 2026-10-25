// Picker rows (P3.8b): group headers and disabled rows. Pure view.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPicker } from "../src/tui/view/chrome.mjs";

const key = (name) => ({ type: "key", name });
const text = (s) => [...s].map((ch) => ({ type: "text", text: ch }));
const items = [
  { kind: "header", label: "ChatGPT" },
  { label: "personal", hint: "this window", value: "a" },
  { label: "work", hint: "needs sign-in", value: "b", disabled: true, reason: "Sign in again first: /login chatgpt" },
  { kind: "header", label: "OpenRouter" },
  { label: "default", hint: "key …9f3c", value: "c" },
  { label: "client-a", hint: "key …a1b2", value: "d" },
];

test("header rows are skipped by arrows and never selected", () => {
  const p = createPicker({ items });
  assert.equal(p.current, "a", "the first selectable row");
  p.handle(key("down"));
  assert.equal(p.current, "b");
  p.handle(key("down"));
  assert.equal(p.current, "c", "skips the OpenRouter header");
  p.handle(key("up"));
  p.handle(key("up"));
  assert.equal(p.current, "a");
  p.handle(key("up"));
  assert.equal(p.current, "d", "wraps past the first header");
  const rows = p.render({ width: 60, height: 10 }).map((l) => l.map((s) => s.text).join(""));
  assert.ok(rows.some((r) => r === " ChatGPT"));
  assert.ok(!rows.some((r) => r.startsWith("\u{203a}  ChatGPT")));
});

test("disabled rows show their reason on Enter and select nothing", () => {
  const p = createPicker({ items, initial: "b" });
  assert.equal(p.current, "b");
  const r = p.handle(key("enter"));
  assert.equal(r.select, undefined);
  assert.equal(r.note, "Sign in again first: /login chatgpt");
});

test("a group's header stays only when one of its rows matches the filter", () => {
  const p = createPicker({ items });
  for (const ev of text("client")) p.handle(ev);
  const rows = p.render({ width: 60, height: 10 }).map((l) => l.map((s) => s.text).join(""));
  assert.ok(rows.some((r) => r === " OpenRouter"));
  assert.ok(!rows.some((r) => r === " ChatGPT"));
  assert.equal(p.current, "d");
  assert.equal(p.handle(key("enter")).select, "d");
});

test("a filter that matches nothing selects nothing on Enter", () => {
  const p = createPicker({ items });
  for (const ev of text("zzz")) p.handle(ev);
  const r = p.handle(key("enter"));
  assert.equal(r?.select, undefined);
});

test("a list of only disabled rows explains itself and selects nothing", () => {
  const p = createPicker({ items: [{ kind: "header", label: "Not offered" }, { label: "x", value: "x", disabled: true, reason: "why not" }] });
  const r = p.handle(key("enter"));
  assert.equal(r?.select, undefined);
  assert.equal(r?.note, "why not");
});

// Chrome and popups (tui/view/chrome.mjs), plan Part 5d. Goldens at widths
// 40, 80 and 120 (AD_UPDATE_GOLDEN=1 rewrites them; review the diff).

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertGolden } from "../testkit/golden.mjs";
import { createPicker, newlineHint, renderFooter, renderHeader, renderShortcuts, renderStatus, shortenPath } from "../src/tui/view/chrome.mjs";
import { lineWidth } from "../src/tui/terminal/text.mjs";

const text = (lines) => lines.map((l) => l.map((s) => s.text).join("").replace(/ +$/, "")).join("\n");
const key = (name, mods = {}) => ({ type: "key", name, ctrl: false, alt: false, shift: false, ...mods });

const HEADER = {
  title: ">_ Agent Daemon (v2.1.0) \u{b7} on Codex 0.160.0 (tested)",
  rows: [
    { label: "model", value: "gpt-5.x-codex medium \u{b7} ChatGPT Plus", hint: "/model to change" },
    { label: "directory", value: "D:\\Program Files\\work\\shop-app \u{b7} git: dev", path: true },
    { label: "memory", value: "142 learnings \u{b7} profile loaded", hint: "/memory" },
    { label: "sandbox", value: "workspace-write \u{b7} asks first \u{b7} Windows sandbox ready" },
  ],
};
const IDLE = { hints: ["? shortcuts", "@ files", "ctrl+j newline"], meters: [{ text: "ctx 100%" }, { text: "5h 34%" }] };
const BUSY = { hints: ["enter steer", "tab queue", "ctrl+j newline"], chips: [{ full: "loop 3/20", short: "L3" }], meters: [{ text: "ctx 91%" }, { text: "5h 38%" }] };

function sheet(width) {
  const out = [];
  out.push("── header ──", text(renderHeader(HEADER, { width })));
  out.push("── status ──", text(renderStatus({ label: "Checking token refresh", elapsedMs: 14_000, queued: ["also run the signup test"] }, { width })));
  out.push("── footer idle ──", text([renderFooter(IDLE, { width })]));
  out.push("── footer busy ──", text([renderFooter(BUSY, { width })]));
  out.push("── shortcuts ──", text(renderShortcuts({ newline: "ctrl+enter" }, { width })));
  return out.join("\n");
}

for (const width of [40, 80, 120]) {
  test(`chrome golden at width ${width}`, () => {
    assertGolden(`tui/chrome-${width}.txt`, sheet(width));
  });
}

test("the header box is closed and fits; under 40 columns it is one line", () => {
  for (const width of [40, 60, 80, 120]) {
    const lines = renderHeader(HEADER, { width });
    const widths = new Set(lines.map(lineWidth));
    assert.equal(widths.size, 1, `every row as wide as the border @${width}`);
    assert.ok([...widths][0] <= Math.min(78, width - 2) + 0, `@${width}`);
  }
  assert.equal(renderHeader(HEADER, { width: 30 }).length, 1);
  // Outside values are sanitized.
  const evil = renderHeader({ title: "t", rows: [{ label: "directory", value: "C:\\x\x1b]0;pwn\x07y", path: true }] }, { width: 60 });
  assert.ok(!text(evil).includes("\x1b"));
});

test("shortenPath keeps the drive and the last folders", () => {
  assert.equal(shortenPath("D:\\Program Files\\work\\shop-app", 25), "D:\\\u{2026}\\work\\shop-app");
  assert.equal(shortenPath("/home/me/src/app", 40), "/home/me/src/app");
  assert.equal(shortenPath("/home/me/src/app", 10), "/\u{2026}/src/app");
  assert.equal(shortenPath("/home/me/src/app", 7), "/\u{2026}/app");
});

test("footer drop order: hints, then chips shorten, then chips go, meters last", () => {
  const at = (w) => text([renderFooter(BUSY, { width: w })]);
  assert.match(at(80), /enter steer · tab queue · ctrl\+j newline +ctx 91% · 5h 38% · loop 3\/20/);
  assert.match(at(50), /^ {2}enter steer +ctx 91% · 5h 38% · loop 3\/20$/);
  assert.equal(at(30), "  ctx 91% · 5h 38% · loop 3/20");
  assert.match(at(24), /ctx 91% · 5h 38% · L3$/);
  assert.match(at(17), /ctx 91% · 5h 38%$/);
  assert.match(at(8), /ctx 91%$/);
  for (const w of [4, 10, 30, 60]) assert.ok(lineWidth(renderFooter(BUSY, { width: w })) <= w);
  // A meter over 80 % shows amber.
  const warn = renderFooter({ meters: [{ text: "5h 85%", warn: true }] }, { width: 40 });
  assert.deepEqual(warn.find((s) => s.text === "5h 85%").style, { fg: "yellow" });
});

test("newline hint per terminal (FC0)", () => {
  assert.equal(newlineHint({ terminal: "zed" }), "shift+enter");
  assert.equal(newlineHint({ terminal: "windows-terminal" }), "ctrl+enter");
  assert.equal(newlineHint({ terminal: "windows-terminal", csiU: true }), "shift+enter");
  assert.equal(newlineHint({ terminal: "vscode" }), "ctrl+j");
});

test("status: elapsed time, queued prompts with the edit hint on the last", () => {
  assert.match(text(renderStatus({ elapsedMs: 125_000 }, { width: 80 })), /Working \(2m 05s · esc to interrupt\)/);
  const lines = renderStatus({ queued: ["a", "b"] }, { width: 40 });
  assert.ok(!text([lines[1]]).includes("tab: edit"));
  assert.match(text([lines[2]]), /tab: edit$/);
  for (const l of renderStatus({ queued: ["x".repeat(200)] }, { width: 20 })) assert.ok(lineWidth(l) <= 20);
});

test("picker: filters by every word, moves, scrolls, picks, closes", () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ label: `thread ${i}`, hint: i % 2 ? "odd" : "even", value: i }));
  const p = createPicker({ items, title: "Resume" });
  assert.equal(p.render({ width: 40, height: 6 }).length, 6);
  for (const ch of "odd 1") p.handle({ type: "text", text: ch });
  assert.deepEqual(text(p.render({ width: 40, height: 10 }).slice(1)).split("\n").map((l) => l.trim()), ["› thread 1  odd", "thread 11  odd", "thread 13  odd", "thread 15  odd", "thread 17  odd", "thread 19  odd", "thread 21  odd"]);
  p.handle(key("down"));
  assert.deepEqual(p.handle(key("enter")), { select: 11, item: items[11] });
  p.handle(key("up"));
  p.handle(key("up"));
  assert.equal(p.handle(key("enter")).select, 21, "wraps around");
  for (let i = 0; i < 10; i++) p.handle(key("backspace"));
  for (let i = 0; i < 12; i++) p.handle(key("down"));
  assert.match(text(p.render({ width: 40, height: 6 })), /› thread 12/);
  for (const ch of "zzz") p.handle({ type: "text", text: ch });
  assert.match(text(p.render({ width: 40 })), /no matches/);
  assert.deepEqual(p.handle(key("enter")), { changed: false });
  assert.deepEqual(p.handle(key("escape")), { cancel: true });
});

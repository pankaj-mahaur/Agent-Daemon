// ad's own dialogs (codex-parity-2 Part 1): the yes/no confirm (view/modals.mjs)
// and the checklist (view/chrome.mjs), alone and inside the app.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertGolden } from "../testkit/golden.mjs";
import { createConfirm } from "../src/tui/view/modals.mjs";
import { createChecklist } from "../src/tui/view/chrome.mjs";
import { lineWidth } from "../src/tui/terminal/text.mjs";

const text = (lines) => lines.map((l) => l.map((s) => s.text).join("").replace(/ +$/, "")).join("\n");
const key = (name, mods = {}) => ({ type: "key", name, ctrl: false, alt: false, shift: false, ...mods });
const chr = (t) => ({ type: "text", text: t });

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

const CONFIRM = { title: "Delete this conversation?", body: "login fix\nCannot be undone. Subagent threads will also be deleted.", yes: "Yes, delete it", no: "No, keep it" };
const ITEMS = [
  { label: "model-with-reasoning", hint: "gpt-5.5 high", value: "model-with-reasoning", checked: true },
  { label: "current-dir", hint: "~/work/app", value: "current-dir", checked: true },
  { label: "git-branch", hint: "main", value: "git-branch" },
  { label: "context-remaining", hint: "62% left", value: "context-remaining" },
];

test("confirm: no answer until armed (type-ahead, a held key); Esc is no at once", () => {
  const c = clock();
  const d = createConfirm(CONFIRM, { now: c.now, armMs: 400 });
  assert.deepEqual(d.handle(chr("y")), { changed: true }, "too soon: not an answer");
  c.advance(399);
  assert.deepEqual(d.handle(key("enter")), { changed: true }, "the window restarted with the last key");
  c.advance(400);
  assert.deepEqual(d.handle(key("enter")), { answer: false }, '"No" is focused first');
  const e = createConfirm(CONFIRM, { now: c.now, armMs: 400 });
  c.advance(400);
  assert.deepEqual(e.handle(chr("y")), { answer: true });
  assert.deepEqual(createConfirm(CONFIRM, { now: c.now, armMs: 400 }).handle(key("escape")), { answer: false });
  assert.deepEqual(createConfirm(CONFIRM, { now: c.now, armMs: 400 }).handle(key("c", { ctrl: true })), { answer: false });
  const f = createConfirm(CONFIRM, { now: c.now, armMs: 400 });
  c.advance(500);
  f.handle(key("down")); // moving restarts the window, then Enter picks "Yes"
  assert.deepEqual(f.handle(key("enter")), { changed: true });
  c.advance(400);
  assert.deepEqual(f.handle(key("enter")), { answer: true });
});

test("checklist: space toggles, ←/→ reorder, Enter saves in order, Esc cancels, onChange sees each change", () => {
  const seen = [];
  const l = createChecklist({ items: ITEMS, title: "Status line", reorder: true, onChange: (v) => seen.push(v.join(",")) });
  assert.deepEqual(l.values, ["model-with-reasoning", "current-dir"]);
  l.handle(key("down"));
  l.handle(key("down"));
  l.handle(key("space")); // git-branch on
  l.handle(key("left")); // git-branch before current-dir
  l.handle(chr(" ")); // a space typed as text toggles too: git-branch off again
  l.handle(key("space"));
  assert.deepEqual(seen, ["model-with-reasoning,current-dir,git-branch", "model-with-reasoning,git-branch,current-dir", "model-with-reasoning,current-dir", "model-with-reasoning,git-branch,current-dir"]);
  assert.deepEqual(l.handle(chr("x")), { changed: false }, "other keys are taken, not passed on");
  assert.deepEqual(l.handle(key("enter")), { select: ["model-with-reasoning", "git-branch", "current-dir"] });
  assert.deepEqual(l.handle(key("escape")), { cancel: true });
  const fixed = createChecklist({ items: ITEMS });
  fixed.handle(key("down"));
  assert.deepEqual(fixed.handle(key("left")), { changed: false }, "no reordering unless asked for");
  assert.deepEqual(fixed.values, ["model-with-reasoning", "current-dir"]);
});

function sheet(width) {
  const c = clock();
  const out = [];
  out.push("── confirm (arming) ──", text(createConfirm(CONFIRM, { now: c.now }).render({ width, height: 12 })));
  const armed = createConfirm(CONFIRM, { now: c.now });
  c.advance(500);
  out.push("── confirm (armed) ──", text(armed.render({ width, height: 12 })));
  out.push("── confirm (short) ──", text(armed.render({ width, height: 4 })));
  out.push("── checklist ──", text(createChecklist({ items: ITEMS, title: "Status line", reorder: true }).render({ width, height: 10 })));
  out.push("── checklist (scrolls) ──", text(createChecklist({ items: ITEMS, title: "Title" }).render({ width, height: 4 })));
  return out.join("\n");
}

for (const width of [40, 80, 120]) {
  test(`dialogs golden at width ${width}`, () => {
    assertGolden(`tui/dialogs-${width}.txt`, sheet(width));
    const c = clock();
    for (const l of [...createConfirm(CONFIRM, { now: c.now }).render({ width, height: 12 }), ...createChecklist({ items: ITEMS, reorder: true }).render({ width, height: 10 })]) {
      assert.ok(lineWidth(l) <= width, JSON.stringify(l));
    }
  });
}

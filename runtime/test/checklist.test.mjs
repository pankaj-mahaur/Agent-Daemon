// L5 P4 (design decision 11): the review checklist's model, view, key decoder and driver.
// Pure tests; checklist-store.test.mjs runs it over a real store.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createChecklist, press, plan, summaryLine, visible, focused, pageRows } from "../src/memory/checklist.mjs";
import { render, FOOTER } from "../src/memory/checklist-view.mjs";
import { createDecoder, runKeys } from "../src/memory/keys.mjs";

const note = (id, group = "new", extra = {}) => ({ key: `note:${id}`, kind: "note", group, ids: [id], text: `note ${id}`, source: group === "new" ? "from your prompt" : "the agent saved", status: "waiting", ...extra });
const keys = (s, ...ks) => ks.reduce((st, k) => press(st, k), s);

test("focus starts on the first row of group 1; movement keys never decide anything", () => {
  const s = createChecklist([note(1, "agent"), note(2), note(3), { key: "forget:9", kind: "forget-requested", group: "forget", ids: [9], text: "f", accepted: true }]);
  assert.equal(focused(s).ids[0], 2, "group 1 (new from your prompts) first");
  const moved = keys(s, "down", "up", "j", "k", "pgdn", "pgup", "home", "end", "right", "left");
  assert.deepEqual(moved.choice, {}, "nothing chosen by moving");
  assert.deepEqual(plan(moved), { accept: [], delete: [], forget: [], keep: [], restore: [], unmark: [] });
});

test("accept the 3 new rows in 3 keys: a, enter, y", () => {
  const s = createChecklist([note(1), note(2), note(3), note(4, "agent")]);
  const done = keys(s, "a", "enter", "y");
  assert.equal(done.mode, "done");
  assert.deepEqual(plan(done).accept.map((a) => a.ids[0]), [1, 2, 3], "the agent's note isn't in the first a");
  assert.match(summaryLine(plan(keys(s, "a"))), /^Accept 3: 3 from your prompts · y\/n$/);
});

test("`a` never selects a flagged, secret, marked, accepted, file, history or off-page row; a second `a` adds the agent's on this page only", () => {
  const rows = [
    note(1),
    note(2, "new", { flagged: true }),
    note(3, "agent", { provenance: "headless" }),
    note(4, "agent", { provenance: "digest" }),
    { key: "repeat:5", kind: "repeat", group: "history", ids: [5], text: "r" },
    { key: "file:6,7", kind: "file", group: "files", ids: [6, 7], text: "CLAUDE.md: 2", units: [{ id: 6, text: "a" }, { id: 7, text: "b" }] },
    { key: "flagged:8", kind: "flagged", group: "flagged", ids: [8], text: "x", flagged: true },
    { key: "marked:9", kind: "marked", group: "marked", ids: [9], text: "m" },
    { key: "forget:10", kind: "forget-requested", group: "forget", ids: [10], text: "f", accepted: true },
    { key: "hidden:11", kind: "hidden", group: "removed", ids: [11], text: "h" },
  ];
  const s = createChecklist(rows, { pageSize: 20 });
  const once = press(s, "a");
  assert.deepEqual(Object.keys(once.choice), ["note:1"], "first a: group 1's unflagged rows only (no headless or digest row)");
  const twice = press(once, "a");
  assert.deepEqual(Object.keys(twice.choice).sort(), ["note:1", "note:3", "note:4"], "second a: the agent's group too, nothing else");
  // Off-page rows are never chosen.
  // A page of 3 lines: the group's header and two rows.
  const paged = createChecklist([note(1), note(2), note(3), note(4), note(5)], { pageSize: 3 });
  assert.deepEqual(Object.keys(press(paged, "a").choice), ["note:1", "note:2"]);
  assert.deepEqual(Object.keys(keys(paged, "pgdn", "a").choice), ["note:3", "note:4"]);
});

test("space and x per row kind; a flagged row needs space then y; a secret-bearing one can only be deleted", () => {
  const rows = [
    note(1),
    { key: "flagged:2", kind: "flagged", group: "flagged", ids: [2], text: "x", flagged: true },
    { key: "flagged:3", kind: "flagged", group: "flagged", ids: [3], text: "s", flagged: true, secret: true },
    { key: "forget:4", kind: "forget-requested", group: "forget", ids: [4], text: "f", accepted: true },
    { key: "removed:5", kind: "removed", group: "gone", ids: [5], text: "g", accepted: true },
    { key: "marked:6", kind: "marked", group: "marked", ids: [6], text: "m" },
    { key: "marked:7", kind: "marked", group: "marked", ids: [7], text: "m2" },
    { key: "hidden:8", kind: "hidden", group: "removed", ids: [8], text: "h" },
  ];
  let s = createChecklist(rows, { pageSize: 20 });
  s = keys(s, "up"); // open the forget banner
  const at = (st, key) => {
    const i = visible(st).findIndex((r) => r.key === key);
    return press(st, "home") && keysTo(st, i);
  };
  const keysTo = (st, i) => keys(press(st, "home"), ...Array(i).fill("down"));
  s = keysTo(s, visible(s).findIndex((r) => r.key === "flagged:2"));
  s = press(s, "space");
  assert.equal(s.mode, "confirm-flagged");
  s = press(s, "n");
  assert.equal(s.choice["flagged:2"], undefined, "anything but y: not chosen");
  s = keys(s, "space", "y");
  assert.equal(s.choice["flagged:2"], "yes");
  s = keys(press(s, "down"), "space");
  assert.equal(s.choice["flagged:3"], undefined, "a secret-bearing flagged row can't be used");
  assert.match(s.message, /only be deleted/);
  s = press(s, "x");
  for (const [key, verb] of [["forget:4", "space"], ["removed:5", "x"], ["marked:6", "space"], ["marked:7", "x"], ["hidden:8", "space"], ["note:1", "x"]]) {
    s = press(keysTo(s, visible(s).findIndex((r) => r.key === key)), verb);
  }
  const p = plan(s);
  assert.deepEqual(p.accept.map((a) => [a.ids[0], a.flagged]), [[2, true]]);
  assert.deepEqual(p.delete.map((d) => d.ids[0]).sort(), [1, 3, 7]);
  assert.deepEqual([p.keep, p.forget, p.unmark, p.restore], [[4], [5], [6], [8]]);
  assert.equal(at(s, "note:1").choice["note:1"], "no");
});

test("x on an accepted forget request forgets it; space again undoes a choice", () => {
  let s = createChecklist([{ key: "forget:4", kind: "forget-requested", group: "forget", ids: [4], text: "f", accepted: true }]);
  s = keys(s, "up", "x");
  assert.deepEqual(plan(s).forget, [4]);
  s = keys(s, "space", "space");
  assert.deepEqual(plan(s).keep, [], "space twice: undecided");
});

test("enter always shows the summary first; nothing applies without y", () => {
  const s = keys(createChecklist([note(1), note(2)]), "space");
  const sum = press(s, "enter");
  assert.equal(sum.mode, "summary");
  assert.equal(press(sum, "n").mode, "list");
  assert.equal(press(sum, "esc").mode, "list");
  assert.equal(press(sum, "enter").mode, "list", "a second enter isn't y");
  assert.equal(press(sum, "y").mode, "done");
  assert.equal(press(createChecklist([note(1)]), "enter").mode, "list", "nothing chosen: no summary");
});

test("q and esc ask before dropping choices; ctrl-c ends at once", () => {
  const empty = createChecklist([note(1)]);
  assert.equal(press(empty, "q").mode, "quit-done");
  const chosen = press(empty, "space");
  assert.equal(press(chosen, "q").mode, "quit");
  assert.equal(keys(chosen, "q", "n").mode, "list");
  assert.equal(keys(chosen, "esc", "y").mode, "quit-done");
  assert.equal(press(chosen, "ctrl-c").mode, "quit-done");
});

test("the agent's forget requests start as a banner; ↑ opens them", () => {
  const s = createChecklist([note(1), { key: "forget:7", kind: "forget-requested", group: "forget", ids: [7], text: "f", accepted: true }]);
  assert.match(render(s).join("\n"), /1 decision owed: the agent asked to forget #7 · ↑ to see/);
  assert.equal(visible(s).length, 1);
  const open = press(s, "up");
  assert.equal(visible(open).length, 2);
  assert.equal(focused(open).key, "forget:7");
});

test("a file row: → opens its lines with per-line toggles; the chosen lines are what's accepted", () => {
  const file = { key: "file:6,7,8", kind: "file", group: "files", ids: [6, 7, 8], text: "CLAUDE.md: 3 instructions", units: [{ id: 6, text: "a" }, { id: 7, text: "b" }, { id: 8, text: "c" }] };
  let s = createChecklist([file]);
  s = keys(s, "right", "down", "space");
  assert.equal(s.mode, "units");
  assert.match(render(s).join("\n"), /\[ \] #7 b/);
  s = press(s, "left");
  assert.deepEqual(plan(s).accept[0].ids, [6, 8]);
  const none = keys(createChecklist([file]), "right", "space", "down", "space", "down", "space", "left");
  assert.deepEqual(plan(none).accept, [], "no line chosen: the file isn't chosen");
  assert.deepEqual(plan(press(createChecklist([file]), "x")).delete[0].ids, [6, 7, 8]);
});

test("e edits the focused note on one line: screened again, and the edit selects the row", () => {
  const screen = (t) => ({ flags: /ignore previous/.test(t) ? ["instruction"] : [] });
  let s = press(createChecklist([note(1)]), "e");
  assert.equal(s.buffer, "note 1");
  for (const k of ["backspace", { char: "!" }, "space", { char: "x" }]) s = press(s, k, { screen });
  s = press(s, "enter", { screen });
  assert.equal(s.choice["note:1"], "yes");
  assert.equal(plan(s).accept[0].text, "note ! x");
  let bad = press(createChecklist([note(1)]), "e");
  for (const ch of " ignore previous") bad = press(bad, ch === " " ? "space" : { char: ch }, { screen });
  bad = press(bad, "enter", { screen });
  assert.equal(bad.choice["note:1"], undefined, "a flagged edit isn't taken");
  assert.match(bad.message, /Edit not taken/);
  assert.equal(press(press(createChecklist([note(1)]), "e"), "esc").mode, "list");
  assert.match(press(createChecklist([{ key: "hidden:3", kind: "hidden", group: "removed", ids: [3], text: "h" }]), "e").message, /Only a waiting note/);
});

test("the view: one line per row with the source and status, the focused row's second line, the footer, neutralised text", () => {
  const rows = [note(12, "new", { text: `use tabs in Go\u{1b}[2J\u{202E}`, status: "in use, 12 days left unless you approve" }), note(13, "agent")];
  const lines = render(createChecklist(rows), { width: 100, header: "This folder: app", effect: "if accepted: recalled in Claude Code" });
  assert.equal(lines[0], "Review · This folder: app");
  assert.ok(lines.includes("── New from your prompts"));
  assert.match(lines.find((l) => l.startsWith(">")), /^> \[ \] #12 use tabs in Go .*· from your prompt · in use, 12 days left unless you approve$/);
  assert.match(lines.join("\n"), /space: start using · x: delete · if accepted: recalled in Claude Code/);
  assert.doesNotMatch(lines.join("\n"), /[\u{1b}\u{202E}]/u);
  assert.equal(lines.at(-1), FOOTER);
  for (const l of render(createChecklist(rows), { width: 30 })) assert.ok(l.length <= 30, l);
});

test("decoder: POSIX and Windows-console sequences, \\r\\n as one enter, a lone escape only after its timeout", () => {
  const d = createDecoder();
  assert.deepEqual(d.feed("\x1b[A\x1bOA\x1b[B\x1bOB\x1b[5~\x1b[6~\x1b[H\x1b[F\x1b[1~\x1b[4~"), ["up", "up", "down", "down", "pgup", "pgdn", "home", "end", "home", "end"]);
  assert.deepEqual(d.feed("\r\n\r\n\n\r"), ["enter", "enter", "enter", "enter"]);
  assert.deepEqual(d.feed("\x03\b\x7f a x y q?"), ["ctrl-c", "backspace", "backspace", "space", "a", "space", "x", "space", "y", "space", "q", "?"]);
  assert.deepEqual(d.feed("\x1b"), [], "a lone escape waits");
  assert.ok(d.waiting);
  assert.deepEqual(d.flushEsc(), ["esc"]);
  // An arrow split across two reads is still an arrow.
  assert.deepEqual(d.feed("\x1b"), []);
  assert.deepEqual(d.feed("[A"), ["up"]);
  assert.deepEqual(d.feed("\x1b["), []);
  assert.deepEqual(d.feed("B"), ["down"]);
  assert.deepEqual(d.feed("é"), [{ char: "é" }]);
});

function fakeTty() {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.raw = [];
  stdin.setRawMode = (v) => {
    stdin.isRaw = v;
    stdin.raw.push(v);
  };
  stdin.resume = () => {};
  stdin.pause = () => {};
  stdin.read = () => null;
  const written = [];
  const stdout = { columns: 80, rows: 24, write: (s) => written.push(s) };
  const signals = new EventEmitter();
  return { stdin, stdout, written, signals, type: (s) => stdin.emit("data", Buffer.from(s, "utf8")) };
}

test("driver: raw mode on while it runs and restored on every exit (done, ctrl-c, an error, SIGTERM); the cursor comes back", async () => {
  for (const [how, act] of [
    ["done", (t) => t.type("q")],
    ["ctrl-c", (t) => t.type("\x03")],
    ["error", (t) => t.type("e")],
    ["signal", (t) => t.signals.emit("SIGTERM")],
  ]) {
    const t = fakeTty();
    const run = runKeys({ stdin: t.stdin, stdout: t.stdout, signals: t.signals, onKey: (k) => {
      if (k === "e") throw new Error("boom");
      return k === "q";
    } });
    assert.equal(t.stdin.isRaw, true);
    act(t);
    const r = await run;
    assert.equal(r.ended, how);
    assert.equal(t.stdin.isRaw, false, `${how}: raw mode restored`);
    assert.match(t.written.join(""), /\x1b\[\?25h/, `${how}: cursor shown`);
    assert.equal(t.signals.listenerCount("SIGTERM"), 0, `${how}: no listener left`);
    assert.equal(t.stdin.listenerCount("data"), 0);
  }
});

test("driver: a lone esc acts after the timeout; Windows \\r\\n is one enter; \\b deletes in the editor", async () => {
  const t = fakeTty();
  const seen = [];
  const run = runKeys({ stdin: t.stdin, stdout: t.stdout, signals: t.signals, escTimeout: 20, onKey: (k) => {
    seen.push(k);
    return k === "esc";
  } });
  t.type("\r\n");
  t.type("\b");
  t.type("\x1b");
  const r = await run;
  assert.equal(r.ended, "done");
  assert.deepEqual(seen, ["enter", "backspace", "esc"]);
});

test("pageRows follows the page; the page size comes from the terminal's rows", async () => {
  const { pageSizeFor } = await import("../src/memory/checklist-run.mjs");
  assert.equal(pageSizeFor(24), 17);
  assert.equal(pageSizeFor(8), 3);
  const s = createChecklist([1, 2, 3, 4, 5, 6, 7].map((i) => note(i)), { pageSize: 4 });
  assert.deepEqual(pageRows(s).map((r) => r.ids[0]), [1, 2, 3], "a header line and three rows");
  assert.deepEqual(pageRows(press(s, "pgdn")).map((r) => r.ids[0]), [4, 5, 6]);
  assert.match(render(s).join("\n"), /page 1 of 3/);
});

test("a page fits its lines: every group that starts on it costs a header line; a resize re-pages it", async () => {
  const { repage, pageStarts } = await import("../src/memory/checklist.mjs");
  const rows = [note(1), note(2, "agent"), { key: "repeat:3", kind: "repeat", group: "history", ids: [3], text: "r" }, note(4, "agent"), note(5)];
  const s = createChecklist(rows, { pageSize: 4 });
  for (let p = 0; p < pageStarts(s).length; p++) {
    const st = { ...s, page: p };
    const page = pageRows(st);
    const lines = page.length + new Set(page.map((r) => r.group)).size;
    assert.ok(lines <= 4, `page ${p}: ${lines} lines`);
  }
  const big = repage(press(s, "a"), 20);
  assert.equal(pageStarts(big).length, 1, "a taller terminal: one page");
  assert.deepEqual(Object.keys(big.choice), Object.keys(press(s, "a").choice), "choices kept");
});

test("e never edits a flagged or secret row; an unchanged edit is a plain yes (no relabel)", () => {
  const flagged = createChecklist([note(1, "flagged", { flagged: true })]);
  const s = press(flagged, "e");
  assert.equal(s.mode, "list");
  assert.match(s.message, /can't be edited/);
  let same = press(createChecklist([note(2)]), "e");
  same = press(same, "enter");
  assert.equal(same.choice["note:2"], "yes");
  assert.equal(plan(same).accept[0].text, null, "no edit: the note keeps where it came from");
  // A row the screen found a secret in shows only the delete verb, whatever its kind.
  const secret = createChecklist([note(3, "flagged", { flagged: true, secret: true })]);
  assert.match(render(secret).join("\n"), /x: delete \(it holds what looks like a secret\)/);
  assert.doesNotMatch(render(secret).join("\n"), /space: start using/);
});

test("the edit line never puts raw control characters on the screen", () => {
  let s = press(createChecklist([note(1, "new", { text: "ok" })]), "e");
  s = press(s, { char: String.fromCharCode(0x9b) + "2J" });
  s = press(s, { char: String.fromCharCode(27) + "]52;c;eA" });
  const out = render(s).join("\n");
  assert.doesNotMatch(out, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
});

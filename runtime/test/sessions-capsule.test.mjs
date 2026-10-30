// P4.2: the continuation capsule: the history a new conversation starts with (pure).

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCapsule, buildNote, remapCallIds } from "../src/sessions/capsule.mjs";

const KEY = ["sk", "test", "CAPSULEKEY0123456789abcdef"].join("-");
const turn = (id, items, status = "completed") => ({ id, status, items });
const user = (text) => ({ kind: "userMessage", text });
const said = (text) => ({ kind: "agentMessage", text });
const cmd = (command, extra = {}) => ({ kind: "commandExecution", command, status: "completed", exitCode: 0, output: "", ...extra });

const base = {
  from: { label: "OpenAI · me · gpt-5" },
  cwd: "/work/app",
  git: { branch: "main", files: 3, added: 12, deleted: 4 },
  checkpoint: "abc1234",
  permissions: { sandbox: "workspace-write", approvalPolicy: "on-request" },
  goal: null,
  terminals: [],
};

const text = (items) => JSON.stringify(items);

test("the note: where the work came from, done tools aren't rerun, the objective, workspace and permissions", () => {
  const { items } = buildCapsule({ ...base, turns: [turn("t1", [user("fix the login bug"), said("on it")])] });
  const note = items[0];
  assert.equal(note.role, "developer");
  const n = note.content[0].text;
  assert.match(n, /^This conversation continues work started with OpenAI · me · gpt-5\. What follows is the history so far, not new input\./);
  assert.match(n, /Tool calls marked "done" already ran: don't run them again unless the user asks\. Files on disk already have the earlier edits\./);
  assert.match(n, /Objective: fix the login bug/);
  assert.match(n, /Workspace: \/work\/app · git main · 3 files changed \(\+12 −4\) · checkpoint abc1234/);
  assert.match(n, /Permissions: workspace-write · on-request/);
  assert.doesNotMatch(n, /Still running/, "no block without live terminals");
});

test("the 'Still running' block lists each live background terminal", () => {
  const { items } = buildCapsule({ ...base, terminals: [{ command: "npm run dev", startedAt: "14:01" }, { command: "npm run watch", startedAt: "14:03" }], turns: [] });
  const n = items[0].content[0].text;
  assert.match(n, /Still running from before the switch \(ad keeps them; you can't send them input; don't start them again\):\n {2}\$ npm run dev {2}\(started 14:01\)\n {2}\$ npm run watch {2}\(started 14:03\)/);
});

test("messages mode: user and assistant roles; tools as text lines with their outcome; output tail redacted", () => {
  const out = `${"x".repeat(5000)}\nError: token ${KEY} rejected`;
  const { items, meta } = buildCapsule({
    ...base,
    turns: [
      turn("t1", [
        user("run the tests"),
        cmd("npm test", { exitCode: 1, output: out }),
        { kind: "fileChange", status: "completed", changes: [{ path: "src/a.js", kind: "update", diff: "@@\n-a\n+b\n+c\n+d" }] },
        cmd("rm -rf build", { status: "declined", exitCode: null }),
        said("Fixed it."),
      ]),
    ],
  });
  assert.deepEqual(items.slice(1).map((i) => i.role), ["user", "assistant"]);
  const a = items[2].content[0].text;
  assert.match(a, /\[done\] \$ npm test → exit 1/);
  assert.match(a, /\[done\] edit src\/a\.js \(\+3 −1\)/);
  assert.match(a, /\[declined\] \$ rm -rf build/);
  assert.match(a, /Fixed it\./);
  assert.ok(!text(items).includes(KEY), "redacted");
  assert.ok(!text(items).includes("x".repeat(2100)), "only the output's last 2 KB");
  assert.equal(items[2].content[0].type, "output_text");
  assert.equal(meta.toolCalls, 3);
});

test("never carried: reasoning, bridged envelopes, tool search, response and approval ids, hook prompts, unknown items", () => {
  const { items } = buildCapsule({
    ...base,
    turns: [
      turn("t1", [
        user("go"),
        { kind: "reasoning", summary: ["secret thinking"], content: ["raw"], encrypted_content: "ENC" },
        { kind: "hookPrompt", text: "HOOK TEXT" },
        { kind: "unknown", type: "tool_search_call", text: "TS" },
        { kind: "functionCallOutput", name: "tool_search_output", output: "TSO" },
        said("answer with adbr1.AbCdEf123.xyz and adg1.12345678.zzz inside"),
      ]),
    ],
  });
  const t = text(items);
  for (const bad of ["secret thinking", "ENC", "encrypted_content", "HOOK TEXT", "tool_search", "TSO", "adbr1.", "adg1.", "previous_response_id", "approvalId"]) assert.ok(!t.includes(bad), bad);
});

test("a compaction becomes one line; a turn cut off by the switch says so; a live terminal and an unfinished command are named", () => {
  const { items } = buildCapsule({
    ...base,
    terminals: [{ command: "npm run dev", startedAt: "14:01", itemId: "bg" }],
    turns: [
      turn("t1", [{ kind: "contextCompaction" }]),
      turn("t1b", [user("an earlier stop"), said("partial")], "interrupted"),
      turn("t2", [user("deploy it"), { ...cmd("npm run dev"), id: "bg", status: "inProgress", source: "unifiedExecStartup" }, { ...cmd("npm run deploy"), status: "inProgress" }, said("Deploying")], "interrupted"),
    ],
  });
  const t = text(items);
  assert.match(t, /\(earlier history was compacted\)/);
  assert.match(t, /\[still running\] \$ npm run dev/);
  assert.match(t, /\[may not have finished\] \$ npm run deploy/);
  assert.equal(t.split("(this answer was cut off by the switch)").length - 1, 1, "only the last turn was cut off by the switch");
});

test("the budget keeps the note, the first prompt and the newest turns, with one gap line", () => {
  const turns = Array.from({ length: 20 }, (_, i) => turn(`t${i + 1}`, [user(`prompt ${i + 1} ${"p".repeat(300)}`), cmd(`step ${i + 1}`), cmd(`check ${i + 1}`), said(`answer ${i + 1} ${"a".repeat(300)}`)]));
  const { items, meta } = buildCapsule({ ...base, turns, budgetChars: 4000 });
  const t = text(items);
  assert.match(t, /prompt 1 /, "the first prompt");
  assert.match(t, /answer 20 /, "the newest turn");
  assert.ok(t.length < 6000, String(t.length));
  const gap = /\(turns (\d+)–(\d+) left out: (\d+) prompts, (\d+) tool calls; they're in the previous conversation\)/.exec(t);
  assert.ok(gap, t.slice(0, 400));
  const [from, to, prompts, tools] = gap.slice(1).map(Number);
  assert.equal(prompts, to - from + 1);
  assert.equal(tools, 2 * prompts);
  assert.equal(meta.leftOut, prompts);
  assert.equal(meta.turns, 20);
});

test("transcript mode: the same content as one developer message", () => {
  const { items } = buildCapsule({ ...base, mode: "transcript", turns: [turn("t1", [user("hi"), cmd("ls"), said("files")])] });
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.role), ["developer", "developer"]);
  assert.match(items[1].content[0].text, /User: hi[\s\S]*\[done\] \$ ls → exit 0[\s\S]*Assistant: files/);
});

test("structured mode: real call/output pairs with ad's own ids, consistent per pair; the map is returned", () => {
  const { items, meta } = buildCapsule({ ...base, mode: "structured", turns: [turn("t1", [user("hi"), { ...cmd("ls"), id: "call_engine_1", output: "a.txt" }, { ...cmd("pwd"), id: "call_engine_2", output: "/w" }, said("ok")])] });
  const calls = items.filter((i) => i.type === "function_call");
  const outs = items.filter((i) => i.type === "function_call_output");
  assert.equal(calls.length, 2);
  for (const [i, c] of calls.entries()) {
    assert.match(c.call_id, /^c[0-9a-z]{8}$/);
    assert.equal(outs[i].call_id, c.call_id);
  }
  assert.notEqual(calls[0].call_id, calls[1].call_id);
  assert.deepEqual(Object.keys(meta.callIdMap).sort(), ["call_engine_1", "call_engine_2"]);
});

test("remapCallIds: ids that match ^[a-zA-Z0-9]{9}$, the same id for both halves of a pair", () => {
  const { items, map } = remapCallIds([{ type: "function_call", call_id: "x-1" }, { type: "function_call_output", call_id: "x-1" }, { type: "function_call", call_id: "y/2" }]);
  for (const i of items) assert.match(i.call_id, /^[a-zA-Z0-9]{9}$/);
  assert.equal(items[0].call_id, items[1].call_id);
  assert.equal(map["x-1"], items[0].call_id);
});

test("the fork note: the same note without the history, the 'Still running' block included", () => {
  const n = buildNote({ ...base, terminals: [{ command: "npm run dev", startedAt: "14:01" }], turns: [turn("t1", [user("fix it")])] });
  assert.equal(n.role, "developer");
  assert.match(n.content[0].text, /Still running from before the switch[\s\S]*npm run dev/);
  assert.match(n.content[0].text, /Objective: fix it/);
});

test("the objective is the goal when there is one, else the first prompt, 500 characters at most", () => {
  const long = "z".repeat(900);
  const g = buildNote({ ...base, goal: { objective: "ship the release" }, turns: [turn("t1", [user("hello")])] }).content[0].text;
  assert.match(g, /Objective: ship the release/);
  const f = buildNote({ ...base, turns: [turn("t1", [user(long)])] }).content[0].text;
  const m = /Objective: (z+)/.exec(f);
  assert.ok(m && m[1].length <= 500);
});

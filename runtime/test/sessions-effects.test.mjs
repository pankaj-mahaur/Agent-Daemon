// P4.1: what a tool call did (pure).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { effectOf, isReadOnlyCommand, settleTurn, toolStatus } from "../src/sessions/effects.mjs";

test("isReadOnlyCommand is false for anything that writes or that ad can't follow", () => {
  for (const c of [
    "find . -delete",
    "find . -name x -delete",
    "find . -exec rm {} \\;",
    "cat a | tee b",
    "ls > out.txt",
    "echo $(rm x)",
    "cat `rm x`",
    "git push",
    "git commit -m x",
    "sed -i s/a/b/ f",
    "Get-Content a > b",
    "rm -rf build",
    "ls && rm x",
    "ls; mv a b",
    "cat a | xargs rm",
    "",
    "python -c 'print(1)'",
    'bash -lc "ls > x"',
    // Review P4.1: a second line, a program rg runs, git writing a file, PowerShell subexpressions.
    'bash -lc "ls\nfind . -name x -delete"',
    "ls\nrm -rf x",
    "ls\r\nrm -rf x",
    "rg --pre ./evil.sh foo",
    "rg --pre-glob '*.x' --pre ./evil.sh foo",
    "git diff --output=x.patch",
    "git log --output=x",
    "git diff --ext-diff",
    "ls @(Remove-Item x)",
    "Get-ChildItem (Remove-Item x)",
    // Re-review: the shell takes the quotes off before the program reads the flag.
    "rg '--pre' ./evil.sh foo",
    `bash -lc 'rg "--pre" e foo'`,
    'git diff "--output=x"',
    "git diff --outp=x",
    "find . -name x '-delete'",
  ]) assert.equal(isReadOnlyCommand(c), false, JSON.stringify(c));
});

test("isReadOnlyCommand is true for plain reads (and the shell wrappers around them)", () => {
  for (const c of ["rg foo src", "git diff", "git status", "ls -la", "cat a b", "find . -name '*.mjs'", "git branch --list", 'bash -lc "rg foo | head -5"', "cmd.exe /d /c dir", "Get-ChildItem -Recurse", "git status && git diff", "ls && cat a", "git log --oneline -5", "rg 'foo bar' src"]) assert.equal(isReadOnlyCommand(c), true, c);
});

test("the effect table: the engine's own summary never makes a write a read", () => {
  const cmd = (command, types) => ({ type: "commandExecution", command, commandActions: types.map((type) => ({ type })) });
  assert.equal(effectOf(cmd("rg foo src", ["search"])), "read");
  assert.equal(effectOf(cmd("find . -name x -delete", ["search"])), "exec", "the engine says search; ad says exec");
  assert.equal(effectOf(cmd("cat a | tee b", ["read"])), "exec");
  assert.equal(effectOf(cmd("npm test", ["unknown"])), "exec");
  assert.equal(effectOf(cmd("ls", [])), "exec", "no actions: not proven a read");
  assert.equal(effectOf({ type: "fileChange" }), "write");
  assert.equal(effectOf({ type: "mcpToolCall" }), "external");
  assert.equal(effectOf({ type: "collabAgentToolCall" }), "agent");
  assert.equal(effectOf({ type: "webSearch" }), "read");
  for (const type of ["agentMessage", "reasoning", "plan", "contextCompaction"]) assert.equal(effectOf({ type }), null, type);
});

test("the effect table on what the real engine sent (fixture from engine-real.test.mjs)", () => {
  const fx = JSON.parse(readFileSync(new URL("./fixtures/engine-items-0.163.json", import.meta.url), "utf8"));
  const { ECHO, LIST, DELETE, PATCH } = fx.items;
  assert.equal(effectOf(DELETE), "exec");
  assert.equal(isReadOnlyCommand(DELETE.command), false, "a delete inside the shell wrapper");
  assert.equal(isReadOnlyCommand(LIST.command), true, "a listing inside the shell wrapper");
  assert.equal(effectOf(ECHO), "exec");
  assert.equal(effectOf(PATCH), "write");
  for (const it of [ECHO, LIST, DELETE, PATCH]) assert.equal(toolStatus(it), "succeeded");
});

test("statuses: exit code 2 failed; declined (never for MCP); collab interrupted unknown", () => {
  assert.equal(toolStatus({ type: "commandExecution", status: "completed", exitCode: 0 }), "succeeded");
  assert.equal(toolStatus({ type: "commandExecution", status: "completed", exitCode: 2 }), "failed");
  assert.equal(toolStatus({ type: "fileChange", status: "declined" }), "declined");
  assert.equal(toolStatus({ type: "mcpToolCall", status: "declined" }), "unknown");
  assert.equal(toolStatus({ type: "collabAgentToolCall", status: "interrupted" }), "unknown");
  assert.equal(toolStatus({ type: "commandExecution", status: "inProgress" }), "running");
  assert.equal(toolStatus({ type: "fileChange", status: "failed" }), "failed");
});

test("settleTurn: a child turn's running exec becomes unknown; a background terminal stays running; other turns untouched", () => {
  const tools = new Map([
    ["a", { rootTurnId: "r1", status: "running", background: false }],
    ["b", { rootTurnId: "r1", status: "running", background: true }],
    ["c", { rootTurnId: "r1", status: "succeeded" }],
    ["d", { rootTurnId: "r2", status: "running" }],
  ]);
  assert.deepEqual(settleTurn(tools, "r1"), ["a"]);
  assert.equal(tools.get("a").status, "unknown");
  assert.equal(tools.get("b").status, "running");
  assert.equal(tools.get("d").status, "running");
});

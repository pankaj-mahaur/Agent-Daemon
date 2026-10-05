// Tests for `ad chat` (harness/chat.mjs) against the fake app-server.
// Properties: approvals are shown with what will run / change and answered
// y/a/n; slash commands drive the engine; a line never blocks the loop.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { approvalQuestion, cmdChat, createChatSession, parseApprovalAnswer, parseCommand } from "../src/harness/chat.mjs";
import { createEngine } from "../src/engine/index.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };
const sink = () => ({ text: "", write(c) { this.text += c; return true; } });

async function withSession(answers, fn) {
  const root = mkdtempSync(join(tmpdir(), "ad-chat-"));
  const engine = await createEngine({ home: join(root, "home"), command });
  const out = sink();
  const err = sink();
  const questions = [];
  const ask = async (q) => (questions.push(q), answers.shift() ?? "");
  try {
    await fn({ session: createChatSession({ engine, cwd: root, out, err, ask }), out, err, questions, engine });
  } finally {
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("parseCommand / parseApprovalAnswer", () => {
  assert.deepEqual(parseCommand("/Resume  abc "), { cmd: "resume", arg: "abc" });
  assert.equal(parseCommand("fix the bug"), null);
  assert.equal(parseApprovalAnswer("Y"), "accept");
  assert.equal(parseApprovalAnswer("always"), "acceptForSession");
  assert.equal(parseApprovalAnswer(""), "decline", "Enter alone declines");
  assert.equal(parseApprovalAnswer("sure"), "decline", "anything unclear declines");
});

test("a command approval shows the command and honours y", async () => {
  await withSession(["y"], async ({ session, out, questions }) => {
    await session.handleLine("do it");
    assert.match(questions[0], /Run command\?\n  \$ rm -rf \//);
    assert.match(out.text, /pong\[accept\]/);
  });
});

test("Enter declines; a answers accept-for-session", async () => {
  await withSession(["", "a"], async ({ session, out }) => {
    await session.handleLine("first");
    await session.handleLine("second");
    assert.match(out.text, /pong\[decline\]/);
    assert.match(out.text, /pong\[acceptForSession\]/);
  });
});

test("a file-change approval lists the files from the preceding fileChange item", async () => {
  await withSession(["n"], async ({ session, out, questions }) => {
    await session.handleLine("edit-file");
    assert.match(questions[0], /Apply file changes\?\n  update src\/app\.js/);
    assert.match(questions[0], /reason: apply fix/);
    assert.match(out.text, /edit\[decline\]/);
  });
});

test("slash commands drive the engine", async () => {
  await withSession([], async ({ session, out, err, engine }) => {
    assert.deepEqual(await session.handleLine("/help"), {});
    assert.match(out.text, /\/resume <id>/);
    await session.handleLine("/threads");
    assert.match(out.text, /thread-old  fix the flaky test/);
    await session.handleLine("/goal ship the harness");
    assert.match(out.text, /goal set: ship the harness/);
    assert.ok(session.state.threadId, "/goal starts a thread");
    await session.handleLine("/compact");
    await session.handleLine("/model gpt-x");
    assert.equal(session.state.model, "gpt-x");
    await session.handleLine("/resume thread-old");
    assert.equal(session.state.threadId, "thread-old");
    await session.handleLine("/status");
    assert.match(out.text, /login:  ChatGPT plus/);
    await session.handleLine("/nope");
    assert.match(err.text, /unknown command \/nope/);
    assert.deepEqual(await session.handleLine("/exit"), { exit: true });
    const { calls } = await engine.server.request("debug/state");
    for (const m of ["thread/list", "thread/goal/set", "thread/compact/start", "thread/resume"]) assert.ok(calls.includes(m), m);
  });
});

test("/new forgets the thread; errors are reported, not thrown", async () => {
  await withSession([], async ({ session, err }) => {
    await session.handleLine("/goal x");
    await session.handleLine("/new");
    assert.equal(session.state.threadId, null);
    await session.handleLine("/resume");
    assert.match(err.text, /usage: \/resume/);
  });
});

test("approvalQuestion covers permission requests", () => {
  assert.match(approvalQuestion({ kind: "permissions", params: { permissions: { network: { enabled: true } } } }), /Grant extra permissions\?/);
});

test("cmdChat runs a readline loop until /exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "ad-chatloop-"));
  const stdin = new PassThrough();
  const out = sink();
  const err = sink();
  try {
    const done = cmdChat({ cwd: root, home: join(root, "home"), command, stdin, stdout: out, stderr: err, store: { get: () => null } });
    stdin.write("/status\n");
    stdin.write("/exit\n");
    assert.equal(await done, 0);
    assert.match(out.text, /Agent Daemon chat/);
    assert.match(out.text, /folder: /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two approvals at once are asked one after the other, each answered", async () => {
  await withSession([], async () => {});
  const root = mkdtempSync(join(tmpdir(), "ad-chat2-"));
  const engine = await createEngine({ home: join(root, "home"), command });
  const out = sink();
  const answers = ["y", "n"];
  let inFlight = 0;
  let maxInFlight = 0;
  const { serializedAsk } = await import("../src/harness/chat.mjs");
  const ask = serializedAsk(async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return answers.shift();
  });
  try {
    const session = createChatSession({ engine, cwd: root, out, err: sink(), ask });
    await session.handleLine("two-approvals");
    assert.equal(maxInFlight, 1, "never two prompts at once");
    assert.match(out.text, /two\[accept,decline\]/);
  } finally {
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("piped script: a queued line answers the approval, EOF waits for the queue", async () => {
  const root = mkdtempSync(join(tmpdir(), "ad-chatpipe-"));
  const stdin = new PassThrough();
  const out = sink();
  try {
    const done = cmdChat({ cwd: root, home: join(root, "home"), command, stdin, stdout: out, stderr: sink(), store: { get: () => null } });
    stdin.end("do it\ny\n/status\n");
    assert.equal(await done, 0);
    assert.match(out.text, /Run command\?[\s\S]*: y\n\[accept\]/, "the queued y answered the prompt");
    assert.match(out.text, /thread: thread-1/, "/status ran after the turn, before exit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("piped script: an approval after EOF is declined, not left hanging", async () => {
  const root = mkdtempSync(join(tmpdir(), "ad-chateof-"));
  const stdin = new PassThrough();
  const out = sink();
  try {
    const done = cmdChat({ cwd: root, home: join(root, "home"), command, stdin, stdout: out, stderr: sink(), store: { get: () => null } });
    stdin.end("do it\n");
    assert.equal(await done, 0);
    assert.match(out.text, /\[decline\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/compact waits for compaction; /model alone resets to the thread default", async () => {
  await withSession([], async ({ session, out }) => {
    await session.handleLine("/goal start a thread");
    await session.handleLine("/compact");
    assert.match(out.text, /compacting…\ncompacted/);
    await session.handleLine("/model gpt-x");
    await session.handleLine("/model");
    assert.equal(session.state.model, "fake-model", "explicit default, since turn/start's model sticks");
  });
});

test("approvalQuestion: a network approval names the host, a stdin write shows its input escaped", () => {
  const net = approvalQuestion({ kind: "command", params: { networkApprovalContext: { host: "pypi.org", protocol: "https" }, command: null } });
  assert.match(net, /^Allow network access to pypi\.org\?/);
  assert.doesNotMatch(net, /null/);
  const stdin = approvalQuestion({ kind: "command", params: { kind: "writeStdin", command: "yes\n" } });
  assert.ok(stdin.startsWith('Send input to the running command?\n  $ "yes\\n"'), JSON.stringify(stdin));
});

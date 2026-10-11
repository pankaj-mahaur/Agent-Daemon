// The status line and the window title (tui/status.mjs, codex-parity-2
// Part 3): Codex's item ids, ad's defaults, the title's joins, and hostile
// names kept out of the terminal's title.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_STATUS, canonical, statusSegments, titleSafe, titleText, unsupported } from "../src/tui/status.mjs";

const CTX = {
  app: "ad",
  model: "gpt-5.5",
  effort: "high",
  cwd: "C:\\Users\\sam\\work\\app",
  home: "C:\\Users\\sam",
  project: "app",
  hostname: "box",
  branch: "main",
  changes: { added: 12, removed: 3 },
  running: false,
  waiting: false,
  sandbox: "workspace-write",
  approvalPolicy: "on-request",
  tokens: { last: { total: 85_000 }, contextWindow: 100_000, total: { inputTokens: 120_000, outputTokens: 4_200 } },
  rateLimits: { primary: { usedPercent: 38.4, windowDurationMins: 300 }, secondary: { usedPercent: 91, windowDurationMins: 10080 } },
  codexVersion: "0.160.0",
  threadId: "t-1",
  threadName: "login fix",
  plan: { steps: [{ status: "completed" }, { status: "inProgress" }, { status: "pending" }] },
  frame: 0,
};
const texts = (ids, ctx = CTX) => statusSegments(ids, ctx).map((s) => s.text);

test("status line: ad's default when unset; [] is off; Codex's order and aliases", () => {
  assert.deepEqual(DEFAULT_STATUS, ["model-with-reasoning", "current-dir", "context-remaining", "five-hour-limit"]);
  assert.deepEqual(texts(undefined), ["gpt-5.5 high", "~\\work\\app", "ctx 15%", "5h 38%"]);
  assert.deepEqual(texts([]), []);
  assert.deepEqual(texts(["git-branch", "model-name", "project-root", "status", "session-id"]), ["main", "gpt-5.5", "app", "ready", "t-1"]);
  assert.equal(canonical("context-usage"), "context-used");
});

test("status line: every item ad shows, warnings at 80 % used, empty values skipped", () => {
  assert.deepEqual(texts(["reasoning", "hostname", "branch-changes", "permissions", "approval-mode", "context-used", "context-window-size", "weekly-limit", "codex-version", "used-tokens", "total-input-tokens", "total-output-tokens", "thread-name", "task-progress"]), ["high", "box", "+12 -3", "workspace-write", "on-request", "ctx 85% used", "100.0k window", "wk 91%", "codex 0.160.0", "85.0k tokens", "120.0k in", "4.2k out", "login fix", "1/3 steps"]);
  const segs = statusSegments(["context-remaining", "five-hour-limit", "weekly-limit"], CTX);
  assert.deepEqual(segs.map((s) => s.warn), [true, false, true]);
  assert.deepEqual(texts(["thread-name", "git-branch", "pull-request-number", 42], { ...CTX, threadName: null, branch: null }), [], "nothing for missing values or ids ad can't show");
  assert.deepEqual(texts(["run-state"], { ...CTX, running: true }), ["working"]);
  assert.deepEqual(texts(["run-state"], { ...CTX, waiting: true }), ["waiting for you"]);
});

test("unsupported: Codex's ids ad can't show (and junk) are listed, so they're kept and warned about", () => {
  assert.deepEqual(unsupported(["model", "pull-request-number", "fast-mode", 7, "session-id"]), ["pull-request-number", "fast-mode", 7]);
  assert.deepEqual(unsupported(["activity", "thread-title"], "title"), ["thread-title"]);
  assert.deepEqual(unsupported(undefined), []);
});

test("window title: Codex's joins, the spinner while running, 'action required' while waiting", () => {
  assert.equal(titleText(undefined, CTX), "login fix | app", "default: activity (nothing while idle), thread name, project");
  assert.equal(titleText(undefined, { ...CTX, running: true, frame: 1 }), "\u{2819} login fix | app", "spaces around the activity, not bars");
  assert.equal(titleText(["project-name", "activity", "thread-name"], { ...CTX, running: true }), "app \u{280b} login fix");
  assert.equal(titleText(undefined, { ...CTX, waiting: true }), "action required login fix | app");
  assert.equal(titleText(["app-name", "git-branch"], CTX), "ad | main");
  assert.equal(titleText([], CTX), "");
});

test("titleSafe: no escape, control or line-break characters reach the title; 80 graphemes at most", () => {
  const hostile = "evil\x1b]0;pwned\x07\x1b[2J\r\nname\u{202e}txt\u{200b}";
  const safe = titleSafe(hostile);
  assert.doesNotMatch(safe, /[\x00-\x1f\x7f\u{202e}\u{200b}]/u);
  assert.ok(!safe.includes("\x1b"));
  assert.equal(titleSafe("a".repeat(200)).length, 80);
  assert.ok(titleSafe("a".repeat(200)).endsWith("\u{2026}"));
  // Through titleText too: a branch or thread name can't break out of OSC 0.
  assert.ok(!titleText(["git-branch", "thread-name"], { ...CTX, branch: "x\x07\x1b]2;y", threadName: "n\nm" }).includes("\x07"));
});

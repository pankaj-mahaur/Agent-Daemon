// /recap as Codex 0.160 does it (codex-parity-2 Part 10): the conversation it
// reads (exchanges, labels, Codex's byte budget), the strict parse of the
// answer, and the cell.

import { test } from "node:test";
import assert from "node:assert/strict";
import { HISTORY_MAX_BYTES, parseRecap, RECAP_PROMPT_PREFIX, RECAP_SCHEMA, recapExchanges, recapHistory, TEMPORARY_THREAD_CONFIG } from "../src/tui/recap.mjs";
import { renderRecap } from "../src/tui/view/cells.mjs";

const u = (text) => ({ role: "user", text });
const a = (text) => ({ role: "assistant", text });
const bytes = (s) => Buffer.byteLength(s, "utf8");

test("the prompt and schema are Codex's, byte for byte (its budget comes out the same)", () => {
  assert.equal(bytes(RECAP_PROMPT_PREFIX), 1790);
  assert.equal(HISTORY_MAX_BYTES, 30978);
  assert.ok(RECAP_PROMPT_PREFIX.startsWith("Write a brief catch-up for a user returning to this task."));
  assert.ok(RECAP_PROMPT_PREFIX.endsWith("It may be incomplete or excerpted.\n\nConversation:\n"));
  assert.deepEqual(RECAP_SCHEMA.required, ["summary", "next_action"]);
  assert.equal(RECAP_SCHEMA.properties.summary.maxLength, 700);
  assert.equal(RECAP_SCHEMA.additionalProperties, false);
  assert.equal(TEMPORARY_THREAD_CONFIG["features.shell_tool"], false);
  assert.equal(TEMPORARY_THREAD_CONFIG["features.hooks"], false, "ad's hooks never see the recap's thread");
  assert.equal(TEMPORARY_THREAD_CONFIG.web_search, "disabled");
});

test("exchanges: steers join, an unanswered prompt is pending, a reply before any prompt is dropped, at most 8 answered", () => {
  assert.equal(recapHistory([]), "");
  assert.equal(recapHistory([a("hello there")]), "", "only a reply: nothing to recap");
  assert.equal(
    recapHistory([a("intro"), u("Fix the parser."), u("  and the lexer  "), a("Done. What on empty input?"), u("Return null.")]),
    "User: Fix the parser.\n\nand the lexer\n\nAssistant: Done. What on empty input?\n\nPending user request: Return null.",
  );
  const many = [];
  for (let i = 1; i <= 10; i++) many.push(u(`ask ${i}`), a(`answer ${i}`));
  many.push(u("still waiting"));
  const ex = recapExchanges(many);
  assert.equal(ex.length, 9, "8 answered and the pending one");
  assert.equal(ex[0].user, "ask 3");
  assert.equal(ex.at(-1).user, "still waiting");
});

test("over the budget: the oldest exchanges go first (marked); the newest is kept, excerpted to a fair share", () => {
  const big = (c, n) => c.repeat(n);
  // Older exchanges are dropped first.
  const h = recapHistory([u(big("a", 20000)), a("old answer"), u(big("b", 12000)), a("new answer")]);
  assert.ok(h.startsWith("[Earlier exchanges omitted]\n\nUser: bbb"), h.slice(0, 60));
  assert.ok(bytes(h) <= HISTORY_MAX_BYTES);
  assert.ok(h.endsWith("Assistant: new answer"));
  // One huge exchange: its long message is excerpted (head and tail), the short one kept whole.
  const one = recapHistory([u(`START${big("x", 50000)}END`), a("short reply")]);
  assert.ok(bytes(one) <= HISTORY_MAX_BYTES);
  assert.match(one, /^User: STARTx+\n\[\.\.\. excerpted \.\.\.\]\nx+END\n\nAssistant: short reply$/);
  // A pending prompt after a long exchange keeps both (the last two).
  const two = recapHistory([u(big("q", 40000)), a("long ago"), u("and now?")]);
  assert.ok(two.endsWith("Pending user request: and now?"));
  // Multi-byte text is never cut inside a character.
  const emoji = recapHistory([u("\u{1f600}".repeat(20000)), a("ok")]);
  assert.ok(bytes(emoji) <= HISTORY_MAX_BYTES);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji), "no lone surrogate");
});

test("parseRecap: Codex's strict reading of the answer", () => {
  assert.deepEqual(parseRecap('{"summary":"  Done.  ","next_action":"  Push? "}'), { summary: "Done.", next: "Push?" });
  assert.deepEqual(parseRecap('{"summary":"Done.","next_action":null}'), { summary: "Done.", next: null });
  assert.deepEqual(parseRecap('{"summary":"Done.","next_action":"   "}'), { summary: "Done.", next: null }, "blank next: none");
  for (const bad of [
    "not json",
    '{"summary":"Done."}',
    '{"summary":"Done.","next_action":null,"extra":1}',
    '{"summary":"  ","next_action":null}',
    '{"summary":5,"next_action":null}',
    `{"summary":"${"x".repeat(701)}","next_action":null}`,
    `{"summary":"ok","next_action":"${"y".repeat(201)}"}`,
    "[]",
  ]) assert.equal(parseRecap(bad), null, bad.slice(0, 40));
  assert.ok(parseRecap(`{"summary":"${"\u{1f600}".repeat(700)}","next_action":null}`), "700 characters, not 700 UTF-16 units");
});

test("the recap cell: ↳ Recap: with a hanging indent, then Next:, all italic and dim; narrow, unindented", () => {
  const out = renderRecap({ summary: "Fixing the login bug: the fix is in and the tests pass, not deployed yet.", next: "Deploy it?" }, { width: 40 });
  const text = out.map((l) => l.map((s) => s.text).join(""));
  assert.deepEqual(text, ["  \u{21b3} Recap: Fixing the login bug: the fix", "           is in and the tests pass, not", "           deployed yet.", "           Next: Deploy it?"]);
  for (const l of out) for (const s of l) if (s.text.trim()) assert.ok(s.style?.dim && s.style?.italic, JSON.stringify(s));
  assert.ok(out[3].some((s) => s.text === "Next: " && s.style.bold && s.style.fg));
  assert.deepEqual(renderRecap({ summary: "Done.", next: null }, { width: 40 }).length, 1, "no Next: line");
  const narrow = renderRecap({ summary: "Done here.", next: null }, { width: 12 }).map((l) => l.map((s) => s.text).join(""));
  assert.deepEqual(narrow, ["\u{21b3} Recap:", "Done here."]);
});

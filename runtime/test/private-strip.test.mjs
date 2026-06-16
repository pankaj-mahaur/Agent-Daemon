// Tests for the <private>…</private> content-exclusion tag.
//
// Two layers:
//   1. stripPrivate() removes matched blocks before any extractor sees them.
//   2. screenLearning() flags a RESIDUAL <private> marker as "private-leak"
//      (backstop — quarantines anything that slipped past stripPrivate).
// Plus an end-to-end check that the rules-based extractor never emits a
// learning from inside a private block.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stripPrivate, screenLearning } from "../src/digest/sanitize.mjs";
import { extractFromText } from "../src/hooks/extractors.mjs";
import { extractFromAgentBlock } from "../src/digest/extract.mjs";

/* --------------------------- stripPrivate --------------------------- */

test("stripPrivate removes a single inline block, keeps surrounding text", () => {
  assert.equal(stripPrivate("before <private>secret</private> after"), "before  after");
});

test("stripPrivate removes a multiline block", () => {
  const out = stripPrivate("keep\n<private>\nsecret line 1\nsecret line 2\n</private>\nkeep2");
  assert.equal(out, "keep\n\nkeep2");
  assert.doesNotMatch(out, /secret/);
});

test("stripPrivate is case-insensitive on the tag", () => {
  assert.equal(stripPrivate("a<PRIVATE>x</PRIVATE>b"), "ab");
});

test("stripPrivate removes multiple blocks", () => {
  assert.equal(stripPrivate("a<private>1</private>b<private>2</private>c"), "abc");
});

test("stripPrivate leaves text with no marker untouched (fast path)", () => {
  const s = "nothing private here — remember: use pnpm";
  assert.equal(stripPrivate(s), s);
});

test("stripPrivate leaves an UNBALANCED opening tag in place (so the backstop can flag it)", () => {
  const s = "danger <private>no closing tag here";
  assert.equal(stripPrivate(s), s);
});

test("stripPrivate returns '' for non-string input", () => {
  assert.equal(stripPrivate(null), "");
  assert.equal(stripPrivate(undefined), "");
  assert.equal(stripPrivate(42), "");
});

/* --------------------- screenLearning backstop ---------------------- */

test("screenLearning flags a residual <private> opening marker", () => {
  const r = screenLearning({ text: "benign text <private> leaked content" });
  assert.equal(r.verdict, "suspicious");
  assert.ok(r.reasons.includes("private-leak"), `got ${r.reasons}`);
});

test("screenLearning flags a residual </private> closing marker (in evidence)", () => {
  const r = screenLearning({ text: "harmless", evidence_quote: "tail </private> tail" });
  assert.equal(r.verdict, "suspicious");
  assert.ok(r.reasons.includes("private-leak"));
});

test("screenLearning passes text that merely mentions privacy without the tag", () => {
  const r = screenLearning({ text: "keep the user's private data encrypted at rest" });
  assert.equal(r.verdict, "clean", `false positive: ${r.reasons}`);
});

/* ----------------------- end-to-end extractor ----------------------- */

test("extractFromText never emits a learning from inside a <private> block", () => {
  const text = "remember: use forward slashes in tags <private>remember: the prod password is hunter2</private>";
  const learnings = extractFromText(text, { speaker: "user" });
  const joined = JSON.stringify(learnings);
  assert.doesNotMatch(joined, /hunter2/, "private secret must not be captured");
  assert.doesNotMatch(joined, /password/);
  assert.ok(learnings.some(l => /forward slashes/.test(l.text)), "public note still captured");
});

test("extractFromText returns [] when the whole input is private", () => {
  const learnings = extractFromText("<private>remember: nothing should escape this</private>", { speaker: "user" });
  assert.deepEqual(learnings, []);
});

test("digest agent-block path strips <private> before parsing the block", () => {
  // The valid digest block survives; a private secret in the same assistant
  // turn is gone before extraction.
  const summary = {
    events: [
      {
        type: "assistant",
        text: [
          "<private>the prod token is sk-secret-xyz</private>",
          "<agent-daemon-digest>",
          JSON.stringify({ learnings: [{ type: "pattern", text: "use pnpm in this repo", confidence: 0.7 }], session_summary: "s" }),
          "</agent-daemon-digest>"
        ].join("\n")
      }
    ]
  };
  const r = extractFromAgentBlock(summary);
  assert.equal(r.found, true);
  assert.ok(r.learnings.some(l => /use pnpm/.test(l.text)), "real learning extracted");
  assert.doesNotMatch(JSON.stringify(r), /sk-secret-xyz/, "private secret never reaches extraction");
});

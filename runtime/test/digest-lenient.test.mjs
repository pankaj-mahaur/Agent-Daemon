// Tests for the lenient digest-block parser in runtime/src/digest/extract.mjs.
// Covers: hyphen + colon tag forms, JSON + YAML payloads, code-fence wrappers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFromAgentBlock, parseDigestPayload } from "../src/digest/extract.mjs";

const makeSummary = (assistantText) => ({
  events: [
    { type: "user",      text: "do the thing" },
    { type: "assistant", text: assistantText }
  ]
});

test("parses canonical hyphen-form JSON block", () => {
  const text = `Here you go.

<agent-daemon-digest>
{"learnings":[{"type":"pattern","text":"use npm not yarn","evidence_quote":"q","evidence_speaker":"user","scope":"project","confidence":0.7,"tags":["npm"]}],"session_summary":"summary text"}
</agent-daemon-digest>`;
  const res = extractFromAgentBlock(makeSummary(text));
  assert.equal(res.found, true);
  assert.equal(res.learnings.length, 1);
  assert.equal(res.learnings[0].text, "use npm not yarn");
  assert.equal(res.sessionSummary, "summary text");
});

test("parses colon-form tag (the drift we saw in real transcripts)", () => {
  const text = `<agent-daemon:digest>
{"learnings":[{"type":"pattern","text":"colon form works","evidence_quote":"q","evidence_speaker":"user","scope":"project","confidence":0.7}],"session_summary":"x"}
</agent-daemon:digest>`;
  const res = extractFromAgentBlock(makeSummary(text));
  assert.equal(res.found, true);
  assert.equal(res.learnings.length, 1);
  assert.equal(res.learnings[0].text, "colon form works");
});

test("parses YAML payload inside a hyphen-form tag", () => {
  const text = `<agent-daemon-digest>
learnings:
  - type: pattern
    text: "we use npm not pnpm"
    evidence_quote: "user said so"
    evidence_speaker: user
    scope: project
    confidence: 0.7
    tags: [npm, tooling]
  - type: gotcha
    text: "watcher misses files on Windows"
    evidence_quote: "saw missed events"
    evidence_speaker: agent
    scope: project
    confidence: 0.6
session_summary: "redseer chat work"
</agent-daemon-digest>`;
  const res = extractFromAgentBlock(makeSummary(text));
  assert.equal(res.found, true);
  assert.equal(res.learnings.length, 2);
  assert.equal(res.learnings[0].type, "pattern");
  assert.equal(res.learnings[1].type, "gotcha");
  assert.equal(res.sessionSummary, "redseer chat work");
});

test("parses YAML inside colon-form tag (most-broken real-world combo)", () => {
  const text = `<agent-daemon:digest>
learnings:
  - type: correction
    text: actually we use postgres
    evidence_quote: "the user said postgres"
    evidence_speaker: user
    scope: project
    confidence: 0.8
session_summary: db choice
</agent-daemon:digest>`;
  const res = extractFromAgentBlock(makeSummary(text));
  assert.equal(res.found, true, "colon+YAML should be recoverable");
  assert.equal(res.learnings.length, 1);
  assert.equal(res.learnings[0].type, "correction");
});

test("strips ```json fences inside the block", () => {
  const text = `<agent-daemon-digest>
\`\`\`json
{"learnings":[{"type":"pattern","text":"fenced json","evidence_quote":"q","evidence_speaker":"user","scope":"project","confidence":0.7}],"session_summary":""}
\`\`\`
</agent-daemon-digest>`;
  const res = extractFromAgentBlock(makeSummary(text));
  assert.equal(res.found, true);
  assert.equal(res.learnings[0].text, "fenced json");
});

test("parseDigestPayload: empty string → not ok", () => {
  const res = parseDigestPayload("");
  assert.equal(res.ok, false);
});

test("parseDigestPayload: garbage → not ok", () => {
  const res = parseDigestPayload("this is not parseable in any form 🤷");
  assert.equal(res.ok, false);
});

test("most-recent block wins when transcript has multiple", () => {
  const text = `
<agent-daemon-digest>
{"learnings":[{"type":"pattern","text":"older lesson stored here","evidence_quote":"q","evidence_speaker":"user","scope":"project","confidence":0.7}],"session_summary":"old"}
</agent-daemon-digest>

later in the message...

<agent-daemon-digest>
{"learnings":[{"type":"pattern","text":"newer lesson stored here","evidence_quote":"q","evidence_speaker":"user","scope":"project","confidence":0.7}],"session_summary":"new"}
</agent-daemon-digest>`;
  const res = extractFromAgentBlock(makeSummary(text));
  assert.equal(res.found, true);
  assert.equal(res.learnings[0].text, "newer lesson stored here");
  assert.equal(res.sessionSummary, "new");
});

test("transcript with no block → found:false", () => {
  const res = extractFromAgentBlock(makeSummary("just a normal assistant reply."));
  assert.equal(res.found, false);
});

test("new types (gotcha, decision) survive sanitization", () => {
  const text = `<agent-daemon-digest>
{"learnings":[
  {"type":"gotcha","text":"chokidar misses events on Windows","evidence_quote":"q","evidence_speaker":"user","scope":"project","confidence":0.7},
  {"type":"decision","text":"we'll use polling everywhere","evidence_quote":"q","evidence_speaker":"user","scope":"project","confidence":0.8}
],"session_summary":""}
</agent-daemon-digest>`;
  const res = extractFromAgentBlock(makeSummary(text));
  assert.equal(res.found, true);
  assert.equal(res.learnings.length, 2);
  const types = res.learnings.map(l => l.type).sort();
  assert.deepEqual(types, ["decision", "gotcha"]);
});

/* ------------------------------------------------------------------ */
/* Bug A regression: parser must fall through to earlier turns when    */
/* the most recent block is a placeholder/illustration, not the real   */
/* digest. Real-world failure seen in mobiux-website session 2026-05-21*/
/* ------------------------------------------------------------------ */

test("fallback: malformed LAST turn skips to earlier valid block (placeholder dialogue)", () => {
  // Turn N (earlier): the real digest block
  const realBlock = `Here is the session digest:

<agent-daemon-digest>
{"learnings":[{"type":"pattern","text":"oxblood + mustard tokens for new pages","evidence_quote":"q","evidence_speaker":"user","scope":"project","confidence":0.8}],"session_summary":"shipped 3 trello cards"}
</agent-daemon-digest>

Session band.`;

  // Turn N+1 (later, post-emit follow-up): assistant TALKS about the
  // digest and quotes the tag with a literal placeholder. Common real
  // pattern; this used to abort extraction entirely.
  const followup = `Bas, session close ke last step mein bas yeh kiya: emit kiya \`<agent-daemon-digest>...</agent-daemon-digest>\` JSON block — daemon usse extract karta hai. Skills banayi? Nahi.`;

  const summary = {
    events: [
      { type: "user",      text: "bye, aaj ka kaam ho gaya" },
      { type: "assistant", text: realBlock },
      { type: "user",      text: "thoda explain karo kya kiya" },
      { type: "assistant", text: followup }
    ]
  };

  const res = extractFromAgentBlock(summary);
  assert.equal(res.found, true, "real block must be found despite later placeholder");
  assert.equal(res.learnings.length, 1);
  assert.equal(res.learnings[0].text, "oxblood + mustard tokens for new pages");
  assert.equal(res.sessionSummary, "shipped 3 trello cards");
});

test("fallback: all malformed → found:false with lastParseError surfaced", () => {
  const summary = {
    events: [
      { type: "assistant", text: `early: <agent-daemon-digest>...</agent-daemon-digest>` },
      { type: "assistant", text: `late:  <agent-daemon-digest>{ broken json </agent-daemon-digest>` }
    ]
  };
  const res = extractFromAgentBlock(summary);
  assert.equal(res.found, false);
  assert.ok(res.parseError, "parseError should be surfaced for diagnostics");
  assert.match(res.parseError, /last attempt:/);
});

test("fallback: still respects most-recent-PARSEABLE-wins ordering", () => {
  // Three turns, oldest to newest:
  //   turn 0 — valid block A
  //   turn 1 — placeholder (unparseable)
  //   turn 2 — valid block C (newest)
  // The fall-through should NOT walk past turn 2's valid block to turn 0.
  const blockA = `<agent-daemon-digest>{"learnings":[{"type":"pattern","text":"OLDEST lesson","evidence_quote":"q","evidence_speaker":"user","scope":"project","confidence":0.7}],"session_summary":"A"}</agent-daemon-digest>`;
  const placeholderB = `Quote the tag: <agent-daemon-digest>...</agent-daemon-digest>`;
  const blockC = `<agent-daemon-digest>{"learnings":[{"type":"pattern","text":"NEWEST lesson","evidence_quote":"q","evidence_speaker":"user","scope":"project","confidence":0.7}],"session_summary":"C"}</agent-daemon-digest>`;

  const summary = {
    events: [
      { type: "assistant", text: blockA },
      { type: "assistant", text: placeholderB },
      { type: "assistant", text: blockC }
    ]
  };
  const res = extractFromAgentBlock(summary);
  assert.equal(res.found, true);
  assert.equal(res.learnings[0].text, "NEWEST lesson", "newest parseable block wins, not oldest");
  assert.equal(res.sessionSummary, "C");
});

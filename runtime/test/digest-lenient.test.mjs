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

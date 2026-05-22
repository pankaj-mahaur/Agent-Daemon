// Tests for the lenient digest-block parser in runtime/src/digest/extract.mjs.
// Covers: hyphen + colon tag forms, JSON + YAML payloads, code-fence wrappers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFromAgentBlock, parseDigestPayload, parseCategoryKeyedYaml } from "../src/digest/extract.mjs";

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

/* ------------------------------------------------------------------ */
/* Bug B regression: sanitizeLearnings accepts `tag`/`lessons` drift   */
/* that Claude commonly emits instead of canonical `type`/`text`.      */
/* Real-world failure: mobiux-website session 2026-05-21 had 8 with   */
/* {tag,text} shape and 4 with {lessons} — all 12 dropped before fix.  */
/* ------------------------------------------------------------------ */

test("schema drift: {tag, text} entries land as type=pattern with tag preserved in tags[]", () => {
  const text = `<agent-daemon-digest>
{"learnings":[
  {"tag":"projectbrief","text":"mobiux-website is an Eleventy + Nunjucks marketing site"},
  {"tag":"systemPatterns","text":"design tokens: --bg #f4eedd, --accent #8a2430 (oxblood), --accent-on-accent #d9b865"}
],"session_summary":"shipped 3 trello cards"}
</agent-daemon-digest>`;
  const res = extractFromAgentBlock(makeSummary(text));
  assert.equal(res.found, true);
  assert.equal(res.learnings.length, 2, "both tag-drift entries must land");
  assert.equal(res.learnings[0].type, "pattern", "missing type defaults to pattern when tag is present");
  assert.equal(res.learnings[1].type, "pattern");
  assert.deepEqual(res.learnings[0].tags, ["projectbrief"], "tag value preserved in tags[]");
  assert.deepEqual(res.learnings[1].tags, ["systemPatterns"]);
  assert.equal(res.learnings[0].text, "mobiux-website is an Eleventy + Nunjucks marketing site");
});

test("schema drift: {lessons} (no type, no text) entries land as type=pattern", () => {
  const text = `<agent-daemon-digest>
{"learnings":[
  {"lessons":"Disabling pinch-zoom via user-scalable=no is a WCAG 1.4.4 failure. Always flag the trade-off."}
],"session_summary":""}
</agent-daemon-digest>`;
  const res = extractFromAgentBlock(makeSummary(text));
  assert.equal(res.found, true);
  assert.equal(res.learnings.length, 1);
  assert.equal(res.learnings[0].type, "pattern", "missing type defaults to pattern when lessons is present");
  assert.match(res.learnings[0].text, /pinch-zoom/);
  assert.match(res.learnings[0].text, /WCAG 1\.4\.4/);
});

test("schema drift: mixed batch (canonical + tag-drift + lessons-drift) all land", () => {
  const text = `<agent-daemon-digest>
{"learnings":[
  {"type":"tool","text":"use npm not yarn","confidence":0.9,"tags":["tooling"]},
  {"tag":"techContext","text":"node 22.14, no test runner, no linter"},
  {"lessons":"branch from main, not from another feature branch"}
],"session_summary":"mixed"}
</agent-daemon-digest>`;
  const res = extractFromAgentBlock(makeSummary(text));
  assert.equal(res.found, true);
  assert.equal(res.learnings.length, 3, "no entry should be dropped");
  const types = res.learnings.map(l => l.type);
  assert.deepEqual(types, ["tool", "pattern", "pattern"]);
  assert.deepEqual(res.learnings[0].tags, ["tooling"]);
  assert.deepEqual(res.learnings[1].tags, ["techContext"], "tag value pushed into tags[]");
  assert.deepEqual(res.learnings[2].tags, [], "no tag, no tags[] entries");
});

test("schema drift: {tag, tags} both present → merged + deduped, singular tag wins ordering", () => {
  const text = `<agent-daemon-digest>
{"learnings":[
  {"tag":"systemPatterns","text":"oxblood theme conventions","tags":["css","theme","systemPatterns"]}
],"session_summary":""}
</agent-daemon-digest>`;
  const res = extractFromAgentBlock(makeSummary(text));
  assert.equal(res.found, true);
  assert.equal(res.learnings[0].tags[0], "systemPatterns", "singular tag is first");
  assert.equal(res.learnings[0].tags.length, 3, "duplicate 'systemPatterns' deduped");
  assert.ok(res.learnings[0].tags.includes("css"));
});

test("schema drift: entries with NEITHER type NOR tag/lessons are still dropped (no regression)", () => {
  const text = `<agent-daemon-digest>
{"learnings":[
  {"text":"this entry has no type and no drift-hint — it's noise"},
  {"type":"pattern","text":"this one is valid"}
],"session_summary":""}
</agent-daemon-digest>`;
  const res = extractFromAgentBlock(makeSummary(text));
  assert.equal(res.found, true);
  assert.equal(res.learnings.length, 1, "noise entry dropped, valid entry kept");
  assert.equal(res.learnings[0].text, "this one is valid");
});

test("schema drift: too-short text after fallback to `lessons` still rejected (min 5 chars)", () => {
  const text = `<agent-daemon-digest>
{"learnings":[
  {"lessons":"hi"},
  {"lessons":"this is a properly sized lesson worth keeping"}
],"session_summary":""}
</agent-daemon-digest>`;
  const res = extractFromAgentBlock(makeSummary(text));
  assert.equal(res.found, true);
  assert.equal(res.learnings.length, 1, "short lessons rejected, long one kept");
});

/* ------------------------------------------------------------------ */
/* Bug B2 regression: category-keyed YAML salvage. Some agents emit a   */
/* schema organized by memory-file category (techContext, systemPatterns, */
/* etc.) with `additions[]` / `patterns[]` (and friends) sub-arrays      */
/* instead of a flat learnings[] list. Real-world: redseer-frontend     */
/* sessions May 19-20 emitted ~6 blocks in this shape; canonical path   */
/* extracted 0 from each. Salvage path flattens them into learnings.   */
/* ------------------------------------------------------------------ */

test("parseCategoryKeyedYaml: extracts additions + patterns from techContext + systemPatterns", () => {
  // Verbatim shape from D:/.../redseer-frontend transcript 4d9fea74 (May 20)
  const yaml = `session_date: "2026-05-20"
session_id: "redseer-frontend/2026-05-20-session-01"
branch: "feat/chat-page-v2"

projectbrief: {}

techContext:
  additions:
    - "minisearch@7.2.0 added to deps for BM25 client-side search across conversation titles + bodies (title boosted 3x, prefix + fuzzy 0.2)."
    - "Next.js 15 dynamic route handlers receive params as a Promise<{ id: string }> — must await params before reading."
  patterns:
    - "Path-param ids that flow into Typesense filter_by clauses must be regex-validated server-side BEFORE concatenating into the query string. Pattern: /^[A-Za-z0-9_-]{1,128}$/."
    - "React 19's \\\`inert\\\` boolean prop is the right primitive for hiding background content from AT when a modal is open."

systemPatterns:
  patterns:
    - "Chat conversation list uses cursor-based pagination via Typesense \\\`q=*\\\` with \\\`per_page=20\\\` and a created_at cursor."`;

  const out = parseCategoryKeyedYaml(yaml);
  assert.ok(out, "shape recognized");
  assert.equal(out.length, 5, "5 list items across additions + patterns");

  // Verify type mapping
  const types = out.map(l => l.type).sort();
  assert.deepEqual(types, ["fact", "fact", "pattern", "pattern", "pattern"]);

  // Verify category tagging
  const tcCount = out.filter(l => l.tags[0] === "techContext").length;
  const spCount = out.filter(l => l.tags[0] === "systemPatterns").length;
  assert.equal(tcCount, 4);
  assert.equal(spCount, 1);

  // Verify scope (none should be global since no `user` category)
  assert.ok(out.every(l => l.scope === "project"));

  // Spot-check actual content
  assert.match(out[0].text, /minisearch@7\.2\.0/);
  assert.match(out[2].text, /Typesense filter_by/);
});

test("parseCategoryKeyedYaml: `user` category produces global-scoped entries", () => {
  const yaml = `user:
  patterns:
    - "Prefers terse responses, Hinglish OK when prompt is Hinglish."
    - "Never auto-commit; always wait for explicit OK."

techContext:
  additions:
    - "Project uses pnpm, not npm."`;
  const out = parseCategoryKeyedYaml(yaml);
  assert.ok(out);
  const userEntries = out.filter(l => l.tags[0] === "user");
  const tcEntries   = out.filter(l => l.tags[0] === "techContext");
  assert.equal(userEntries.length, 2);
  assert.equal(tcEntries.length, 1);
  assert.ok(userEntries.every(l => l.scope === "global"), "user entries are global-scoped");
  assert.equal(tcEntries[0].scope, "project", "techContext stays project-scoped");
});

test("parseCategoryKeyedYaml: handles all subkey → type mappings", () => {
  const yaml = `techContext:
  additions:
    - "added fact one entry here"
  patterns:
    - "pattern one entry here"
  corrections:
    - "correction one entry here"
  gotchas:
    - "gotcha one entry here"
  decisions:
    - "decision one entry here"
  tools:
    - "tool one entry here"
  confirmations:
    - "confirmation one entry here"`;
  const out = parseCategoryKeyedYaml(yaml);
  assert.ok(out);
  assert.equal(out.length, 7);
  const types = out.map(l => l.type).sort();
  assert.deepEqual(
    types,
    ["confirmation", "correction", "decision", "fact", "gotcha", "pattern", "tool"]
  );
});

test("parseCategoryKeyedYaml: returns null when no memory-category headers present", () => {
  // Looks like YAML but doesn't have our category shape — should NOT trigger salvage
  const yaml = `learnings:
  - type: pattern
    text: this is the canonical schema
    confidence: 0.7`;
  assert.equal(parseCategoryKeyedYaml(yaml), null);
});

test("parseCategoryKeyedYaml: returns null when category headers present but no list items", () => {
  const yaml = `techContext:
  additions: []
  patterns: []
systemPatterns: {}`;
  assert.equal(parseCategoryKeyedYaml(yaml), null);
});

test("parseCategoryKeyedYaml: stray list items outside any category scope are ignored", () => {
  // A top-level non-memory key resets the scope; subsequent indented items shouldn't capture
  const yaml = `techContext:
  patterns:
    - "valid item inside techContext"

random_top_level_key:
  patterns:
    - "should NOT capture — not a memory-category"

systemPatterns:
  additions:
    - "valid item inside systemPatterns"`;
  const out = parseCategoryKeyedYaml(yaml);
  assert.ok(out);
  assert.equal(out.length, 2, "only the 2 in-scope items survive");
  assert.ok(out.every(l => /valid item/.test(l.text)));
});

test("parseCategoryKeyedYaml: unknown subkey under known category doesn't crash + doesn't capture", () => {
  const yaml = `techContext:
  notes:
    - "should NOT capture — notes isn't a recognized subkey"
  patterns:
    - "this SHOULD capture"`;
  const out = parseCategoryKeyedYaml(yaml);
  assert.ok(out);
  assert.equal(out.length, 1);
  assert.match(out[0].text, /this SHOULD capture/);
});

test("parseCategoryKeyedYaml: direct list items under category (no `additions:`/`patterns:` subkey) default to type=fact", () => {
  // Variant seen in older redseer sessions: items listed directly under the
  // category at indent 2, no intermediate subkey.
  const yaml = `projectbrief:
  - "Redseer is a strategy consulting firm (not market research). Multi-geography."
  - "Standalone /chat/ ChatGPT-style page on feat/chat-page branch."

techContext:
  - "Stack: Next.js 15 + React 19 + TypeScript."`;
  const out = parseCategoryKeyedYaml(yaml);
  assert.ok(out);
  assert.equal(out.length, 3);
  assert.ok(out.every(l => l.type === "fact"), "default type for no-subkey list items is 'fact'");
  const pbCount = out.filter(l => l.tags[0] === "projectbrief").length;
  const tcCount = out.filter(l => l.tags[0] === "techContext").length;
  assert.equal(pbCount, 2);
  assert.equal(tcCount, 1);
});

test("parseCategoryKeyedYaml: strips both double and single quotes from list-item strings", () => {
  const yaml = `techContext:
  additions:
    - "double-quoted item with enough length"
    - 'single-quoted item with enough length'
    - bare unquoted item with enough length`;
  const out = parseCategoryKeyedYaml(yaml);
  assert.ok(out);
  assert.equal(out.length, 3);
  assert.equal(out[0].text, "double-quoted item with enough length");
  assert.equal(out[1].text, "single-quoted item with enough length");
  assert.equal(out[2].text, "bare unquoted item with enough length");
});

/* End-to-end through extractFromAgentBlock ---------------------------- */

test("salvage path: extractFromAgentBlock falls through to category-keyed YAML when learnings[] is empty", () => {
  const text = `<agent-daemon:digest>
\`\`\`yaml
session_id: "redseer-frontend/2026-05-20"
branch: "feat/chat-page-v2"

techContext:
  additions:
    - "minisearch@7.2.0 added for client-side BM25 search"
  patterns:
    - "Next 15 route handlers: params is now Promise — must await before reading"

systemPatterns:
  patterns:
    - "Typesense filter_by params must be regex-validated server-side before concat"
\`\`\`
</agent-daemon:digest>`;

  const res = extractFromAgentBlock(makeSummary(text));
  assert.equal(res.found, true);
  assert.equal(res.learnings.length, 3, "all 3 category-keyed items recovered via salvage");

  // The category should end up in tags[0]
  const taggedTC = res.learnings.filter(l => l.tags[0] === "techContext");
  const taggedSP = res.learnings.filter(l => l.tags[0] === "systemPatterns");
  assert.equal(taggedTC.length, 2);
  assert.equal(taggedSP.length, 1);
});

test("salvage path: does NOT override a successful canonical extraction", () => {
  // Block has BOTH a valid learnings[] and category-keyed data. Canonical path
  // should win — the salvage only fires when learnings.length === 0 after
  // sanitization.
  const text = `<agent-daemon-digest>
{"learnings":[{"type":"pattern","text":"canonical learning takes precedence over salvage","confidence":0.9}],
 "techContext":{"additions":["should NOT land - canonical path produced output"]},
 "session_summary":"mixed"}
</agent-daemon-digest>`;
  const res = extractFromAgentBlock(makeSummary(text));
  assert.equal(res.found, true);
  assert.equal(res.learnings.length, 1);
  assert.match(res.learnings[0].text, /canonical learning takes precedence/);
});

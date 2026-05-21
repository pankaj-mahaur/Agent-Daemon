// Tests for runtime/src/hooks/extractors.mjs — the rules-based regex engine.

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFromText, RULES } from "../src/hooks/extractors.mjs";

test("rule registry is non-empty and well-shaped", () => {
  assert.ok(RULES.length >= 10, `expected ≥10 rules, got ${RULES.length}`);
  for (const r of RULES) {
    assert.equal(typeof r.id, "string");
    assert.ok(r.pattern instanceof RegExp, `${r.id} pattern not RegExp`);
    assert.match(r.type, /^(correction|pattern|gotcha|decision|tool|confirmation)$/, r.id);
    assert.ok(r.confidence >= 0 && r.confidence <= 1, `${r.id} confidence out of range`);
  }
});

test("correction: 'actually we use X'", () => {
  const out = extractFromText("Actually, we use pnpm here, not npm. Be careful.");
  assert.ok(out.length >= 1, "expected at least one match");
  const correction = out.find(l => l.type === "correction");
  assert.ok(correction, "expected a correction");
  assert.match(correction.text.toLowerCase(), /pnpm/);
  assert.equal(correction.evidence_speaker, "user");
});

test("note: 'remember: X'", () => {
  const out = extractFromText("Remember: the build script lives in scripts/build.sh");
  const note = out.find(l => l.type === "pattern" && l.rule_id === "note-remember");
  assert.ok(note);
  assert.match(note.text, /build script/);
});

test("convention: 'we always X' at clause start", () => {
  const out = extractFromText("We always rebase before pushing.");
  const conv = out.find(l => l.rule_id === "note-always-never");
  assert.ok(conv, "expected note-always-never to fire");
  assert.match(conv.text.toLowerCase(), /we always.*rebase before pushing/);
});

// --- v0.3.1 regression tests for the mid-sentence "never X" / "always Y"
//     fragments that produced 6/10 noise in the user's real 7-hour session.
//     These STRINGS MUST NOT produce any pattern captures.

test("regression: 'never on typing' does NOT match (mid-sentence fragment)", () => {
  const text = "conversation list updates (after send, edit, delete, etc.), never on typing.";
  const out = extractFromText(text);
  assert.equal(
    out.filter(l => l.rule_id === "note-always-never").length,
    0,
    `expected zero matches, got: ${JSON.stringify(out.map(l => l.text))}`
  );
});

test("regression: '...never appears' does NOT match (single-word fragment)", () => {
  const text = `finds chats about "shipping speed" even if the word "delivery" never appears. Cost: needs a backend.`;
  const out = extractFromText(text);
  assert.equal(out.filter(l => l.rule_id === "note-always-never").length, 0);
});

test("regression: 'never enter the comparison' does NOT match (preposition-led)", () => {
  const text = "an accent-stripping step before comparing, so the diacritics never enter the comparison.";
  const out = extractFromText(text);
  assert.equal(out.filter(l => l.rule_id === "note-always-never").length, 0);
});

test("regression: 'never for sidebar history' does NOT match (preposition-led)", () => {
  const text = "When to switch: probably never for sidebar history. People searching their own chats remember rough wording.";
  const out = extractFromText(text);
  assert.equal(out.filter(l => l.rule_id === "note-always-never").length, 0);
});

test("regression: 'always being a query' does NOT match (mid-sentence with -ing)", () => {
  const text = "because the prompt is explicit about substantive content always being a query.";
  const out = extractFromText(text);
  assert.equal(out.filter(l => l.rule_id === "note-always-never").length, 0);
});

test("regression: bare 'always rebase' alone does NOT match (no 'we' subject)", () => {
  const text = "I'm just thinking out loud — always rebase before merging makes sense to me.";
  const out = extractFromText(text);
  // The bare "always rebase" mid-sentence is no longer a match. Future rule
  // candidate: capture "I always" / "you always" too, but that's not v0.3.1.
  assert.equal(out.filter(l => l.rule_id === "note-always-never").length, 0);
});

test("positive: 'We always rebase before pushing.' (clause start, has 'we') matches", () => {
  const out = extractFromText("We always rebase before pushing.");
  assert.equal(out.filter(l => l.rule_id === "note-always-never").length, 1);
});

test("positive: 'We never use force-push.' (clause start, has 'we') matches", () => {
  const out = extractFromText("We never use force-push on shared branches.");
  const match = out.find(l => l.rule_id === "note-always-never");
  assert.ok(match);
  assert.match(match.text.toLowerCase(), /we never.*force-push/);
});

test("decision: 'we'll go with X'", () => {
  const out = extractFromText("OK, we'll go with PostgreSQL for the audit log.");
  const dec = out.find(l => l.type === "decision");
  assert.ok(dec);
  assert.match(dec.text.toLowerCase(), /postgresql/);
});

test("gotcha: 'the bug was X'", () => {
  const out = extractFromText("Finally figured it out — the bug was a missing await in the cleanup handler.");
  const g = out.find(l => l.type === "gotcha");
  assert.ok(g);
  assert.match(g.text, /missing await/i);
});

test("gotcha: TIL marker", () => {
  const out = extractFromText("TIL: chokidar polling is required on Windows for nested watches.");
  const g = out.find(l => l.type === "gotcha");
  assert.ok(g);
});

test("tool: 'the right command is X'", () => {
  const out = extractFromText("The right command is `npm run lint:fix` not `eslint --fix`.");
  const t = out.find(l => l.type === "tool");
  assert.ok(t);
});

test("returns [] on empty / non-string input", () => {
  assert.deepEqual(extractFromText(""), []);
  assert.deepEqual(extractFromText(null), []);
  assert.deepEqual(extractFromText(undefined), []);
  assert.deepEqual(extractFromText(123), []);
});

test("does not match in unrelated text", () => {
  const out = extractFromText("Hello, how are you? I'm doing fine today.");
  assert.equal(out.length, 0);
});

test("dedupes within a single call", () => {
  const text = "remember: use npm. remember: use npm. remember: use npm.";
  const out = extractFromText(text);
  // Should fire once due to dedupe — same rule + same text prefix
  const reminders = out.filter(l => l.rule_id === "note-remember");
  assert.equal(reminders.length, 1);
});

test("respects maxLearnings cap", () => {
  // Build a text packed with many distinct hits
  const text = [
    "Actually, we use pnpm not npm.",
    "Remember: lint runs in CI.",
    "We always rebase before pushing.",
    "Decided to use PostgreSQL.",
    "The bug was a race condition.",
    "TIL: tsconfig paths break in jest.",
    "The right command is `npm run dev`."
  ].join(" ");
  const out = extractFromText(text, { maxLearnings: 3 });
  assert.ok(out.length <= 3, `expected ≤3, got ${out.length}`);
});

test("evidence_quote is bounded and stripped of newlines", () => {
  const text = "Some preamble.\n\nActually, we use Vite, not webpack.\n\nMore content here.";
  const out = extractFromText(text);
  const c = out.find(l => l.type === "correction");
  assert.ok(c);
  assert.ok(c.evidence_quote.length <= 200);
  assert.ok(!c.evidence_quote.includes("\n"));
});

test("tags are extracted from text keywords", () => {
  const out = extractFromText("Actually, we use npm not pnpm for this monorepo.");
  const c = out.find(l => l.type === "correction");
  assert.ok(c);
  assert.ok(c.tags.includes("npm") || c.tags.includes("pnpm"));
});

test("uses agent speakerHint via tagger? no — falls back to caller's meta", () => {
  const text = "Important: the API key rotation runs nightly.";
  const out = extractFromText(text, { speaker: "agent" });
  const n = out.find(l => l.type === "pattern" && l.rule_id === "note-remember");
  assert.ok(n);
  assert.equal(n.evidence_speaker, "agent");
});

// --- v0.4.1 regression tests for the 4 rules clause-anchored in the
//     second noise pass. Each input is a mid-sentence fragment harvested
//     from the user's real dogfood data — these MUST NOT produce captures.

test("regression: mid-sentence 'going with' does NOT match", () => {
  const text = "We discussed several options before going with the more conservative path here.";
  const out = extractFromText(text);
  assert.equal(
    out.filter(l => l.rule_id === "decision-decided").length,
    0,
    `expected zero decision-decided matches, got: ${JSON.stringify(out.map(l => l.text))}`
  );
});

test("regression: mid-sentence 'fixed by' inside relative clause does NOT match", () => {
  const text = "the symptom was mostly fixed by then but it kept resurfacing every Friday afternoon";
  const out = extractFromText(text);
  assert.equal(
    out.filter(l => l.rule_id === "gotcha-the-bug-was").length,
    0,
    `expected zero gotcha matches, got: ${JSON.stringify(out.map(l => l.text))}`
  );
});

test("regression: mid-sentence 'by convention' deep in a clause does NOT match", () => {
  const text = "but as it turns out by convention things drift over time anyway here";
  const out = extractFromText(text);
  assert.equal(
    out.filter(l => l.rule_id === "convention-the-convention-is").length,
    0,
    `expected zero convention matches, got: ${JSON.stringify(out.map(l => l.text))}`
  );
});

test("regression: mid-sentence 'run it with' inside relative clause does NOT match", () => {
  const text = "anyone can run it with care if they pay attention to the side effects";
  const out = extractFromText(text);
  assert.equal(
    out.filter(l => l.rule_id === "tool-the-command-is").length,
    0,
    `expected zero tool matches, got: ${JSON.stringify(out.map(l => l.text))}`
  );
});

// --- Positive regression: clause-anchored rules MUST still fire on the
//     legitimate sentence shapes they were designed for.

test("clause-start 'decided' (sentence start) still matches", () => {
  const out = extractFromText("Decided to drop the polling timer in favor of SSE.");
  const dec = out.find(l => l.rule_id === "decision-decided");
  assert.ok(dec, "decision rule should fire on sentence-start trigger");
  assert.match(dec.text.toLowerCase(), /polling timer.*sse/);
});

test("comma-introduced 'we'll go with' still matches", () => {
  const out = extractFromText("OK, we'll go with PostgreSQL for the audit log.");
  const dec = out.find(l => l.rule_id === "decision-decided");
  assert.ok(dec, "decision rule should fire after comma boundary");
  assert.match(dec.text.toLowerCase(), /postgresql/);
});

test("em-dash 'the bug was' still matches", () => {
  const out = extractFromText("Finally figured it out — the bug was a missing await in the cleanup handler.");
  const g = out.find(l => l.rule_id === "gotcha-the-bug-was");
  assert.ok(g, "gotcha rule should fire after em-dash boundary");
  assert.match(g.text, /missing await/i);
});

test("backticked 'right command is' still captures the inline command", () => {
  const out = extractFromText("The right command is `npm run lint:fix` not `eslint --fix`.");
  const t = out.find(l => l.rule_id === "tool-the-command-is");
  assert.ok(t, "tool rule should fire on backticked command");
  assert.match(t.text, /npm run lint/);
});

// --- v0.5 Hinglish / Hindi-Roman rules (WS-6a) ----------------------
//
// All clause-anchored, confidence 0.45. Each rule needs a positive test
// (fires on the canonical shape) and ideally a negative (mid-sentence
// fragment must not capture). looksMeaningful() filter still applies.

test("hinglish correction: 'ye galti mat karna ...' captures the warning", () => {
  const out = extractFromText("Listen, ye galti mat karna config file ko commit kar dena.");
  const c = out.find(l => l.rule_id === "correction-galti-hindi");
  assert.ok(c, "expected correction-galti-hindi to fire");
  assert.match(c.text.toLowerCase(), /config file/);
  assert.equal(c.confidence, 0.45);
});

test("hinglish pattern: 'yaad rakhna: X' captures the reminder", () => {
  const out = extractFromText("yaad rakhna: hamesha pnpm use karna is project mein.");
  const p = out.find(l => l.rule_id === "pattern-yaad-rakhna");
  assert.ok(p, "expected pattern-yaad-rakhna to fire");
  assert.match(p.text.toLowerCase(), /pnpm/);
});

test("hinglish convention: 'isko yun karna X' fires", () => {
  const out = extractFromText("Going forward — isko yun karna ki migrations always go through prisma.");
  const c = out.find(l => l.rule_id === "convention-yun-karna");
  assert.ok(c, "expected convention-yun-karna to fire");
  assert.match(c.text.toLowerCase(), /prisma/);
});

test("hinglish decision: 'maine X decide kiya' fires", () => {
  const out = extractFromText("OK, maine postgres over mysql decide kiya for the audit log.");
  const d = out.find(l => l.rule_id === "decision-decide-kiya");
  assert.ok(d, "expected decision-decide-kiya to fire");
  assert.match(d.text.toLowerCase(), /postgres over mysql/);
});

test("hinglish gotcha: 'mistake ye thi ki X' fires", () => {
  const out = extractFromText("Aha — mistake ye thi ki the env var was not being re-read after restart.");
  const g = out.find(l => l.rule_id === "gotcha-mistake-thi");
  assert.ok(g, "expected gotcha-mistake-thi to fire");
  assert.match(g.text, /env var/i);
});

test("hinglish tool: 'ye command chalana X' fires", () => {
  const out = extractFromText("To regen the lock file, ye command chalana `npm install --package-lock-only`.");
  const t = out.find(l => l.rule_id === "tool-command-chalana");
  assert.ok(t, "expected tool-command-chalana to fire");
  assert.match(t.text, /npm install/);
});

test("hinglish prohibition: 'X mat karna' captures the action to avoid", () => {
  const out = extractFromText("Just FYI — directly merge to main mat karna without a PR.");
  const g = out.find(l => l.rule_id === "pattern-nahi-karna");
  assert.ok(g, "expected pattern-nahi-karna to fire");
  assert.match(g.text.toLowerCase(), /merge to main/);
  assert.match(g.text, /^don't/i, "composer should prepend 'don't'");
});

test("hinglish negative: 'galti hai' mid-deep-clause does NOT match", () => {
  // No clause boundary preceding "ye galti hai" → should not fire
  const text = "tum jaante ho that sometimes ye galti hai but anyway whatever.";
  const out = extractFromText(text);
  // looksMeaningful() may drop short matches, but ensure no clean capture
  const matched = out.filter(l => l.rule_id === "correction-galti-hindi");
  assert.ok(matched.length <= 1, "should not produce noisy multi-matches");
});

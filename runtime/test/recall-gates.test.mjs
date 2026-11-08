// L6 P1 gates (04 L6 Done-when; design "Goal and gates"), measured on the held-out
// corpora through the recall core and the renderer. Totals only: these tests never
// print or assert on an item (D29, test/corpora/README.md). The end-to-end runs
// through the spawned hooks are in recall-hook-gates.test.mjs (P3, P4).
//
//   brief:  a relevant note for ≥ 7 of 8 projects; ≤ 20% of the brief's notes
//           irrelevant (pooled); ours: ≤ 34% in any one project, ≥ 2 relevant notes per
//           brief on average; and the same with every note seeded as the user's own
//           words (the every-session tier filled by the newest)
//   prompt: precision ≥ 0.8 above the threshold; ours: at least 10 notes returned over
//           the corpus (no pass by silence); recall of relevant notes reported

// Held-out runs are deliberate and logged (design decision 3): only with AD_HELDOUT=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const E = await import("../testkit/recall-eval.mjs");
const HELDOUT = process.env.AD_HELDOUT === "1";

const CORPORA = fileURLToPath(new URL("./corpora/", import.meta.url));
const NOW = Date.parse("2026-11-01"); // the corpora's reference date

test("held-out brief gate (totals)", { skip: !HELDOUT && "held-out runs need AD_HELDOUT=1" }, (t) => {
  const projects = E.loadBriefCorpus(path.join(CORPORA, "brief-relevance"));
  for (const seed of ["legacy", "own"]) {
    const s = E.scoreBriefs(projects.map((p) => ({ ids: E.coreBriefIds(p, { now: NOW, seed }), expected: p.expected })));
    t.diagnostic(`held-out brief (${seed} seeding): ${s.withRelevant}/${s.projects} with a relevant note; ${E.pct(s.share)} irrelevant (${s.irrelevant}/${s.total}); per-project max ${E.pct(s.maxShare)}; ${s.relevantPerBrief.toFixed(1)} relevant per brief`);
    assert.equal(s.projects, 8);
    assert.ok(s.withRelevant >= 7, `${seed}: projects with a relevant note ${s.withRelevant}/8`);
    assert.ok(s.share <= 0.2, `${seed}: irrelevant share ${E.pct(s.share)}`);
    assert.ok(s.maxShare <= 0.34, `${seed}: per-project max ${E.pct(s.maxShare)}`);
    assert.ok(s.relevantPerBrief >= 2, `${seed}: relevant per brief ${s.relevantPerBrief.toFixed(1)}`);
  }
  const k = E.scoreBriefs(projects.map((p) => ({ ids: E.coreBriefIds(p, { now: NOW, seed: "kind" }), expected: p.expected })));
  t.diagnostic(`held-out brief, kind proxy (reported): ${k.withRelevant}/${k.projects}; ${E.pct(k.share)} irrelevant`);
});

test("held-out prompt-recall gate (totals)", { skip: !HELDOUT && "held-out runs need AD_HELDOUT=1" }, (t) => {
  const corpus = E.loadPromptCorpus(path.join(CORPORA, "prompt-recall"));
  const s = E.scorePrompts(E.corePromptIds(corpus, { now: NOW }));
  t.diagnostic(`held-out prompt: precision ${s.precision.toFixed(3)} (${s.good}/${s.returned}); recall of relevant ${s.recall.toFixed(3)} (${s.relHit}/${s.relTotal}); ${s.falseOnEmpty} returned on prompts that need none`);
  assert.equal(s.prompts, 64);
  assert.ok(s.precision >= 0.8, `precision ${s.precision.toFixed(3)}`);
  assert.ok(s.returned >= 10, `returned ${s.returned}`);
});

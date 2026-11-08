// L6 P1 (design decision 3): the recall core on the dev set (test/fixtures/recall-dev),
// the set the ranking was tuned on. These floors guard against a regression; the
// gates themselves are measured on the held-out corpora (recall-gates.test.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const E = await import("../testkit/recall-eval.mjs");
const { sizeVariant } = await import("../testkit/recall-sizes.mjs");

const DEV = fileURLToPath(new URL("./fixtures/recall-dev/", import.meta.url));
const NOW = Date.parse("2026-11-01"); // the dev set's reference date
const briefs = E.loadBriefCorpus(path.join(DEV, "brief"));
const prompts = E.loadPromptCorpus(path.join(DEV, "prompt"));

test("dev briefs: every project gets a relevant note, few irrelevant ones, several relevant ones", (t) => {
  const s = E.scoreBriefs(briefs.map((p) => ({ ids: E.coreBriefIds(p, { now: NOW }), expected: p.expected })));
  t.diagnostic(`dev brief: ${s.withRelevant}/${s.projects} with a relevant note, ${E.pct(s.share)} irrelevant (${s.irrelevant}/${s.total}), ${s.relevantPerBrief.toFixed(1)} relevant per brief`);
  assert.equal(s.withRelevant, s.projects);
  assert.ok(s.share <= 0.12, E.pct(s.share));
  assert.ok(s.maxShare <= 0.34, E.pct(s.maxShare));
  assert.ok(s.relevantPerBrief >= 4, String(s.relevantPerBrief));
});

test("dev briefs with every note seeded as the user's own words (the every-session tier filled) stay clean", (t) => {
  const s = E.scoreBriefs(briefs.map((p) => ({ ids: E.coreBriefIds(p, { now: NOW, seed: "own" }), expected: p.expected })));
  t.diagnostic(`dev brief, own-words seeding: ${E.pct(s.share)} irrelevant (${s.irrelevant}/${s.total}), per-project max ${E.pct(s.maxShare)}`);
  assert.equal(s.withRelevant, s.projects);
  assert.ok(s.share <= 0.15, E.pct(s.share));
  const k = E.scoreBriefs(briefs.map((p) => ({ ids: E.coreBriefIds(p, { now: NOW, seed: "kind" }), expected: p.expected })));
  t.diagnostic(`dev brief, kind proxy (reported): ${E.pct(k.share)} irrelevant (${k.irrelevant}/${k.total})`);
});

test("dev briefs hold at 10, 300 and 2,000 notes per project", (t) => {
  for (const size of [10, 300, 2000]) {
    const res = briefs.map((p) => {
      const others = [...briefs.filter((o) => o !== p).flatMap((o) => o.notes), ...prompts.notes];
      const v = sizeVariant(p, others, size);
      return { ids: E.coreBriefIds(v, { now: NOW }), expected: v.expected };
    });
    const s = E.scoreBriefs(res);
    t.diagnostic(`dev brief at ${size} notes: ${s.withRelevant}/${s.projects}, ${E.pct(s.share)} irrelevant`);
    assert.equal(s.withRelevant, s.projects, `${size}`);
    // Larger sizes add other projects' real notes (a store never mixes projects) and
    // invented other-area notes: a robustness guard, not the gate.
    assert.ok(s.share <= 0.25, `${size}: ${E.pct(s.share)}`);
  }
});

test("dev briefs drop at most 2 current notes as superseded (relevant or neutral ones whose newer note is shown)", async (t) => {
  const K = await import("../src/memory/recall-rank.mjs");
  let dropped = 0;
  for (const p of briefs) {
    const sel = K.selectBrief(p.notes.map((n) => E.asNote(n)), { branch: p.context.branch, paths: p.context.recent_paths, commits: p.context.recent_commits }, { now: NOW });
    for (const id of sel.superseded.keys()) if (p.expected.relevant.includes(id) || p.expected.neutral.includes(id)) dropped++;
  }
  t.diagnostic(`dev brief: ${dropped} current notes dropped as superseded`);
  assert.ok(dropped <= 2, String(dropped));
});

test("dev prompts: precision above the threshold, and recall that isn't silence", (t) => {
  const s = E.scorePrompts(E.corePromptIds(prompts, { now: NOW }));
  t.diagnostic(`dev prompt: precision ${s.precision.toFixed(3)} (${s.good}/${s.returned}), recall ${s.recall.toFixed(3)} (${s.relHit}/${s.relTotal}), ${s.falseOnEmpty} on prompts that need none`);
  assert.ok(s.precision >= 0.85, s.precision.toFixed(3));
  assert.ok(s.recall >= 0.33, s.recall.toFixed(3));
  assert.ok(s.returned >= 15, String(s.returned));
});

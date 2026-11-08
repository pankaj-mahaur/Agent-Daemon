// L6 gates end to end (design decision 1): the held-out brief corpus through the
// spawned dispatcher, as the memory product delivers it (--memory-only under Claude
// Code): a seeded store, a git project on the corpus's branch, its context cache, and
// every learning id in the delivered context scored. Totals only (D29): nothing here
// prints or asserts on an item.
//
// Dates are shifted so the corpus's reference date (1 Nov 2026) is today: a note's age
// is what the corpus says it is. Two seedings: legacy notes (none sent every session),
// and every note as the user's own words accepted at its date (the newest fill the
// every-session tier). AD_L6_BRIEF_DIR points it at the dev set instead (a check of
// the harness itself, before a held-out run).

// Held-out runs are deliberate and logged (design decision 3): only with AD_HELDOUT=1.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ad-l6-gates-"));
const AD = path.join(ROOT, "ad-root");
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
process.env.AD_ROOT = AD;
for (const k of ["AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[k];
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const H = await import("../testkit/recall-hook.mjs");
const E = await import("../testkit/recall-eval.mjs");
const HELDOUT = process.env.AD_HELDOUT === "1" || Boolean(process.env.AD_L6_BRIEF_DIR);
const { writeContext } = await import("../src/memory/recall-context.mjs");

const CORPORA = process.env.AD_L6_BRIEF_DIR ? path.dirname(process.env.AD_L6_BRIEF_DIR) : fileURLToPath(new URL("./corpora/", import.meta.url));
const BRIEFS = process.env.AD_L6_BRIEF_DIR ?? path.join(CORPORA, "brief-relevance");
const REF = Date.parse("2026-11-01");
const shift = Date.now() - REF;
const shifted = (iso) => new Date(Date.parse(iso) + shift).toISOString();

test("held-out brief gate, end to end through the memory product's session start (totals)", { skip: !H.hasGit ? "no git" : !HELDOUT && "held-out runs need AD_HELDOUT=1", timeout: 300_000 }, async (t) => {
  const projects = E.loadBriefCorpus(BRIEFS);
  for (const seed of ["legacy", "own"]) {
    const results = [];
    for (const p of projects) {
      const dir = fs.realpathSync.native(H.gitProject(path.join(ROOT, seed, `${p.slug}-${seed}`), p.context.branch));
      writeContext(dir, { branch: p.context.branch, paths: p.context.recent_paths ?? [], commits: p.context.recent_commits ?? [] }, { root: AD });
      const S = await H.projectStore(dir);
      const toCorpus = new Map();
      for (const n of p.notes) {
        const at = shifted(n.created);
        const id = S.add({ text: n.text, category: "fact", created_at: at, accepted_at: at, provenance: seed === "own" ? "prompt" : "legacy" });
        toCorpus.set(id, n.id);
      }
      S.close();
      const r = H.runHook("session.start", H.sessionStart(dir, `gate-${seed}-${p.slug}`), { host: "memory-only", project: dir });
      assert.equal(r.status, 0);
      results.push({ ids: H.idsIn(r.context).map((id) => toCorpus.get(id)).filter(Boolean), expected: p.expected });
    }
    const s = E.scoreBriefs(results);
    t.diagnostic(`${process.env.AD_L6_BRIEF_DIR ? "dev" : "held-out"} brief end to end (${seed} seeding): ${s.withRelevant}/${s.projects} with a relevant note; ${E.pct(s.share)} irrelevant (${s.irrelevant}/${s.total}); per-project max ${E.pct(s.maxShare)}; ${s.relevantPerBrief.toFixed(1)} relevant per brief`);
    assert.ok(s.withRelevant >= Math.ceil(s.projects * 7 / 8), `${seed}: ${s.withRelevant}/${s.projects}`);
    assert.ok(s.share <= 0.2, `${seed}: ${E.pct(s.share)}`);
    assert.ok(s.maxShare <= 0.34, `${seed}: per-project max ${E.pct(s.maxShare)}`);
    assert.ok(s.relevantPerBrief >= 2, `${seed}: ${s.relevantPerBrief.toFixed(1)}`);
  }
});

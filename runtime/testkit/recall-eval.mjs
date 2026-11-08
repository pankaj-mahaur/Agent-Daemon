// Scoring the recall core against a labelled corpus (L6 design decision 3): the dev
// set (test/fixtures/recall-dev, tuning) and the held-out corpora (test/corpora,
// gates). Results are totals; nothing here prints an item.

import fs from "node:fs";
import path from "node:path";
import { selectBrief, selectPrompt, PROMPT } from "../src/memory/recall-rank.mjs";
import { renderBrief, renderPrompt } from "../src/memory/recall-render.mjs";
import { ownWords } from "../src/mistakes/classify.mjs";

const jsonl = (f) => fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

/** [{slug, context, notes, expected}] from a brief corpus folder. */
export function loadBriefCorpus(dir) {
  return fs
    .readdirSync(dir)
    .filter((s) => fs.existsSync(path.join(dir, s, "expected.json")))
    .sort()
    .map((slug) => ({
      slug,
      context: JSON.parse(fs.readFileSync(path.join(dir, slug, "context.json"), "utf8")),
      notes: jsonl(path.join(dir, slug, "notes.jsonl")),
      expected: JSON.parse(fs.readFileSync(path.join(dir, slug, "expected.json"), "utf8")),
    }));
}

/** {notes, prompts} from a prompt corpus folder. */
export function loadPromptCorpus(dir) {
  return { notes: jsonl(path.join(dir, "notes.jsonl")), prompts: jsonl(path.join(dir, "prompts.jsonl")) };
}

/** A corpus note as the core sees a store row: accepted, dated, no provenance or repeats. */
export const asNote = (n, extra = {}) => ({ id: n.id, text: n.text, created: n.created, status: "active", ...extra });

/**
 * The ids the brief would deliver for one project through the core and the renderer
 * (budget, withheld notes). seed: how the notes were captured —
 *   "legacy" (default): none is sent every session;
 *   "own": the user's own words accepted at their `created` date, so the ones from the
 *     last 14 days are sent every session (the adapter's rule);
 *   "kind": a proxy by kind (tooling, workflow, git), reported only.
 */
export function coreBriefIds(project, { now, seed = "legacy", budget } = {}) {
  const recent = (n) => Date.parse(n.created) >= now - 14 * 86_400_000;
  const extra = (n) => (seed === "own" && recent(n) ? { standing: true, recent: true } : seed === "kind" && ["tooling", "workflow", "git"].includes(n.kind) ? { standing: true } : {});
  const notes = project.notes.map((n) => asNote(n, extra(n)));
  const ctx = { branch: project.context.branch, paths: project.context.recent_paths ?? [], commits: project.context.recent_commits ?? [] };
  const sel = selectBrief(notes, ctx, { now });
  const b = renderBrief({ standing: sel.standing.map((r) => r.note), work: sel.work.map((r) => r.note), branch: ctx.branch, fallback: sel.fallback, product: "p", now, ...(budget ? { budget } : {}) });
  return b ? b.ids : [];
}

/** Totals for briefs: [{ids, expected}]. */
export function scoreBriefs(results) {
  let withRelevant = 0;
  let total = 0;
  let irrelevant = 0;
  let relevant = 0;
  let maxShare = 0;
  for (const { ids, expected } of results) {
    const r = ids.filter((id) => expected.relevant.includes(id)).length;
    const i = ids.filter((id) => expected.irrelevant.includes(id)).length;
    if (r > 0) withRelevant++;
    total += ids.length;
    irrelevant += i;
    relevant += r;
    if (ids.length) maxShare = Math.max(maxShare, i / ids.length);
  }
  return { projects: results.length, withRelevant, total, irrelevant, relevant, share: total ? irrelevant / total : 0, maxShare, relevantPerBrief: results.length ? relevant / results.length : 0 };
}

/** The ids prompt recall would deliver for each prompt (project-scoped), through the core and the renderer. */
export function corePromptIds(corpus, { opts = PROMPT, now } = {}) {
  const byProject = new Map();
  for (const n of corpus.notes) {
    if (!byProject.has(n.project)) byProject.set(n.project, []);
    byProject.get(n.project).push(asNote(n));
  }
  return corpus.prompts.map((p) => {
    const rows = selectPrompt(byProject.get(p.project) ?? [], p.prompt, { own: ownWords(p.prompt), opts });
    const block = renderPrompt({ notes: rows.map((r) => r.note), product: "p", now });
    return { ids: block ? block.ids : [], prompt: p };
  });
}

/** Totals for prompts: [{ids, prompt: {relevant, acceptable}}]. */
export function scorePrompts(results) {
  let returned = 0;
  let good = 0;
  let relTotal = 0;
  let relHit = 0;
  let falseOnEmpty = 0;
  for (const { ids, prompt } of results) {
    const ok = new Set([...(prompt.relevant ?? []), ...(prompt.acceptable ?? [])]);
    returned += ids.length;
    const g = ids.filter((id) => ok.has(id)).length;
    good += g;
    relTotal += prompt.relevant.length;
    relHit += ids.filter((id) => prompt.relevant.includes(id)).length;
    if (!prompt.relevant.length) falseOnEmpty += ids.length - g;
  }
  return { prompts: results.length, returned, good, precision: returned ? good / returned : 0, recall: relTotal ? relHit / relTotal : 0, relHit, relTotal, falseOnEmpty };
}

export const pct = (x) => `${(x * 100).toFixed(1)}%`;

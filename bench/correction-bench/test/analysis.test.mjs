// The statistics on synthetic data with known answers, the archive hash, the plan.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clusterBootstrap, unitBootstrap, mcnemarExact, gee, holm, rng, powerAt, normCdf, signFlip, tCdf } from "../lib/stats.mjs";
import { analyze, pairUnits, renderMarkdown } from "../lib/analysis.mjs";
import { hashTree, verify, writeHashFile } from "../lib/archive.mjs";
import { buildPlan, pickPhrasing } from "../lib/plan.mjs";
import { loadSplit } from "../lib/family.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bench-analysis-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

// 40 families × 6 paired opportunities; off violates 40%, on-hooks 20%, with
// family-level variation in the baseline.
function synthetic({ families = 40, per = 6, pa = 0.4, pb = 0.2, seed = 3 } = {}) {
  const rand = rng(seed);
  const units = [];
  for (let f = 0; f < families; f++) {
    const shift = (rand() - 0.5) * 0.2;
    for (let i = 0; i < per; i++) units.push({ family: `f${f}`, a: rand() < pa + shift ? 1 : 0, b: rand() < pb + shift ? 1 : 0 });
  }
  return units;
}

test("a known 40% → 20% effect: the cluster bootstrap's CI contains 20 points and excludes 0", () => {
  const r = clusterBootstrap(synthetic(), { resamples: 4000 });
  assert.ok(r.ci[0] <= 0.2 && 0.2 <= r.ci[1], JSON.stringify(r));
  assert.ok(r.ci[0] > 0, JSON.stringify(r));
  assert.ok(r.p < 0.01);
  // Seeded: the same input gives the same numbers.
  assert.deepEqual(clusterBootstrap(synthetic(), { resamples: 4000 }), r);
});

test("all the effect in one family: clustering widens the CI and McNemar alone would mislead", () => {
  const units = [];
  for (let f = 0; f < 20; f++) for (let i = 0; i < 6; i++) units.push({ family: `f${f}`, a: f === 0 ? 1 : i % 2, b: f === 0 ? 0 : i % 2 });
  // Make family 0 heavy: 40 discordant pairs.
  for (let i = 0; i < 34; i++) units.push({ family: "f0", a: 1, b: 0 });
  const clustered = clusterBootstrap(units, { resamples: 4000 });
  const flat = unitBootstrap(units, { resamples: 4000 });
  const mc = mcnemarExact(units);
  assert.ok(clustered.ci[1] - clustered.ci[0] > 2 * (flat.ci[1] - flat.ci[0]), `clustered ${clustered.ci} vs flat ${flat.ci}`);
  assert.ok(mc.p < 1e-6 && clustered.p > 0.05, `McNemar ${mc.p}, clustered ${clustered.p}`);
});

test("exact McNemar and Holm match hand-computed values", () => {
  const u = (a, b, n) => Array.from({ length: n }, () => ({ family: "f", a, b }));
  // b = 8, c = 2: two-sided exact p = 2 · P(X ≤ 2 | n = 10) = 2 · 56/1024 = 0.109375
  assert.ok(Math.abs(mcnemarExact([...u(1, 0, 8), ...u(0, 1, 2), ...u(1, 1, 5)]).p - 0.109375) < 1e-12);
  assert.equal(mcnemarExact(u(1, 1, 3)).p, 1);
  assert.deepEqual(holm([0.01, 0.04, 0.03]).map((x) => +x.toFixed(4)), [0.03, 0.06, 0.06]);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-4);
});

test("GEE finds the effect's direction, refuses a degenerate condition", () => {
  const g = gee(synthetic());
  assert.equal(g.ok, true);
  assert.ok(g.b1 > 0 && g.p < 0.01, JSON.stringify(g));
  // log-odds of 0.4 vs 0.2 ≈ 0.98: the estimate is near it
  assert.ok(Math.abs(g.b1 - Math.log((0.4 / 0.6) / (0.2 / 0.8))) < 0.5, JSON.stringify(g));
  assert.equal(gee([{ family: "f", a: 0, b: 1 }, { family: "g", a: 0, b: 0 }]).ok, false);
});

test("sign-flip: exact with few families, calibrated under no effect", () => {
  // 5 families, one discordant pair each: only the all-plus pattern is as extreme → 1/32.
  const five = Array.from({ length: 5 }, (_, f) => ({ family: `f${f}`, a: 1, b: 0 }));
  const r = signFlip(five);
  assert.equal(r.exact, true);
  assert.equal(r.p, 1 / 32);
  assert.equal(r.pTwoSided, 2 / 32);
  // The other way round never confirms.
  assert.equal(signFlip(five.map((u) => ({ ...u, a: 0, b: 1 }))).p, 1);
  // Under no effect, a one-sided 5% test rejects about 5% of the time (here ≤ 8% of 400 runs).
  let rejects = 0;
  for (let s = 0; s < 400; s++) {
    const rand = rng(1000 + s);
    const us = [];
    for (let f = 0; f < 8; f++) {
      const base = rand() * 0.6;
      for (let i = 0; i < 6; i++) us.push({ family: `f${f}`, a: rand() < base ? 1 : 0, b: rand() < base ? 1 : 0 });
    }
    if (signFlip(us).p < 0.05) rejects++;
  }
  assert.ok(rejects / 400 <= 0.08, `null rejection rate ${rejects / 400}`);
  // Monte Carlo above the exact limit, seeded.
  const many = synthetic({ families: 30 });
  const mc = signFlip(many, { exactMax: 10, draws: 5000 });
  assert.equal(mc.exact, false);
  assert.ok(mc.p < 0.01);
  assert.deepEqual(signFlip(many, { exactMax: 10, draws: 5000 }), mc);
});

test("Student's t matches known values", () => {
  assert.ok(Math.abs(tCdf(2.228, 10) - 0.975) < 1e-3);
  assert.ok(Math.abs(tCdf(0, 7) - 0.5) < 1e-12);
  assert.ok(Math.abs(tCdf(-1.833, 9) - 0.05) < 1e-3);
});

test("power at a stated smallest effect: more families, more power; H4 needs both comparisons", () => {
  const pilot = synthetic({ families: 12, pa: 0.4, pb: 0.35 });
  const p = powerAt([pilot], { delta: 0.2, sizes: [6, 40], sims: 60, draws: 199 });
  assert.ok(p[1].power >= p[0].power, JSON.stringify(p));
  assert.ok(p[1].power > 0.7, JSON.stringify(p));
  // A tiny effect is hard to find; requiring two comparisons is never easier than one.
  const tiny = powerAt([pilot], { delta: 0.01, sizes: [40], sims: 60, draws: 199 });
  assert.ok(tiny[0].power < 0.3, JSON.stringify(tiny));
  const both = powerAt([pilot, pilot], { delta: 0.2, sizes: [40], sims: 60, draws: 199 });
  assert.ok(both[0].power <= p[1].power + 0.05, JSON.stringify(both));
  assert.throws(() => powerAt([pilot], { sizes: [10] }), /delta/);
});

// Session 1 teaches: it violates and is corrected in every arm (the design aim);
// later sessions violate at each condition's rate.
function records() {
  const out = [];
  const rand = rng(11);
  for (let f = 0; f < 12; f++)
    for (const seed of [1, 2])
      for (const [condition, pv] of [["off", 0.6], ["native", 0.5], ["static-rules", 0.45], ["on-hooks", 0.15]])
        for (let session = 1; session <= 3; session++) {
          const v = session === 1 || rand() < pv;
          out.push({ driver: "ad", model: "m1", family: `fam${f}`, condition, seed, session, status: "ok", opportunity: true, violated: v, corrected: v, captured: condition === "on-hooks" && session === 1 ? rand() < 0.8 : false, hostMemory: condition === "native" });
        }
  return out;
}
const find = (rs, c, fam, seed, session) => rs.find((r) => r.condition === c && r.family === fam && r.seed === seed && r.session === session);

test("analysis: pairs only taught, shared opportunities; confirms H1 and H4 on a strong effect; Holm across them", () => {
  const rs = records();
  find(rs, "off", "fam0", 1, 2).status = "timeout";
  const units = pairUnits(rs, "off", "on-hooks");
  assert.equal(units.length, 12 * 2 * 2 - 1, "the timed-out session drops out of the primary pairs");
  assert.equal(pairUnits(rs, "off", "on-hooks", { failuresAsViolations: true }).length, 12 * 2 * 2);
  // A session that touched nothing the rule governs is no pair, under either condition…
  const noOpp = find(rs, "on-hooks", "fam1", 1, 2);
  noOpp.opportunity = false;
  assert.equal(pairUnits(rs, "off", "on-hooks").length, 12 * 2 * 2 - 2);
  assert.equal(pairUnits(rs, "off", "on-hooks", { anyOpportunity: true, failuresAsViolations: true }).length, 12 * 2 * 2, "…except in the either-arm sensitivity");
  noOpp.opportunity = true;
  // …and a family and seed whose session 1 wasn't corrected in one arm taught nothing there.
  find(rs, "on-hooks", "fam2", 2, 1).corrected = false;
  assert.equal(pairUnits(rs, "off", "on-hooks").length, 12 * 2 * 2 - 1 - 2);
  assert.equal(pairUnits(rs, "off", "on-hooks", { taughtOnly: false }).length, 12 * 2 * 2 - 1);
  find(rs, "on-hooks", "fam2", 2, 1).corrected = true;
  const [g] = analyze(rs, { resamples: 2000 });
  assert.equal(g.hypotheses.map((h) => h.id).join(","), "H1,H4");
  for (const h of g.hypotheses) assert.ok(h.pHolm < 0.05, JSON.stringify(h, null, 1));
  for (const h of g.hypotheses) assert.equal(h.exploratory, true, "12 families is below the pre-registered 40");
  assert.ok(g.conditions["on-hooks"].captureRate > 0 && g.conditions.off.captureRate === 0);
  assert.equal(g.conditions.off.excluded, 1);
  const md = renderMarkdown([g]);
  assert.match(md, /### H4: on-hooks < min\(native, static-rules\)/);
  assert.match(md, /sign-flip p [0-9.]+, exact/);
  assert.match(md, /EXPLORATORY \(12 families/);
});

test("analysis: H4 needs evidence that the host's own memory ran in native", () => {
  const strip = records().map(({ hostMemory, ...r }) => r);
  const [none] = analyze(strip, { resamples: 300 });
  const h4 = none.hypotheses.find((h) => h.id === "H4");
  assert.equal(h4.p, null);
  assert.match(h4.note, /no evidence that the host's own memory ran/);
  assert.notEqual(none.hypotheses.find((h) => h.id === "H1").p, null, "H1 doesn't depend on it");
  let i = 0;
  const rare = records().map((r) => (r.condition === "native" ? { ...r, hostMemory: i++ % 5 === 0 } : r));
  const [few] = analyze(rare, { resamples: 300 });
  assert.match(few.hypotheses.find((h) => h.id === "H4").note, /seen in only 2\d% of native's sessions/);
  assert.match(renderMarkdown([few]), /not tested: the host's own memory was seen/);
});

test("analysis: duplicates throw; the family boundary; H1 the wrong way; Holm counts the pre-registered tests", () => {
  const rs = records();
  assert.throws(() => pairUnits([...rs, { ...find(rs, "off", "fam0", 1, 2) }], "off", "on-hooks"), /duplicate record/);
  const keep = (n) => rs.filter((r) => Number(r.family.slice(3)) < n);
  const [four] = analyze(keep(4), { resamples: 200 });
  assert.equal(four.hypotheses[0].p, null);
  assert.match(four.hypotheses[0].note, /at least 5/);
  const [fiveG] = analyze(keep(5), { resamples: 200 });
  assert.notEqual(fiveG.hypotheses[0].p, null);
  // ad worse than nothing: H1 is not confirmed, however clear the difference.
  const flipped = rs.map((r) => (r.condition === "off" ? { ...r, condition: "on-hooks" } : r.condition === "on-hooks" ? { ...r, condition: "off" } : r));
  assert.ok(analyze(flipped, { resamples: 500 })[0].hypotheses[0].p > 0.5);
  // Holm: an untestable hypothesis still counts, and a pre-registered m larger than the analysed set too.
  const onlyH1 = rs.filter((r) => r.condition === "off" || r.condition === "on-hooks");
  const [a] = analyze(onlyH1, { resamples: 200 });
  const [b] = analyze(onlyH1, { resamples: 200, holmM: 8 });
  assert.equal(a.hypotheses[1].p, null);
  assert.ok(Math.abs(a.hypotheses[0].pHolm - Math.min(1, 2 * a.hypotheses[0].p)) < 1e-12, "m = 2: H4 untestable still counts");
  assert.ok(Math.abs(b.hypotheses[0].pHolm - Math.min(1, 8 * b.hypotheses[0].p)) < 1e-12);
  assert.throws(() => analyze(rs, { holmM: 1 }), /smaller than/);
});

test("analysis: H4 is not confirmed when ad only beats one baseline", () => {
  // static-rules does exactly as well as ad: no difference to find.
  const base = records();
  const ad = new Map(base.filter((r) => r.condition === "on-hooks").map((r) => [`${r.family}/${r.seed}/${r.session}`, r.violated]));
  const rs = base.map((r) => (r.condition === "static-rules" ? { ...r, violated: ad.get(`${r.family}/${r.seed}/${r.session}`) } : r));
  const [g] = analyze(rs, { resamples: 2000 });
  assert.ok(g.hypotheses.find((h) => h.id === "H1").p < 0.05, "ad still beats no memory");
  const h4 = g.hypotheses.find((h) => h.id === "H4");
  assert.ok(h4.p > 0.05, JSON.stringify(h4.comparisons.map((c) => c.primary)));
});

test("the analysis refuses a --mock run unless asked", async () => {
  const { readResults } = await import("../analysis/analyze.mjs");
  const dir = path.join(TMP, "mockrun");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ mock: true }));
  fs.writeFileSync(path.join(dir, "episodes.jsonl"), JSON.stringify({ session: 1 }) + "\n");
  assert.throws(() => readResults([dir]), /proves plumbing/);
  assert.equal(readResults([dir], { allowMock: true }).length, 1);
});

test("a changed test archive fails its hash check", () => {
  const dir = path.join(TMP, "archive");
  fs.mkdirSync(path.join(dir, "fam1"), { recursive: true });
  fs.writeFileSync(path.join(dir, "fam1", "family.json"), '{"id":"fam1"}\n');
  fs.writeFileSync(path.join(dir, "README"), "test split\n");
  const file = path.join(TMP, "test.sha256");
  const h = writeHashFile(dir, file);
  assert.match(fs.readFileSync(file, "utf8"), new RegExp(`^${h}  test  \\(2 files\\)`));
  assert.equal(verify(dir, file).ok, true);
  fs.writeFileSync(path.join(dir, "fam1", "family.json"), '{"id":"fam1" }\n');
  assert.equal(verify(dir, file).ok, false);
  fs.writeFileSync(path.join(dir, "fam1", "family.json"), '{"id":"fam1"}\n');
  fs.renameSync(path.join(dir, "README"), path.join(dir, "README.md"));
  assert.equal(verify(dir, file).ok, false, "a renamed file changes the hash");
  assert.throws(() => hashTree(path.join(TMP, "nothing-here-" + Date.now())), /ENOENT/);
});

test("the plan: same phrasing for every condition and model of a seed; interleaved, seeded order", () => {
  const split = loadSplit("dev");
  const plan = buildPlan(split, { conditions: ["off", "on-hooks"], models: ["m1", "m2"], seeds: [1, 2], runSeed: 5 });
  assert.equal(plan.length, 12 * 2 * 2 * 2);
  for (const e of plan) assert.equal(e.phrasing.id, pickPhrasing(split.find((s) => s.family.id === e.familyId).phrasings, e.familyId, e.seed).id);
  assert.deepEqual(buildPlan(split, { conditions: ["off", "on-hooks"], models: ["m1", "m2"], seeds: [1, 2], runSeed: 5 }).map((e) => e.id), plan.map((e) => e.id));
  const firstHalf = plan.slice(0, plan.length / 2).map((e) => e.condition);
  assert.ok(firstHalf.includes("off") && firstHalf.includes("on-hooks"), "conditions interleave");
  assert.throws(() => buildPlan(split, { conditions: ["nope"], models: ["m"], seeds: [1] }), /unknown condition/);
});

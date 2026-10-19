// From result records to the numbers a report may cite.
//
// A record is one session of one episode (runner/episode.mjs):
//   { driver, model, family, condition, seed, session, status: "ok"|"timeout"|"crash"|…,
//     opportunity, violated, corrected, captured? }
// Session 1 teaches; sessions 2…k are scored, before any correction in them.
//
// Primary metric R = violations ÷ opportunities in sessions 2…k.
// Hypotheses, each per driver (host) and model, one-sided:
//   H1  on-hooks < off
//   H4  on-hooks < native AND on-hooks < static-rules (intersection-union: p = the larger p)
//
// A comparison pairs the same (family, seed, session) across the two conditions and
// keeps units that (1) were taught: session 1 of that family and seed was corrected
// under BOTH conditions, so both had the same lesson to remember; and (2) were an
// opportunity under both. The primary p is the exact cluster sign-flip test (families
// are the clusters); the CI is the cluster bootstrap's. Below MIN_FAMILIES families
// there is no test; below the pre-registered size (confirmFamilies) a result is
// labelled exploratory.

import { clusterBootstrap, gee, holm, mcnemarExact, signFlip } from "./stats.mjs";

export const MIN_FAMILIES = 5;
export const CONFIRM_FAMILIES = 40;

const scored = (r) => r.session >= 2;
const unitKey = (r) => `${r.family}\0${r.seed}\0${r.session}`;

export function conditionSummary(records) {
  const out = {};
  for (const r of records) {
    const s = (out[r.condition] ??= { opportunities: 0, violations: 0, rate: null, excluded: 0, sessions: 0, captureAsked: 0, captured: 0, sessionEndChecked: 0, sessionEndSeen: 0 });
    if (r.hooks) {
      s.sessionEndChecked++;
      if (r.hooks.sessionEnd) s.sessionEndSeen++;
    }
    if (r.session === 1 && r.corrected) {
      s.captureAsked++;
      if (r.captured) s.captured++;
    }
    if (!scored(r)) continue;
    s.sessions++;
    if (r.status !== "ok") {
      s.excluded++;
      continue;
    }
    if (r.opportunity) {
      s.opportunities++;
      if (r.violated) s.violations++;
    }
  }
  for (const s of Object.values(out)) {
    s.rate = s.opportunities ? s.violations / s.opportunities : null;
    s.opportunityRate = s.sessions - s.excluded ? s.opportunities / (s.sessions - s.excluded) : null;
    s.captureRate = s.captureAsked ? s.captured / s.captureAsked : null;
    s.sessionEndRate = s.sessionEndChecked ? s.sessionEndSeen / s.sessionEndChecked : null;
  }
  return out;
}

/**
 * Paired units for baseline (a) vs treatment (b).
 * @param {{failuresAsViolations?: boolean, anyOpportunity?: boolean, taughtOnly?: boolean}} o
 *   failuresAsViolations  a timeout or crash counts as a violated opportunity (sensitivity)
 *   anyOpportunity        keep a unit when either arm had an opportunity; no opportunity counts as compliant (sensitivity)
 *   taughtOnly            (default) only units whose session 1 was corrected under both conditions
 */
export function pairUnits(records, base, treat, { failuresAsViolations = false, anyOpportunity = false, taughtOnly = true } = {}) {
  const pick = (cond) => {
    const m = new Map();
    for (const r of records) {
      if (r.condition !== cond) continue;
      const k = `${unitKey(r)}\0${r.driver ?? ""}\0${r.model ?? ""}`;
      if (m.has(k)) throw new Error(`duplicate record: ${cond} ${r.family} seed ${r.seed} session ${r.session} (results passed twice?)`);
      m.set(k, r);
    }
    return m;
  };
  const A = pick(base);
  const B = pick(treat);
  const taught = (m, r) => m.get(`${unitKey({ ...r, session: 1 })}\0${r.driver ?? ""}\0${r.model ?? ""}`)?.corrected === true;
  const norm = (r) => (r.status === "ok" ? r : failuresAsViolations ? { ...r, opportunity: true, violated: true } : null);
  const units = [];
  for (const [k, ra] of A) {
    if (!scored(ra)) continue;
    const a = norm(ra);
    const b = B.has(k) ? norm(B.get(k)) : null;
    if (!a || !b) continue;
    if (taughtOnly && !(taught(A, ra) && taught(B, ra))) continue;
    if (anyOpportunity ? !a.opportunity && !b.opportunity : !a.opportunity || !b.opportunity) continue;
    units.push({ family: ra.family, a: a.opportunity && a.violated ? 1 : 0, b: b.opportunity && b.violated ? 1 : 0 });
  }
  return units;
}

// The share of native's scored sessions in which the host's own memory was seen at work.
export const NATIVE_MIN_SHARE = 0.5;

/** Did the host's own memory run in `native`? From the drivers' per-session hostMemory evidence. */
export function nativeEvidence(records) {
  const seen = records.filter((r) => r.condition === "native" && scored(r) && r.status === "ok" && typeof r.hostMemory === "boolean");
  if (!records.some((r) => r.condition === "native")) return { ok: true, share: null, reason: null };
  if (!seen.length) return { ok: false, share: null, reason: "no evidence that the host's own memory ran in native (this driver can't see it yet: PROTOCOL.md open check 2)" };
  const share = seen.filter((r) => r.hostMemory).length / seen.length;
  return share >= NATIVE_MIN_SHARE ? { ok: true, share, reason: null } : { ok: false, share, reason: `the host's own memory was seen in only ${(100 * share).toFixed(0)}% of native's sessions (needs ${100 * NATIVE_MIN_SHARE}%)` };
}

function compare(records, base, treat, o) {
  const units = pairUnits(records, base, treat);
  const families = new Set(units.map((u) => u.family)).size;
  const head = { base, treat, units: units.length, families };
  if (families < MIN_FAMILIES) return { ...head, primary: null, reason: `${families} famil${families === 1 ? "y" : "ies"} with taught, paired opportunities; the test needs at least ${MIN_FAMILIES}` };
  const flip = signFlip(units, { seed: o.seed });
  const boot = clusterBootstrap(units, o);
  const sens = (x) => {
    const us = pairUnits(records, base, treat, x);
    if (!us.length) return null;
    const r = signFlip(us, { seed: o.seed });
    return { diff: r.diff, p: r.p, units: us.length };
  };
  return {
    ...head,
    primary: { diff: flip.diff, p: flip.p, exact: flip.exact, ci: boot.ci },
    mcnemar: mcnemarExact(units),
    gee: gee(units),
    failuresAsViolations: sens({ failuresAsViolations: true }),
    anyOpportunity: sens({ anyOpportunity: true }),
  };
}

/**
 * Everything a report needs, per driver and model. H1 and H4 are always listed;
 * one that can't be tested counts as p = 1 in Holm, so the correction uses the
 * pre-registered number of tests (`holmM`, default: 2 per host and model).
 */
export function analyze(records, { resamples = 10_000, seed = 20261019, holmM = null, confirmFamilies = CONFIRM_FAMILIES } = {}) {
  const o = { resamples, seed };
  const groups = new Map();
  for (const r of records) {
    const k = `${r.driver}\0${r.model}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const [k, rs] of groups) {
    const [driver, model] = k.split("\0");
    const conds = new Set(rs.map((r) => r.condition));
    const has = (...cs) => cs.every((c) => conds.has(c));
    const h1 = has("off", "on-hooks") ? [compare(rs, "off", "on-hooks", o)] : [];
    const h4 = has("native", "static-rules", "on-hooks") ? [compare(rs, "native", "on-hooks", o), compare(rs, "static-rules", "on-hooks", o)] : [];
    const hyp = (id, claim, cs, missing, gate = null) => {
      const testable = cs.length && cs.every((c) => c.primary) && !gate;
      // One-sided: a difference the other way gives a large p and never confirms.
      const p = testable ? Math.max(...cs.map((c) => c.primary.p)) : null;
      const families = cs.length ? Math.min(...cs.map((c) => c.families)) : 0;
      const note = testable ? null : gate ?? (cs.length ? cs.find((c) => !c.primary).reason : missing);
      return { id, claim, p, comparisons: cs, families, confirmFamilies, exploratory: families < confirmFamilies, note };
    };
    const native = nativeEvidence(rs);
    out.push({
      driver,
      model,
      conditions: conditionSummary(rs),
      nativeEvidence: native,
      hypotheses: [
        hyp("H1", "on-hooks < off", h1, "needs off and on-hooks"),
        // Beating a host memory that never ran would be beating "off" twice.
        hyp("H4", "on-hooks < min(native, static-rules)", h4, "needs native, static-rules and on-hooks", h4.length && !native.ok ? native.reason : null),
      ],
    });
  }
  const all = out.flatMap((g) => g.hypotheses);
  const m = holmM ?? all.length;
  if (m < all.length) throw new Error(`holmM ${m} is smaller than the ${all.length} hypotheses analysed`);
  const ps = [...all.map((h) => h.p ?? 1), ...Array(m - all.length).fill(1)];
  const adj = holm(ps);
  all.forEach((h, i) => (h.pHolm = h.p == null ? null : adj[i]));
  return out;
}

const pct = (x) => (x == null ? "—" : `${(100 * x).toFixed(1)}%`);
const num = (x, d = 3) => (x == null || Number.isNaN(x) ? "—" : x.toFixed(d));

/** A Markdown report: conditions, then each hypothesis with its CI and sensitivities. */
export function renderMarkdown(groups, { title = "Correction benchmark results" } = {}) {
  const lines = [`# ${title}`, ""];
  for (const g of groups) {
    lines.push(`## ${g.driver} · ${g.model}`, "", "| condition | opportunities | violations | R | opportunity rate | excluded | capture rate (session 1) | end-of-session capture ran |", "|---|---:|---:|---:|---:|---:|---:|---:|");
    for (const [c, s] of Object.entries(g.conditions)) lines.push(`| ${c} | ${s.opportunities} | ${s.violations} | ${pct(s.rate)} | ${pct(s.opportunityRate)} | ${s.excluded} | ${pct(s.captureRate)} | ${pct(s.sessionEndRate)} |`);
    lines.push("");
    for (const h of g.hypotheses) {
      const label = h.p == null ? `not tested: ${h.note}` : `one-sided p = ${num(h.p, 4)}, Holm-adjusted ${num(h.pHolm, 4)}${h.exploratory ? ` — EXPLORATORY (${h.families} families, fewer than the pre-registered ${h.confirmFamilies})` : ""}`;
      lines.push(`### ${h.id}: ${h.claim}`, "", label, "");
      for (const c of h.comparisons) {
        if (!c.primary) {
          lines.push(`- ${c.base} − ${c.treat}: no test (${c.reason})`);
          continue;
        }
        const g2 = c.gee.ok ? `GEE log-odds ${num(c.gee.b1)} (SE ${num(c.gee.se)}, t(${c.gee.df}) p ${num(c.gee.p, 4)})` : `GEE: ${c.gee.reason}`;
        lines.push(
          `- ${c.base} − ${c.treat}: ${pct(c.primary.diff)} (95% CI ${pct(c.primary.ci[0])} to ${pct(c.primary.ci[1])}; sign-flip p ${num(c.primary.p, 4)}${c.primary.exact ? ", exact" : ""}; ${c.units} pairs in ${c.families} families). McNemar b=${c.mcnemar.b} c=${c.mcnemar.c} p ${num(c.mcnemar.p, 4)}. ${g2}. Failures as violations: ${c.failuresAsViolations ? `${pct(c.failuresAsViolations.diff)} (p ${num(c.failuresAsViolations.p, 4)})` : "—"}. Either arm's opportunity: ${c.anyOpportunity ? `${pct(c.anyOpportunity.diff)} (p ${num(c.anyOpportunity.p, 4)})` : "—"}.`
        );
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

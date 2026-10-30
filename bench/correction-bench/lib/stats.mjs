// Statistics for the benchmark. Dependency-free and seeded, so every number in
// a report can be recomputed from the published results.
//
// A "unit" is one opportunity seen under two conditions with everything else
// equal (family, model, seed, session): { family, a: 0|1, b: 0|1 } where 1 is a
// violation. Families are the clusters: sessions of one family share a
// convention, so they are not independent.
//
//   clusterBootstrap(units)  primary: the paired difference in violation rates
//                            (a − b), 95% percentile CI and a two-sided p, resampling FAMILIES
//   unitBootstrap(units)     the same, resampling units (ignores clustering; for comparison)
//   mcnemarExact(units)      sensitivity: exact McNemar on discordant pairs
//   gee(units)               sensitivity: logistic GEE, exchangeable within family, robust SE
//   holm(ps)                 Holm adjustment across hypotheses, models and hosts
//   powerCheck(units, …)     resample pilot families to n families; share of runs with p < alpha

/** A seeded PRNG (mulberry32): the same seed gives the same numbers everywhere. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

/** Violation-rate difference a − b over units. */
export const rateDiff = (units) => mean(units.map((u) => u.a)) - mean(units.map((u) => u.b));

function quantile(sorted, q) {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function summarize(diff, draws) {
  draws.sort((x, y) => x - y);
  // (k + 1) / (B + 1): a bootstrap p is never exactly 0.
  const B = draws.length;
  const below = (draws.filter((d) => d <= 0).length + 1) / (B + 1);
  const above = (draws.filter((d) => d >= 0).length + 1) / (B + 1);
  return { diff, ci: [quantile(draws, 0.025), quantile(draws, 0.975)], p: Math.min(1, 2 * Math.min(below, above)), resamples: B };
}

export function groupBy(units, key = (u) => u.family) {
  const m = new Map();
  for (const u of units) {
    const k = key(u);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(u);
  }
  return [...m.values()];
}

/** Primary test: resample families with replacement, keep each family's units together. */
export function clusterBootstrap(units, { resamples = 10_000, seed = 20261019 } = {}) {
  const clusters = groupBy(units);
  const rand = rng(seed);
  const draws = [];
  for (let r = 0; r < resamples; r++) {
    let sa = 0;
    let sb = 0;
    let n = 0;
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[Math.floor(rand() * clusters.length)];
      for (const u of c) {
        sa += u.a;
        sb += u.b;
        n++;
      }
    }
    draws.push((sa - sb) / n);
  }
  return summarize(rateDiff(units), draws);
}

/**
 * The primary test: cluster sign-flip randomization. Under "the condition makes
 * no difference" each family's summed paired difference is as likely to have
 * either sign, so the statistic is compared with every sign pattern (exact up to
 * `exactMax` families, Monte Carlo above). Exact at any number of families,
 * unlike a bootstrap, which is anti-conservative with few clusters.
 * → { diff, p (one-sided, a > b), pTwoSided, exact, families }
 */
export function signFlip(units, { exactMax = 20, draws = 100_000, seed = 20261019 } = {}) {
  const d = groupBy(units).map((us) => us.reduce((s, u) => s + u.a - u.b, 0));
  const N = units.length;
  const T = d.reduce((s, x) => s + x, 0);
  const G = d.length;
  const eps = 1e-9;
  let ge = 0;
  let absGe = 0;
  let total = 0;
  const count = (t) => {
    total++;
    if (t >= T - eps) ge++;
    if (Math.abs(t) >= Math.abs(T) - eps) absGe++;
  };
  const exact = G <= exactMax;
  if (exact) {
    for (let mask = 0; mask < 2 ** G; mask++) {
      let t = 0;
      for (let i = 0; i < G; i++) t += mask & (1 << i) ? -d[i] : d[i];
      count(t);
    }
  } else {
    const rand = rng(seed);
    count(T); // the observed pattern is one of the draws: (k + 1) / (B + 1)
    for (let r = 0; r < draws; r++) {
      let t = 0;
      for (let i = 0; i < G; i++) t += rand() < 0.5 ? -d[i] : d[i];
      count(t);
    }
  }
  return { diff: N ? T / N : NaN, p: ge / total, pTwoSided: absGe / total, exact, families: G };
}

/** Resample single units: what the CI would be if families didn't matter. */
export function unitBootstrap(units, { resamples = 10_000, seed = 20261019 } = {}) {
  const rand = rng(seed);
  const draws = [];
  for (let r = 0; r < resamples; r++) {
    let d = 0;
    for (let i = 0; i < units.length; i++) {
      const u = units[Math.floor(rand() * units.length)];
      d += u.a - u.b;
    }
    draws.push(d / units.length);
  }
  return summarize(rateDiff(units), draws);
}

function logChoose(n, k) {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

/** Exact McNemar: b = a violated and b didn't, c = the reverse; two-sided binomial p. */
export function mcnemarExact(units) {
  const b = units.filter((u) => u.a === 1 && u.b === 0).length;
  const c = units.filter((u) => u.a === 0 && u.b === 1).length;
  const n = b + c;
  if (!n) return { b, c, p: 1 };
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return { b, c, p: Math.min(1, 2 * tail) };
}

// ln Γ (Lanczos), the regularized incomplete beta (continued fraction), Student's t.
function lnGamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const t = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let s = 1.000000000190015;
  for (const k of c) s += k / ++y;
  return -t + Math.log((2.5066282746310005 * s) / x);
}
function betacf(a, b, x) {
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-14) break;
  }
  return h;
}
function betaInc(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
/** Student's t CDF with `df` degrees of freedom. */
export function tCdf(t, df) {
  const tail = 0.5 * betaInc(df / 2, 0.5, df / (df + t * t));
  return t >= 0 ? 1 - tail : tail;
}

/** The standard normal CDF (Abramowitz–Stegun 7.1.26 erf, error < 1.5e-7). */
export function normCdf(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

function invert(m) {
  const n = m.length;
  const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-12) throw new Error("singular matrix");
    [a[c], a[p]] = [a[p], a[c]];
    const d = a[c][c];
    for (let j = 0; j < 2 * n; j++) a[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c];
      if (f) for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j];
    }
  }
  return a.map((row) => row.slice(n));
}
const mul = (A, B) => A.map((row) => B[0].map((_, j) => row.reduce((s, x, k) => s + x * B[k][j], 0)));
const T = (A) => A[0].map((_, j) => A.map((row) => row[j]));
const add = (A, B) => A.map((row, i) => row.map((x, j) => x + B[i][j]));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/**
 * Logistic GEE, exchangeable working correlation within family, robust (sandwich) SE.
 * Model: logit P(violation) = b0 + b1 · [condition a]. → { ok, b1, se, z, p, alpha } or { ok: false, reason }.
 */
export function gee(units, { maxIter = 50, tol = 1e-8 } = {}) {
  const ya = units.map((u) => u.a);
  const yb = units.map((u) => u.b);
  for (const [name, ys] of [["a", ya], ["b", yb]]) {
    const r = mean(ys);
    if (r === 0 || r === 1) return { ok: false, reason: `condition ${name} has a violation rate of ${r}: the model has no finite estimate` };
  }
  const clusters = groupBy(units).map((us) => ({
    X: us.flatMap(() => [[1, 1], [1, 0]]),
    y: us.flatMap((u) => [u.a, u.b]),
  }));
  const N = clusters.reduce((s, c) => s + c.y.length, 0);
  const p = 2;
  let beta = [Math.log(mean(yb) / (1 - mean(yb))), 0];
  beta[1] = Math.log(mean(ya) / (1 - mean(ya))) - beta[0];
  let alpha = 0;
  const pieces = () =>
    clusters.map((c) => {
      const mu = c.X.map((x) => sigmoid(x[0] * beta[0] + x[1] * beta[1]));
      const A = mu.map((m) => m * (1 - m));
      return { ...c, mu, A };
    });
  let converged = false;
  for (let it = 0; it < maxIter; it++) {
    const cs = pieces();
    // Moment estimates of the scale and the exchangeable correlation.
    let ss = 0;
    let cross = 0;
    let pairs = 0;
    for (const c of cs) {
      const r = c.y.map((y, j) => (y - c.mu[j]) / Math.sqrt(c.A[j]));
      ss += r.reduce((s, x) => s + x * x, 0);
      for (let j = 0; j < r.length; j++) for (let k = j + 1; k < r.length; k++) cross += r[j] * r[k];
      pairs += (r.length * (r.length - 1)) / 2;
    }
    const phi = ss / Math.max(1, N - p);
    const nmax = Math.max(...cs.map((c) => c.y.length));
    alpha = pairs > p ? cross / (phi * (pairs - p)) : 0;
    alpha = Math.min(0.98, Math.max(nmax > 1 ? -1 / (nmax - 1) + 1e-6 : 0, alpha));
    let H = [[0, 0], [0, 0]];
    let U = [[0], [0]];
    for (const c of cs) {
      const n = c.y.length;
      const s = c.A.map(Math.sqrt);
      const V = Array.from({ length: n }, (_, j) => Array.from({ length: n }, (_, k) => phi * s[j] * s[k] * (j === k ? 1 : alpha)));
      const Vi = invert(V);
      const D = c.X.map((x, j) => [c.A[j] * x[0], c.A[j] * x[1]]);
      const DtVi = mul(T(D), Vi);
      H = add(H, mul(DtVi, D));
      U = add(U, mul(DtVi, c.y.map((y, j) => [y - c.mu[j]])));
      c.DtVi = DtVi;
    }
    const step = mul(invert(H), U);
    beta = [beta[0] + step[0][0], beta[1] + step[1][0]];
    if (Math.abs(step[0][0]) + Math.abs(step[1][0]) < tol) {
      converged = true;
      break;
    }
  }
  if (!converged || !beta.every(Number.isFinite)) return { ok: false, reason: "the GEE did not converge" };
  // Robust covariance with the Mancl–DeRouen small-sample correction:
  // H⁻¹ (Σ Dᵀ V⁻¹ (I − Hᵢ)⁻¹ e eᵀ (I − Hᵢ)⁻ᵀ V⁻¹ D) H⁻¹, Hᵢ = D H⁻¹ Dᵀ V⁻¹; t with G − 1 df.
  const cs = pieces().map((c) => {
    const n = c.y.length;
    const s = c.A.map(Math.sqrt);
    const Vi = invert(Array.from({ length: n }, (_, j) => Array.from({ length: n }, (_, k) => s[j] * s[k] * (j === k ? 1 : alpha))));
    const D = c.X.map((x, j) => [c.A[j] * x[0], c.A[j] * x[1]]);
    return { ...c, n, Vi, D, DtVi: mul(T(D), Vi) };
  });
  let H = [[0, 0], [0, 0]];
  for (const c of cs) H = add(H, mul(c.DtVi, c.D));
  const Hi = invert(H);
  let M = [[0, 0], [0, 0]];
  for (const c of cs) {
    const Hc = mul(mul(c.D, Hi), c.DtVi);
    const IminusH = Hc.map((row, j) => row.map((x, k) => (j === k ? 1 : 0) - x));
    let e = c.y.map((y, j) => [y - c.mu[j]]);
    try {
      e = mul(invert(IminusH), e);
    } catch {
      // a leverage of 1: keep the plain residuals for this family
    }
    const g = mul(c.DtVi, e);
    M = add(M, mul(g, T(g)));
  }
  const cov = mul(mul(Hi, M), Hi);
  const se = Math.sqrt(cov[1][1]);
  const t = beta[1] / se;
  const df = Math.max(1, cs.length - 1);
  return { ok: true, b1: beta[1], se, t, df, p: 2 * (1 - tCdf(Math.abs(t), df)), alpha };
}

/** Holm step-down adjusted p-values, in the input order. */
export function holm(ps) {
  const order = ps.map((p, i) => [p, i]).sort((x, y) => x[0] - y[0]);
  const out = new Array(ps.length);
  let running = 0;
  order.forEach(([p, i], rank) => {
    running = Math.max(running, Math.min(1, (ps.length - rank) * p));
    out[i] = running;
  });
  return out;
}

/**
 * Power for a hypothesis made of one or more comparisons that must ALL succeed
 * (H1: one; H4: two), at a pre-stated minimal effect, not the pilot's noisy one.
 *
 * Each simulated study resamples the pilot's families with their paired
 * outcomes (keeping within-family correlation and the pilot's discordance), then
 * moves the treated arm to a violation rate exactly `delta` below the baseline's
 * by flipping treated outcomes at random (1 → 0 when the pilot's treated rate is
 * above that target, 0 → 1 when below). It succeeds when every comparison's
 * one-sided sign-flip p is below `alpha` (pass the Holm-corrected worst case:
 * 0.05 ÷ the pre-registered number of tests).
 *
 * @param {Array<Array<{family, a, b}>>} comparisons  the pilot's paired units per comparison
 * → [{ families, power, sims }] per size
 */
export function powerAt(comparisons, { delta, sizes = [20, 40, 60], alpha = 0.05, sims = 500, draws = 999, seed = 7 }) {
  if (!(delta > 0)) throw new Error("powerAt: delta, the smallest effect worth finding, must be > 0");
  const rand = rng(seed);
  const famIds = [...new Set(comparisons.flatMap((us) => us.map((u) => u.family)))];
  const byFam = comparisons.map((us) => {
    const m = new Map();
    for (const u of us) {
      if (!m.has(u.family)) m.set(u.family, []);
      m.get(u.family).push(u);
    }
    const ra = mean(us.map((u) => u.a));
    const rb = mean(us.map((u) => u.b));
    const target = Math.max(0, ra - delta);
    // down: P(1 → 0); up: P(0 → 1)
    return { m, down: rb > target ? (rb - target) / rb : 0, up: rb < target ? (target - rb) / (1 - rb) : 0 };
  });
  const move = (b, { down, up }) => (b === 1 ? (rand() < down ? 0 : 1) : rand() < up ? 1 : 0);
  return sizes.map((families) => {
    let hits = 0;
    for (let s = 0; s < sims; s++) {
      const pick = Array.from({ length: families }, () => famIds[Math.floor(rand() * famIds.length)]);
      const ok = byFam.every((c) => {
        const sample = [];
        pick.forEach((f, i) => {
          for (const u of c.m.get(f) ?? []) sample.push({ family: `sim${i}`, a: u.a, b: move(u.b, c) });
        });
        return sample.length > 0 && signFlip(sample, { exactMax: 0, draws, seed: Math.floor(rand() * 2 ** 31) }).p < alpha;
      });
      if (ok) hits++;
    }
    return { families, power: hits / sims, sims };
  });
}

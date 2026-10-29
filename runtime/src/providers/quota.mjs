// Limits as last seen (P4.3): ~/.agent-daemon/quota/observations.json, under the lock
// "quota-store", re-read before every write. Nothing is polled: observations come from the
// ChatGPT engine's rate-limit reads and updates, the gateway's headers and errors, and
// OpenRouter's /key after a 429. Unknown stays unknown (D12).
//
//   mergeRateLimits(prev, next)                 a partial ChatGPT update keeps the other windows
//   fromChatgpt(snapshot, { accountId, source, now })      → [QuotaObservation]
//   fromHeaders(headers, { accountId, provider, status, now }) → [QuotaObservation]
//   fromOpenRouterKey(json, { accountId, now })  → { observations, freeDaily }
//   recordObservations(list, { root, waitMs })   readStore({ root })
//   stateAt(observation, now)  limitState(accountId, { now, root })  "ok" | "near" | "limited" | "exhausted" | "unknown"
//   benchProvider(provider, { until, reason, accountId }, { root, now })   benchedUntil(provider, { now, root })
//   noticesShown({ root })   markNoticed(keys, { root, now })      the limit notices already shown (P4.6)
//
// Reading rule: past its reset, or older than 6 h with no reset → unknown, never ok.

import fs from "node:fs";
import path from "node:path";
import { adRoot } from "../ad-root.mjs";
import { acquireLockWithin } from "../lock.mjs";
import { writeJsonAtomicSync } from "../atomic-json.mjs";

const STALE_MS = 6 * 60 * 60_000;
const NEAR = 90;
const BENCH_DEFAULT = { quotaExhausted: 24 * 60 * 60_000, rateLimit: 10 * 60_000 };
const SEVERITY = { exhausted: 4, limited: 3, near: 2, ok: 1, unknown: 0 };

export const quotaDir = (root = adRoot()) => path.join(root, "quota");
const fileOf = (root) => path.join(quotaDir(root), "observations.json");
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const num = (v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const nextUtcMidnight = (now) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

function observation(o, now) {
  return { v: 1, accountId: o.accountId, provider: o.provider ?? null, scope: o.scope ?? "account", model: o.model ?? null, kind: o.kind ?? null, window: o.window ?? "unknown", usedPercent: o.usedPercent ?? null, used: o.used ?? null, limit: o.limit ?? null, remaining: o.remaining ?? null, resetsAt: o.resetsAt ?? null, state: o.state ?? "unknown", source: o.source, observedAt: iso(now), confidence: o.confidence ?? "reported" };
}

const WINDOWS = new Set(["primary", "secondary", "credits"]);
const own = (s) => {
  if (!s) return null;
  const { byLimit: _all, ...rest } = s;
  return rest;
};
/**
 * A partial account/rateLimits/updated: the windows it doesn't carry stay, every flag it
 * carries is taken as it is (a null clears "limit reached"). Each limit id keeps its own
 * snapshot (byLimit); the top level is the one updated last.
 */
export function mergeRateLimits(prev, next) {
  if (!next) return prev ?? null;
  const id = next.limitId ?? null;
  const all = { ...(prev?.byLimit ?? (prev ? { [prev.limitId ?? null]: own(prev) } : {})) };
  const base = all[id] ?? null;
  const merged = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(own(next))) {
    if (v === undefined) continue;
    if (WINDOWS.has(k) && v === null) continue; // a window it doesn't report
    merged[k] = v;
  }
  all[id] = merged;
  return Object.keys(all).length > 1 ? { ...merged, byLimit: all } : merged;
}

const windowOf = (mins) => {
  const m = Number(mins);
  if (!Number.isFinite(m)) return "unknown";
  if (m <= 60) return "minute";
  if (m <= 360) return "5h";
  if (m <= 1440) return "day";
  if (m <= 10080) return "week";
  if (m <= 44640) return "month";
  return "unknown";
};

/** A ChatGPT rate-limit snapshot (read or update) → one observation per window. */
export function fromChatgpt(snap, { accountId, source = "chatgpt:rateLimits/updated", now = Date.now() } = {}) {
  if (!snap || typeof snap !== "object") return [];
  if (snap.byLimit) return Object.values(snap.byLimit).flatMap((s) => fromChatgpt(s, { accountId, source, now }));
  const reached = Boolean(snap.rateLimitReachedType || snap.spendControlReached || snap.ordinaryUsageAllowed === false);
  const unknownAllowance = Object.hasOwn(snap, "ordinaryUsageAllowed") && snap.ordinaryUsageAllowed === null;
  const out = [];
  for (const w of [snap.primary, snap.secondary]) {
    if (!w) continue;
    const used = num(w.usedPercent);
    const resetsAt = num(w.resetsAt) !== null ? iso(num(w.resetsAt) * 1000) : null;
    let state = used === null ? "unknown" : used >= 100 ? "exhausted" : used >= NEAR ? "near" : "ok";
    if (reached) state = "exhausted";
    if (unknownAllowance) state = "unknown";
    out.push(observation({ accountId, provider: "chatgpt", scope: "account", kind: snap.limitId ?? null, window: windowOf(w.windowDurationMins), usedPercent: used, resetsAt, state, source }, now));
  }
  return out;
}

// "12s", "6m0s", "2m59.56s", "1h2m", "250ms" → ms.
function durationMs(s) {
  const str = String(s ?? "").trim();
  if (!str) return null;
  if (/^\d+(\.\d+)?$/.test(str)) return Number(str) * 1000;
  let ms = 0;
  let hit = false;
  for (const m of str.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    hit = true;
    const v = Number(m[1]);
    ms += m[2] === "h" ? v * 3_600_000 : m[2] === "m" ? v * 60_000 : m[2] === "s" ? v * 1000 : v;
  }
  return hit ? Math.round(ms) : null;
}
// A reset header: epoch ms, epoch s, or a delta.
function resetAt(v, now) {
  const n = num(v);
  if (n !== null && n > 1e12) return n;
  if (n !== null && n > 1e9) return n * 1000;
  const d = durationMs(v);
  return d === null ? null : now + d;
}
const stateOf = (remaining, limit) => (remaining === 0 ? "limited" : remaining !== null && limit ? ((limit - remaining) / limit) * 100 >= NEAR ? "near" : "ok" : remaining !== null ? "ok" : "unknown");

/** The gateway's allowlisted headers → observations (OpenAI/Groq per kind, OpenRouter plain, Retry-After). */
export function fromHeaders(headers = {}, { accountId, provider = null, status = null, now = Date.now() } = {}) {
  const h = Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const out = [];
  for (const kind of ["requests", "tokens"]) {
    const limit = num(h[`x-ratelimit-limit-${kind}`]);
    const remaining = num(h[`x-ratelimit-remaining-${kind}`]);
    if (limit === null && remaining === null) continue;
    // Groq's request limit is per day; tokens (and OpenAI's both) per minute.
    const window = kind === "requests" && provider === "groq" ? "day" : "minute";
    out.push(observation({ accountId, provider, scope: "key", kind, window, limit, remaining, used: limit !== null && remaining !== null ? limit - remaining : null, usedPercent: limit ? Math.round(((limit - remaining) / limit) * 100) : null, resetsAt: iso(resetAt(h[`x-ratelimit-reset-${kind}`], now)), state: stateOf(remaining, limit), source: "gateway:headers" }, now));
  }
  const limit = num(h["x-ratelimit-limit"]);
  const remaining = num(h["x-ratelimit-remaining"]);
  if (limit !== null || remaining !== null) out.push(observation({ accountId, provider, scope: "key", window: "unknown", limit, remaining, used: limit !== null && remaining !== null ? limit - remaining : null, usedPercent: limit ? Math.round(((limit - remaining) / limit) * 100) : null, resetsAt: iso(resetAt(h["x-ratelimit-reset"], now)), state: stateOf(remaining, limit), source: "gateway:headers" }, now));
  const ra = h["retry-after"];
  if ((status === 429 || status === 503) && ra !== undefined) {
    const s = num(ra);
    const at = s !== null ? now + s * 1000 : Date.parse(ra);
    if (Number.isFinite(at)) out.push(observation({ accountId, provider, scope: "key", window: "unknown", resetsAt: iso(at), state: "limited", source: "gateway:error" }, now));
  }
  return out;
}

/** OpenRouter's GET /api/v1/key (the key's own data, top level or under data). */
export function fromOpenRouterKey(json, { accountId, now = Date.now() } = {}) {
  const d = json?.data && typeof json.data === "object" ? json.data : (json ?? {});
  const observations = [];
  let freeDaily = null;
  const f = d.free_model_daily_requests;
  if (f && typeof f === "object") {
    freeDaily = { used: num(f.used), limit: num(f.limit), remaining: num(f.remaining) };
    const state = freeDaily.remaining === 0 ? "exhausted" : freeDaily.limit && freeDaily.used !== null && (freeDaily.used / freeDaily.limit) * 100 >= NEAR ? "near" : freeDaily.remaining !== null ? "ok" : "unknown";
    observations.push(observation({ accountId, provider: "openrouter", scope: "account", window: "day", ...freeDaily, usedPercent: freeDaily.limit ? Math.round(((freeDaily.used ?? 0) / freeDaily.limit) * 100) : null, resetsAt: iso(nextUtcMidnight(now)), state, source: "openrouter:/api/v1/key" }, now));
  }
  const credits = num(d.limit_remaining);
  if (credits !== null) observations.push(observation({ accountId, provider: "openrouter", scope: "account", window: "credits", remaining: credits, state: credits <= 0 ? "exhausted" : "ok", source: "openrouter:/api/v1/key" }, now));
  return { observations, freeDaily };
}

/** The state an observation can still be trusted for at `now`. */
export function stateAt(o, now = Date.now()) {
  if (!o) return "unknown";
  const reset = Date.parse(o.resetsAt ?? "");
  if (Number.isFinite(reset) && reset <= now) return "unknown";
  const seen = Date.parse(o.observedAt ?? "");
  const old = !Number.isFinite(seen) || now - seen > STALE_MS;
  if (!Number.isFinite(reset) && old) return "unknown";
  if (old && (o.state === "ok" || o.state === "near")) return "unknown";
  return o.state ?? "unknown";
}

const empty = () => ({ v: 1, revision: 0, observations: {}, bench: {} });
export function readStore({ root = adRoot() } = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(root), "utf8"));
    if (j && typeof j === "object" && j.observations && j.bench) return j;
  } catch {
    // missing or unreadable: a cache
  }
  return empty();
}

async function update(mutate, { root = adRoot(), waitMs = 5000 } = {}) {
  const dir = quotaDir(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const release = await acquireLockWithin("quota-store", { dir: path.join(dir, ".locks"), waitMs });
  try {
    const doc = readStore({ root });
    mutate(doc);
    doc.revision = (doc.revision ?? 0) + 1;
    writeJsonAtomicSync(fileOf(root), doc);
  } finally {
    release();
  }
}

const keyOf = (o) => `${o.accountId}|${o.scope}|${o.model ?? ""}|${o.window}|${o.kind ?? ""}`;
export function recordObservations(list, opts = {}) {
  if (!list?.length) return Promise.resolve();
  return update((doc) => {
    for (const o of list) if (o?.accountId) doc.observations[keyOf(o)] = o;
  }, opts);
}

/** The worst state among an account's trusted observations; unknown when none is trusted. */
export function limitState(accountId, { now = Date.now(), root = adRoot() } = {}) {
  let worst = "unknown";
  for (const o of Object.values(readStore({ root }).observations)) {
    if (o.accountId !== accountId) continue;
    const s = stateAt(o, now);
    if (SEVERITY[s] > SEVERITY[worst]) worst = s;
  }
  return worst;
}

/** What a bench is keyed by: the provider, or the account itself for your own endpoint. */
export const benchKey = (provider, accountId) => (provider === "custom" ? `custom:${accountId}` : provider);

/** No automatic move goes to any account of a provider until `until` (T3-H5). */
export function benchProvider(provider, { until = null, reason = "quotaExhausted", accountId = null } = {}, { root = adRoot(), now = Date.now(), waitMs } = {}) {
  const at = Date.parse(until ?? "") || now + (BENCH_DEFAULT[reason] ?? BENCH_DEFAULT.quotaExhausted);
  return update((doc) => {
    const prev = Date.parse(doc.bench[provider]?.until ?? "");
    if (Number.isFinite(prev) && prev >= at && prev > now) return; // a longer bench stays
    doc.bench[provider] = { until: iso(at), reason, accountId, at: iso(now) };
  }, { root, waitMs });
}

export function benchedUntil(provider, { now = Date.now(), root = adRoot() } = {}) {
  const b = readStore({ root }).bench[provider];
  const until = Date.parse(b?.until ?? "");
  return Number.isFinite(until) && until > now ? until : null;
}

// The limit notices already shown (P4.6), so a restart doesn't repeat one: key → when.
// Marks older than 8 days are dropped (every window resets within a week).
const NOTICE_KEEP_MS = 8 * 24 * 60 * 60_000;
export const noticesShown = ({ root = adRoot() } = {}) => readStore({ root }).notices ?? {};
export function markNoticed(keys, { root = adRoot(), now = Date.now(), waitMs } = {}) {
  if (!keys?.length) return Promise.resolve();
  return update((doc) => {
    const kept = Object.entries(doc.notices ?? {}).filter(([, at]) => now - Date.parse(at) < NOTICE_KEEP_MS);
    doc.notices = Object.fromEntries([...kept, ...keys.map((k) => [k, new Date(now).toISOString()])]);
  }, { root, waitMs });
}

// Limits as the user reads them (P4.6): one view per account over the QuotaStore (P4.3), with
// the words each surface shows. Pure: the store and the clock come in. Unknown stays unknown
// (D12): a window past its reset, or too old, is left out, never shown as 0% or ok.
//
//   quotaView(accountId, { store, now, provider }) → { accountId, state, windows, benchedUntil, observedAt, source }
//     windows: [{ window, kind, usedPercent, used, limit, remaining, resetsAt, state, confidence, label, short }]
//   mostConstrained(view) → a window or null
//   resetText(iso, now) → "05:30" | "Tue 05:30" | null      inText(iso, now) → "in 2h 10m" | null
//   limitNotices(view, { name, warnAt, seen, now }) → [{ key, text }]   the notices due, once each
//   windowName(w) → "the 5-hour limit", …
//   windowLong(w, now) → "5-hour 64% (resets 14:05, in 1h 10m)"   agoText(iso, now) → "1 min ago"
//   listCell(view, now) → ad auth list's limits cell (≤ 13 chars)   quotaJson(view) → --json's quota

import { benchKey, stateAt } from "./quota.mjs";

const SEVERITY = { exhausted: 4, limited: 3, near: 2, ok: 1, unknown: 0 };
const two = (n) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A reset time: "05:30" within 24 h, else "Tue 05:30" (local time); null when unknown. */
export function resetText(iso, now = Date.now()) {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return null;
  const d = new Date(at);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return at - now < 24 * 3_600_000 ? hm : `${DAYS[d.getDay()]} ${hm}`;
}

/** "in 2h 10m", "in 45m", "in 3d"; null when unknown or past. */
export function inText(iso, now = Date.now()) {
  const ms = Date.parse(iso ?? "") - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h >= 48) return `in ${Math.round(h / 24)}d`;
  return m % 60 ? `in ${h}h ${m % 60}m` : `in ${h}h`;
}

const pct = (n) => `${Math.round(n)}%`;
const money = (n) => `$${Number(n).toFixed(2)}`;
const SHORT_WINDOW = { "5h": "5h", week: "wk", day: "day", month: "mo", minute: "min" };

// A window's own words while it isn't used up: "5h 64%", "wk 22%", "today 41/50", "$3.20 left".
function ordinary(o) {
  if (o.window === "credits") return o.remaining !== null ? `${money(o.remaining)} left` : null;
  if (o.window === "day" && o.used !== null && o.limit) return `today ${o.used}/${o.limit}`;
  if (o.usedPercent === null) return null;
  const w = SHORT_WINDOW[o.window];
  if (o.window === "minute") return `${o.kind === "tokens" ? "tokens" : "requests"}/min ${pct(o.usedPercent)}`;
  return w ? `${w} ${pct(o.usedPercent)}` : `${pct(o.usedPercent)} used`;
}

/** What a window is called in a sentence. */
export function windowName(w) {
  switch (w.window) {
    case "5h":
      return "the 5-hour limit";
    case "week":
      return "the weekly limit";
    case "day":
      return w.used !== null && w.limit ? "today's free requests" : "the daily limit";
    case "month":
      return "the monthly limit";
    case "minute":
      return `the ${w.kind === "tokens" ? "token" : "request"} rate limit`;
    case "credits":
      return "the credits";
    default:
      return "the limit";
  }
}

function labels(o, now) {
  const at = resetText(o.resetsAt, now);
  if (o.state === "exhausted") return { label: at ? `used up until ${at}` : "used up", short: at ? `out → ${at}` : "out" };
  if (o.state === "limited") return { label: at ? `rate-limited until ${at}` : "rate-limited", short: "rate-limited" };
  const t = ordinary(o);
  return { label: t, short: t };
}

/**
 * One account's limits now. provider: for the bench (another window's limit on the provider).
 * Windows whose state is unknown at `now` are left out.
 */
export function quotaView(accountId, { store, now = Date.now(), provider = null } = {}) {
  const windows = [];
  let observedAt = null;
  let source = null;
  for (const o of Object.values(store?.observations ?? {})) {
    if (o?.accountId !== accountId) continue;
    const state = stateAt(o, now);
    if (state === "unknown") continue;
    const w = { window: o.window, kind: o.kind ?? null, usedPercent: o.usedPercent ?? null, used: o.used ?? null, limit: o.limit ?? null, remaining: o.remaining ?? null, resetsAt: o.resetsAt ?? null, state, confidence: o.confidence ?? "reported" };
    const l = labels(w, now);
    if (!l.label) continue;
    windows.push({ ...w, ...l });
    if (!observedAt || Date.parse(o.observedAt) > Date.parse(observedAt)) {
      observedAt = o.observedAt;
      source = o.source ?? null;
    }
  }
  const order = { "5h": 0, week: 1, day: 2, month: 3, credits: 4, minute: 5 };
  windows.sort((a, b) => (order[a.window] ?? 9) - (order[b.window] ?? 9));
  const b = provider ? store?.bench?.[benchKey(provider, accountId)] : null;
  const until = Date.parse(b?.until ?? "");
  const benchedUntil = Number.isFinite(until) && until > now ? new Date(until).toISOString() : null;
  const state = windows.reduce((s, w) => (SEVERITY[w.state] > SEVERITY[s] ? w.state : s), "unknown");
  return { accountId, state, windows, benchedUntil, observedAt, source };
}

/** The window closest to running out: the worst state, then the highest use. */
export function mostConstrained(view) {
  let best = null;
  for (const w of view?.windows ?? []) {
    if (!best || SEVERITY[w.state] > SEVERITY[best.state] || (SEVERITY[w.state] === SEVERITY[best.state] && (w.usedPercent ?? -1) > (best.usedPercent ?? -1))) best = w;
  }
  return best;
}

/**
 * The notices due now: a reported window that crossed warnAt (once), or ran out (once), per
 * window and reset period. seen: the keys already shown (kept in the QuotaStore). An inferred
 * observation never gives the warning. warnAt "off" (or null) → none.
 */
export function limitNotices(view, { name, warnAt = 90, seen = {}, now = Date.now() } = {}) {
  if (warnAt === "off" || warnAt === null || !view) return [];
  const out = [];
  for (const w of view.windows) {
    if (w.confidence !== "reported" || w.window === "credits") continue;
    const used = w.usedPercent ?? (w.used !== null && w.limit ? (w.used / w.limit) * 100 : null);
    const out100 = w.state === "exhausted";
    if (!out100 && (used === null || used < warnAt)) continue;
    const threshold = out100 ? 100 : warnAt;
    const key = `${view.accountId ?? ""}|${w.window}|${w.kind ?? ""}|${w.resetsAt ?? ""}|${threshold}`;
    if (seen[key]) continue;
    const at = resetText(w.resetsAt, now);
    const resets = at ? ` (resets ${at})` : "";
    const text = out100 ? `${name}: ${windowName(w)} ${w.window === "day" && w.limit ? "are" : "is"} used up${resets}.` : `${name}: ${Math.round(used)}% of ${windowName(w)} used${resets}.`;
    out.push({ key, text, threshold });
  }
  return out;
}

const LONG_WINDOW = { "5h": "5-hour", week: "weekly", day: "daily", month: "monthly" };
/**
 * A window in /status's and /usage's words: "5-hour 64% (resets 14:05, in 1h 10m)",
 * "free requests today: 41 of 50 (resets 05:30, in 7h)", "credits $3.20 left".
 */
export function windowLong(w, now = Date.now()) {
  const at = resetText(w.resetsAt, now);
  const when = at ? ` (resets ${at}${inText(w.resetsAt, now) ? `, ${inText(w.resetsAt, now)}` : ""})` : "";
  const name = w.window === "day" && w.used !== null && w.limit ? "free requests today" : LONG_WINDOW[w.window] ?? (w.window === "minute" ? `${w.kind === "tokens" ? "tokens" : "requests"} per minute` : "limit");
  if (w.window === "credits") return w.state === "exhausted" ? "credits used up" : `credits ${money(w.remaining)} left`;
  if (w.state === "exhausted") return `${name} used up${when || " (reset time unknown)"}`;
  if (w.state === "limited") return `rate-limited${when || " (reset time unknown)"}`;
  if (w.window === "day" && w.used !== null && w.limit) return `${name}: ${w.used} of ${w.limit}${when}`;
  return `${name} ${w.usedPercent !== null ? pct(w.usedPercent) : "?"}${when}`;
}

/** How long ago, for "checked 1 min ago". */
export function agoText(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso ?? "")) / 1000));
  if (!Number.isFinite(s)) return null;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/**
 * ad auth list's limits cell (at most 13 characters at 80 columns): what ran out first, else
 * a ChatGPT sign-in's two windows ("5h 64% wk 22%"), else the closest to running out, else a
 * benched provider ("out → 05:30"); "" when nothing is known.
 */
export function listCell(view, now = Date.now()) {
  if (!view) return "";
  const worst = mostConstrained(view);
  if (worst && (worst.state === "exhausted" || worst.state === "limited")) return worst.short;
  const five = view.windows.find((w) => w.window === "5h");
  const week = view.windows.find((w) => w.window === "week");
  if (five && week) return `${five.short} ${week.short}`;
  // A long count ("today 999/1000") as a share, rounded down: 99% is not used up.
  if (worst && worst.short.length > 13 && worst.used !== null && worst.limit) return `${worst.window === "day" ? "today" : (SHORT_WINDOW[worst.window] ?? "used")} ${Math.floor((worst.used / worst.limit) * 100)}%`;
  if (worst) return worst.short;
  if (view.benchedUntil) return `out → ${resetText(view.benchedUntil, now)}`;
  return "";
}

/** --json's quota: the view without the display words. */
export function quotaJson(view) {
  if (!view) return null;
  return { state: view.state, windows: view.windows.map(({ label: _l, short: _s, ...w }) => w), benchedUntil: view.benchedUntil, observedAt: view.observedAt, source: view.source };
}

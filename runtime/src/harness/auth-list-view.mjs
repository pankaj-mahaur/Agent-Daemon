// The canonical account list (P3.8a; P4.6 adds columns, never a second layout). Pure:
// accounts + width → lines. Grouped by provider in the registry's order, sorted by label.
//
//   listLines(accounts, { width, wide, defaultId, upstream, limits, providerOrder, nameOf, now })
//
// Columns at 80: marker (● default), label, owner (only when it differs from the label;
// under 60 columns a dim "owner: …" suffix instead), who (masked email · plan, key …1234,
// local), status, limits (P4.6's cell from the QuotaStore, else the gateway's last 429). --wide or 120+ columns
// add method and last use. Long values are cut with …, never wrapped.

const STATUS = { ready: "ready", "needs-sign-in": "needs sign-in", error: "error", pending: "pending", disabled: "disabled", removing: "removing" };
const METHOD = { "api-key": "api key", "openrouter-oauth": "openrouter sign-in", "engine-login": "chatgpt sign-in", "api-key-engine": "engine key", none: "no key" };

export const cut = (s, n) => {
  const t = String(s ?? "");
  if (n <= 0) return "";
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1)).trimEnd()}…`;
};
// A cell: cut to leave one space, so neighbouring columns never run together.
const pad = (s, n) => (n <= 0 ? "" : cut(s, n - 1).padEnd(n));

export function maskEmailShort(email) {
  if (!email || !String(email).includes("@")) return email ?? "";
  const [user, domain] = String(email).split("@");
  return `${user.slice(0, 1)}***@${domain}`;
}

/** "s***@example.com · plus", "key …a1b2", "local". */
export function whoOf(a, { showEmails = false, emails = {} } = {}) {
  if (a.identity?.email || a.method === "engine-login") {
    const email = showEmails && emails[a.id] ? emails[a.id] : maskEmailShort(a.identity?.email ?? "");
    return [email, a.identity?.plan].filter(Boolean).join(" · ") || "sign-in";
  }
  if (a.keyHint) return `key …${a.keyHint}`;
  if (a.method === "none") return "local";
  if (a.method === "api-key-engine") return "key kept by the engine";
  return "";
}

const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
/** The limits column: a 429 the gateway saw, with when it resets. */
export function limitOf(obs, now = Date.now()) {
  if (!obs || obs.status !== 429) return "";
  const at = obs.at ? Date.parse(obs.at) : now;
  const until = obs.retryAfterS ? new Date(at + obs.retryAfterS * 1000) : null;
  // Short enough for the 80-column limits cell: "429 → 05:30" (until 05:30).
  return until && until.getTime() > now ? `429 → ${hhmm(until)}` : "429";
}

const ago = (iso, now) => {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
};

export function listLines(accounts, { width = 80, wide = false, defaultId = null, upstream = () => null, limits = () => "", providerOrder = [], nameOf = (id) => id, now = Date.now(), showEmails = false, emails = {} } = {}) {
  const w = Math.max(40, width);
  const showWide = wide || w >= 120;
  const narrow = w < 69;
  // Column widths for 80 (marker 2 + label 13 + owner 14 + who 26 + status 14 + limits 11 = 80).
  // Narrow: the owner moves to a suffix, so label and who share what's left after status.
  const col = narrow ? { label: Math.max(8, w - 2 - 18 - 13 - 12), owner: 0, who: 18, status: 13, limits: 0 } : { label: 13, owner: 14, who: 24, status: 14, limits: w - 2 - 13 - 14 - 24 - 14 };
  // Wide: method and last use; at 120+ roomier columns, under that the others give way.
  if (showWide) Object.assign(col, w >= 120 ? { label: 16, owner: 16, who: 28, method: 20, used: 12 } : { owner: 10, who: 20, method: 12, used: 9 });
  if (showWide && !narrow) col.limits = Math.max(0, w - 2 - col.label - col.owner - col.who - col.status - col.method - col.used);
  const header = narrow ? `  ${pad("label", col.label)}${pad("who", col.who)}status` : `  ${pad("label", col.label)}${pad("owner", col.owner)}${pad("who", col.who)}${pad("status", col.status)}${showWide ? `${pad("method", col.method)}${pad("last use", col.used)}` : ""}limits`;
  const lines = [cut((col.limits > 0 || narrow ? header : header.replace(/limits$/, "")).trimEnd(), w)];
  const order = (p) => {
    const i = providerOrder.indexOf(p);
    return i === -1 ? providerOrder.length : i;
  };
  const groups = [...new Set(accounts.map((a) => a.provider))].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  for (const p of groups) {
    lines.push(cut(nameOf(p), w));
    for (const a of accounts.filter((x) => x.provider === p).sort((x, y) => String(x.label).localeCompare(String(y.label)))) {
      const mark = a.id === defaultId ? "● " : "  ";
      const owner = a.owner && a.owner !== a.label ? a.owner : "";
      const who = whoOf(a, { showEmails, emails });
      const status = STATUS[a.status] ?? a.status;
      let line;
      if (narrow) line = `${mark}${pad(a.label, col.label)}${pad(who, col.who)}${cut(status, col.status)}${owner ? `  owner: ${owner}` : ""}`;
      else line = `${mark}${pad(a.label, col.label)}${pad(owner, col.owner)}${pad(who, col.who)}${pad(status, col.status)}${showWide ? `${pad(METHOD[a.method] ?? a.method, col.method)}${pad(ago(a.lastUsedAt, now), col.used)}` : ""}${cut(limits(a) || limitOf(upstream(a.id), now), Math.max(0, col.limits))}`;
      lines.push(cut(line.trimEnd(), w));
    }
  }
  lines.push("");
  const legend = [defaultId && accounts.some((a) => a.id === defaultId) ? "● = ad's default for new sessions." : null, showWide ? null : "More columns: --wide"].filter(Boolean).join(" ");
  if (legend) lines.push(cut(legend, w));
  return lines;
}

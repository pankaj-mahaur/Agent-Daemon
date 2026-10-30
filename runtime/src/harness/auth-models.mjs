// `ad auth models <account> [--refresh] [--json]` (P4.3): an account's models as ad's catalog
// knows them: tools, context, price ("free, checked 3 min ago" / "price unknown"), route and
// the provider's data terms. The cached list unless --refresh (at most once per 10 minutes).

import { readRegistry } from "../auth/accounts/registry.mjs";
import { accountName } from "../auth/accounts/target.mjs";
import { readCatalog, refresh as refreshCatalog, freeOf } from "../providers/catalog.mjs";
import { resolveAccount } from "./auth-commands.mjs";

const tri = (v) => (v === true ? "yes" : v === false ? "no" : "?");
const ago = (iso, now) => {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const perM = (v) => {
  const n = Number(v) * 1e6;
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toPrecision(2)}`;
};

/** The price column: what ad knows, never a guess. */
export function priceText(entry, now = Date.now()) {
  const free = freeOf(entry.price, { now, billing: entry.billing });
  if (entry.billing === "local") return "free (local)";
  if (entry.billing === "subscription") return "your plan";
  if (free.value === true) return `free, checked ${ago(free.observedAt, now)}`;
  if (!entry.price || entry.price.input === null || entry.price.output === null) return "price unknown";
  if (free.value === null) return `price unknown (last seen ${ago(entry.price.observedAt, now)})`;
  return `${perM(entry.price.input)} in \u{b7} ${perM(entry.price.output)} out per 1M tokens`;
}

export async function cmdModels(ref, { out = process.stdout, json = false, refresh = false, store, fetch, clientVersion, now = Date.now() } = {}) {
  const a = resolveAccount(readRegistry(), ref);
  if (a.method === "engine-login" || a.credential?.kind === "engine-home") {
    const text = `${accountName(a)} is a ChatGPT sign-in: its models are the engine's own; /model lists them in ad tui.`;
    if (json) out.write(`${JSON.stringify({ account: a.id, entries: null, note: text })}\n`);
    else out.write(`${text}\n`);
    return 0;
  }
  let doc = refresh ? null : readCatalog(a.id);
  if (!doc) {
    const key = a.credential?.ref ? store.get(a.credential.ref) : null;
    doc = await refreshCatalog(a, { key, fetch, clientVersion, now, force: refresh });
  }
  if (json) {
    out.write(`${JSON.stringify({ account: a.id, observedAt: doc.observedAt, entries: doc.entries })}\n`);
    return 0;
  }
  const rows = doc.entries.map((e) => [e.model, tri(e.caps?.tools), e.caps?.contextWindow ? `${Math.round(e.caps.contextWindow / 1000)}K` : "?", priceText(e, now), e.route]);
  const head = ["model", "tools", "context", "price", "route"];
  const widths = head.map((h, i) => Math.min(48, Math.max(h.length, ...rows.map((r) => String(r[i]).length))));
  const line = (r) => r.map((c, i) => String(c).padEnd(widths[i])).join("  ").trimEnd();
  out.write(`${accountName(a)}: ${doc.entries.length} model${doc.entries.length === 1 ? "" : "s"}, listed ${ago(doc.observedAt, now)}\n`);
  out.write(`${line(head)}\n`);
  for (const r of rows) out.write(`${line(r)}\n`);
  const note = doc.entries.find((e) => e.data?.note)?.data.note;
  if (note) out.write(`\n${note}\n`);
  return 0;
}

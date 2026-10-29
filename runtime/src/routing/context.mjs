// What routing reads (P4.4): the accounts and each one's model catalog, from ad's own files.
//
//   routingContext({ root, now }) → { accounts, catalog(accountId, model), now, root }
//
// A ChatGPT sign-in has no catalog file: its models are the engine's own, so a target on it
// reads as "your plan, calls tools" (P4.3 lists them only in the TUI's /model).

import { adRoot } from "../ad-root.mjs";
import { readRegistry } from "../auth/accounts/registry.mjs";
import { readCatalog } from "../providers/catalog.mjs";

export const isEngineLogin = (a) => a?.method === "engine-login" || a?.credential?.kind === "engine-home";

export function routingContext({ root = adRoot(), now = Date.now() } = {}) {
  let doc;
  try {
    doc = readRegistry({ root });
  } catch (e) {
    if (e.code !== "REGISTRY_NEWER" || !e.doc) throw e;
    doc = e.doc; // a newer ad's list: read what this version understands
  }
  const accounts = (doc.accounts ?? []).filter((a) => a.status !== "removing");
  const lists = new Map();
  const catalog = (accountId, model) => {
    const a = accounts.find((x) => x.id === accountId);
    if (!a) return null;
    if (isEngineLogin(a)) return { accountId, provider: a.provider, model, caps: { tools: true, contextWindow: null }, price: null, billing: "subscription", data: {} };
    if (!lists.has(accountId)) lists.set(accountId, readCatalog(accountId, { root })?.entries ?? []);
    return lists.get(accountId).find((e) => e.model === model) ?? null;
  };
  return { accounts, catalog, now, root };
}

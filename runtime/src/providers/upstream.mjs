// What ad does with each of the gateway's observations (P4.3), in ad's own process: the
// limits it shows go to the QuotaStore, a quota or rate-limit failure benches its provider,
// the attempt is charged to the spend store, and an OpenRouter 429 is followed by one /key
// read (at most every 30 s per account) to tell a used-up free day from a throttle.
//
//   createUpstreamRecorder({ probeKey, onFailure, root, now }) → record(event) → Promise
//   probeOpenRouterKey({ key, fetch, clientVersion }) → the /key JSON
// probeKey(accountId) → that JSON or null (the caller reads the key from ad's secret store).
// Records run one after another; a failure in one never reaches the gateway or the turn.

import { adRoot } from "../ad-root.mjs";
import { providerRequest } from "./http.mjs";
import { classifyUpstream } from "./errors.mjs";
import { benchKey, benchProvider, fromHeaders, fromOpenRouterKey, recordObservations } from "./quota.mjs";
import { addCharge } from "./spend.mjs";
import fs from "node:fs";
import { catalogFile, readCatalog } from "./catalog.mjs";

const PROBE_EVERY_MS = 30_000;
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";

/** OpenRouter's own data on the key: its documented host only, no redirect, 5 s. */
export async function probeOpenRouterKey({ key, fetch, clientVersion, url = OPENROUTER_KEY_URL } = {}) {
  const r = await providerRequest({ url, key, fetch, clientVersion, timeoutMs: 5000 });
  if (r.status !== 200) throw Object.assign(new Error(`OpenRouter answered HTTP ${r.status} for /key.`), { code: "KEY_PROBE_FAILED", status: r.status });
  return r.json;
}

export function createUpstreamRecorder({ probeKey = null, onFailure = () => {}, root = adRoot(), now = () => Date.now() } = {}) {
  let chain = Promise.resolve();
  const probed = new Map(); // accountId → when /key was last read

  // A catalog read per billed answer, cached until its file changes.
  const prices = new Map(); // accountId → { mtime, byModel }
  const priceOf = (accountId, model) => {
    let mtime;
    try {
      mtime = fs.statSync(catalogFile(accountId, { root })).mtimeMs;
    } catch {
      return null; // no catalog: unpriced
    }
    let c = prices.get(accountId);
    if (c?.mtime !== mtime) {
      const doc = readCatalog(accountId, { root });
      if (!doc) return null;
      prices.set(accountId, (c = { mtime, byModel: new Map(doc.entries.map((e) => [e.model, e.price ?? null])) }));
    }
    return c.byModel.get(model) ?? null;
  };
  // One step's failure (a lock that waited too long…) never skips the others.
  const step = async (fn) => {
    try {
      await fn();
    } catch {
      // the next observation will try again
    }
  };

  async function handle(ev) {
    // ad's own answers (its caps, a missing key) say nothing about the provider.
    if (!ev?.accountId || ev.local) return;
    const t = now();
    const observations = fromHeaders(ev.headers ?? {}, { accountId: ev.accountId, provider: ev.provider ?? null, status: ev.status, now: t });
    let f = ev.status >= 400 || ev.error ? classifyUpstream(ev, { now: t }) : null;
    if (f && ev.provider === "openrouter" && ev.status === 429 && probeKey && t - (probed.get(ev.accountId) ?? 0) >= PROBE_EVERY_MS) {
      probed.set(ev.accountId, t);
      const json = await probeKey(ev.accountId).catch(() => null);
      if (json) {
        const r = fromOpenRouterKey(json, { accountId: ev.accountId, now: t });
        observations.push(...r.observations);
        f = classifyUpstream(ev, { probe: r, now: t });
      }
    }
    if (f && (f.class === "quotaExhausted" || f.class === "rateLimit")) {
      observations.push({ v: 1, accountId: ev.accountId, provider: ev.provider ?? null, scope: "account", model: null, window: f.period ?? "unknown", usedPercent: null, used: null, limit: null, remaining: f.class === "quotaExhausted" ? 0 : null, resetsAt: f.resetsAt, state: f.class === "quotaExhausted" ? "exhausted" : "limited", source: "gateway:error", observedAt: new Date(t).toISOString(), confidence: f.resetsAt ? "reported" : "inferred" });
      if (ev.provider) await step(() => benchProvider(benchKey(ev.provider, ev.accountId), { until: f.resetsAt, reason: f.class, accountId: ev.accountId }, { root, now: t }));
    }
    await step(() => recordObservations(observations, { root }));
    // Spend: an answer the provider bills (a 2xx), exactly with usage, else pessimistically
    // (a cut or aborted stream). Rejections (4xx, 5xx) aren't billed by providers.
    if (ev.status >= 200 && ev.status < 300) {
      const price = priceOf(ev.accountId, ev.model);
      await step(() => addCharge({ accountId: ev.accountId, usage: ev.usage ?? null, price, requestBytes: ev.requestBytes ?? 0, maxOutputTokens: null }, { root, now: t }));
    }
    if (f) onFailure(ev, f);
  }

  return (ev) => {
    chain = chain.then(() => handle(ev)).catch(() => {});
    return chain;
  };
}

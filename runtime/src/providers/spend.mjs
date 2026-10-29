// What was spent (P4.3, T3-H6): ~/.agent-daemon/quota/spend.json, per calendar day (local)
// per account, under the lock "spend-store". Every gateway attempt is charged, retries
// included: usage × price when the response reports usage, else a pessimistic estimate.
// ChatGPT accounts are subscriptions and never charged here.
//
//   chargeOf({ usage, price, requestBytes, maxOutputTokens }) → { usd | null, estimated }
//   addCharge({ accountId, usage, price, requestBytes, maxOutputTokens }, { root, now, waitMs })
//   today(accountId, { now, root }) → { usd, requests, estimated, unpriced }   todayTotal({ now, root })

import fs from "node:fs";
import path from "node:path";
import { adRoot } from "../ad-root.mjs";
import { acquireLockWithin } from "../lock.mjs";
import { writeJsonAtomicSync } from "../atomic-json.mjs";
import { quotaDir } from "./quota.mjs";

const DEFAULT_MAX_OUTPUT = 8192;
const KEEP_DAYS = 31;
const fileOf = (root) => path.join(quotaDir(root), "spend.json");
const price = (v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const dayOf = (now) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** One attempt's cost. No price → usd null (unknown), never 0. */
export function chargeOf({ usage = null, price: p = null, requestBytes = 0, maxOutputTokens = null } = {}) {
  const pin = price(p?.input);
  const pout = price(p?.output);
  const preq = price(p?.request) ?? 0;
  if (pin === null || pout === null) return { usd: null, estimated: !usage };
  // Usage in a shape ad knows (Responses, Chat, Gemini); one with no such field counts as none.
  const inTok = usage?.input_tokens ?? usage?.prompt_tokens ?? usage?.promptTokenCount;
  const outTok = usage?.output_tokens ?? usage?.completion_tokens ?? usage?.candidatesTokenCount;
  if (usage && inTok !== undefined && outTok !== undefined) return { usd: (Number(inTok) || 0) * pin + (Number(outTok) || 0) * pout + preq, estimated: false };
  // Half a usage: the half that's there, the other half assumed at its worst.
  if (usage && (inTok !== undefined || outTok !== undefined)) {
    const input = inTok !== undefined ? Number(inTok) || 0 : Math.ceil((Number(requestBytes) || 0) / 3);
    const output = outTok !== undefined ? Number(outTok) || 0 : Number(maxOutputTokens) > 0 ? Number(maxOutputTokens) : DEFAULT_MAX_OUTPUT;
    return { usd: input * pin + output * pout + preq, estimated: true };
  }
  // No usage (a cut stream, a failed attempt, a provider that doesn't say): assume the worst.
  const input = Math.ceil((Number(requestBytes) || 0) / 3);
  const output = Number(maxOutputTokens) > 0 ? Number(maxOutputTokens) : DEFAULT_MAX_OUTPUT;
  return { usd: input * pin + output * pout + preq, estimated: true };
}

function readDoc(root) {
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(root), "utf8"));
    if (j && typeof j === "object" && j.days) return j;
  } catch {
    // missing or unreadable
  }
  return { v: 1, revision: 0, days: {} };
}

export async function addCharge({ accountId, ...rest }, { root = adRoot(), now = Date.now(), waitMs = 5000 } = {}) {
  if (!accountId) return;
  const c = chargeOf(rest);
  const dir = quotaDir(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const release = await acquireLockWithin("spend-store", { dir: path.join(dir, ".locks"), waitMs });
  try {
    const doc = readDoc(root);
    const day = (doc.days[dayOf(now)] ??= {});
    const a = (day[accountId] ??= { usd: 0, requests: 0, estimated: 0, unpriced: 0 });
    a.requests += 1;
    if (c.usd === null) a.unpriced += 1;
    else a.usd += c.usd;
    if (c.estimated) a.estimated += 1;
    // Old days go: the store answers "today", not a history.
    const keep = new Set(Object.keys(doc.days).sort().slice(-KEEP_DAYS));
    for (const k of Object.keys(doc.days)) if (!keep.has(k)) delete doc.days[k];
    doc.revision = (doc.revision ?? 0) + 1;
    writeJsonAtomicSync(fileOf(root), doc);
  } finally {
    release();
  }
}

const ZERO = () => ({ usd: 0, requests: 0, estimated: 0, unpriced: 0 });
export function today(accountId, { now = Date.now(), root = adRoot() } = {}) {
  const a = readDoc(root).days[dayOf(now)]?.[accountId];
  return a ? { usd: a.usd, requests: a.requests, estimated: a.estimated, unpriced: a.unpriced } : ZERO();
}

export function todayTotal({ now = Date.now(), root = adRoot() } = {}) {
  const t = ZERO();
  for (const a of Object.values(readDoc(root).days[dayOf(now)] ?? {})) for (const k of Object.keys(t)) t[k] += a[k] ?? 0;
  return t;
}

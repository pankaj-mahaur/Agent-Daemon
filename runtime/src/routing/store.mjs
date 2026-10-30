// ~/.agent-daemon/fallback.json (P4.4): the fallback order and its rules, changed under the
// lock "fallback-policy" and re-read before every write. A change is saved only when it adds no
// validation error; consent clears itself when any confirmed destination fact changes.
//
//   readPolicy({ root, lenient })     missing → the defaults (off); unreadable → FALLBACK_CORRUPT (lenient: off)
//   updatePolicy(mutate, { root, accounts, catalog, now, expectedRevision, enabling })
//     → { policy, consentCleared, warnings }
//   enablePolicy(opts)  disablePolicy(opts)
//   consentState(policy, accounts) → { ok: true } | { ok: false, reason: "off" | "changed", text, name }

import fs from "node:fs";
import path from "node:path";
import { adRoot } from "../ad-root.mjs";
import { acquireLockWithin } from "../lock.mjs";
import { writeJsonAtomicSync } from "../atomic-json.mjs";
import { accountName } from "../auth/accounts/target.mjs";
import { consentHash, consentParts, DEFAULT_POLICY, targetKey, validatePolicy } from "./policy.mjs";

export const fallbackFile = (root = adRoot()) => path.join(root, "fallback.json");

export const FALLBACK_TEXTS = Object.freeze({
  CORRUPT: (file, why) => `${file} can't be read (${why}). Fix it or delete it; fallback stays off until then.`,
  NEWER: (file) => `${file} was written by a newer ad. Update ad to change it; fallback stays off until then.`,
  CONFLICT: "The fallback order changed in another window. Look at it again: ad fallback",
  BUSY: "The fallback order is being changed elsewhere. Try again in a moment.",
  CLEARED: "Fallback is off until you confirm the new order: ad fallback enable",
  CHANGED: (name) => `Fallback is off: ${name} changed since you confirmed the order. /fallback to confirm again.`,
  RULES_CHANGED: "Fallback is off: its rules changed since you confirmed them. /fallback to confirm again.",
});

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const defaults = () => structuredClone({ ...DEFAULT_POLICY, dataRules: { ...DEFAULT_POLICY.dataRules } });

export function readPolicy({ root = adRoot(), lenient = false } = {}) {
  const file = fallbackFile(root);
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw fail("FALLBACK_CORRUPT", FALLBACK_TEXTS.CORRUPT(file, "not a policy"));
    if (Number(doc.schemaVersion) > DEFAULT_POLICY.schemaVersion) throw fail("FALLBACK_NEWER", FALLBACK_TEXTS.NEWER(file));
    // The shapes code walks: a list that isn't one makes the file unreadable, not a crash.
    const bad = ["targets", "on", "allowRunningBackground"].find((k) => k in doc && !Array.isArray(doc[k])) ?? (["dataRules", "consent"].find((k) => doc[k] !== undefined && doc[k] !== null && (typeof doc[k] !== "object" || Array.isArray(doc[k]))) || null) ?? (Array.isArray(doc.targets) && doc.targets.some((t) => !t || typeof t !== "object") ? "targets" : null);
    if (bad) throw fail("FALLBACK_CORRUPT", FALLBACK_TEXTS.CORRUPT(file, `${bad} isn't what ad expects`));
  } catch (e) {
    if (e.code === "ENOENT") return defaults();
    if (lenient) return defaults();
    if (e.code === "FALLBACK_CORRUPT" || e.code === "FALLBACK_NEWER") throw e;
    throw fail("FALLBACK_CORRUPT", FALLBACK_TEXTS.CORRUPT(file, e instanceof SyntaxError ? "not valid JSON" : (e.code ?? e.message)));
  }
  return { ...defaults(), ...doc };
}

const errKey = (e) => `${e.code}\u{0}${e.text}`;

export async function updatePolicy(mutate, { root = adRoot(), accounts = [], catalog = () => null, now = Date.now(), waitMs = 5000, expectedRevision, enabling = false } = {}) {
  const dir = path.join(root, ".locks");
  fs.mkdirSync(dir, { recursive: true });
  let release;
  try {
    release = await acquireLockWithin("fallback-policy", { dir, waitMs });
  } catch (e) {
    if (e.code === "LOCK_BUSY") throw fail("FALLBACK_BUSY", FALLBACK_TEXTS.BUSY);
    throw e;
  }
  try {
    const current = readPolicy({ root });
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw fail("FALLBACK_CONFLICT", FALLBACK_TEXTS.CONFLICT);
    const next = structuredClone(current);
    if ((await mutate(next)) === false) return { policy: current, consentCleared: false, warnings: [] };
    const ctx = { accounts, catalog, now };
    const { errors, warnings } = validatePolicy(next, { ...ctx, enabling });
    // A change may not add a problem; one already there (an account removed since) doesn't
    // block removing it or turning fallback off. Turning it on needs none at all.
    const before = enabling ? new Set() : new Set(validatePolicy(current, ctx).errors.map(errKey));
    const added = errors.filter((e) => !before.has(errKey(e)));
    if (added.length) throw fail("FALLBACK_INVALID", added.map((e) => e.text).join("\n"), { errors: added, warnings });
    // Consent covers exactly what was confirmed; anything else turns fallback off.
    let consentCleared = false;
    if (next.consent && next.consent.hash !== consentHash(next, accounts)) {
      next.consent = null;
      consentCleared = current.enabled === true;
    }
    if (!next.consent) next.enabled = false;
    if (JSON.stringify(next) === JSON.stringify(current)) return { policy: current, consentCleared, warnings };
    next.schemaVersion = DEFAULT_POLICY.schemaVersion;
    next.revision = (current.revision ?? 0) + 1;
    if (next.consent && next.consent.revision === null) next.consent.revision = next.revision;
    writeJsonAtomicSync(fallbackFile(root), next);
    return { policy: next, consentCleared, warnings };
  } finally {
    release();
  }
}

export function enablePolicy(opts = {}) {
  const { accounts = [], now = Date.now() } = opts;
  return updatePolicy((p) => {
    p.enabled = true;
    p.consent = { at: new Date(now).toISOString(), revision: null, hash: consentHash(p, accounts), parts: consentParts(p, accounts) };
  }, { ...opts, enabling: true });
}

export function disablePolicy(opts = {}) {
  return updatePolicy((p) => {
    p.enabled = false;
    p.consent = null;
  }, opts);
}

/** Whether fallback may act now: on, and confirmed for exactly these destinations. */
export function consentState(policy, accounts = []) {
  if (!policy?.enabled || !policy.consent) return { ok: false, reason: "off" };
  if (policy.consent.hash === consentHash(policy, accounts)) return { ok: true };
  const parts = consentParts(policy, accounts);
  const changed = (policy.targets ?? []).find((t) => policy.consent.parts?.[targetKey(t)] !== parts[targetKey(t)]);
  const account = changed ? accounts.find((a) => a.id === changed.account) : null;
  const name = account ? accountName(account) : (changed ? changed.account : null);
  const text = changed ? FALLBACK_TEXTS.CHANGED(account ? accountName(account) : changed.account) : FALLBACK_TEXTS.RULES_CHANGED;
  return { ok: false, reason: "changed", text, name };
}

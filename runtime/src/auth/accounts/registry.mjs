// The account registry (P3.2): every account ad can run on, with an immutable id, a
// label, an owner tag and where its credential lives. No engine imports.
//
//   adRoot()/accounts/registry.json      schema v1 (below); never holds a secret
//   adRoot()/accounts/registry.json.bak  the previous good revision
//   adRoot()/accounts/registry.lock      the write lock (outside locks/, so ad migrate
//                                        never counts it as a running session)
//
// Writes go through transact(): lock → re-read → refuse a newer schema → check the
// expected revision → mutate a copy (no network, prompts or other locks inside) →
// unchanged: no write → revision + 1, validate, copy the current file to .bak, write
// atomically → unlock. A damaged file is never reset: ad auth repair restores .bak.
//
// v1: { schemaVersion: 1, revision, salt, engines: { api: { home } },
//       accounts: [{ id, provider, label, owner, method, credential, keyHint, credentialRevision,
//                    providerEntry, endpoint, defaultModel, status, statusDetail, identity,
//                    attempt, migratedFrom, createdAt, lastUsedAt }],
//       defaults: { target: { account, model, effort } | null, digest: null | id } }

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { adRoot } from "../../ad-root.mjs";
import { ulid } from "../../ids.mjs";
import { acquireLockWithin } from "../../lock.mjs";
import { writeFileAtomicSync, writeJsonAtomicSync } from "../../atomic-json.mjs";

export const REGISTRY_SCHEMA_VERSION = 1;

export const REGISTRY_TEXTS = Object.freeze({
  REGISTRY_CORRUPT: (file, reason) => `ad can't read its account list (${file}: ${reason}). Your keys are untouched. Run: ad auth repair`,
  REGISTRY_NEWER: (n) => `This account list was written by a newer ad (schema ${n}). Update ad to change accounts; this version only reads what it understands.`,
  REGISTRY_CONFLICT: "The account list changed while you were choosing. Look again: ad auth status",
  REGISTRY_BUSY: "Another ad is updating the account list. Try again in a moment.",
  REGISTRY_INVALID: (problems) => `ad refused to save an account list that doesn't hold together: ${problems.join("; ")}`,
  ACCOUNT_NOT_FOUND: (ref) => `No account matches ${JSON.stringify(ref)}. See: ad auth status`,
  ACCOUNT_AMBIGUOUS: (ref, n) => `${n} accounts match ${JSON.stringify(ref)}. Name one as <provider>/<label>, or by its id. See: ad auth status`,
});

const fail = (code, message) => Object.assign(new Error(message), { code });

/** Provider ids and the words that name them: never an account label (LABEL_RESERVED). */
export const PROVIDER_NAMES = Object.freeze([
  "openai", "chatgpt", "openrouter", "kimi", "kimi-code", "moonshot", "xai", "grok", "fireworks", "ollama", "lmstudio", "lm-studio", "opencode", "opencode-go", "custom", "local", "api",
  "gemini", "google", "anthropic", "claude", "groq", "cerebras", "mistral", "nvidia", "deepseek", "together", "zai", "zai-coding", "huggingface", "nebius", "minimax", "sambanova",
]);
export const METHODS = Object.freeze(["api-key", "api-key-engine", "engine-login", "openrouter-oauth", "none"]);
export const STATUSES = Object.freeze(["pending", "ready", "needs-sign-in", "disabled", "error", "removing"]);

export const accountsDir = (root = adRoot()) => path.join(root, "accounts");
const registryFile = (root) => path.join(accountsDir(root), "registry.json");

export function emptyRegistry() {
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, revision: 0, salt: `b64:${crypto.randomBytes(16).toString("base64")}`, engines: { api: { home: null } }, accounts: [], defaults: { target: null, digest: null } };
}

/** The registry as stored (never writes). Missing → an empty v1 document. */
export function readRegistry({ root = adRoot() } = {}) {
  const file = registryFile(root);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return emptyRegistry();
    throw fail("REGISTRY_CORRUPT", REGISTRY_TEXTS.REGISTRY_CORRUPT(file, e.code ?? e.message));
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw fail("REGISTRY_CORRUPT", REGISTRY_TEXTS.REGISTRY_CORRUPT(file, "not valid JSON"));
  }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.accounts) || !Number.isInteger(doc.schemaVersion)) throw fail("REGISTRY_CORRUPT", REGISTRY_TEXTS.REGISTRY_CORRUPT(file, "not an account list"));
  if (doc.schemaVersion > REGISTRY_SCHEMA_VERSION) {
    const e = fail("REGISTRY_NEWER", REGISTRY_TEXTS.REGISTRY_NEWER(doc.schemaVersion));
    e.doc = doc; // a newer ad's list may still be read for what this version understands
    throw e;
  }
  doc.engines ??= { api: { home: null } };
  doc.defaults ??= { target: null, digest: null };
  return doc;
}

/* ------------------------------------------------------------------ */
/* Ids, refs, labels                                                   */
/* ------------------------------------------------------------------ */

export const newAccountId = (now = Date.now()) => `acct_${ulid(now)}`;
/** The last 8 ULID characters (H.2's rule): provider entries and secret names use it. */
export const shortId = (id) => String(id).slice(-8);
/** The secret name of an account's key: acct-<lowercase ulid>, -n (the next key while rekeying), -t (a temp). */
export function secretRef(id, { next = false, temp = false } = {}) {
  const base = `acct-${String(id).replace(/^acct_/, "").toLowerCase()}`;
  return next ? `${base}-n` : temp ? `${base}-t` : base;
}

const LABEL_RE = /^[A-Za-z0-9._ -]{1,40}$/;
/** null when fine, else LABEL_INVALID | LABEL_RESERVED. */
export function checkLabel(label) {
  const s = String(label ?? "");
  if (s.startsWith("@")) return "LABEL_RESERVED"; // home tokens such as @default
  if (!LABEL_RE.test(s) || s.trim() !== s) return "LABEL_INVALID";
  if (PROVIDER_NAMES.includes(s.toLowerCase())) return "LABEL_RESERVED";
  return null;
}
/** null when fine, else OWNER_INVALID: 0–40 printable characters. */
export function checkOwner(owner) {
  const s = String(owner ?? "");
  if (s.length > 40 || /[\u{0}-\u{1F}\u{7F}-\u{9F}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u.test(s)) return "OWNER_INVALID";
  return null;
}

/** A new account record (status pending until finalized). */
export function newAccount({ provider, label, owner = "", method, credential = null, endpoint = null, defaultModel = null, migratedFrom = null, now = new Date(), id = newAccountId(now.getTime()) }) {
  const entry = method === "engine-login" ? null : provider === "custom" ? `ad-custom-${shortId(id).toLowerCase()}` : `ad-${provider}-${shortId(id).toLowerCase()}`;
  return {
    id,
    provider,
    label,
    owner,
    method,
    credential: credential ?? (method === "api-key" || method === "openrouter-oauth" ? { kind: "secret", ref: secretRef(id) } : method === "none" ? { kind: "none" } : null),
    keyHint: null,
    credentialRevision: 1,
    providerEntry: entry,
    endpoint,
    defaultModel,
    status: "pending",
    statusDetail: null,
    identity: null,
    attempt: null,
    migratedFrom,
    createdAt: now.toISOString(),
    lastUsedAt: null,
  };
}

/** Problems with a document (empty when it holds together). */
export function validateRegistry(doc) {
  const problems = [];
  const ids = new Set();
  const labels = new Set();
  for (const a of doc.accounts ?? []) {
    if (!/^acct_[0-9A-HJKMNP-TV-Z]{26}$/.test(a.id)) problems.push(`bad id ${JSON.stringify(a.id)}`);
    if (ids.has(a.id)) problems.push(`duplicate id ${a.id}`);
    ids.add(a.id);
    if (!METHODS.includes(a.method)) problems.push(`${a.id}: unknown method ${a.method}`);
    if (!STATUSES.includes(a.status)) problems.push(`${a.id}: unknown status ${a.status}`);
    const lc = checkLabel(a.label);
    if (lc) problems.push(`${a.id}: ${lc} (${JSON.stringify(a.label)})`);
    if (checkOwner(a.owner)) problems.push(`${a.id}: OWNER_INVALID`);
    const key = `${a.provider}/${String(a.label).toLowerCase()}`;
    if (labels.has(key)) problems.push(`LABEL_TAKEN: ${a.provider}/${a.label}`);
    labels.add(key);
    if (a.credential?.kind === "secret" && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(a.credential.ref ?? "")) problems.push(`${a.id}: bad secret ref`);
    if (a.keyHint !== null && a.keyHint !== undefined && !/^.{1,4}$/.test(a.keyHint)) problems.push(`${a.id}: keyHint longer than 4`);
  }
  const target = doc.defaults?.target?.account;
  if (target && !ids.has(target)) problems.push(`default target ${target} isn't an account`);
  return problems;
}

/**
 * Find one account: by id, by short id (last 8), by "<provider>/<label>", or by a label
 * only one account has. ACCOUNT_NOT_FOUND / ACCOUNT_AMBIGUOUS otherwise.
 */
export function findAccount(doc, ref) {
  const r = String(ref ?? "").trim();
  const all = doc.accounts ?? [];
  const byId = all.find((a) => a.id === r);
  if (byId) return byId;
  const lower = r.toLowerCase();
  const slash = lower.indexOf("/");
  let hits;
  if (slash > 0) hits = all.filter((a) => a.provider === lower.slice(0, slash) && String(a.label).toLowerCase() === lower.slice(slash + 1));
  else {
    hits = all.filter((a) => shortId(a.id).toLowerCase() === lower);
    if (!hits.length) hits = all.filter((a) => String(a.label).toLowerCase() === lower);
  }
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw fail("ACCOUNT_AMBIGUOUS", REGISTRY_TEXTS.ACCOUNT_AMBIGUOUS(r, hits.length));
  throw fail("ACCOUNT_NOT_FOUND", REGISTRY_TEXTS.ACCOUNT_NOT_FOUND(r));
}

/**
 * Change the registry under its lock. mutate(doc) changes a copy in place (or returns
 * false); its return value is transact's.
 * @param {(doc: any) => any} mutate
 * @param {{ root?: string, waitMs?: number, expectedRevision?: number }} [opts]
 */
export async function transact(mutate, { root = adRoot(), waitMs = 5000, expectedRevision } = {}) {
  const dir = accountsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  let release;
  try {
    release = await acquireLockWithin("registry", { dir, waitMs });
  } catch (e) {
    if (e.code === "LOCK_BUSY") throw fail("REGISTRY_BUSY", REGISTRY_TEXTS.REGISTRY_BUSY);
    throw e;
  }
  try {
    const current = readRegistry({ root });
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw fail("REGISTRY_CONFLICT", REGISTRY_TEXTS.REGISTRY_CONFLICT);
    const next = structuredClone(current);
    const result = await mutate(next);
    if (result === false || JSON.stringify(next) === JSON.stringify(current)) return result;
    next.revision = (current.revision ?? 0) + 1;
    const problems = validateRegistry(next);
    if (problems.length) throw fail("REGISTRY_INVALID", REGISTRY_TEXTS.REGISTRY_INVALID(problems));
    const file = registryFile(root);
    if (fs.existsSync(file)) writeFileAtomicSync(`${file}.bak`, fs.readFileSync(file, "utf8"));
    writeJsonAtomicSync(file, next);
    return result;
  } finally {
    release();
  }
}

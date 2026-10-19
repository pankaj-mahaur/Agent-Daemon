// Account changes that take slow steps (P3.2): adding a key, rotating it, removing an
// account. The order makes every crash recoverable (reconcile.mjs finds the rest):
//   add      reserve a `pending` record → store the secret → test it (outside the
//            lock) → finalize. A crash leaves a pending record, with or without its
//            secret, never a secret no record names.
//   rekey    acct- refs: write the other name (acct-<id> ⇄ acct-<id>-n), test, swap
//            the ref, delete the old one. The 3.0 ref `openrouter`: a temp name, test,
//            then overwrite `openrouter` in place, so a 3.0 rollback still finds a key.
//            Every rekey bumps credentialRevision and refreshes keyHint.
//   remove   mark `removing` → delete the secret → delete the record.
// finalize applies only to a still-pending record with the same attempt id
// (ATTEMPT_SUPERSEDED otherwise). crashAt(step) is a test seam: "afterReserve",
// "afterSecret", "afterSecretDelete".

import crypto from "node:crypto";
import { adRoot } from "../../ad-root.mjs";
import { createSecretStore } from "../secrets.mjs";
import { checkLabel, checkOwner, findAccount, newAccount, readRegistry, secretRef, transact } from "./registry.mjs";

export const SERVICE_TEXTS = Object.freeze({
  ATTEMPT_SUPERSEDED: "This sign-in was replaced by a newer attempt for the same account; nothing was changed.",
  LABEL_TAKEN: (provider, label) => `${provider} already has an account labelled "${label}". Pick another label.`,
  LABEL_INVALID: "A label is 1–40 letters, digits, spaces, dots, underscores or dashes.",
  LABEL_RESERVED: (label) => `"${label}" names a provider (or starts with @), so it can't be a label. Pick another.`,
  OWNER_INVALID: "An owner tag is up to 40 printable characters.",
  KEY_TEST_FAILED: (why) => `The key didn't work (${why}), so it wasn't saved.`,
});

const fail = (code, message) => Object.assign(new Error(message), { code });
const keyHintOf = (key) => String(key).trim().slice(-4);

/**
 * @param {{ root?: string, store?: ReturnType<typeof createSecretStore>, now?: () => Date,
 *           crashAt?: ((step: string) => void) | null }} [o]
 */
export function createAccountService({ root = adRoot(), store = createSecretStore(), now = () => new Date(), crashAt = null } = {}) {
  const crash = (step) => crashAt?.(step);
  const tx = (fn, o) => transact(fn, { root, ...o });
  const checkNames = (doc, { provider, label, owner }, selfId = null) => {
    const lc = checkLabel(label);
    if (lc === "LABEL_RESERVED") throw fail(lc, SERVICE_TEXTS.LABEL_RESERVED(label));
    if (lc) throw fail(lc, SERVICE_TEXTS.LABEL_INVALID);
    if (checkOwner(owner)) throw fail("OWNER_INVALID", SERVICE_TEXTS.OWNER_INVALID);
    if (doc.accounts.some((a) => a.id !== selfId && a.provider === provider && String(a.label).toLowerCase() === String(label).toLowerCase())) throw fail("LABEL_TAKEN", SERVICE_TEXTS.LABEL_TAKEN(provider, label));
  };

  const service = {
    list: () => readRegistry({ root }).accounts,
    resolve: (ref) => findAccount(readRegistry({ root }), ref),

    /** A pending record for a sign-in or key that isn't stored yet. → { id, attemptId } */
    async reserve({ provider, label, owner = "", method, endpoint = null, credential = null, defaultModel = null, migratedFrom = null }) {
      const attemptId = crypto.randomBytes(8).toString("hex");
      return tx((doc) => {
        checkNames(doc, { provider, label, owner });
        const a = newAccount({ provider, label, owner, method, endpoint, credential, defaultModel, migratedFrom, now: now() });
        a.attempt = { id: attemptId, pid: process.pid, at: now().toISOString() };
        doc.accounts.push(a);
        return { id: a.id, attemptId };
      });
    },

    /** Complete a pending record: ready, with `patch` applied. */
    async finalize(id, attemptId, patch = {}) {
      return tx((doc) => {
        const a = doc.accounts.find((x) => x.id === id);
        if (!a || a.status !== "pending" || a.attempt?.id !== attemptId) throw fail("ATTEMPT_SUPERSEDED", SERVICE_TEXTS.ATTEMPT_SUPERSEDED);
        Object.assign(a, patch, { status: patch.status ?? "ready", statusDetail: patch.statusDetail ?? null, attempt: null });
        return a;
      });
    },

    /** Drop a pending record (and its secret, if one was stored). */
    async abandon(id, attemptId) {
      let ref = null;
      await tx((doc) => {
        const i = doc.accounts.findIndex((x) => x.id === id && x.status === "pending" && x.attempt?.id === attemptId);
        if (i < 0) return false;
        ref = doc.accounts[i].credential?.kind === "secret" ? doc.accounts[i].credential.ref : null;
        doc.accounts.splice(i, 1);
      });
      if (ref && ref !== "openrouter") store.delete(ref);
    },

    /**
     * Add an API-key account. test(key) → resolves (works) or rejects (why); it runs
     * outside the registry lock. → the ready record
     */
    async addApiKey({ provider, label, owner = "", endpoint = null, key, test = async () => {}, defaultModel = null }) {
      const { id, attemptId } = await service.reserve({ provider, label, owner, method: "api-key", endpoint, defaultModel });
      crash("afterReserve");
      const ref = secretRef(id);
      store.set(ref, key);
      crash("afterSecret");
      try {
        await test(key);
      } catch (e) {
        await service.abandon(id, attemptId);
        throw fail("KEY_TEST_FAILED", SERVICE_TEXTS.KEY_TEST_FAILED(e.message));
      }
      return service.finalize(id, attemptId, { keyHint: keyHintOf(key), credential: { kind: "secret", ref } });
    },

    /** A new key for an existing API-key account; the old one works until the new one passes. */
    async rekey(accountRef, { key, test = async () => {} }) {
      const a = service.resolve(accountRef);
      if (a.credential?.kind !== "secret") throw fail("NOT_A_KEY_ACCOUNT", `${a.provider}/${a.label} doesn't use a stored key.`);
      const old = a.credential.ref;
      const legacy = old === "openrouter";
      const base = secretRef(a.id);
      const staged = legacy ? secretRef(a.id, { temp: true }) : old === base ? secretRef(a.id, { next: true }) : base;
      store.set(staged, key);
      try {
        await test(key);
      } catch (e) {
        store.delete(staged);
        throw fail("KEY_TEST_FAILED", SERVICE_TEXTS.KEY_TEST_FAILED(e.message));
      }
      // The 3.0 name is overwritten in place, so 3.0 keeps finding a valid key.
      if (legacy) {
        store.set("openrouter", key);
        store.delete(staged);
      }
      const ref = legacy ? "openrouter" : staged;
      const updated = await tx((doc) => {
        const x = doc.accounts.find((y) => y.id === a.id);
        if (!x) throw fail("ACCOUNT_NOT_FOUND", `The account ${a.id} was removed while its key was being changed.`);
        x.credential = { kind: "secret", ref };
        x.keyHint = keyHintOf(key);
        x.credentialRevision = (x.credentialRevision ?? 1) + 1;
        if (x.status === "needs-sign-in") x.status = "ready";
        return x;
      });
      if (!legacy && old !== ref) store.delete(old);
      return updated;
    },

    /** A new label or owner tag. Never bumps credentialRevision. */
    async rename(accountRef, { label, owner }) {
      const a = service.resolve(accountRef);
      return tx((doc) => {
        const x = doc.accounts.find((y) => y.id === a.id);
        const next = { provider: x.provider, label: label ?? x.label, owner: owner ?? x.owner };
        checkNames(doc, next, x.id);
        x.label = next.label;
        x.owner = next.owner;
        return x;
      });
    },

    /** Remove an account: removing → secret deleted → record deleted. */
    async remove(accountRef) {
      const a = service.resolve(accountRef);
      await tx((doc) => {
        const x = doc.accounts.find((y) => y.id === a.id);
        x.status = "removing";
        if (doc.defaults?.target?.account === x.id) doc.defaults.target = null;
        if (doc.defaults?.digest === x.id) doc.defaults.digest = null;
      });
      const ref = a.credential?.kind === "secret" ? a.credential.ref : null;
      // The 3.0 name too: removing the account is the user asking for the key to go
      // (3.0's own logout deletes it the same way).
      if (ref) store.delete(ref);
      crash("afterSecretDelete");
      await tx((doc) => {
        doc.accounts = doc.accounts.filter((y) => y.id !== a.id);
      });
    },

    async setStatus(accountRef, status, detail = null) {
      const a = service.resolve(accountRef);
      return tx((doc) => {
        const x = doc.accounts.find((y) => y.id === a.id);
        x.status = status;
        x.statusDetail = detail;
        return x;
      });
    },

    async touch(id) {
      return tx((doc) => {
        const x = doc.accounts.find((y) => y.id === id);
        if (x) x.lastUsedAt = now().toISOString();
      });
    },
  };
  return service;
}

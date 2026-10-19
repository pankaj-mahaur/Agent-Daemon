// Finding and fixing what an interruption left behind (P3.2): `ad auth repair` and the
// doctor's account rows. Never prints a secret value.
//
//   ready record, secret gone           → needs-sign-in              (automatic)
//   stale pending, no secret            → record removed             (automatic)
//   stale pending, with its secret      → finish later or remove     (asks)
//   removing                            → removal finished           (automatic)
//   acct- secret no record names        → delete it                  (asks)
//   leftover acct-…-t temp secret       → deleted                    (automatic)
//   3.0 openrouter key not adopted      → adopted                    (automatic; migrate.mjs rule 2)
//   damaged registry.json               → restore .bak               (asks; the damaged file is kept)
// "Stale": the attempt is older than 30 minutes, or its process is gone.

import fs from "node:fs";
import path from "node:path";
import { adRoot } from "../../ad-root.mjs";
import { accountsDir, readRegistry, transact } from "./registry.mjs";
import { syncLegacyAccounts } from "./migrate.mjs";

const STALE_MS = 30 * 60_000;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

/** → [{ kind, auto, id?, ref?, label?, text }] */
export function inspectAccounts({ root = adRoot(), store, now = new Date() } = {}) {
  const findings = [];
  let doc;
  try {
    doc = readRegistry({ root });
  } catch (e) {
    if (e.code === "REGISTRY_CORRUPT") {
      const bak = fs.existsSync(path.join(accountsDir(root), "registry.json.bak"));
      findings.push({ kind: "corrupt", auto: false, canRestore: bak, text: bak ? "The account list is damaged. Restore the last good copy? The damaged file is kept as registry.json.corrupt-<date>." : "The account list is damaged and there is no earlier copy. Move it aside and sign in again." });
      return findings;
    }
    throw e;
  }
  const names = new Set(store.list());
  const named = new Set();
  for (const a of doc.accounts) {
    const ref = a.credential?.kind === "secret" ? a.credential.ref : null;
    if (ref) named.add(ref);
    const who = `${a.provider}/${a.label}`;
    if (a.status === "ready" && ref && !names.has(ref)) findings.push({ kind: "ready-no-secret", auto: true, id: a.id, label: who, text: `${who}: its key is gone; it will show as needing sign-in.` });
    if (a.status === "pending") {
      const age = now - Date.parse(a.attempt?.at ?? a.createdAt);
      const stale = age > STALE_MS || !a.attempt?.pid || !alive(a.attempt.pid);
      if (!stale) continue;
      if (ref && names.has(ref)) findings.push({ kind: "pending-with-secret", auto: false, id: a.id, label: who, text: `Finish adding ${who}? It was interrupted. Remove it, or keep it for later?` });
      else findings.push({ kind: "pending-no-secret", auto: true, id: a.id, label: who, text: `${who}: an interrupted sign-in with nothing stored; removed.` });
    }
    if (a.status === "removing") findings.push({ kind: "removing", auto: true, id: a.id, ref, label: who, text: `${who}: an interrupted removal; finished.` });
  }
  for (const n of names) {
    if (named.has(n) || n === "openrouter") continue;
    if (/^acct-[a-z0-9]+-t$/.test(n)) findings.push({ kind: "temp-secret", auto: true, ref: n, text: `A leftover temporary key ${n.slice(0, 12)}…; deleted.` });
    else if (/^acct-/.test(n)) findings.push({ kind: "orphan-secret", auto: false, ref: n, text: `Delete the stored key ${n.slice(0, 12)}…? No account uses it.` });
  }
  if (names.has("openrouter") && !doc.accounts.some((a) => a.credential?.ref === "openrouter")) findings.push({ kind: "legacy-unadopted", auto: true, text: "ad 3.0's OpenRouter key isn't an account yet; adopted." });
  return findings;
}

/**
 * Apply findings: automatic ones always, the others when confirm(finding) says yes.
 * → [{ kind, done: boolean, text }]
 */
export async function repairAccounts(findings, { root = adRoot(), store, confirm = async () => false, now = new Date() } = {}) {
  const out = [];
  for (const f of findings) {
    const yes = f.auto || (await confirm(f));
    if (!yes) {
      out.push({ kind: f.kind, done: false, text: f.text });
      continue;
    }
    switch (f.kind) {
      case "corrupt": {
        const dir = accountsDir(root);
        const file = path.join(dir, "registry.json");
        const stamp = now.toISOString().replace(/[:.]/g, "-");
        fs.renameSync(file, `${file}.corrupt-${stamp}`);
        if (f.canRestore) fs.copyFileSync(`${file}.bak`, file);
        break;
      }
      case "ready-no-secret":
        await transact((d) => {
          const a = d.accounts.find((x) => x.id === f.id);
          if (a) Object.assign(a, { status: "needs-sign-in", statusDetail: "its stored key is gone" });
        }, { root });
        break;
      case "pending-no-secret":
        await transact((d) => void (d.accounts = d.accounts.filter((x) => x.id !== f.id)), { root });
        break;
      case "pending-with-secret":
      case "removing":
        await transact((d) => {
          const a = d.accounts.find((x) => x.id === f.id);
          if (a?.credential?.kind === "secret") store.delete(a.credential.ref);
          d.accounts = d.accounts.filter((x) => x.id !== f.id);
        }, { root });
        break;
      case "temp-secret":
      case "orphan-secret":
        store.delete(f.ref);
        break;
      case "legacy-unadopted":
        // The sign-in isn't known here: only the key is adopted.
        await syncLegacyAccounts({ root, store, legacy: { account: undefined, config: {} }, now });
        break;
    }
    out.push({ kind: f.kind, done: true, text: f.text });
  }
  return out;
}

/** The doctor's rows: counts and the store in use, never a value. */
export function accountRows({ root = adRoot(), store } = {}) {
  const rows = [];
  try {
    const doc = readRegistry({ root });
    const by = (s) => doc.accounts.filter((a) => a.status === s).length;
    const parts = [`${by("ready")} ready`, by("needs-sign-in") && `${by("needs-sign-in")} need sign-in`, by("pending") && `${by("pending")} unfinished`].filter(Boolean);
    rows.push({ name: "Accounts", ok: true, note: `${doc.accounts.length}${doc.accounts.length ? ` (${parts.join(", ")})` : ""}` });
  } catch (e) {
    rows.push({ name: "Accounts", ok: false, note: e.message });
  }
  const backend = store.backend;
  const readable = backend === "file" || backend === "dpapi";
  rows.push({ name: "Secret store", ok: true, note: `${backend}${store.reason ? ` (${store.reason})` : ""}${readable ? "; tools the agent runs can read this folder's files until ad can deny it (docs/harness.md)" : ""}` });
  try {
    const findings = inspectAccounts({ root, store });
    if (findings.length) rows.push({ name: "Account repair", ok: false, note: `${findings.length} thing(s) to fix. Run: ad auth repair` });
  } catch {
    // the Accounts row already says what's wrong
  }
  return rows;
}

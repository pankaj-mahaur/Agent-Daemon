// ad 3.0's sign-ins as accounts (P3.2): an idempotent reconcile, keyed by migratedFrom.
// Run when the default home's engine starts and around every `ad auth` command.
//
//   "3.0-default-home"  the default engine home's sign-in (ChatGPT, or an OpenAI API key
//                       the engine keeps) → { method: engine-login | api-key-engine,
//                       credential: { kind: "engine-home", home: "@default" }, label: "default" };
//                       signed out later → needs-sign-in (never deleted)
//   "3.0-openrouter"    the `openrouter` secret → { method: api-key, credential: { ref: "openrouter" } }
//                       (adopted in place: 3.0 keeps finding it); gone later → needs-sign-in
//   engines.api.home    "api" when the default home holds a ChatGPT sign-in, else "@default";
//                       it only ever moves to "api" (D15: new API work never runs in a home
//                       that holds a ChatGPT sign-in)
//   defaults.target     set only when empty: 3.0's active provider and model
// Nothing is read from auth.json, no home file is moved or written, config.toml is untouched.

import { adRoot } from "../../ad-root.mjs";
import { newAccount, readRegistry, transact } from "./registry.mjs";

/**
 * @param {{ root?: string, store: any, legacy: { account: any, config: any }, now?: Date }} o
 *   legacy.account: the default home's `account/read` result (undefined: not known yet, so
 *   the sign-in rules are skipped, as before the engine starts); legacy.config: its config
 * @returns {Promise<{ created: number, updated: number }>}
 */
export async function syncLegacyAccounts({ root = adRoot(), store, legacy: { account, config = {} } = {}, now = new Date() }) {
  const accountKnown = account !== undefined;
  const signIn = account?.account ?? null;
  const hasOpenrouter = (() => {
    try {
      return store.has("openrouter");
    } catch {
      return false;
    }
  })();
  // The key is read only when its account is new or has no hint yet (on Windows a read
  // starts PowerShell), and only to show its last 4 characters.
  let openrouterHint = null;
  const known = (() => {
    try {
      return readRegistry({ root }).accounts.find((a) => a.migratedFrom === "3.0-openrouter");
    } catch {
      return null;
    }
  })();
  if (hasOpenrouter && !known?.keyHint) {
    try {
      openrouterHint = String(store.get("openrouter") ?? "").trim().slice(-4) || null;
    } catch {
      openrouterHint = null;
    }
  }
  let created = 0;
  let updated = 0;
  await transact((doc) => {
    const find = (from) => doc.accounts.find((a) => a.migratedFrom === from);
    const ready = (a, patch = {}) => {
      const before = JSON.stringify(a);
      Object.assign(a, patch);
      if (JSON.stringify(a) !== before) updated++;
    };

    // 1. The default home's sign-in.
    const home = find("3.0-default-home");
    if (!accountKnown) {
      // the engine hasn't said who is signed in yet: leave the sign-in record as it is
    } else if (signIn) {
      const provider = signIn.type === "chatgpt" ? "chatgpt" : "openai";
      const method = signIn.type === "chatgpt" ? "engine-login" : "api-key-engine";
      if (!home) {
        const a = newAccount({ provider, label: uniqueLabel(doc, provider, "default"), method, credential: { kind: "engine-home", home: "@default" }, migratedFrom: "3.0-default-home", now });
        a.status = "ready";
        doc.accounts.push(a);
        created++;
      } else ready(home, { provider, method, status: home.status === "needs-sign-in" ? "ready" : home.status, statusDetail: home.status === "needs-sign-in" ? null : home.statusDetail });
    } else if (home && home.status === "ready") ready(home, { status: "needs-sign-in", statusDetail: "signed out of the default engine home" });

    // 2. The 3.0 OpenRouter key, adopted under its own name.
    const or = find("3.0-openrouter");
    if (hasOpenrouter) {
      if (!or) {
        const a = newAccount({ provider: "openrouter", label: uniqueLabel(doc, "openrouter", "default"), method: "api-key", credential: { kind: "secret", ref: "openrouter" }, defaultModel: config?.model_provider === "openrouter" ? (config.model ?? null) : null, migratedFrom: "3.0-openrouter", now });
        a.status = "ready";
        a.keyHint = openrouterHint;
        doc.accounts.push(a);
        created++;
      } else if (or.status === "needs-sign-in" && or.credential?.ref === "openrouter") ready(or, { status: "ready", statusDetail: null, ...(openrouterHint ? { keyHint: openrouterHint } : {}) });
    } else if (or && or.status === "ready" && or.credential?.ref === "openrouter") ready(or, { status: "needs-sign-in", statusDetail: "the stored OpenRouter key was removed" });

    // 3. Where API work runs: never in a home that holds a ChatGPT sign-in; one-way.
    doc.engines ??= { api: { home: null } };
    doc.engines.api ??= { home: null };
    const chatgptHere = signIn?.type === "chatgpt";
    if (accountKnown && !doc.engines.api.home) doc.engines.api.home = chatgptHere ? "api" : "@default";
    else if (accountKnown && doc.engines.api.home === "@default" && chatgptHere) doc.engines.api.home = "api";

    // 4. The default target, only when none is chosen.
    doc.defaults ??= { target: null, digest: null };
    if (!doc.defaults.target) {
      const provider = config?.model_provider ?? "openai";
      const pick = provider === "openrouter" ? find("3.0-openrouter") : find("3.0-default-home");
      if (pick) doc.defaults.target = { account: pick.id, model: config?.model ?? null, effort: config?.model_reasoning_effort ?? null };
    }
  }, { root });
  return { created, updated };
}

// "default", unless another account of that provider has it.
function uniqueLabel(doc, provider, want) {
  const taken = new Set(doc.accounts.filter((a) => a.provider === provider).map((a) => String(a.label).toLowerCase()));
  if (!taken.has(want)) return want;
  for (let i = 2; ; i++) if (!taken.has(`${want}-${i}`)) return `${want}-${i}`;
}

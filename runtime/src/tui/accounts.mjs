// The terminal UI's accounts (P3.8b): what /model, /account, /login and /logout need,
// over the account list, the window's session and the EngineManager. main.mjs builds it;
// app.mjs only calls it (so the app stays testable with a stub).
//
//   createTuiAccounts({ session, store, launch, clientVersion, fetch, openBrowser }) → {
//     snapshot()            { accounts, defaultId, current, ready } (never throws: a list ad
//                           can't read gives no accounts)
//     current()             this window's account: the open conversation's, else the window's
//     label()               "OpenRouter · client-a" when more than one account is ready, else
//                           null; cached (the footer asks every frame), refreshed by refresh()
//     plan(a, model)        "continues" | "new": what choosing it does to the open conversation
//     models(a)             [{ id, name, free, priceObservedAt, dataNote }] (API accounts), or
//                           null for an engine's own account
//     switchTo(a, { model, effort })   → { kind: "same" | "continues" | "new" }
//     targetFor(a, model, effort)   a switch's target (P4.2): the session's fields plus label, key, account
//     currentTarget()       the window's own, the same shape
//     prepare(target)       the target's engine for a switch: { engine, release, restart, sameEngine }
//     setDefault(a, model)  the default for new sessions
//     logout(a)             → { text, wasCurrent }
//     providers()           what /login offers, then the unavailable rows
//     signIn({ provider, method, label, owner, readKey, baseUrl, noKey, signal, out })
//     reSignIn(a, { readKey })   a new key for an account that needs one (same id and label)
//     nextLabel(provider)   "default", else "default-2", …
//   }
// A window's choice lives in the session (its target), never in a file: other windows and
// `ad auth use --global` don't change it.

import fs from "node:fs";
import path from "node:path";
import { accountsDir, readRegistry, transact } from "../auth/accounts/registry.mjs";
import { createAccountService } from "../auth/accounts/service.mjs";
import { accountForProviderId, accountName, engineParamsFor, targetKey } from "../auth/accounts/target.mjs";
import { checkKeyText, keyVerdict, signInApiKey, signInCustom, signInLocal } from "../auth/accounts/signin.mjs";
import { signInOpenRouter } from "../auth/accounts/openrouter-oauth.mjs";
import { listModels } from "../providers/models.mjs";
import { presetFor, PROVIDER_PRESETS, UNAVAILABLE, visiblePresets } from "../providers/registry.mjs";
import { homeKeyFor } from "../harness/engines.mjs";
import { readCatalog, refresh as refreshCatalog } from "../providers/catalog.mjs";
import { priceText } from "../harness/auth-models.mjs";
import { AUTH_TEXTS } from "../harness/auth-texts.mjs";

const live = (doc) => doc.accounts.filter((a) => a.status !== "removing");
const keyAccount = (a) => a.credential?.kind === "secret";
const ownsHome = (a) => a.method === "engine-login" || a.credential?.kind === "engine-home";
const EMPTY = { accounts: [], defaults: { target: null }, engines: { api: { home: null } } };

export function createTuiAccounts({ session, store, launch, clientVersion, fetch, openBrowser } = {}) {
  // Never throws: a damaged or newer account list leaves the UI working (with no accounts).
  const doc = () => {
    try {
      return readRegistry();
    } catch {
      return EMPTY;
    }
  };
  const homeNow = () => session.state.config.homeKey ?? "@default";
  const providerNow = () => session.state.thread?.modelProvider ?? session.state.config.modelProvider ?? null;

  /** The target a session understands, for an account (and model). */
  const targetOf = (a, model, d = doc()) => {
    const p = engineParamsFor({ account: a, model }, d);
    let passthrough = true;
    try {
      passthrough = presetFor(a.provider).mode === "passthrough";
    } catch {
      // a provider without a preset (chatgpt): its engine speaks its own wire
    }
    return { modelProvider: p.modelProvider ?? null, homeKey: homeKeyFor({ account: a }, d), provider: a.provider, passthrough, ...(model ? { model } : {}) };
  };

  // The account a provider entry and home name (the entry alone can't tell two homes' "openai" apart).
  const accountFor = (d, mp, home) => {
    const all = live(d);
    if (mp && mp !== "openai") return accountForProviderId(d, mp);
    return all.find((a) => ownsHome(a) && (a.credential?.home ?? "@default") === home && a.status !== "removing") ?? (mp ? accountForProviderId(d, mp) : null);
  };

  // The footer asks every frame: the label is kept until the window's target or the list changes
  // (a /resume, a /new, a sign-in in another window or the CLI all move one of these).
  let cachedLabel;
  let cachedKey = null;
  const listStamp = () => {
    try {
      return fs.statSync(path.join(accountsDir(), "registry.json")).mtimeMs;
    } catch {
      return 0;
    }
  };
  const api = {
    current() {
      return accountFor(doc(), providerNow(), homeNow());
    },
    snapshot() {
      const d = doc();
      const accounts = live(d);
      return { accounts, defaultId: d.defaults?.target?.account ?? null, current: accountFor(d, providerNow(), homeNow()), ready: accounts.filter((a) => a.status === "ready").length };
    },
    refresh() {
      cachedLabel = undefined;
    },
    label() {
      const key = `${providerNow()}|${homeNow()}|${listStamp()}`;
      if (key !== cachedKey) {
        cachedKey = key;
        cachedLabel = undefined;
      }
      if (cachedLabel === undefined) {
        const s = api.snapshot();
        cachedLabel = s.ready > 1 && s.current ? accountName(s.current) : null;
      }
      return cachedLabel;
    },
    targetFor(a, model, effort) {
      const t = targetOf(a, model);
      const m = model ?? (t.homeKey === homeNow() && a.id === api.current()?.id ? session.state.config.model : null) ?? null;
      return { ...t, ...(m ? { model: m } : {}), ...(effort ? { effort } : {}), label: `${accountName(a)}${m ? ` \u{b7} ${m}` : ""}`, key: targetKey({ account: a, model: m, effort }), account: a };
    },
    currentTarget() {
      const c = session.state.config;
      const a = api.current();
      let passthrough = true;
      try {
        if (a) passthrough = presetFor(a.provider).mode === "passthrough";
      } catch {
        // an engine's own account
      }
      const label = a ? `${accountName(a)}${c.model ? ` \u{b7} ${c.model}` : ""}` : c.model ?? "this account";
      return { modelProvider: providerNow(), homeKey: c.homeKey ?? null, provider: a?.provider ?? c.provider ?? null, model: c.model ?? null, effort: c.effort ?? null, passthrough, label, key: a ? targetKey({ account: a, model: c.model, effort: c.effort }) : null, account: a ?? null };
    },
    /** The target's engine for a switch's continuation; an error's .reason says why not. */
    async prepare(t) {
      const a = t.account;
      if (!a) throw Object.assign(new Error("no account"), { reason: "engine" });
      if (a.status && a.status !== "ready") throw Object.assign(new Error(`${accountName(a)} isn't ready`), { reason: "signIn" });
      // The model, when the account lists its models (an engine's own account lists none here).
      if (t.model) {
        const listed = await api.models(a).catch(() => null);
        if (listed?.length && !listed.some((m) => m.id === t.model)) throw Object.assign(new Error(`${t.model} isn't listed for ${accountName(a)}`), { reason: "model" });
      }
      if (t.homeKey === homeNow()) return { sameEngine: true };
      const next = await launch(a);
      if (!next?.engine) throw Object.assign(new Error(next?.error ?? "the engine for that account didn't start"), { reason: "engine" });
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        await next.release?.();
      };
      return { engine: next.engine, release, restart: next.restart, sameEngine: false };
    },
    plan(a, model) {
      if (!session.state.thread) return "new";
      const t = targetOf(a, model);
      // Another engine home is always a new conversation (useEngine), whatever the entry says.
      if (t.homeKey !== homeNow()) return "new";
      return session.retarget.plan(t);
    },
    async models(a) {
      if (ownsHome(a)) return null; // an engine's own account: the engine lists them
      const key = keyAccount(a) ? store.get(a.credential.ref) : null;
      const rows = await listModels(a, { key, fetch, clientVersion });
      // The catalog's facts beside each row (P4.3): price and tools, as last seen. Its refresh
      // runs at most every 10 minutes and never holds the picker.
      void refreshCatalog(a, { key, fetch, clientVersion }).catch(() => {});
      const cat = readCatalog(a.id);
      return rows.map((m) => {
        const e = cat?.entries?.find((x) => x.model === m.id);
        if (!e) return m;
        return { ...m, ...(m.free ? {} : { priceHint: priceText(e) }), ...(e.caps?.tools === false ? { noTools: true } : {}) };
      });
    },
    /** Moves this window to an account: same engine → retarget (a fork when it continues); another home → useEngine. */
    async switchTo(a, { model, effort } = {}) {
      const d = readRegistry(); // never on a list ad can't read: its home would be guessed
      const t = targetOf(a, model, d);
      try {
        if (t.homeKey === homeNow()) {
          const r = await session.retarget(t);
          if (effort) session.setNextTurn({ effort });
          return { kind: r.kind };
        }
        const next = await launch(a);
        if (!next?.engine) throw Object.assign(new Error(next?.error ?? "the engine for that account didn't start"), { code: next?.code ?? "LAUNCH_FAILED" });
        // Released once, whoever lets it go (useEngine does when wiring the new engine fails).
        let released = false;
        const release = async () => {
          if (released) return;
          released = true;
          await next.release?.();
        };
        try {
          await session.useEngine({ engine: next.engine, release, restart: next.restart }, { ...t, model: model ?? next.params?.model ?? null });
        } catch (err) {
          // Not moved (a turn started meanwhile, …): the new engine's lease goes back. Moved
          // and failed later: the window runs on it, so it stays.
          if (session.engine !== next.engine) await release().catch(() => {});
          throw err;
        }
        if (effort) session.setNextTurn({ effort });
        return { kind: "new" };
      } finally {
        api.refresh();
      }
    },
    async setDefault(a, model) {
      await transact((x) => {
        x.defaults.target = { account: a.id, model: model ?? a.defaultModel ?? null, effort: null };
      });
      api.refresh();
    },
    async logout(a) {
      const wasCurrent = api.current()?.id === a.id;
      const service = createAccountService({ store });
      if (keyAccount(a)) {
        store.delete(a.credential.ref);
        await service.setStatus(a.id, "needs-sign-in", "signed out");
      } else if (ownsHome(a) && (a.credential?.home ?? "@default") === "@default") {
        // The main folder's sign-in lives in that engine: only a window on it can sign it out.
        if (homeNow() !== "@default") throw Object.assign(new Error(`Sign out ${accountName(a)} from a terminal: ad auth logout`), { code: "LOGOUT_ELSEWHERE" });
        await session.engine.logout();
        await service.setStatus(a.id, "needs-sign-in", "signed out");
      } else throw Object.assign(new Error(AUTH_TEXTS.CHATGPT_LATER), { code: "CHATGPT_LATER" });
      api.refresh();
      const now = api.current();
      return { wasCurrent, text: wasCurrent ? `Signed out of ${accountName(a)}. Pick an account to keep working.` : `Signed out: ${accountName(a)}. This window keeps ${now ? accountName(now) : "its account"}.` };
    },
    providers({ env = process.env } = {}) {
      const rows = visiblePresets({ env }).flatMap((p) => p.methods.map((m) => ({ id: p.id, name: p.name, method: m, label: m === "openrouter-oauth" ? `${p.name} (sign in in the browser)` : p.pickerHint ? `${p.name} · your key` : p.name, ...(p.pickerHint ? { hint: p.pickerHint } : {}) })));
      // Presets ad blocked (their reason) join the sign-ins it doesn't offer.
      const blocked = PROVIDER_PRESETS.filter((p) => p.status === "blocked").map((p) => ({ id: p.id, text: p.blockedReason ?? `${p.name}: not available yet.` }));
      return { rows, unavailable: [...UNAVAILABLE, ...blocked] };
    },
    nextLabel(provider) {
      const taken = new Set(live(doc()).filter((a) => a.provider === provider).map((a) => String(a.label).toLowerCase()));
      if (!taken.has("default")) return "default";
      for (let i = 2; ; i++) if (!taken.has(`default-${i}`)) return `default-${i}`;
    },
    async signIn({ provider, method = "api-key", label, owner = "", readKey, baseUrl, noKey = false, signal, out, confirmNotice = null }) {
      const service = createAccountService({ store });
      const common = { service, label, owner, fetch, clientVersion };
      const preset = presetFor(provider);
      try {
        if (preset.local) return await signInLocal({ ...common, provider });
        if (provider === "custom") return await signInCustom({ ...common, baseUrl, noKey, readKey, confirmProbe: async () => false });
        if (method === "openrouter-oauth") return await signInOpenRouter({ ...common, openBrowser, out, signal });
        return await signInApiKey({ ...common, provider, readKey, confirmNotice });
      } finally {
        api.refresh();
      }
    },
    /** A new key for an account that needs one: the same account (id, label), never a second one. */
    async reSignIn(a, { readKey }) {
      if (!keyAccount(a)) throw Object.assign(new Error(`${accountName(a)} signs in with ad auth login ${a.provider}.`), { code: "NOT_A_KEY_ACCOUNT" });
      const key = checkKeyText(await readKey());
      const service = createAccountService({ store });
      try {
        return await service.rekey(a.id, { key, test: keyVerdict(presetFor(a.provider), a.provider, a.label, { endpoint: a.endpoint, fetch, clientVersion, insecure: Boolean(a.insecure) }) });
      } finally {
        api.refresh();
      }
    },
  };
  return api;
}

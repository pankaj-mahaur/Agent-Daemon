// Launch: the right engine first (P3.4, T2-H5). Every entry point resolves the target
// (account, model) before any engine starts, then acquires the engine that serves it
// from this process's EngineManager, and starts its threads with that account's provider.
//
//   launchHarness({ cwd, account, model, effort, env, store, err, purpose, idleMs, ...startOpts })
//     → { engine, release(), restart() → engine, target, params: { modelProvider, model, effort }, homeKey, homeRisk }
//     | { engine: null, error, code }
//   closeHarnessEngines()   stop every engine this process started (tests, shutdown)
//
// Homes, keyed for the manager (one engine per home per ad process):
//   "@default"  ad's default engine home: 3.0's, a ChatGPT sign-in made there, and every
//               API account while it holds no ChatGPT sign-in (registry engines.api.home)
//   "api"       <root>/api: every API account once the default home holds a ChatGPT sign-in
//   "a/<id>"    an account's own home (P3.7)
// A home a command or a test chose (startOpts.home) runs as before: no accounts, no gateway.
// API accounts reach their provider through the gateway: each home gets the provider
// entries; the home that serves API work also gets the default target and retry settings
// (apiEngineArgs). A ChatGPT default home gets only 3.0's `openrouter` alias, so 3.0 API
// threads there resume and its own new threads stay on ChatGPT (D15's exception, N4).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngineManager, engineHome } from "../engine/index.mjs";
import { readRegistry } from "../auth/accounts/registry.mjs";
import { syncLegacyAccounts } from "../auth/accounts/migrate.mjs";
import { accountForProviderId, engineHomeFor, engineIdFor, engineParamsFor, resolveTarget } from "../auth/accounts/target.mjs";
import { createSecretStore } from "../auth/secrets.mjs";
import { apiEngineArgs, engineEnvFor, engineProviderArgs } from "../gateway/table.mjs";
import { gatewayState } from "./gateway-runtime.mjs";
import { adRoot } from "../ad-root.mjs";
import { accountHomePath, apiHomePath, folderTrusted } from "./settings-sync.mjs";
import { startHarnessEngine } from "./start.mjs";

const START_REFUSED = "ENGINE_START_REFUSED";
const TARGET_CODES = new Set(["TARGET_NOT_READY", "ACCOUNT_NOT_FOUND", "ACCOUNT_AMBIGUOUS", "REGISTRY_CORRUPT", "REGISTRY_NEWER"]);

/** Where a target runs: "@default" | "api" | "a/<id>". */
export function homeKeyFor(target, doc) {
  if (!target?.account) return "@default";
  return engineHomeFor(engineIdFor(target.account, doc), doc);
}

export const homePathFor = (key) => (key === "@default" ? undefined : key === "api" ? apiHomePath() : accountHomePath(key.slice(2)));

/**
 * The home that runs API work: registry engines.api.home, "@default" only once ad knows
 * the default home holds no ChatGPT sign-in. Unknown (null, before an engine there said
 * who is signed in): api/, the same fallback engineHomeFor uses, so API targets go there
 * with their entries and the default home gets only 3.0's alias (D15).
 */
const servesApi = (key, doc) => key === (doc.engines?.api?.home ?? "api");

/** One home's gateway arguments (pure: the table, the gateway's addresses, the registry). */
export function homeArgs(key, { table, gateway, doc }) {
  const all = engineProviderArgs(table, { gateway, doc });
  if (servesApi(key, doc)) return [...all, ...apiEngineArgs(doc, table)];
  if (key === "@default") {
    // A ChatGPT (or not yet known) default home: 3.0's alias only.
    const out = [];
    for (let i = 0; i < all.length; i += 2) if (all[i + 1].startsWith("model_providers.openrouter=")) out.push(all[i], all[i + 1]);
    return out;
  }
  return []; // an account's own home: no API entries
}

/**
 * The project's target selector: the nearest `.agent-daemon/config.json` above cwd. Never
 * the home folder's, and never ad's own folder's (its config.json is ad's, not a project's).
 */
export function readProjectSelector(cwd, { home = os.homedir(), root = adRoot() } = {}) {
  if (!cwd) return null;
  const stop = engineHome.canonical(home);
  const own = engineHome.canonical(root);
  let dir = path.resolve(cwd);
  for (let i = 0; i < 64; i++) {
    if (engineHome.canonical(dir) === stop) return null;
    const folder = path.join(dir, ".agent-daemon");
    const f = path.join(folder, "config.json");
    if (engineHome.canonical(folder) !== own && fs.existsSync(f)) {
      try {
        const target = JSON.parse(fs.readFileSync(f, "utf8"))?.target;
        return target ? { dir, target } : null;
      } catch {
        return null;
      }
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

// Engines are keyed by home and by the caller's start options ("<home>#<profile>"): two
// callers in one process with different options (an unattended worker that declines
// every approval, a chat that asks) never share an engine.
let manager = null;
let shared = null; // { store, err, env } of the first caller: the gateway's
const profiles = new Map(); // profile id → { store, err, env, startOpts }
const profileIds = new Map(); // options key → profile id
const fnIds = new WeakMap();
let fnSeq = 0;
const fnId = (fn) => {
  if (typeof fn !== "function") return null;
  if (!fnIds.has(fn)) fnIds.set(fn, ++fnSeq);
  return fnIds.get(fn);
};

function profileFor({ store, err, env, ...startOpts }) {
  const key = JSON.stringify({ env: env ?? null, fns: Object.entries(startOpts).filter(([, v]) => typeof v === "function").map(([k, v]) => [k, fnId(v)]), opts: Object.fromEntries(Object.entries(startOpts).filter(([, v]) => typeof v !== "function")) });
  if (!profileIds.has(key)) {
    const id = profileIds.size + 1;
    profileIds.set(key, id);
    profiles.set(id, { store, err, env, startOpts });
  }
  return profileIds.get(key);
}

const engineKeyOf = (homeKey, profile) => `${homeKey}#${profile}`;
const homeOf = (engineKey) => engineKey.slice(0, engineKey.lastIndexOf("#"));

function harnessManager({ store, err, idleMs, env }) {
  if (manager) return manager;
  shared = { store, err, env };
  const gw = async () => {
    try {
      return await gatewayState({ store: shared.store, env: { ...process.env, ...(shared.env ?? {}) } });
    } catch (e) {
      shared.err.write(`[agent-daemon] the provider gateway didn't start (${e.message.split("\n")[0]}); API accounts are unavailable this run\n`);
      return null;
    }
  };
  manager = createEngineManager({
    idleMs,
    homeFor: (key) => homePathFor(homeOf(key)),
    argsFor: async (key) => {
      const s = await gw();
      return s ? homeArgs(homeOf(key), s) : [];
    },
    envFor: async () => {
      const s = await gw();
      return s ? engineEnvFor({ gateway: s.gateway, env: { ...process.env, ...(shared.env ?? {}) } }) : {};
    },
    factory: async ({ engineId: key, home, env: gwEnv, args, cwd }) => {
      const o = profiles.get(Number(key.slice(key.lastIndexOf("#") + 1)));
      const r = await startHarnessEngine({
        ...o.startOpts,
        cwd,
        home,
        store: o.store,
        err: o.err,
        env: o.env,
        gateway: { env: gwEnv, args },
        // ad's api home holds no engine sign-in: its accounts are ad's own.
        loginGate: homeOf(key) !== "api",
      });
      if (!r.engine) throw Object.assign(new Error(r.error), { code: START_REFUSED, exitCode: r.code });
      r.engine.homeRisk = r.homeRisk ?? null;
      return r.engine;
    },
  });
  return manager;
}

/**
 * "ad tui --resume <tid>", naming the thread's account when it isn't the one ad would pick
 * by default (T2-M12). modelProvider: the thread's provider entry.
 */
export function resumeHint(threadId, modelProvider, { doc } = {}) {
  let named = null;
  try {
    doc ??= readRegistry();
    const a = modelProvider ? accountForProviderId(doc, modelProvider) : null;
    const byDefault = doc.defaults?.target?.account ?? null;
    if (a && a.id !== byDefault) named = `${a.provider}/${a.label}`;
  } catch {
    // no account list: the plain hint
  }
  return `ad tui --resume ${threadId}${named ? ` --account ${named}` : ""}`;
}

/** A thread's provider entry → the window's target for it: { modelProvider, provider, model }. */
export function windowTarget(modelProvider, { doc } = {}) {
  let a = null;
  try {
    a = modelProvider ? accountForProviderId(doc ?? readRegistry(), modelProvider) : null;
  } catch {
    // no account list: the provider entry alone
  }
  return { modelProvider: modelProvider ?? null, provider: a?.provider ?? null, ...(a?.defaultModel ? { model: a.defaultModel } : {}) };
}

export const REMOVED_ACCOUNT_TEXT = (entry) => `This conversation used an account you removed (${entry}). Start a new conversation; carrying it over comes in a later release.`;

/** A thread whose provider entry is an ad account that no longer exists → the text to show, else null. */
export function removedAccountText(modelProvider, { doc } = {}) {
  if (!/^ad-/.test(modelProvider ?? "")) return null;
  try {
    doc ??= readRegistry();
  } catch {
    return null;
  }
  return accountForProviderId(doc, modelProvider) ? null : REMOVED_ACCOUNT_TEXT(modelProvider);
}

// The other homes on this machine: the default home always, api/ once it exists.
function otherHomeKeys(current) {
  const keys = ["@default"];
  if (fs.existsSync(apiHomePath())) keys.push("api");
  return keys.filter((k) => k !== current);
}

/**
 * A thread another home holds (--resume <tid> without --account): each other home's engine
 * is started (or reused) and asked → { engine, release, restart, homeKey, thread } | null.
 * Only for this process's manager (a home a command chose has no others).
 */
export async function findThreadHome(threadId, { currentKey, cwd, profile = 1 } = {}) {
  if (!manager) return null;
  for (const key of otherHomeKeys(currentKey)) {
    let lease;
    try {
      lease = await manager.acquire(engineKeyOf(key, profile), { cwd, purpose: "resume lookup" });
    } catch {
      continue;
    }
    const thread = await lease.engine.threads.read(threadId).catch(() => null);
    if (thread) {
      const m = manager;
      return { engine: lease.engine, release: () => lease.release(), restart: () => m.restart(engineKeyOf(key, profile)), homeKey: key, thread };
    }
    await lease.release();
  }
  return null;
}

/** --last across homes: the newest thread for this folder in any home → { threadId, homeKey } | null. */
export async function newestThreadAcrossHomes({ currentKey, engine, cwd, profile = 1 } = {}) {
  const sourceKinds = ["cli", "vscode", "exec", "appServer"];
  const best = [];
  const mine = await engine.threads.list({ cwd, limit: 1, sourceKinds }).catch(() => []);
  if (mine[0]) best.push({ threadId: mine[0].id, homeKey: currentKey, at: mine[0].updatedAt ?? 0 });
  if (manager) {
    for (const key of otherHomeKeys(currentKey)) {
      let lease;
      try {
        lease = await manager.acquire(engineKeyOf(key, profile), { cwd, purpose: "resume lookup" });
      } catch {
        continue;
      }
      const t = await lease.engine.threads.list({ cwd, limit: 1, sourceKinds }).catch(() => []);
      if (t[0]) best.push({ threadId: t[0].id, homeKey: key, at: t[0].updatedAt ?? 0 });
      await lease.release();
    }
  }
  best.sort((a, b) => b.at - a.at);
  return best[0] ?? null;
}

export async function closeHarnessEngines() {
  const m = manager;
  manager = null;
  shared = null;
  profiles.clear();
  profileIds.clear();
  await m?.closeAll();
}

/**
 * @param {{ cwd?: string, account?: string, model?: string, effort?: string, env?: any,
 *   store?: any, err?: any, purpose?: string, idleMs?: number, home?: string }} o
 *   idleMs: how long an engine no one uses stays (0: one-shot commands stop it at release)
 *   pin: the engine stays until closeHarnessEngines (the terminal UI's own)
 */
export async function launchHarness({ cwd, account, model, effort, env, store, err = process.stderr, purpose = null, idleMs = 0, pin = false, ...startOpts } = {}) {
  if (startOpts.home) {
    const start = () => startHarnessEngine({ cwd, store, err, env, ...startOpts });
    const r = await start();
    if (!r.engine) return r;
    // restart: a new engine on that home (the caller closed or lost the old one).
    const restart = async () => {
      const again = await start();
      if (!again.engine) throw new Error(again.error);
      return again.engine;
    };
    return { engine: r.engine, homeRisk: r.homeRisk ?? null, target: null, params: { model }, homeKey: null, release: () => r.engine.close(), restart };
  }
  store ??= createSecretStore();
  let doc;
  let target;
  try {
    // ad 3.0's key as an account before anything is resolved (the sign-in itself is
    // judged when the default home's engine starts).
    await syncLegacyAccounts({ store, legacy: { account: undefined, config: {} } });
    doc = readRegistry();
    const sel = readProjectSelector(cwd);
    target = resolveTarget({ explicit: { account, model, effort }, env: { ...process.env, ...(env ?? {}) }, project: sel?.target ?? null, projectTrusted: sel ? folderTrusted(sel.dir) : false, doc });
  } catch (e) {
    if (TARGET_CODES.has(e.code)) return { engine: null, error: e.message, code: 2 };
    throw e;
  }
  for (const n of target.notes) err.write(`[agent-daemon] ${n.text}\n`);
  const key = homeKeyFor(target, doc);
  const profile = profileFor({ store, err, env, ...startOpts });
  let lease;
  try {
    lease = await harnessManager({ store, err, idleMs, env }).acquire(engineKeyOf(key, profile), { cwd, purpose, pin });
  } catch (e) {
    if (e.code === START_REFUSED) return { engine: null, error: e.message, code: e.exitCode };
    throw e;
  }
  const p = engineParamsFor(target, doc);
  const m = manager;
  return { engine: lease.engine, lease, homeRisk: lease.engine.homeRisk ?? null, target, params: { modelProvider: p.modelProvider, model: p.model ?? model, effort: p.effort ?? effort }, homeKey: key, profile, release: () => lease.release(), restart: () => m.restart(engineKeyOf(key, profile)) };
}

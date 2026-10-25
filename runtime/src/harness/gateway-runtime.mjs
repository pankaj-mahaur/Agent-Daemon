// The gateway for this ad process (P3.3): started on the first engine that needs it,
// kept for the process's life (one port, one token across engine restarts). Only for
// ad's default engine home (the user's real accounts): a home a command or a test chose
// gets no gateway and no account. P3.4's EngineManager uses gatewayState for its homes.
//
//   gatewayEngineOpts({ home, store, env }) → { env, args } to add to an engine start
//     env: AD_GATEWAY_TOKEN and NO_PROXY; never a key
//     args: a -c provider entry per ready API account, and the 3.0 `openrouter` alias

import { randomBytes, randomUUID } from "node:crypto";
import { engineHome } from "../engine/index.mjs";
import { registerSecret } from "../auth/redact.mjs";
import { readRegistry } from "../auth/accounts/registry.mjs";
import { syncLegacyAccounts } from "../auth/accounts/migrate.mjs";
import { createSecretStore } from "../auth/secrets.mjs";
import { startGateway } from "../gateway/client.mjs";
import { engineEnvFor, engineProviderArgs, gatewayTable, threadConfigFor, TOKEN_HIDDEN_ARGS } from "../gateway/table.mjs";

let shared = null; // { gateway, tableKey }
// This ad session's id for providers that want one (OpenCode Go outside a conversation):
// made once per ad process, so a gateway started again sends the same value.
const SESSION_ID = randomUUID();

// The reasoning envelope's key (P6.1 §7): 32 random bytes per install, in ad's secret store.
const SEAL_REF = "gateway-seal";
// A store that can't be read leaves the envelope off (null): the gateway and every other
// account still start, and a key that exists is never replaced because one read failed.
export function sealKeyFrom(store) {
  let k;
  try {
    k = store.get(SEAL_REF);
  } catch {
    return null;
  }
  if (k && Buffer.from(k, "base64").length === 32) {
    registerSecret(k, "gateway seal key");
    return k;
  }
  if (k) return null; // something else under ad's name: left alone
  try {
    k = randomBytes(32).toString("base64");
    store.set(SEAL_REF, k);
  } catch {
    return null;
  }
  registerSecret(k, "gateway seal key");
  return k;
}

/** AD_TRANSLATE=0 turns translated providers off (their routes answer 502 with the reason). */
export const translateEnabled = (env = process.env) => env.AD_TRANSLATE !== "0";
const isDefaultHome = (home) => engineHome.canonical(home ?? engineHome.defaultPath()) === engineHome.canonical(engineHome.defaultPath());

/**
 * The process's gateway and what it routes (P3.4: the EngineManager builds each home's
 * arguments from it) → { gateway, table, doc }, or null when no API account is ready and
 * no gateway runs yet. Adopts ad 3.0's key first. Throws when the gateway can't start.
 */
export async function gatewayState({ store, env = process.env } = {}) {
  store ??= createSecretStore();
  // ad 3.0's key is adopted before the engine starts (the sign-in itself is judged
  // after, when the engine can say who is signed in).
  await syncLegacyAccounts({ store, legacy: { account: undefined, config: {} } });
  const doc = readRegistry();
  const table = gatewayTable(doc);
  if (!table.size && !shared) return null;
  const getKeys = async (ids) => {
    const refs = new Map(ids.map((id) => [id, doc.accounts.find((a) => a.id === id)?.credential?.ref]).filter(([, r]) => r));
    const values = store.getMany([...new Set(refs.values())]);
    return Object.fromEntries([...refs].map(([id, ref]) => [id, values.get(ref)]).filter(([, v]) => v));
  };
  const tableKey = JSON.stringify([...table]);
  if (!shared) shared = { gateway: await startGateway({ table, getKeys, env, sealKey: sealKeyFrom(store), translate: translateEnabled(env), sessionId: SESSION_ID }), tableKey };
  else if (shared.tableKey !== tableKey) {
    await shared.gateway.setTable(table);
    shared.tableKey = tableKey;
  }
  return { gateway: shared.gateway, table, doc };
}

export async function gatewayEngineOpts({ home, store, env = process.env, err = process.stderr } = {}) {
  if (!isDefaultHome(home)) return { env: {}, args: [] };
  try {
    const s = await gatewayState({ store, env });
    if (!s) return { env: {}, args: [] };
    return { env: engineEnvFor({ gateway: s.gateway, env }), args: [...engineProviderArgs(s.table, { gateway: s.gateway, doc: s.doc }), ...TOKEN_HIDDEN_ARGS], threadConfigFor: (t) => threadConfigFor(s.table, t) };
  } catch (e) {
    err.write(`[agent-daemon] the provider gateway didn't start (${e.message.split("\n")[0]}); API accounts are unavailable this run\n`);
    return { env: {}, args: [] };
  }
}

/** The running gateway's last observation for an account (ad auth status, /status). */
export const lastUpstream = (accountId) => shared?.gateway.last(accountId) ?? null;

// What a translated turn's failure really was (P6.1 §6): the engine only knows generic
// codes ("Quota exceeded. Check your plan…" even for a free daily limit), the gateway knows
// the provider's reason. Kinds that end a turn; a truncation or a filter is the engine's to say.
const REASON_KINDS = new Set(["quotaExhausted", "rateLimit", "contextOverflow", "provider5xx", "authExpired", "authRevoked", "invalidConfig", "transientNetwork", "unknown"]);
/**
 * ad's own words for the last classified upstream failure in one conversation (the engine's
 * thread id), if its request started at or after the turn did (`sinceMs`); else null. Never
 * another window's, worker's or ad's own background call's: those are other threads.
 */
export function gatewayReason({ threadId, sinceMs, source = shared?.gateway } = {}) {
  if (!threadId || !Number.isFinite(sinceMs) || sinceMs <= 0) return null;
  const e = source?.lastForThread?.(threadId);
  if (!e?.translate?.message || !REASON_KINDS.has(e.translate.kind)) return null;
  if (Date.parse(e.at) < sinceMs) return null;
  return e.translate.message;
}

/** Tests and shutdown. */
export async function closeGateway() {
  await shared?.gateway.close();
  shared = null;
}

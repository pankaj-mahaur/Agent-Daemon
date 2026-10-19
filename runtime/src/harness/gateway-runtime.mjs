// The gateway for this ad process (P3.3): started on the first engine that needs it,
// kept for the process's life (one port, one token across engine restarts). Only for
// ad's default engine home (the user's real accounts): a home a command or a test chose
// gets no gateway and no account. P3.4's EngineManager takes this over.
//
//   gatewayEngineOpts({ home, store, env }) → { env, args } to add to an engine start
//     env: AD_GATEWAY_TOKEN and NO_PROXY; never a key
//     args: a -c provider entry per ready API account, and the 3.0 `openrouter` alias

import { engineHome } from "../engine/index.mjs";
import { readRegistry } from "../auth/accounts/registry.mjs";
import { syncLegacyAccounts } from "../auth/accounts/migrate.mjs";
import { createSecretStore } from "../auth/secrets.mjs";
import { startGateway } from "../gateway/client.mjs";
import { engineEnvFor, engineProviderArgs, gatewayTable } from "../gateway/table.mjs";

let shared = null; // { gateway, tableKey }
const isDefaultHome = (home) => engineHome.canonical(home ?? engineHome.defaultPath()) === engineHome.canonical(engineHome.defaultPath());

export async function gatewayEngineOpts({ home, store, env = process.env, err = process.stderr } = {}) {
  if (!isDefaultHome(home)) return { env: {}, args: [] };
  store ??= createSecretStore();
  try {
    // ad 3.0's key is adopted before the engine starts (the sign-in itself is judged
    // after, when the engine can say who is signed in).
    await syncLegacyAccounts({ store, legacy: { account: undefined, config: {} } });
    const doc = readRegistry();
    const table = gatewayTable(doc);
    if (!table.size && !shared) return { env: {}, args: [] };
    const getKeys = async (ids) => {
      const refs = new Map(ids.map((id) => [id, doc.accounts.find((a) => a.id === id)?.credential?.ref]).filter(([, r]) => r));
      const values = store.getMany([...new Set(refs.values())]);
      return Object.fromEntries([...refs].map(([id, ref]) => [id, values.get(ref)]).filter(([, v]) => v));
    };
    const tableKey = JSON.stringify([...table]);
    if (!shared) shared = { gateway: await startGateway({ table, getKeys, env }), tableKey };
    else if (shared.tableKey !== tableKey) {
      await shared.gateway.setTable(table);
      shared.tableKey = tableKey;
    }
    return { env: engineEnvFor({ gateway: shared.gateway, env }), args: engineProviderArgs(table, { gateway: shared.gateway, doc }) };
  } catch (e) {
    err.write(`[agent-daemon] the provider gateway didn't start (${e.message.split("\n")[0]}); API accounts are unavailable this run\n`);
    return { env: {}, args: [] };
  }
}

/** The running gateway's last observation for an account (ad auth status, /status). */
export const lastUpstream = (accountId) => shared?.gateway.last(accountId) ?? null;

/** Tests and shutdown. */
export async function closeGateway() {
  await shared?.gateway.close();
  shared = null;
}

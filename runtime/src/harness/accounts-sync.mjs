// The 3.0 sign-ins as accounts (P3.2 migrate.mjs), from a running engine: only for
// ad's default engine home (3.0's), never for a home a command or test chose. A
// failure here never stops a start or an auth command: the next one tries again.

import { engineHome } from "../engine/index.mjs";
import { syncLegacyAccounts } from "../auth/accounts/migrate.mjs";
import { createSecretStore } from "../auth/secrets.mjs";

export async function syncAccountsFromEngine(engine, { store, acct, err = process.stderr } = {}) {
  // No store given (a caller that never needed one): the real one, or the 3.0 key
  // would look gone and its account would be marked as needing sign-in.
  store ??= createSecretStore();
  try {
    if (!engine?.home || engineHome.canonical(engine.home) !== engineHome.canonical(engineHome.defaultPath())) return null;
    const account = acct ?? (await engine.account());
    const config = await engine.readConfig().catch(() => ({}));
    return await syncLegacyAccounts({ store, legacy: { account, config } });
  } catch (e) {
    err.write(`[agent-daemon] accounts: ${e.message.split("\n")[0]}\n`);
    return null;
  }
}

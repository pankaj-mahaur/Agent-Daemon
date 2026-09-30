// Start the harness engine the way every entry point needs it:
// create → check login → wire memory/hooks/skills (setup.mjs) → restart once
// if setup changed something the running app-server caches (Windows sandbox).
// Used by `ad run`, `ad chat` and team workers.

import { createEngine } from "../engine/index.mjs";
import { providerEnv } from "../auth/providers.mjs";
import { ensureHarnessSetup } from "./setup.mjs";

export const NOT_LOGGED_IN = "Not logged in. Run: ad auth login chatgpt   (or: ad auth login openai | ad auth login openrouter --model <slug>)";

export async function startHarnessEngine({ cwd, home, command, clientVersion, store, onApproval, err = process.stderr, setup = true, platform } = {}) {
  const engineOpts = { cwd, home, command, clientVersion, env: providerEnv(store), onApproval };
  let engine = await createEngine(engineOpts);
  try {
    const acct = await engine.account();
    if (acct.requiresOpenaiAuth && !acct.account) {
      await engine.close();
      return { engine: null, error: NOT_LOGGED_IN, code: 2 };
    }
    if (setup) {
      let report = await safeSetup(engine, { cwd, platform }, err);
      if (report?.restartEngine) {
        await engine.close();
        engine = await createEngine(engineOpts);
        report = await safeSetup(engine, { cwd, platform }, err);
      }
    }
    return { engine };
  } catch (e) {
    await engine.close();
    throw e;
  }
}

async function safeSetup(engine, opts, err) {
  try {
    const report = await ensureHarnessSetup(engine, opts);
    for (const w of report.warnings) err.write(`[agent-daemon] harness setup: ${w}\n`);
    if (report.sandboxConfigured) err.write(`[agent-daemon] set up the Windows sandbox (${report.sandboxConfigured}); for stronger isolation run: ad sandbox setup --elevated\n`);
    return report;
  } catch (e) {
    // Memory/hooks are an enhancement; a setup failure must not block the run.
    err.write(`[agent-daemon] harness setup incomplete: ${e.message}\n`);
    return null;
  }
}

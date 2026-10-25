// `ad auth repair [--yes]` (P3.2): fix interrupted sign-ins and keys without an account.
// A terminal asks per row; --yes answers yes; without a terminal and without --yes it
// prints what it found and exits 1. Never prints a key.

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createSecretStore } from "../auth/secrets.mjs";
import { inspectAccounts, repairAccounts } from "../auth/accounts/reconcile.mjs";
import { adRoot } from "../ad-root.mjs";
import { AUTH_TEXTS } from "./auth-texts.mjs";

export async function cmdAuthRepair({ root = adRoot(), store = createSecretStore(), out = process.stdout, err = process.stderr, yes = false, isTTY = () => Boolean(input.isTTY && output.isTTY), ask, env = process.env } = {}) {
  // D49: account changes refuse in the agent's own shell (P3.8a).
  if (env.AD_TOOL_SHELL === "1") {
    err.write(`ad auth: ${AUTH_TEXTS.TOOL_SHELL}\n`);
    return 2;
  }
  const findings = inspectAccounts({ root, store });
  if (!findings.length) {
    out.write("Nothing to repair: every account and stored key is in order.\n");
    return 0;
  }
  const asking = findings.filter((f) => !f.auto);
  if (asking.length && !yes && !isTTY()) {
    for (const f of findings) out.write(`  ${f.auto ? "·" : "?"} ${f.text}\n`);
    err.write("Run ad auth repair in a terminal to answer each question, or add --yes to answer yes to all.\n");
    return 1;
  }
  let rl = null;
  const question = ask ?? (async (q) => {
    rl ??= readline.createInterface({ input, output });
    return rl.question(q);
  });
  try {
    const done = await repairAccounts(findings, {
      root,
      store,
      confirm: async (f) => yes || /^y(es)?$/i.test(String(await question(`${f.text} [y/N] `)).trim()),
    });
    for (const d of done) out.write(`  ${d.done ? "✓" : "·"} ${d.text}${d.done ? "" : " (left as it is)"}\n`);
    return 0;
  } finally {
    rl?.close();
  }
}

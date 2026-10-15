// `ad codex [args…]`: kept until Part 3 replaces it with a tombstone. The
// implementation lives in the adapter (engine/codex/stock-ui.mjs).

import { engineDebugUi } from "../engine/index.mjs";

export async function cmdCodex(args = [], opts = {}) {
  try {
    return await engineDebugUi.run({ args, cwd: opts.cwd ?? process.cwd(), home: opts.home, store: opts.store });
  } catch (err) {
    (opts.stderr ?? process.stderr).write(`ad codex: ${err.message}\n`);
    return 1;
  }
}

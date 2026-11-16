// `report --purge` (MCP launch plan L8, design decision 13; the L4b handover): this
// project's history-import rows and the history notes still waiting for review, hard
// deleted. Only the CLIs load it (memory-install/cli.mjs, cli.mjs), so the plugin's report
// never loads the history import.

/**
 * `report --purge` (L4b handover, design decision 13): this project's history rows and the
 * history notes still waiting for review, hard deleted. Your own terminal and a typed y.
 */
export async function purgeCommand(handle, { keys, out, token, ask, now }) {
  if (!Array.isArray(keys) || !keys.length) {
    out("Nothing to purge: --purge works on this project (run it in the project's folder, without --all-projects).");
    return 1;
  }
  const askLine = ask ?? (async (q) => {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(q);
    } finally {
      rl.close();
    }
  });
  const { cliToken } = await import("./memory-cli.mjs");
  const t = await cliToken({ token, ask: askLine, out });
  if (!t.token) {
    out(`Nothing removed: purging needs your own terminal (${t.refused}).`);
    return 2;
  }
  const yes = String(await askLine("Remove what the history import found in this project (its sentences and the notes from it still waiting for review)? Accepted notes stay. (y/N) ")).trim().toLowerCase();
  if (yes !== "y" && yes !== "yes") {
    out("Nothing removed.");
    return 1;
  }
  const { purgeHistory } = await import("./history-import.mjs");
  const r = purgeHistory(handle, keys);
  out(`Removed ${r.rows} history row${r.rows === 1 ? "" : "s"} and ${r.notes} note${r.notes === 1 ? "" : "s"} waiting for review.`);
  return 0;
}

/** `report --purge` from a CLI: this folder's project. → exit code */
export async function reportPurgeMain(argv, { cwd = process.cwd(), out = (l) => console.log(l), handle: given, keys: givenKeys, token, ask, now = Date.now() } = {}) {
  argv = argv.flatMap((a) => (/^--[\w-]+=/.test(a) ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a]));
  const at = argv.indexOf("--cwd"); // ad's global flag
  if (at >= 0) cwd = argv[at + 1] ?? cwd;
  const other = argv.filter((a, i) => a !== "--purge" && i !== at && i !== at + 1);
  if (other.length) {
    out(`report --purge takes no other option (${other.join(" ")})`);
    return 1;
  }
  const { db } = await import("./episodic.mjs");
  const handle = given ?? (await db());
  if (!handle) {
    out("The memory store is unavailable (run doctor).");
    return 1;
  }
  const keys = givenKeys !== undefined ? givenKeys : await (await import("./scope.mjs")).hookProjectKeys(cwd);
  return purgeCommand(handle, { keys, out, token, ask, now });
}

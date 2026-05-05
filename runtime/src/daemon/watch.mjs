// Watch daemon — chokidar fswatch over configured transcript dirs.
//
// For each watched path, fires `agent-daemon digest` on transcripts that:
//   1. Match the configured glob pattern
//   2. Have been quiet (no writes) for at least `debounceMs`
//   3. Have stable size across two `stableCheckIntervalMs` polls
//   4. Aren't already marked digested in SQLite (if skipDigested=true)
//
// Runs foreground until Ctrl+C. OS service registration (so this runs at
// login automatically) lands in Stream F.

import path from "node:path";
import fs from "node:fs/promises";
import { runDigest } from "../digest/digest.mjs";
import { loadConfig } from "./config.mjs";

/**
 * @param {{
 *   projectRoot: string,
 *   verbose?: boolean,
 *   onceOnExisting?: boolean   - run digest on existing files at startup; default false
 * }} opts
 * @returns {Promise<number>} resolves when watcher exits
 */
export async function runWatcher(opts) {
  let chokidar;
  try {
    chokidar = (await import("chokidar")).default || (await import("chokidar"));
  } catch {
    console.error("agent-daemon watch: chokidar not installed. Run: cd runtime && npm install");
    return 1;
  }

  const config = await loadConfig();
  if (!config.watch || config.watch.length === 0) {
    console.error(`agent-daemon watch: no entries in watch.json. Edit ${process.env.HOME || process.env.USERPROFILE}/.agent-daemon/watch.json to add paths.`);
    return 1;
  }

  // Validate / filter to existing paths
  const existing = [];
  for (const entry of config.watch) {
    const stat = await fs.stat(entry.path).catch(() => null);
    if (stat?.isDirectory()) {
      existing.push(entry);
    } else if (opts.verbose) {
      console.error(`  (skip ${entry.path} — not a directory)`);
    }
  }
  if (existing.length === 0) {
    console.error("agent-daemon watch: none of the configured paths exist. Edit watch.json.");
    return 1;
  }

  console.error(`agent-daemon watch: monitoring ${existing.length} path(s)`);
  for (const e of existing) {
    console.error(`  ${e.path}/${e.pattern}  (adapter=${e.adapter || "auto"})`);
  }
  console.error(`  debounce: ${config.debounceMs}ms, stable poll: ${config.stableCheckIntervalMs}ms`);
  console.error("  press Ctrl+C to stop\n");

  const pendingDigests = new Map();  // filepath → setTimeout handle
  const inFlight       = new Set();  // currently running digest paths
  const lastSizes      = new Map();  // filepath → size at last poll

  function scheduleDigest(filepath, entry) {
    if (inFlight.has(filepath)) return;
    if (pendingDigests.has(filepath)) clearTimeout(pendingDigests.get(filepath));
    const handle = setTimeout(() => fireDigestIfStable(filepath, entry), config.debounceMs);
    pendingDigests.set(filepath, handle);
  }

  async function fireDigestIfStable(filepath, entry) {
    pendingDigests.delete(filepath);

    // Stability check: poll size twice, both equal
    let stat;
    try { stat = await fs.stat(filepath); } catch { return; }
    const sizeA = stat.size;
    await new Promise(r => setTimeout(r, config.stableCheckIntervalMs));
    let stat2;
    try { stat2 = await fs.stat(filepath); } catch { return; }
    if (stat2.size !== sizeA) {
      // still being written — reschedule
      scheduleDigest(filepath, entry);
      return;
    }
    lastSizes.set(filepath, sizeA);

    // Run the digest
    inFlight.add(filepath);
    const t0 = Date.now();
    if (opts.verbose) console.error(`agent-daemon: digesting ${path.basename(filepath)}`);
    try {
      await runDigest({
        transcript: filepath,
        cwd: path.dirname(filepath),
        projectRoot: opts.projectRoot,
        adapter: entry.adapter,
        verbose: false  // keep watch output less noisy
      });
      console.error(`agent-daemon: digested ${path.basename(filepath)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (err) {
      console.error(`agent-daemon: digest failed for ${path.basename(filepath)}: ${err.message}`);
    } finally {
      inFlight.delete(filepath);
    }
  }

  // Start a watcher per configured entry (chokidar can take an array but
  // per-entry adapter binding is cleaner).
  const watchers = [];
  for (const entry of existing) {
    const globPattern = path.join(entry.path, entry.pattern).replace(/\\/g, "/");
    const watcher = chokidar.watch(globPattern, {
      ignoreInitial: !opts.onceOnExisting,
      persistent: true,
      awaitWriteFinish: false  // we do our own stability check
    });
    watcher
      .on("add",    p => scheduleDigest(p, entry))
      .on("change", p => scheduleDigest(p, entry))
      .on("error",  e => console.error(`agent-daemon: watch error: ${e.message}`));
    watchers.push(watcher);
  }

  // Block until Ctrl+C
  return new Promise((resolve) => {
    const cleanup = async () => {
      console.error("\nagent-daemon: stopping watch...");
      for (const w of watchers) await w.close().catch(() => {});
      resolve(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  });
}

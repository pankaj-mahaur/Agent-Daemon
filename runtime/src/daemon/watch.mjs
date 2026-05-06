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
import { readInbox, ackMessage } from "../orchestration/inbox.mjs";
import { updateTaskStatus, listTasks, listTeams, isTeamComplete } from "../orchestration/team.mjs";

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

  // Team inbox monitoring — poll for task-complete messages and auto-unblock
  const INBOX_POLL_MS = 10000;
  const inboxPollHandle = setInterval(async () => {
    try {
      await pollTeamInboxes(opts.verbose);
    } catch (err) {
      if (opts.verbose) console.error(`agent-daemon: inbox poll error: ${err.message}`);
    }
  }, INBOX_POLL_MS);

  // Block until Ctrl+C (guard against double-fire)
  return new Promise((resolve) => {
    let shuttingDown = false;
    const cleanup = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.error("\nagent-daemon: stopping watch...");
      clearInterval(inboxPollHandle);
      for (const h of pendingDigests.values()) clearTimeout(h);
      pendingDigests.clear();
      for (const w of watchers) await w.close().catch(() => {});
      resolve(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  });
}

async function pollTeamInboxes(verbose) {
  let teams;
  try {
    teams = await listTeams();
  } catch (err) {
    if (verbose) console.error(`agent-daemon: failed to list teams: ${err.message}`);
    return;
  }

  for (const team of teams) {
    try {
      const leaders = (team.roles || []).filter(r => r.is_leader).map(r => r.name);
      if (leaders.length === 0) continue;

      for (const leader of leaders) {
        let messages;
        try {
          messages = await readInbox(team.id, leader);
        } catch (err) {
          if (verbose) console.error(`agent-daemon: [team ${team.id}] inbox read error for ${leader}: ${err.message}`);
          continue;
        }

        for (const msg of messages) {
          if (msg.type !== "task-complete") continue;

          if (verbose) {
            console.error(`agent-daemon: [team ${team.id}] ${msg.from} completed (${msg.payload?.status || "unknown"})`);
          }

          try {
            const tasks = await listTasks(team.id);
            // Match by role OR by agent name (from field) for robustness
            const ownerTask = tasks.find(t =>
              (t.owner === msg.payload?.role || t.owner === msg.from) &&
              (t.status === "in_progress" || t.status === "pending")
            );
            if (ownerTask && msg.payload?.status === "completed") {
              const { unblocked } = await updateTaskStatus(team.id, ownerTask.id, "completed");
              if (unblocked.length > 0 && verbose) {
                console.error(`agent-daemon: [team ${team.id}] unblocked: ${unblocked.map(t => t.title).join(", ")}`);
              }
            }
          } catch (err) {
            if (verbose) console.error(`agent-daemon: [team ${team.id}] task update error: ${err.message}`);
          }

          try {
            await ackMessage(team.id, leader, msg.id);
          } catch (err) {
            if (verbose) console.error(`agent-daemon: [team ${team.id}] ack error: ${err.message}`);
          }

          try {
            if (await isTeamComplete(team.id)) {
              console.error(`agent-daemon: [team ${team.id}] ALL TASKS COMPLETE`);
            }
          } catch { /* non-critical */ }
        }
      }
    } catch (err) {
      if (verbose) console.error(`agent-daemon: [team ${team.id}] poll error: ${err.message}`);
    }
  }
}

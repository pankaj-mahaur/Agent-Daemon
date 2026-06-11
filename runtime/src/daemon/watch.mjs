// Watch daemon — chokidar fswatch over configured transcript dirs.
//
// For each watched path, fires `agent-daemon digest` on transcripts that:
//   1. Match the configured glob pattern
//   2. Have been quiet (no writes) for at least `debounceMs`
//   3. Have stable size across two `stableCheckIntervalMs` polls
//   4. Aren't already marked digested in SQLite (if skipDigested=true)
//
// Runs foreground until Ctrl+C. Register it as a per-user login service with
// `ad service install` (see daemon/service.mjs).

import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { runDigest } from "../digest/digest.mjs";
import { loadConfig } from "./config.mjs";
import { readInbox, ackMessage } from "../orchestration/inbox.mjs";
import { updateTaskStatus, listTasks, listTeams, isTeamComplete, markTaskFailed, retryTask } from "../orchestration/team.mjs";
import { cleanupWorktrees } from "../orchestration/spawn.mjs";

const WORKTREE_GC_THROTTLE_MS = 6 * 60 * 60 * 1000;  // sweep at most every 6h
let lastWorktreeGc = 0;

const LOG_ROTATE_BYTES = 1024 * 1024;  // 1MB, keep one .1 generation

/**
 * Tee console.error to a log file (service mode has no terminal). Size-based
 * rotation: at 1MB the current log moves to <file>.1, overwriting the prior
 * generation. Sync appends — the watcher logs a handful of lines per digest.
 *
 * @param {string} logFile
 */
function teeConsoleToFile(logFile) {
  try { fsSync.mkdirSync(path.dirname(logFile), { recursive: true }); } catch { /* best-effort */ }
  const original = console.error.bind(console);
  console.error = (...args) => {
    original(...args);
    try {
      const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}\n`;
      try {
        const stat = fsSync.statSync(logFile);
        if (stat.size > LOG_ROTATE_BYTES) fsSync.renameSync(logFile, `${logFile}.1`);
      } catch { /* no log yet */ }
      fsSync.appendFileSync(logFile, line, "utf8");
    } catch { /* logging must never crash the watcher */ }
  };
}

/**
 * @param {{
 *   projectRoot: string,
 *   verbose?: boolean,
 *   onceOnExisting?: boolean   - run digest on existing files at startup; default false
 * }} opts
 * @returns {Promise<number>} resolves when watcher exits
 */
export async function runWatcher(opts) {
  if (opts.logFile) teeConsoleToFile(opts.logFile);

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
    // Extract project cwd from the transcript itself (Claude Code records the
    // working directory; fall back to the transcript's parent dir).
    const projectCwd = (await readCwdFromTranscript(filepath)) || path.dirname(filepath);
    if (opts.verbose) console.error(`agent-daemon: digesting ${path.basename(filepath)} (cwd=${projectCwd})`);
    try {
      await runDigest({
        transcript: filepath,
        cwd: projectCwd,
        projectRoot: opts.projectRoot,
        adapter: entry.adapter,
        verbose: false,  // keep watch output less noisy
        fallbackToLlm: opts.fallbackToLlm,
        force: opts.force
      });
      console.error(`agent-daemon: digested ${path.basename(filepath)} → ${projectCwd} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (err) {
      console.error(`agent-daemon: digest failed for ${path.basename(filepath)}: ${err.message}`);
    } finally {
      inFlight.delete(filepath);
    }
  }

  /**
   * Scan the first N events of a Claude Code transcript JSONL for the cwd
   * field. Claude Code records the working directory in every assistant/user
   * event. Returns null if not found.
   */
  async function readCwdFromTranscript(filepath, scanBytes = 64 * 1024) {
    try {
      const fh = await fs.open(filepath, "r");
      try {
        const buf = Buffer.alloc(scanBytes);
        const { bytesRead } = await fh.read(buf, 0, scanBytes, 0);
        const text = buf.slice(0, bytesRead).toString("utf8");
        // Match "cwd":"<value>" with JSON-escaped backslashes.
        const m = text.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
        if (!m) return null;
        // Unescape JSON string escapes.
        return JSON.parse('"' + m[1] + '"');
      } finally { await fh.close(); }
    } catch { return null; }
  }

  // Start a watcher per configured entry (chokidar can take an array but
  // per-entry adapter binding is cleaner).
  const watchers = [];
  for (const entry of existing) {
    const globPattern = path.join(entry.path, entry.pattern).replace(/\\/g, "/");
    const watcher = chokidar.watch(globPattern, {
      ignoreInitial: !opts.onceOnExisting,
      persistent: true,
      awaitWriteFinish: false,  // we do our own stability check
      // Windows: native fs.watch misses changes inside deep directory trees.
      // Polling is slower but reliable. Tunable via AGENT_DAEMON_WATCH_POLL.
      usePolling: process.platform === "win32" || process.env.AGENT_DAEMON_WATCH_POLL === "1",
      interval: 2000,
      binaryInterval: 5000
    });
    watcher
      .on("add",    p => { if (opts.verbose) console.error(`  + add ${path.basename(p)}`); scheduleDigest(p, entry); })
      .on("change", p => { if (opts.verbose) console.error(`  ~ change ${path.basename(p)}`); scheduleDigest(p, entry); })
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
          if (msg.type !== "task-complete" && msg.type !== "task-failed") continue;

          if (verbose) {
            console.error(`agent-daemon: [team ${team.id}] ${msg.from} ${msg.type} (${msg.payload?.status || "unknown"})`);
          }

          try {
            const tasks = await listTasks(team.id);
            // Match by role OR by agent name (from field) for robustness
            const ownerTask = tasks.find(t =>
              (t.owner === msg.payload?.role || t.owner === msg.from) &&
              (t.status === "in_progress" || t.status === "pending")
            );
            if (ownerTask && msg.type === "task-complete" && msg.payload?.status === "completed") {
              const { unblocked } = await updateTaskStatus(team.id, ownerTask.id, "completed");
              if (unblocked.length > 0 && verbose) {
                console.error(`agent-daemon: [team ${team.id}] unblocked: ${unblocked.map(t => t.title).join(", ")}`);
              }
            }
            if (ownerTask && msg.type === "task-failed") {
              // markTaskFailed handles attempt counting + backoff scheduling;
              // the retry-due sweep below resets it to pending when its
              // next_retry_at passes.
              const r = await markTaskFailed(team.id, ownerTask.id, msg.payload?.error || msg.payload?.summary || "agent reported failure");
              console.error(`agent-daemon: [team ${team.id}] task "${ownerTask.title}" failed (attempt ${r?.task?.attempts ?? "?"})${r?.willRetry ? " — retry scheduled" : ""}`);
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

      // Retry-due sweep: tasks whose backoff window has elapsed go back to
      // pending so a leader (or the user via `ad sp`) can respawn them.
      try {
        for (const task of await listTasks(team.id)) {
          if (task.status !== "retrying" || !task.next_retry_at) continue;
          if (new Date(task.next_retry_at).getTime() > Date.now()) continue;
          const r = await retryTask(team.id, task.id);
          if (r.reset) {
            console.error(`agent-daemon: [team ${team.id}] retry window elapsed — "${task.title}" reset to pending (attempt ${task.attempts || 0})`);
          }
        }
      } catch (err) {
        if (verbose) console.error(`agent-daemon: [team ${team.id}] retry sweep error: ${err.message}`);
      }
    } catch (err) {
      if (verbose) console.error(`agent-daemon: [team ${team.id}] poll error: ${err.message}`);
    }
  }

  // Throttled worktree GC: report (never auto-delete) stale worktrees so the
  // user can `ad tu --force` them. Broken worktrees (no .git) are removed.
  if (Date.now() - lastWorktreeGc > WORKTREE_GC_THROTTLE_MS) {
    lastWorktreeGc = Date.now();
    try {
      const { removed, stale } = await cleanupWorktrees(process.cwd());
      if (removed > 0) console.error(`agent-daemon: worktree GC removed ${removed} broken worktree(s)`);
      if (stale.length > 0) {
        console.error(`agent-daemon: ${stale.length} stale worktree(s) past TTL — review with: ad tu`);
      }
    } catch { /* GC is best-effort */ }
  }
}

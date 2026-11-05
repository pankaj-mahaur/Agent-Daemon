// What a hook does instead of migrating the memory store (plan L2, 02 §3).
//
// The hook dispatcher sets AD_HOOK_NO_MIGRATE=1; memory/sqlite.mjs open()
// then reads the schema version first, read-only, and opens the store only
// when it is exactly this ad's version. Otherwise the hook goes on without
// the store (captures stay in the journal, the drain waits) and:
//   older or missing → the upgrade starts detached, once per 5 minutes
//   newer            → nothing to do here: an older ad must not touch it
//   unreadable       → logged; doctor shows it

import { fileURLToPath } from "node:url";
import { spawnDetached } from "../hooks/detached.mjs";
import { hookLog } from "../hooks/hook-log.mjs";

export const MIGRATE_JOB = fileURLToPath(new URL("./migrate-job.mjs", import.meta.url));
export const MIGRATE_WINDOW_MS = 5 * 60_000;

/** True in a process the hook dispatcher started. */
export const noMigrateMode = (env = process.env) => env.AD_HOOK_NO_MIGRATE === "1";

/**
 * The store isn't this ad's version: log it, and start the upgrade when it is older.
 * @param {{state:string, version:number|null, expected:number, error?:string}} s  memory/sqlite.mjs schemaState
 * @returns {boolean} whether an upgrade was started
 */
export function deferStore(s, { dbPath, spawn = spawnDetached, log = hookLog, env = process.env } = {}) {
  const event = env.AD_HOOK_EVENT || "hook";
  if (s.state === "newer") {
    log(event, `the memory store is schema v${s.version}, newer than this ad's v${s.expected}: captures wait in the journal until ad is updated`);
    return false;
  }
  if (s.state === "unreadable") {
    log(event, `the memory store couldn't be read (${s.error ?? "unknown error"}): captures wait in the journal`);
    return false;
  }
  const started = spawn([MIGRATE_JOB, dbPath], { key: "migrate", windowMs: MIGRATE_WINDOW_MS });
  log(event, `the memory store ${s.state === "missing" ? "doesn't exist yet" : `is schema v${s.version ?? 0}, older than this ad's v${s.expected}`}: ${started ? "upgrading it in the background" : "an upgrade is already running"}; captures wait in the journal`);
  return started;
}

#!/usr/bin/env node
// Upgrade the memory store, detached (plan L2): a hook that found the store
// older than this ad, or missing, starts this and exits at once (the hook
// dispatcher never migrates: a host kills a hook at its timeout, and a
// migration cut off half-way is worse than one that waits).
//
//   node migrate-job.mjs <episodic.db path>
//
// Opening the store runs its migrations (memory/sqlite.mjs open); each is
// idempotent, and the trust-core one runs in an IMMEDIATE transaction, so two
// jobs racing do the work once.

import { open } from "./sqlite.mjs";

try {
  const db = await open({ dbPath: process.argv[2] || undefined, noMigrate: false });
  db?.close();
} catch (e) {
  const { hookLog } = await import("../hooks/hook-log.mjs");
  hookLog("migrate", `the memory store couldn't be upgraded: ${e?.message ?? e}`);
  process.exitCode = 1;
}

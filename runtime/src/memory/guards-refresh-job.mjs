#!/usr/bin/env node
// Rebuild guards.json from the rules store, detached (MCP launch plan L7, design D3): a
// session start that finds the snapshot behind the store (rules_rev), a folder of a
// project with rules that no snapshot root covers (a moved folder), or a pause that ended,
// starts this and exits at once. Tokenless, so one-way (design S1): it may add rules,
// roots and pauses' ends, never drop anything. It reads only ad's own store under ad's
// root: no argument or AD_MEMORY_DB can point it at another (an empty store would read as
// "no rules"; the store id check refuses that too).
//
//   node guards-refresh-job.mjs

import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "./sqlite.mjs";
import { rebuildGuards } from "./guards-build.mjs";

// The root this copy was installed for: <root>/memory/dist/<version>/… when it runs from
// the guard copy; else the home folder's (a clone). Never AD_ROOT (S1).
function installedRoot() {
  const here = fileURLToPath(import.meta.url);
  const m = /^(.*)[\\/]memory[\\/]dist[\\/][^\\/]+[\\/]/.exec(here);
  return m ? m[1] : path.join(os.homedir(), ".agent-daemon");
}

// Two spellings of one folder (a link, /var vs /private/var, 8.3 names, letter case where
// the filesystem ignores it) are the same folder.
function sameFolder(a, b) {
  const real = (p) => {
    try {
      return realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const fold = (p) => (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p);
  return fold(real(a)) === fold(real(b));
}

// ad's own store: this copy's root first, then where the hooks look (HOME, then USERPROFILE:
// Git Bash's HOME can differ) — never through AD_MEMORY_DB or AD_ROOT. None → nothing to do
// (and no stray empty store made). Another store is refused by the rebuild's store-id check.
function ownStore(root) {
  const homes = [process.env.HOME, process.env.USERPROFILE, os.homedir()].filter(Boolean);
  const roots = [...new Set([root, ...homes.map((h) => path.join(h, ".agent-daemon"))])];
  return roots.map((r) => path.join(r, "episodic.db")).find((f) => existsSync(f)) ?? null;
}

const root = installedRoot();
let db = null;
try {
  // AD_ROOT is a documented setting: when it names another root than this copy's, the job
  // does nothing (it never rebuilds someone else's snapshot from its own store, S1).
  const override = process.env.AD_ROOT && path.isAbsolute(process.env.AD_ROOT) ? process.env.AD_ROOT : null;
  if (override && !sameFolder(override, root)) throw new Error(`AD_ROOT (${override}) isn't the root this copy was installed for (${root})`);
  const file = ownStore(root);
  if (file) {
    db = await open({ dbPath: file });
    if (db) await rebuildGuards(db, { root });
  }
} catch (e) {
  const { hookLog } = await import("../hooks/hook-log.mjs");
  hookLog("guards-refresh", `the rules snapshot couldn't be rebuilt: ${e?.message ?? e}`, { root });
} finally {
  try {
    db?.close();
  } catch {
    // closed already
  }
}

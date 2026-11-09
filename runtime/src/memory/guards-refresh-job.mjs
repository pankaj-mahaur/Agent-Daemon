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
// the guard copy (the launcher starts it there, D3); else the home folder's (a clone).
// AD_ROOT is compared, never followed (S1).
function installedRoot() {
  const here = fileURLToPath(import.meta.url);
  const m = /^(.*)[\\/]memory[\\/]dist[\\/][^\\/]+[\\/]/.exec(here);
  return m ? m[1] : path.join(os.homedir(), ".agent-daemon");
}

// Two spellings of one path (a link, /var vs /private/var, 8.3 names, letter case where
// the filesystem ignores it) are the same folder.
function samePath(a, b) {
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

// ad's own store: <root>/episodic.db, nothing else (S1). An AD_MEMORY_DB naming another file
// means the user's hooks read another store: the job refuses rather than rebuild from it.
function ownStore(root) {
  const file = path.join(root, "episodic.db");
  const named = process.env.AD_MEMORY_DB ? path.resolve(process.env.AD_MEMORY_DB) : null;
  if (named && !samePath(named, file)) throw new Error(`AD_MEMORY_DB (${named}) isn't this root's store (${file})`);
  return existsSync(file) ? file : null;
}

const root = installedRoot();
let db = null;
try {
  // AD_ROOT is a documented setting: when it names another root than this copy's, the job
  // does nothing (it never rebuilds someone else's snapshot from its own store, S1).
  // Any AD_ROOT (relative ones included) must name this root.
  const override = process.env.AD_ROOT ? path.resolve(process.env.AD_ROOT) : null;
  if (override && !samePath(override, root)) throw new Error(`AD_ROOT (${override}) isn't the root this copy was installed for (${root})`);
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

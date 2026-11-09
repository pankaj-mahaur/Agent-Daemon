// The SQLite driver under ad's memory store (P5.3, D46). Two engines, one
// surface — the slice of better-sqlite3's API the store uses:
//   db.exec(sql), db.prepare(sql) → { run(...p) → {changes, lastInsertRowid}, get(...p), all(...p) },
//   db.transaction(fn) → a function (also .deferred / .immediate / .exclusive), db.close()
//
//   node:sqlite      built into Node 22.16+ (FTS5): no native build, so the memory package
//                    installs anywhere with npx. Transactions are BEGIN IMMEDIATE
//                    (nested ones are savepoints), busy timeout 5 s, rows are plain
//                    objects, `undefined` binds as NULL, a locked database throws
//                    code "SQLITE_BUSY" like better-sqlite3.
//   better-sqlite3   the full runtime's driver (prebuilt binaries).
//
// openDatabase(file, { prefer }) picks AD_SQLITE_DRIVER when set, else `prefer`,
// else better-sqlite3 when it can be loaded, else node:sqlite. → null when neither loads.
//
// better-sqlite3 loads only from inside the tree this file runs from, or from the
// node_modules folder that tree was installed into (a hoisted dependency: npx, a global
// install, pnpm's store) — MCP launch plan L7, D10. Hooks, the jobs they start and the MCP
// server run outside the host's sandbox, and the lookup walks up past the tree into folders
// the agent can write (~/.claude/node_modules, a plugin cache's parents, ~/node_modules).
// One found there is never loaded: node:sqlite.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const DRIVERS = Object.freeze(["better-sqlite3", "node:sqlite"]);

// <tree>/src/memory/driver.mjs (the runtime, an npm copy, the plugin's server/).
const HERE = fileURLToPath(import.meta.url);
const TREE = path.resolve(path.dirname(HERE), "..", "..");

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// What loading better-sqlite3 loads by name, each looked up from the one before: its addon
// loader and that loader's helper (CommonJS lookups that walk up the same way).
const CHAIN = ["better-sqlite3", "bindings", "file-uri-to-path"];

/**
 * Where an import of better-sqlite3 from here would load it, when every package of CHAIN
 * resolves to a node_modules folder inside the tree (lexically: a package manager's link in
 * the tree counts) or to the node_modules folder that holds the tree itself; null when
 * better-sqlite3 isn't found, or any of them is found anywhere else. A later package not
 * found at all fails the load by itself.
 */
export function betterSqliteInTree({ tree = TREE, from = HERE, exists = isDir, paths } = {}) {
  const under = (child, parent) => {
    const rel = path.relative(parent, child);
    return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  const ok = (dir) => under(dir, tree) || (path.basename(dir) === "node_modules" && under(tree, dir));
  let found = null;
  let at = from;
  for (const [i, name] of CHAIN.entries()) {
    let dirs;
    try {
      dirs = (i === 0 ? paths : null) ?? createRequire(at).resolve.paths(name) ?? [];
    } catch {
      return null;
    }
    // better-sqlite3 is imported (folders only); the rest are require()d, which also loads a
    // plain file (`bindings.js`, …): any such match counts, so one planted above is refused.
    const here = i === 0 ? (d) => exists(path.join(d, name)) : (d) => ["", ".js", ".json", ".node"].some((x) => fs.existsSync(path.join(d, name + x)));
    const dir = dirs.find(here);
    if (!dir) {
      if (i === 0) return null;
      break;
    }
    if (!ok(dir)) return null;
    if (i === 0) found = path.join(dir, name);
    at = path.join(dir, name, "package.json");
  }
  return found;
}

const BUSY_TIMEOUT_MS = 5000;

async function loadBetterSqlite3() {
  if (!betterSqliteInTree()) return null;
  try {
    const mod = await import("better-sqlite3");
    return mod.default || mod;
  } catch {
    return null;
  }
}

// Loading node:sqlite prints an ExperimentalWarning (Node 22): only that one is
// kept off the user's terminal (and off a hook's stderr).
async function loadNodeSqlite() {
  const emit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    if (/SQLite is an experimental feature/.test(String(warning?.message ?? warning))) return;
    return emit.call(process, warning, ...rest);
  };
  try {
    const DatabaseSync = (await import("node:sqlite")).DatabaseSync ?? null;
    return DatabaseSync && hasFts5(DatabaseSync) ? DatabaseSync : null;
  } catch {
    return null;
  } finally {
    process.emitWarning = emit;
  }
}

// Memory search is full-text (FTS5). Node's built-in SQLite has it from 22.16
// (nodejs/node#57621); 22.13–22.15 load but fail on the first write, so such a
// build counts as no driver at all.
const fts5Seen = new WeakMap();
export function hasFts5(DatabaseSync) {
  if (fts5Seen.has(DatabaseSync)) return fts5Seen.get(DatabaseSync);
  let db = null;
  let ok = false;
  try {
    db = new DatabaseSync(":memory:");
    db.exec("CREATE VIRTUAL TABLE temp.fts5_probe USING fts5(x)");
    ok = true;
  } catch {
    // no FTS5 in this build
  } finally {
    try {
      db?.close();
    } catch {
      // nothing to close
    }
  }
  fts5Seen.set(DatabaseSync, ok);
  return ok;
}

/** The driver names that load here, in preference order. */
export async function availableDrivers() {
  const out = [];
  if (await loadBetterSqlite3()) out.push("better-sqlite3");
  if (await loadNodeSqlite()) out.push("node:sqlite");
  return out;
}

const plain = (row) => (row === undefined || row === null ? row : Object.assign({}, row));
const bindable = (params) => params.map((p) => (p === undefined ? null : p));
// SQLITE_BUSY (5) and SQLITE_LOCKED (6), named as better-sqlite3 names them.
function normalizeError(e) {
  if (e && (e.errcode === 5 || e.errcode === 6) && e.code !== "SQLITE_BUSY") {
    try {
      e.code = "SQLITE_BUSY";
    } catch {
      // read-only code: leave it
    }
  }
  return e;
}
const guarded = (fn) => (...args) => {
  try {
    return fn(...args);
  } catch (e) {
    throw normalizeError(e);
  }
};

/** A better-sqlite3-shaped wrapper around a node:sqlite DatabaseSync. */
export function wrapNodeSqlite(native) {
  let depth = 0;
  let sp = 0;
  const run = (sql) => guarded(() => native.exec(sql))();
  const db = {
    driver: "node:sqlite",
    exec: (sql) => run(sql),
    prepare(sql) {
      const st = guarded(() => native.prepare(sql))();
      return {
        run: guarded((...p) => {
          const r = st.run(...bindable(p));
          return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
        }),
        get: guarded((...p) => plain(st.get(...bindable(p)))),
        all: guarded((...p) => st.all(...bindable(p)).map(plain)),
      };
    },
    transaction(fn) {
      const make = (begin) => (...args) => {
        const nested = depth > 0;
        const name = `ad_sp_${++sp}`;
        run(nested ? `SAVEPOINT ${name}` : begin);
        depth++;
        try {
          const result = fn(...args);
          depth--;
          run(nested ? `RELEASE ${name}` : "COMMIT");
          return result;
        } catch (e) {
          depth--;
          try {
            run(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : "ROLLBACK");
          } catch {
            // the transaction is already gone (SQLite rolled it back): nothing to undo
          }
          throw e;
        }
      };
      // Immediate by default: a deferred transaction that later writes can fail with
      // SQLITE_BUSY at once, while waiting for the lock up front honours the busy timeout.
      const tx = make("BEGIN IMMEDIATE");
      tx.deferred = make("BEGIN DEFERRED");
      tx.immediate = make("BEGIN IMMEDIATE");
      tx.exclusive = make("BEGIN EXCLUSIVE");
      return tx;
    },
    close: () => native.close(),
  };
  return db;
}

/**
 * @param {string} file
 * @param {{prefer?: "better-sqlite3"|"node:sqlite", env?: object, readonly?: boolean}} [opts]
 *   readonly: open an existing file without the right to change it (never creates one)
 * @returns {Promise<object|null>} the database (with .driver), or null when no driver loads
 */
export async function openDatabase(file, { prefer, env = process.env, readonly = false } = {}) {
  const wanted = DRIVERS.includes(env.AD_SQLITE_DRIVER) ? env.AD_SQLITE_DRIVER : prefer;
  const order = wanted === "node:sqlite" ? ["node:sqlite", "better-sqlite3"] : ["better-sqlite3", "node:sqlite"];
  // An explicit AD_SQLITE_DRIVER is the only one tried: a test that asks for node:sqlite must get it.
  for (const name of DRIVERS.includes(env.AD_SQLITE_DRIVER) ? [env.AD_SQLITE_DRIVER] : order) {
    if (name === "better-sqlite3") {
      const Database = await loadBetterSqlite3();
      if (!Database) continue;
      const native = new Database(file, { timeout: BUSY_TIMEOUT_MS, ...(readonly ? { readonly: true, fileMustExist: true } : {}) });
      native.driver = "better-sqlite3";
      return native;
    }
    const DatabaseSync = await loadNodeSqlite();
    if (!DatabaseSync) continue;
    const native = new DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS, ...(readonly ? { readOnly: true } : {}) });
    // The timeout option is newer than Node 22.13: the pragma covers every version.
    native.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    return wrapNodeSqlite(native);
  }
  return null;
}

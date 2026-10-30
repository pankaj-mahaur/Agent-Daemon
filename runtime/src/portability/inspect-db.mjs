// A bundle's database, inspected as hostile (P7.3a): opened read-only with the schema distrusted,
// and refused unless it holds only what ad's own exporter writes.
//
//   adColumns(dir) → Map(table → Set(column))   ad's own schema, from a scratch DB in `dir`
//   inspectDb(file, manifest, { ours }) → []  or the problems (each a sentence)
//   openInspection(file) → a read-only connection (trusted_schema OFF, mmap off, query_only)
//
// Refused: any trigger, view, index or virtual table; a table ad doesn't export; a column ad's
// schema doesn't have (and a fact's project lists, which never travel); a failed integrity
// check; counts that differ from the manifest; a row of a project the manifest doesn't carry,
// or a global row when the bundle has no global memory.

import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "../memory/driver.mjs";
import { TABLES } from "../memory/tables.mjs";

const EXPORTED = new Set(TABLES.filter((t) => t.export !== "exclude").map((t) => t.name));
const NEVER_TRAVEL = { user_facts: new Set(["projects", "project_ids", "promoted_at"]) };
const EXPORT_ONLY = { user_facts: new Set(["export_project"]) };

let cached = null;
export async function adColumns(dir) {
  if (cached) return cached;
  const { open } = await import("../memory/sqlite.mjs");
  const file = path.join(dir, `schema-${process.pid}.db`);
  const db = await open({ dbPath: file });
  const out = new Map();
  try {
    for (const { name } of db.raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()) out.set(name, new Set(db.raw.prepare(`PRAGMA table_info("${name}")`).all().map((c) => c.name)));
  } finally {
    await db.close?.();
    for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true, maxRetries: 5, retryDelay: 50 });
  }
  cached = out;
  return out;
}

export async function openInspection(file) {
  const db = await openDatabase(file);
  if (!db) throw Object.assign(new Error("No SQLite driver could open the bundle's database."), { code: "IMPORT_NO_DRIVER" });
  db.exec("PRAGMA trusted_schema = OFF");
  db.exec("PRAGMA mmap_size = 0");
  db.exec("PRAGMA query_only = ON");
  return db;
}

export async function inspectDb(file, manifest, { ours }) {
  const problems = [];
  const db = await openInspection(file);
  try {
    const objects = db.prepare("SELECT type, name, sql FROM sqlite_schema").all();
    for (const o of objects) {
      if (o.type === "table" && o.name === "sqlite_sequence") continue;
      // SQLite's own index for a table's key or UNIQUE constraint: no SQL, and no CREATE INDEX can make one.
      if (o.type === "index" && o.sql === null && /^sqlite_autoindex_/.test(o.name)) continue;
      if (o.type !== "table" || /^CREATE VIRTUAL TABLE/i.test(o.sql ?? "")) problems.push(`This bundle's database has parts ad didn't make (${o.type === "table" ? "virtual table" : o.type} '${o.name}')`);
      else if (!EXPORTED.has(o.name)) problems.push(`This bundle's database has a table ad doesn't export ('${o.name}')`);
    }
    if (problems.length) return problems;
    const tables = objects.filter((o) => o.type === "table" && EXPORTED.has(o.name)).map((o) => o.name);
    for (const t of tables) {
      const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
      for (const c of cols) {
        if (NEVER_TRAVEL[t]?.has(c)) problems.push(`'${t}.${c}' never travels in a bundle`);
        else if (!ours.get(t)?.has(c) && !EXPORT_ONLY[t]?.has(c)) problems.push(`'${t}' has a column ad doesn't have ('${c}')`);
      }
    }
    if (problems.length) return problems;
    const integrity = Object.values(db.prepare("PRAGMA integrity_check").get() ?? {})[0];
    if (integrity !== "ok") return [`the database failed its integrity check (${integrity})`];
    const projects = new Set((manifest.projects ?? []).map((p) => p.id));
    const info = manifest.db?.[0]?.tables ?? {};
    for (const t of tables) {
      const n = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
      if (info[t] && info[t].rows !== n) problems.push(`'${t}' holds ${n} rows, the manifest says ${info[t].rows}`);
      const cols = new Set(db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name));
      const key = cols.has("export_project") ? "export_project" : cols.has("project_id") ? "project_id" : null;
      if (!key) continue;
      for (const r of db.prepare(`SELECT ${key} AS k, COUNT(*) AS n FROM "${t}" GROUP BY ${key}`).all()) {
        if (r.k === null) {
          if (!manifest.scope?.globalMemory && TABLES.find((x) => x.name === t)?.export === "rows" && key === "export_project") problems.push(`'${t}' has global rows, but the bundle has no global memory`);
        } else if (!projects.has(r.k)) problems.push(`'${t}' has rows of a project the bundle doesn't carry (${r.k})`);
      }
    }
    return problems;
  } finally {
    db.close();
  }
}

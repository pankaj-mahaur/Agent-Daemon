// Project ids in the memory database (P7.1a). Additive only: an older ad ignores
// the columns, the tables and the triggers, and keeps working by slug.
//
//   project_id      on every table with a project_slug (tables.mjs PROJECT_TABLES)
//   user_facts.project_ids   JSON list next to `projects` (slugs)
//   project_keys    the registry's slugs (projects.json), mirrored: slug → id, collided
//   triggers        a row written with a slug and no id gets the slug's id, unless two
//                   projects share that slug (then only a writer that knows the folder
//                   sets the id; the row stays unserved otherwise)
//   import_rows, import_updates   P7.3's rollback records
//   meta            key/value: the mirrored registry revision, backfill progress
//
// The backfill (backfillProjectIds) never runs in a hook or an MCP request: it runs
// from `ad memory migrate`, `ad doctor --fix`, and long-lived processes at start.

import { PROJECT_TABLES } from "./tables.mjs";
import { canonicalDir, collidedSlugs, readRegistry, resolveProject } from "./projects.mjs";
import { moveToIdFolder } from "./project-dir.mjs";

/** @param {any} raw the driver's database (prepare/exec) */
export function migrateProjectIds(raw) {
  const has = (table) => raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  for (const table of PROJECT_TABLES) {
    if (!has(table)) continue;
    const cols = new Set(raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    if (!cols.has("project_id")) raw.exec(`ALTER TABLE ${table} ADD COLUMN project_id TEXT`);
    raw.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_project_id ON ${table}(project_id)`);
  }
  const factCols = new Set(raw.prepare("PRAGMA table_info(user_facts)").all().map((c) => c.name));
  if (!factCols.has("project_ids")) raw.exec("ALTER TABLE user_facts ADD COLUMN project_ids TEXT");
  raw.exec(`
    CREATE TABLE IF NOT EXISTS project_keys (
      slug       TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      collided   INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS import_rows (
      import_id  TEXT NOT NULL,
      table_name TEXT NOT NULL,
      row_id     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_import_rows ON import_rows(import_id);
    CREATE TABLE IF NOT EXISTS import_updates (
      import_id   TEXT NOT NULL,
      table_name  TEXT NOT NULL,
      row_id      INTEGER NOT NULL,
      column_name TEXT NOT NULL,
      old_value   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_import_updates ON import_updates(import_id);
  `);
  // Sessions know their folder: they take the id by path (episodic.upsertSession) or in
  // the backfill, never by slug, so a folder the registry hasn't met yet can't get the
  // id of another folder with the same slug.
  raw.exec("DROP TRIGGER IF EXISTS sessions_project_id_insert; DROP TRIGGER IF EXISTS sessions_project_id_update;");
  for (const table of PROJECT_TABLES) {
    if (!has(table) || table === "sessions") continue;
    // A new row: its slug's id, when exactly one project has that slug.
    raw.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_project_id_insert AFTER INSERT ON ${table}
      WHEN NEW.project_id IS NULL AND NEW.project_slug IS NOT NULL
      BEGIN
        UPDATE ${table} SET project_id = (SELECT project_id FROM project_keys WHERE slug = NEW.project_slug AND collided = 0) WHERE rowid = NEW.rowid;
      END`);
    // A row that changes project (made cross-project: no project; moved back: its slug's).
    raw.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_project_id_update AFTER UPDATE OF project_slug ON ${table}
      WHEN NEW.project_slug IS NOT OLD.project_slug
      BEGIN
        UPDATE ${table} SET project_id = CASE WHEN NEW.project_slug IS NULL THEN NULL
          ELSE (SELECT project_id FROM project_keys WHERE slug = NEW.project_slug AND collided = 0) END WHERE rowid = NEW.rowid;
      END`);
  }
  raw.exec("INSERT OR IGNORE INTO schema_version (version) VALUES (4)");
}

/**
 * Mirror the registry's slugs into project_keys when its revision changed since the
 * last mirror. Cheap on every open: one small file read and a meta lookup.
 * @param {any} raw
 */
export function syncProjectKeys(raw, { env = process.env } = {}) {
  let reg;
  try {
    reg = readRegistry({ env });
  } catch {
    return false; // a newer ad's registry: leave the mirror as it is
  }
  const rev = String(reg.revision ?? 0);
  const had = raw.prepare("SELECT value FROM meta WHERE key = 'project_keys_revision'").get();
  if (had?.value === rev) return false;
  const shared = collidedSlugs(reg);
  const rows = [];
  for (const p of reg.projects) for (const s of new Set(p.aliases?.episodic ?? [])) rows.push([s, p.id, shared.has(s) ? 1 : 0]);
  raw.transaction(() => {
    raw.prepare("DELETE FROM project_keys").run();
    const ins = raw.prepare("INSERT OR REPLACE INTO project_keys (slug, project_id, collided) VALUES (?, ?, ?)");
    for (const r of rows) ins.run(...r);
    raw.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('project_keys_revision', ?)").run(rev);
  })();
  return true;
}

/**
 * Give every row a project id where it can be told (P7.1a-4). Resumable and idempotent:
 * only rows without an id are touched, a table at a time.
 *   1. one project per distinct folder in sessions (and learnings.project_path);
 *   2. sessions by their path; learnings by their session or recorded path;
 *   3. a slug only one folder ever had: every row of that slug;
 *   4. rows of a slug two folders shared, with nothing to tell them apart: left
 *      without an id, unserved (ad memory assign places them by hand).
 * user_facts: project_ids from `projects` (slugs) where a slug names one project.
 * → { projects, updated: { table: n }, unassigned: { table: n } }
 * @param {{ run, all, get, transaction }} handle
 */
export function backfillProjectIds(handle, { env = process.env, platform = process.platform, batch = 5000 } = {}) {
  // 1. Every folder ad has seen, by its canonical path; slugs that two folders had.
  const folders = new Map(); // canonical → path
  const slugPaths = new Map(); // slug → Set(canonical)
  const seen = (p, slug) => {
    if (!p) return;
    const c = canonicalDir(p, { platform });
    if (!folders.has(c)) folders.set(c, p);
    if (slug) slugPaths.set(slug, (slugPaths.get(slug) ?? new Set()).add(c));
  };
  for (const r of handle.all("SELECT DISTINCT project_path, project_slug FROM sessions")) seen(r.project_path, r.project_slug);
  try {
    for (const r of handle.all("SELECT DISTINCT project_path, project_slug FROM learnings WHERE project_path IS NOT NULL")) seen(r.project_path, r.project_slug);
  } catch {
    // an older learnings table without project_path
  }
  const idOf = new Map(); // canonical → id
  let movedFolders = 0;
  for (const [c, p] of folders) {
    // A folder that no longer exists still gets an entry (its rows keep their identity).
    const r = resolveProject(p, { env, platform, create: true });
    if (!r) continue;
    idOf.set(c, r.id);
    // Its capture folder outside the project moves from the path key to the id.
    if (moveToIdFolder(p, r.id)) movedFolders++;
  }
  // The registry may now know about more collisions: refresh the mirror.
  syncProjectKeys(handle.raw, { env });

  const updated = {};
  const bump = (table, n) => (updated[table] = (updated[table] ?? 0) + n);
  // Set `id` on the rows of `table` that match `where`, `batch` rows per transaction.
  const assign = (table, id, where, params) => {
    for (;;) {
      const r = handle.transaction(() => handle.run(`UPDATE ${table} SET project_id = ? WHERE rowid IN (SELECT rowid FROM ${table} WHERE project_id IS NULL AND ${where} LIMIT ${batch})`, [id, ...params]));
      const n = Number(r?.changes ?? 0);
      bump(table, n);
      if (n < batch) break;
    }
  };
  // 2. sessions and learnings by the folder they recorded.
  for (const [c, id] of idOf) {
    const p = folders.get(c);
    assign("sessions", id, "project_path = ?", [p]);
    try {
      assign("learnings", id, "project_path = ?", [p]);
    } catch {
      // no project_path column
    }
  }
  handle.transaction(() => {
    const r = handle.run("UPDATE learnings SET project_id = (SELECT s.project_id FROM sessions s WHERE s.id = learnings.session_id) WHERE project_id IS NULL AND project_slug IS NOT NULL AND session_id IS NOT NULL AND (SELECT s.project_id FROM sessions s WHERE s.id = learnings.session_id AND s.project_slug = learnings.project_slug) IS NOT NULL");
    bump("learnings", Number(r?.changes ?? 0));
  });
  // 3. Slugs one folder had: every remaining row of that slug, in every table.
  const single = new Map();
  for (const [slug, cs] of slugPaths) if (cs.size === 1) single.set(slug, idOf.get([...cs][0]));
  for (const table of PROJECT_TABLES) {
    for (const [slug, id] of single) {
      if (!id) continue;
      try {
        assign(table, id, "project_slug = ?", [slug]);
      } catch {
        // a table this database doesn't have yet
      }
    }
  }
  // Rows that point at a learning take its project (injections, feedback, events).
  for (const [table, col] of [["injections", "learning_id"], ["feedback", "learning_id"], ["correction_events", "matched_learning_id"]]) {
    try {
      handle.transaction(() => {
        const r = handle.run(`UPDATE ${table} SET project_id = (SELECT l.project_id FROM learnings l WHERE l.id = ${table}.${col}) WHERE project_id IS NULL AND project_slug IS NOT NULL AND (SELECT l.project_id FROM learnings l WHERE l.id = ${table}.${col} AND l.project_slug = ${table}.project_slug) IS NOT NULL`);
        bump(table, Number(r?.changes ?? 0));
      });
    } catch {
      // missing table
    }
  }
  // user_facts: ids for the slugs that name one project.
  const facts = handle.all("SELECT id, projects, project_ids FROM user_facts WHERE projects IS NOT NULL AND projects != '[]'");
  handle.transaction(() => {
    for (const f of facts) {
      let slugs = [];
      try {
        slugs = JSON.parse(f.projects);
      } catch {
        continue;
      }
      const ids = new Set(JSON.parse(f.project_ids || "[]"));
      const before = ids.size;
      for (const s of slugs) if (single.get(s)) ids.add(single.get(s));
      if (ids.size !== before) {
        handle.run("UPDATE user_facts SET project_ids = ? WHERE id = ?", [JSON.stringify([...ids]), f.id]);
        bump("user_facts", 1);
      }
    }
  });
  const unassigned = {};
  for (const table of PROJECT_TABLES) {
    try {
      const n = handle.get(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id IS NULL AND project_slug IS NOT NULL`).n;
      if (n) unassigned[table] = n;
    } catch {
      // missing table
    }
  }
  return { projects: idOf.size, movedFolders, updated, unassigned };
}

/** Rows that have a slug but no project id yet (doctor, ad memory migrate). */
export function unassignedCounts(handle) {
  const out = {};
  for (const table of PROJECT_TABLES) {
    try {
      const n = handle.get(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id IS NULL AND project_slug IS NOT NULL`).n;
      if (n) out[table] = n;
    } catch {
      // missing table or column
    }
  }
  return out;
}

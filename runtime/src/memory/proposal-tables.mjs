// The tables L4b's imports write (MCP launch plan L4b, 02 §6), made by the imports and
// the review's reject themselves: no schema version bump, so an older ad or plugin
// reading this store keeps capturing (a hook skips a store newer than its own schema,
// L2). Readers treat a missing table as empty (hasProposalTables).
//
//   history_clusters          what the history import found, per project. The redacted
//                             sentence is kept only while a repeated cluster waits to be
//                             proposed; once proposed (or linked to a note the user has)
//                             the text lives in the note alone, so rejecting or purging
//                             the note removes the last copy. Every hash is an HMAC with
//                             this install's key (historyHashKey). member_hashes: each
//                             wording's token key, the cluster's identity when retention
//                             changes its first wording.
//   instruction_imports       one row per instruction file and version imported;
//                             loaded_by: the hosts that read that file by themselves
//   instruction_import_notes  the notes each of those files holds
//   proposal_rejections       what the user rejected in review (recordRejection): keyed
//                             hashes only; neither import proposes it again
//
// No triggers on learnings: a trigger that names one of these tables would break every
// delete of a note once the table is gone.

import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { adRoot } from "../ad-root.mjs";
import { migrateProjectIds } from "./project-db.mjs";
import { idOfKeys, slugOfKeys, projectClause } from "./projects.mjs";
import { normKey } from "./sqlite.mjs";

const DDL = `
  CREATE TABLE IF NOT EXISTS history_clusters (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id    TEXT,
    project_slug  TEXT,
    cluster_id    TEXT NOT NULL,
    member_hashes TEXT NOT NULL,
    sentence      TEXT,
    sentence_key  TEXT,
    count         INTEGER NOT NULL,
    sessions      INTEGER NOT NULL,
    hosts         TEXT NOT NULL,
    first_ts      TEXT,
    last_ts       TEXT,
    learning_id   INTEGER,
    proposed_at   TEXT,
    imported_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_history_clusters_learning ON history_clusters(learning_id);
  CREATE TABLE IF NOT EXISTS instruction_imports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   TEXT,
    project_slug TEXT,
    file         TEXT NOT NULL,
    kind         TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    units        INTEGER NOT NULL,
    skipped      INTEGER NOT NULL DEFAULT 0,
    loaded_by    TEXT,
    scope        TEXT,
    imported_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS instruction_import_notes (
    import_id    INTEGER NOT NULL,
    learning_id  INTEGER NOT NULL,
    unit_key     TEXT,
    PRIMARY KEY (import_id, learning_id)
  );
  CREATE INDEX IF NOT EXISTS idx_instruction_import_notes_learning ON instruction_import_notes(learning_id);
  CREATE TABLE IF NOT EXISTS proposal_rejections (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   TEXT,
    project_slug TEXT,
    key_hash     TEXT NOT NULL,
    rejected_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_proposal_rejections_key ON proposal_rejections(key_hash);
`;

export const PROPOSAL_TABLES = Object.freeze(["history_clusters", "instruction_imports", "instruction_import_notes", "proposal_rejections"]);

/**
 * Create the tables and indexes (idempotent), and the project-id index and triggers the
 * store gives every project table (project-db.mjs), so no later open, a hook's
 * included, has any DDL left to do for them.
 */
export function ensureProposalTables(handle) {
  handle.raw.exec(DDL);
  migrateProjectIds(handle.raw);
}

/** Do the import tables exist in this store? (Readers: a store never imported into has none.) */
export function hasProposalTables(handle) {
  return Boolean(handle.get("SELECT 1 AS x FROM sqlite_schema WHERE type = 'table' AND name = 'history_clusters'"));
}

/**
 * This install's key for history hashes: a file of its own under ad's folder (0600),
 * never in the store and never exported, so a copy of the store alone can't test a
 * guess against a hash. Made once, by exclusive create. Kept by a purge: the
 * rejections need it. Always ad's own root (AD_ROOT, else the home folder), never a
 * caller's env, so every import and reject in one install uses one key.
 */
export function historyHashKey({ env = process.env } = {}) {
  const file = path.join(adRoot({ env }), "memory/history.key");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e; // another process made it first
  }
  return fs.readFileSync(file, "utf8").trim();
}

/** A keyed hash (16 hex) of a string with this install's history key. */
export const keyedHash = (key, s) => createHmac("sha256", key).update(String(s)).digest("hex").slice(0, 16);

/** The keyed hash a text is rejected and looked up by. */
export const textKey = (key, text) => keyedHash(key, normKey(text));

/**
 * The review's reject (L5's discard), before it deletes the note: neither import
 * proposes this text again in this project, nor (when it came from the history) any
 * wording of its cluster. Only the user's reject calls this; an agent's hide never does.
 * @param {{id?:number, text:string}} note
 */
export function recordRejection(handle, keys, { id = null, text }, { now = new Date() } = {}) {
  ensureProposalTables(handle);
  const key = historyHashKey();
  const hashes = new Set([textKey(key, text)]);
  if (id != null) {
    for (const r of handle.all("SELECT member_hashes, sentence_key FROM history_clusters WHERE learning_id = ?", [id])) {
      if (r.sentence_key) hashes.add(r.sentence_key);
      for (const m of JSON.parse(r.member_hashes || "[]")) hashes.add(m);
    }
    // The file lines it came from, as the file wrote them (before redaction or neutralising).
    for (const r of handle.all("SELECT unit_key FROM instruction_import_notes WHERE learning_id = ? AND unit_key IS NOT NULL", [id])) hashes.add(keyedHash(key, r.unit_key));
  }
  const t = now.toISOString();
  for (const h of hashes) handle.run("INSERT INTO proposal_rejections (project_id, project_slug, key_hash, rejected_at) VALUES (?, ?, ?, ?)", [idOfKeys(keys), slugOfKeys(keys), h, t]);
  return hashes.size;
}

/** The rejected hashes of this project. */
export function rejectedHashes(handle, keys) {
  const p = projectClause("", keys);
  return new Set(handle.all(`SELECT key_hash FROM proposal_rejections WHERE ${p.sql}`, p.params).map((r) => r.key_hash));
}

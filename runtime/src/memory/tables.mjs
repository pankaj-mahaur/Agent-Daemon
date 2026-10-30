// Every table of ad's memory database, in one registry (P7.1a). Migration (project
// ids), export (P7.2) and import (P7.3) all read it; a test fails when a table in the
// schema is missing here, so a new table can't be forgotten by any of them.
//
//   export   rows     per-project rows, filtered by project
//            global   no project column; goes with global memory
//            exclude  machine-local or telemetry: never leaves this computer
//   projectColumn / slugColumn  the project id and the path-derived slug (null: none)
//   pathColumns      absolute paths of this machine (rewritten or dropped on import)
//   jsonPathColumns  JSON that may hold paths
//   textColumns      free text screened on import
//   parents          foreign keys, for remapping ids on import
//   importKey        what makes an imported row the same as one already here
//   rehash           columns recomputed on import, never taken from a bundle
//   screen           the screen imported rows pass (learning | fact | none)
//
// FTS shadow tables (learnings_fts*, messages_fts*) follow their base table and are
// rebuilt, never exported.

const t = (name, o = {}) =>
  Object.freeze({
    name,
    export: o.export ?? "exclude",
    projectColumn: o.projectColumn ?? null,
    slugColumn: o.slugColumn ?? null,
    pathColumns: o.pathColumns ?? [],
    jsonPathColumns: o.jsonPathColumns ?? [],
    textColumns: o.textColumns ?? [],
    parents: o.parents ?? [],
    importKey: o.importKey ?? null,
    rehash: o.rehash ?? [],
    screen: o.screen ?? "none",
  });

const P = { projectColumn: "project_id", slugColumn: "project_slug" };

export const TABLES = Object.freeze([
  t("sessions", { ...P, export: "rows", pathColumns: ["project_path", "transcript_path"], importKey: ["id"] }),
  t("messages", { export: "exclude", parents: [{ column: "session_id", table: "sessions", onDelete: "CASCADE" }] }),
  t("tool_calls", { export: "exclude", parents: [{ column: "session_id", table: "sessions", onDelete: "CASCADE" }, { column: "message_id", table: "messages" }] }),
  t("learnings", {
    ...P,
    export: "rows",
    pathColumns: ["project_path"],
    jsonPathColumns: ["tags"],
    textColumns: ["text", "evidence"],
    parents: [{ column: "session_id", table: "sessions", onDelete: "SET NULL" }],
    importKey: ["project_id", "norm_key"],
    rehash: ["content_hash", "norm_key"],
    screen: "learning",
  }),
  t("user_facts", { export: "rows", projectColumn: "project_ids", slugColumn: "projects", textColumns: ["text", "evidence"], importKey: ["content_hash"], rehash: ["content_hash"], screen: "fact" }),
  t("feedback", { ...P, export: "rows", parents: [{ column: "learning_id", table: "learnings" }], importKey: ["project_id", "learning_id", "verdict", "ts"] }),
  t("correction_events", { ...P, export: "rows", parents: [{ column: "learning_id", table: "learnings" }, { column: "matched_learning_id", table: "learnings" }], rehash: ["norm_key"] }),
  t("injections", { ...P, export: "rows", parents: [{ column: "learning_id", table: "learnings" }] }),
  t("capture_heartbeats", { ...P, export: "exclude" }),
  t("memory_maintenance", { export: "exclude" }),
  t("skill_executions", { export: "exclude", pathColumns: ["trace_path"], parents: [{ column: "session_id", table: "sessions", onDelete: "CASCADE" }] }),
  t("skill_variants", { export: "global" }),
  t("skill_route_events", { ...P, export: "exclude" }),
  t("retrieval_events", { ...P, export: "exclude" }),
  t("proposals", { export: "global" }),
  t("schema_version", { export: "exclude" }),
  t("project_keys", { export: "exclude" }),
  t("meta", { export: "exclude" }),
  t("import_rows", { export: "exclude" }),
  t("import_updates", { export: "exclude" }),
]);

/** Tables that carry project_slug and get a project_id column. */
export const PROJECT_TABLES = Object.freeze(TABLES.filter((x) => x.projectColumn === "project_id").map((x) => x.name));

/** FTS shadow tables: rebuilt from their base table. */
export const isShadowTable = (name) => /^(learnings|messages)_fts(_|$)/.test(name) || /^sqlite_/.test(name);

export const tableByName = (name) => TABLES.find((x) => x.name === name) ?? null;

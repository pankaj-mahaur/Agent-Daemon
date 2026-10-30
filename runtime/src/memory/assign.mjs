// `ad memory migrate` and `ad memory assign` (P7.1a).
//
//   migrate   gives every row a project id where ad can tell (project-db.mjs
//             backfillProjectIds) and says what is left
//   assign    places one row ad couldn't attribute (two folders shared its slug)
//             in a project, by hand. It changes which folder a note reaches, so it
//             is the user's alone: refused in an agent's shell and without a
//             terminal, then a typed confirmation.

import path from "node:path";
import { refuseInAgentShell, confirmTyped } from "../security/agent-shell.mjs";
import { neutralizeText } from "../digest/sanitize.mjs";
import { backfillProjectIds, unassignedCounts } from "./project-db.mjs";
import { resolveProject } from "./projects.mjs";
import { PROJECT_TABLES } from "./tables.mjs";

const preview = (t) => neutralizeText(String(t ?? "")).replace(/\s+/g, " ").trim().slice(0, 120);

export function memoryMigrate({ handle, out = console.log, env = process.env }) {
  const r = backfillProjectIds(handle, { env });
  const moved = Object.entries(r.updated).filter(([, n]) => n);
  out(`Projects known: ${r.projects}. ${moved.length ? `Rows given a project: ${moved.map(([t, n]) => `${t} ${n}`).join(", ")}.` : "Every row that can be placed already has its project."}`);
  const left = Object.entries(r.unassigned);
  if (left.length) {
    out(`Rows two folders shared, with nothing to tell them apart (served to neither): ${left.map(([t, n]) => `${t} ${n}`).join(", ")}.`);
    out("Place one by hand: ad memory assign learnings:<id> --project <folder>   (list them: ad memory assign --list)");
  }
  return 0;
}

/**
 * @param {{ ref?: string, project?: string, list?: boolean, handle: any, io: { ask: (q: string) => Promise<string> },
 *           out?: (l: string) => void, env?: object, isTTY?: () => boolean }} opts
 */
export async function memoryAssign({ ref, project, list = false, handle, io, out = console.log, env = process.env, isTTY }) {
  if (list) {
    const rows = handle.all("SELECT id, project_slug, text FROM learnings WHERE project_id IS NULL AND project_slug IS NOT NULL ORDER BY id LIMIT 200");
    if (!rows.length) {
      out("No notes are waiting to be placed in a project.");
      return 0;
    }
    for (const r of rows) out(`  learnings:${r.id}  ${preview(r.text)}`);
    const counts = unassignedCounts(handle);
    const others = Object.entries(counts).filter(([t]) => t !== "learnings");
    if (others.length) out(`Also without a project (telemetry, placed with their notes): ${others.map(([t, n]) => `${t} ${n}`).join(", ")}`);
    return 0;
  }
  const refused = refuseInAgentShell({ cmd: "memory assign", env, ...(isTTY ? { isTTY } : {}) });
  if (refused) {
    out(refused);
    return 2;
  }
  const m = /^([a-z_]+):(\d+)$/.exec(String(ref ?? ""));
  if (!m || !PROJECT_TABLES.includes(m[1]) || !project) {
    out("Usage: ad memory assign <table>:<id> --project <folder>   (e.g. learnings:42)");
    return 1;
  }
  const [, table, id] = m;
  const row = handle.get(`SELECT rowid AS rid, project_slug, project_id${table === "learnings" ? ", text" : ""} FROM ${table} WHERE rowid = ?`, [Number(id)]);
  if (!row) {
    out(`No ${table} row ${id}.`);
    return 1;
  }
  if (row.project_id) {
    out(`${table}:${id} already belongs to a project.`);
    return 1;
  }
  const dir = path.resolve(project);
  const p = resolveProject(dir, { env });
  if (!p || p.slug !== row.project_slug) {
    out(`${dir} isn't one of the folders that wrote this note (its key is ${row.project_slug}).`);
    return 1;
  }
  if (row.text) out(`  ${preview(row.text)}`);
  out(`Place ${table}:${id} in ${dir}? It will be served there, and not in the other folder.`);
  if (!(await confirmTyped({ expected: `${table}:${id}`, io }))) {
    out("Not confirmed: nothing changed.");
    return 1;
  }
  handle.run(`UPDATE ${table} SET project_id = ? WHERE rowid = ? AND project_id IS NULL`, [p.id, Number(id)]);
  out(`${table}:${id} now belongs to ${dir}.`);
  return 0;
}

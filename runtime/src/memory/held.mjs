// `ad memory held`: the notes memory is keeping back from sessions, and the
// user's way to accept, release or drop them (plan P0.8b, D49).
//
//   pending      — written by an agent about itself; accept makes it active
//   quarantined  — the injection screen or the secret check held it back;
//                  release makes an injection-held note active (never one
//                  holding a secret); drop clears its text
//
// accept / release / drop refuse inside an agent's tool shell and without a
// terminal (security/agent-shell.mjs), then ask the user to type the id.

import { refuseInAgentShell, confirmTyped } from "../security/agent-shell.mjs";
import { redactSecrets } from "../security/secret-patterns.mjs";
import { neutralizeText } from "../digest/sanitize.mjs";

const preview = (t) => neutralizeText(redactSecrets(String(t ?? "")).text).replace(/\s+/g, " ").slice(0, 100);

function keyClause(keys, col) {
  if (keys === null) return { sql: "1", params: [] };
  if (!keys.length) return { sql: "0", params: [] };
  return { sql: `${col} IN (${keys.map(() => "?").join(",")})`, params: [...keys] };
}

/** Held learnings ("L<id>") and user facts ("F<id>") for `keys` (null = every project). */
export function heldNotes(handle, keys) {
  const lk = keyClause(keys, "project_slug");
  const learnings = handle.all(
    `SELECT id, project_slug, status, quarantine_reason, origin, created_at, text FROM learnings
      WHERE status IN ('pending', 'quarantined') AND ${lk.sql} ORDER BY id`,
    lk.params
  ).map((r) => ({ ref: `L${r.id}`, kind: "learning", id: r.id, project: r.project_slug, status: r.status, why: r.quarantine_reason ?? (r.origin === "agent" ? "written by the agent" : r.status), at: r.created_at, preview: preview(r.text) }));
  const fk = keys === null ? { sql: "1", params: [] } : keys.length ? { sql: `EXISTS (SELECT 1 FROM json_each(COALESCE(projects, '[]')) WHERE value IN (${keys.map(() => "?").join(",")}))`, params: [...keys] } : { sql: "0", params: [] };
  const facts = handle.all(
    `SELECT id, status, quarantine_reason, origin, created_at, text FROM user_facts
      WHERE status IN ('pending', 'quarantined') AND ${fk.sql} ORDER BY id`,
    fk.params
  ).map((r) => ({ ref: `F${r.id}`, kind: "fact", id: r.id, project: null, status: r.status, why: r.quarantine_reason ?? r.status, at: r.created_at, preview: preview(r.text) }));
  return [...learnings, ...facts];
}

export const heldLine = (n) => `${n} memory notes are waiting or held back. Review: ad memory held`;

/**
 * @param {string|undefined} sub  undefined (list) | "accept" | "release" | "drop"
 * @param {{ ref?: string, keys: string[]|null, handle: any, json?: boolean,
 *           env?: object, isTTY?: () => boolean, io?: {ask:(q:string)=>Promise<string>},
 *           out?: (line:string)=>void }} deps
 * @returns {Promise<number>} exit code
 */
export async function memoryHeld(sub, { ref, keys, handle, json = false, env = process.env, isTTY, io, out = (l) => console.log(l) }) {
  if (!sub || sub === "list") {
    const rows = heldNotes(handle, keys);
    if (json) {
      out(JSON.stringify(rows));
      return 0;
    }
    if (!rows.length) {
      out("No memory notes are waiting or held back.");
      return 0;
    }
    out(heldLine(rows.length).replace(/ Review: ad memory held$/, ""));
    for (const r of rows) out(`  ${r.ref.padEnd(6)} ${r.status.padEnd(11)} ${String(r.why).padEnd(24)} ${String(r.at ?? "").slice(0, 10)}  ${r.preview}`);
    out("Accept: ad memory held accept <id> · release: … release <id> · drop: … drop <id>");
    return 0;
  }
  if (!["accept", "release", "drop"].includes(sub)) {
    out(`ad memory held: unknown command "${sub}" (accept, release, drop)`);
    return 1;
  }
  const refused = refuseInAgentShell({ cmd: `memory held ${sub}`, env, ...(isTTY ? { isTTY } : {}) });
  if (refused) {
    out(refused);
    return 2;
  }
  const row = heldNotes(handle, keys).find((r) => r.ref.toLowerCase() === String(ref ?? "").toLowerCase() || (/^\d+$/.test(String(ref)) && r.kind === "learning" && r.id === Number(ref)));
  if (!row) {
    out(`No held memory note ${ref ?? ""} in this project.`.replace(/ {2}/, " "));
    return 1;
  }
  if (sub === "accept" && row.status !== "pending") {
    out(`Note ${row.ref} is held back (${row.why}), not waiting: use release or drop.`);
    return 1;
  }
  if (sub === "release" && row.status !== "quarantined") {
    out(`Note ${row.ref} is waiting, not held back: use accept.`);
    return 1;
  }
  if (sub === "release" && /^secret:/.test(row.why)) {
    out(`Note ${row.ref} holds a secret, so it can't go back into memory. Drop it: ad memory held drop ${row.ref}`);
    return 1;
  }
  if (!(await confirmTyped({ expected: row.ref, io }))) {
    out("Not confirmed: nothing changed.");
    return 1;
  }
  const table = row.kind === "fact" ? "user_facts" : "learnings";
  if (sub === "drop") {
    handle.run(`UPDATE ${table} SET status = 'rejected', text = '[dropped]' WHERE id = ?`, [row.id]);
    out(`Dropped ${row.ref}.`);
  } else {
    handle.run(`UPDATE ${table} SET status = 'active', quarantine_reason = NULL${table === "learnings" ? ", applied_to = NULL" : ""} WHERE id = ?`, [row.id]);
    out(`${sub === "accept" ? "Accepted" : "Released"} ${row.ref}: it is served in this project from the next session.`);
  }
  return 0;
}

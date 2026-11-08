// `ad review` / `<pkg> review` with the checklist (L5 design decision 11). What waits in
// the store comes first; proposal files (memory-promote, memory-reword, skills) keep the
// older loop, offered after (`review --proposals`).
//
//   review                 the checklist in a TTY (the token first; refused → the list)
//   review --list          the rows, numbered (no token)
//   review --plain         a numbered line mode with the same choices (also TERM=dumb, a
//                          screen under 12 rows)
//   review --accept-all    group 1's unflagged rows across every page, after the typed
//                          count; --with-agent adds the agent's
// A folder with nothing waiting (or no project) lists the projects that have waiting
// learnings and asks which.

import os from "node:os";
import path from "node:path";
import { checklistRows } from "./checklist-rows.mjs";
import { checklistText, openChecklist } from "./checklist-run.mjs";
import { createChecklist, plan, summaryLine } from "./checklist.mjs";
import { applyPlan } from "./checklist-apply.mjs";
import { clean } from "./checklist-view.mjs";
import { openSql } from "./trust.mjs";

const name = (slug) => String(slug ?? "").replace(/^-+/, "").split(/[-/\\]/).filter(Boolean).pop() ?? String(slug ?? "");

/** Projects with waiting learnings, newest first: [{ slug, id, n }]. */
export function waitingProjects(handle) {
  try {
    return handle.all(
      `SELECT project_slug AS slug, MAX(project_id) AS id, COUNT(*) AS n, MAX(created_at) AS at FROM learnings
        WHERE ${openSql()} AND project_slug IS NOT NULL GROUP BY project_slug ORDER BY at DESC`
    );
  } catch {
    return [];
  }
}

const keysOf = (p) => [p.slug, p.id].filter(Boolean);

/**
 * → an exit code, or null when nothing waits in the store anywhere (the caller goes on
 * with proposal files).
 * @param {{handle:object, keys:string[], cwd:string, out:Function, ask:(q:string)=>Promise<string>,
 *   gate:()=>Promise<{token?:object, refused?:string}>, isTTY:()=>boolean, env?:object,
 *   list?:boolean, plain?:boolean, acceptAll?:boolean, withAgent?:boolean, command?:(v:string)=>string,
 *   stdin?:object, stdout?:object, home?:string}} o
 */
export async function reviewChecklist(o) {
  const { handle, out } = o;
  if (!handle) return null;
  const command = o.command ?? ((v) => `ad ${v}`);
  const env = o.env ?? process.env;
  let keys = o.keys ?? [];
  let picked = null;
  let rows = keys.length ? checklistRows(handle, keys) : [];
  const projects = waitingProjects(handle);
  const here = keys.find((k) => !String(k).startsWith("prj_")) ?? null;
  const others = projects.filter((p) => p.slug !== here);
  if (!rows.length) {
    if (!projects.length) return null;
    // Nothing waits here: which project?
    out(keys.length ? "Nothing waits for review in this folder. Projects with waiting learnings:" : "This folder isn't a project ad knows. Projects with waiting learnings:");
    projects.forEach((p, i) => out(`  ${i + 1}. ${name(p.slug)} (${p.n})`));
    if (o.list || !o.isTTY()) {
      out(`Run ${command("review")} in that project's folder to review them.`);
      return 0;
    }
    const pick = Number(String(await o.ask("Which one? (number, enter to stop) ")).trim());
    const p = projects[pick - 1];
    if (!p) return 0;
    keys = keysOf(p);
    picked = p;
    rows = checklistRows(handle, keys);
    if (!rows.length) return 0;
  }
  const slug = keys.find((k) => !String(k).startsWith("prj_")) ?? null;
  const projectId = keys.find((k) => String(k).startsWith("prj_")) ?? null;
  const also = projects.filter((p) => p.slug !== slug).slice(0, 3).map((p) => `${name(p.slug)} (${p.n})`);
  const header = `${picked ? "Project" : "This folder"}: ${name(slug)}${also.length ? ` · also waiting: ${also.join(", ")}` : ""}`;

  if (o.list) {
    out(header);
    for (const l of checklistText(rows)) out(l);
    out(`Review them in your own terminal: ${command("review")}`);
    return 0;
  }
  if (!o.isTTY()) {
    out(header);
    for (const l of checklistText(rows)) out(l);
    out(`Run ${command("review")} in your own terminal to decide (in Git Bash's mintty, run it through winpty or in Windows Terminal).`);
    return 0;
  }
  // The token first, before the screen opens: refused → the list and the refusal.
  const g = await o.gate();
  if (!g.token) {
    out(header);
    for (const l of checklistText(rows)) out(l);
    out(g.refused ?? "Reviewing needs your own terminal.");
    return 2;
  }
  // The project's own memory file: the picked project's folder, else this one.
  const where = picked ? projectPath(handle, picked.slug) : o.cwd;
  const projectMemory = where ? await memoryPath(where) : null;
  const memoryFile = [projectMemory, path.join(o.home ?? os.homedir(), ".agent-daemon", "user.md")].filter(Boolean);

  if (o.acceptAll) return acceptAll({ ...o, rows, keys, slug, projectId, token: g.token, memoryFile, projectMemory });

  const stdout = o.stdout ?? process.stdout;
  const stdin = o.stdin ?? process.stdin;
  // Raw keys only where they can be read: a stdin that can go raw (a scripted or piped
  // input gets the line mode, which reads answers).
  const raw = Boolean(stdin?.isTTY && typeof stdin.setRawMode === "function");
  const plain = o.plain || !raw || env.TERM === "dumb" || (Number(stdout.rows) || 24) < 12;
  if (plain) return plainMode({ ...o, rows, keys, slug, projectId, token: g.token, header, memoryFile, projectMemory });

  // The line reader lets go of stdin first: the checklist reads raw keys.
  o.release?.();
  const r = await openChecklist({ handle, keys, token: g.token, stdin, stdout, rows, header, slug, projectId, memoryFile, projectMemory, onApply: o.onApply });
  return report(out, r);
}

async function memoryPath(dir) {
  try {
    return (await (await import("../digest/apply.mjs")).resolveProjectMemoryPath(dir)) ?? null;
  } catch {
    return null; // no project memory file
  }
}

// A project's folder as the store recorded it (its notes' project_path).
function projectPath(handle, slug) {
  try {
    // An accepted note's recorded folder first (the user decided it), then the newest.
    return handle.get("SELECT project_path FROM learnings WHERE project_slug = ? AND project_path IS NOT NULL ORDER BY (accepted_by IS NOT NULL) DESC, id DESC LIMIT 1", [slug])?.project_path ?? null;
  } catch {
    return null;
  }
}

function report(out, r) {
  if (r.ended === "empty") {
    out("Nothing waits for review here.");
    return 0;
  }
  if (r.ended !== "applied") {
    out(r.ended === "error" ? `Review stopped: ${r.error?.message ?? "an error"}. Nothing was saved.` : "Nothing saved.");
    return r.ended === "error" ? 1 : r.ended === "signal" ? 143 : 0;
  }
  const a = r.applied;
  const parts = [a.accepted.length && `accepted ${a.accepted.length}`, a.deleted.length && `deleted ${a.deleted.length}`, a.forgotten.length && `forgot ${a.forgotten.length}`, a.kept.length && `kept ${a.kept.length}`, a.restored.length && `restored ${a.restored.length}`, a.unmarked.length && `kept ${a.unmarked.length} you asked to remove`].filter(Boolean);
  out(parts.length ? `Done: ${parts.join(", ")}.${a.accepted.length ? " Agents use these from your next session." : ""}` : "Nothing changed (decided elsewhere meanwhile).");
  return 0;
}

// --accept-all: group 1's unflagged, unmarked notes across every page (with --with-agent,
// group 2's too), after the count is typed back. Never flagged, file, history or removed rows.
async function acceptAll(o) {
  const groups = o.withAgent ? ["new", "agent"] : ["new"];
  const take = o.rows.filter((r) => groups.includes(r.group) && r.kind === "note" && !r.flagged && !r.secret && !r.accepted);
  if (!take.length) {
    const agent = o.rows.some((r) => r.group === "agent" && r.kind === "note" && !r.flagged && !r.secret);
    o.out(o.withAgent || !agent ? "Nothing to accept in bulk here (flagged notes are decided one at a time)." : `Nothing new from your prompts to accept in bulk here; the agent's notes need ${(o.command ?? ((v) => `ad ${v}`))("review --accept-all --with-agent")}.`);
    return 1;
  }
  o.out(`Accept these ${take.length}?`);
  for (const r of take) o.out(`  #${r.ids[0]} ${clean(r.text)} · ${clean(r.source)}`);
  const typed = String(await o.ask(`Type ${take.length} to accept them: `)).trim();
  if (typed !== String(take.length)) {
    o.out("Not confirmed: nothing changed.");
    return 1;
  }
  const s = createChecklist(take, { pageSize: take.length });
  const choice = Object.fromEntries(take.map((r) => [r.key, "yes"]));
  const res = await applyPlan(o.handle, o.token, plan({ ...s, choice }), { keys: o.keys, slug: o.slug, projectId: o.projectId, rows: take, memoryFile: o.memoryFile, projectMemory: o.projectMemory, onApply: o.onApply });
  o.out(`Accepted ${res.accepted.length}. Agents use these from your next session.`);
  return 0;
}

// A numbered line mode with the same choices: numbers to use, xN to delete, yN to use a
// flagged one, a for the new ones from your prompts; then the summary and y.
async function plainMode(o) {
  o.out(o.header);
  const lines = checklistText(o.rows);
  for (const l of lines) o.out(l);
  const order = [];
  // checklistText numbers rows group by group, in GROUPS order.
  const { GROUPS } = await import("./checklist.mjs");
  for (const g of GROUPS) for (const r of o.rows) if (r.group === g.id) order.push(r);
  const s = createChecklist(o.rows, { pageSize: o.rows.length });
  const choice = {};
  const answer = String(await o.ask("Numbers to use (1 3), x2 to delete, y4 to use a flagged one, a for the new ones; enter when done: ")).trim();
  for (const tok of answer.split(/[\s,]+/).filter(Boolean)) {
    if (tok === "a") {
      for (const r of order) if (r.group === "new" && r.kind === "note" && !r.flagged && !r.secret) choice[r.key] = "yes";
      continue;
    }
    const m = /^([xy]?)(\d+)$/i.exec(tok);
    const r = m ? order[Number(m[2]) - 1] : null;
    if (!r) {
      o.out(`Skipped "${tok}": not a row number.`);
      continue;
    }
    const verb = m[1].toLowerCase();
    if (verb === "x") choice[r.key] = "no";
    else if (r.secret) o.out(`#${r.ids[0]} holds what looks like a secret: it can only be deleted (x${m[2]}).`);
    else if ((r.flagged || r.kind === "flagged") && verb !== "y") o.out(`#${r.ids[0]} was flagged: type y${m[2]} to use it anyway.`);
    else choice[r.key] = "yes";
  }
  const st = { ...s, choice };
  const p = plan(st);
  if (!Object.keys(choice).length) {
    o.out("Nothing chosen: nothing changed.");
    return 0;
  }
  if (String(await o.ask(`${summaryLine(p)} `)).trim().toLowerCase() !== "y") {
    o.out("Nothing saved.");
    return 0;
  }
  const res = await applyPlan(o.handle, o.token, p, { keys: o.keys, slug: o.slug, projectId: o.projectId, rows: o.rows, shownHidden: o.rows.filter((r) => r.kind === "hidden" && r.statusAtNull).flatMap((r) => r.ids), memoryFile: o.memoryFile, projectMemory: o.projectMemory, onApply: o.onApply });
  return report(o.out, { ended: "applied", applied: res });
}

// `ad state inspect | export | verify` (P7.2) and `ad memory redact` (owned by P7.2): the command
// lines. The work is in export.mjs; this file parses, prints and maps errors to exit codes.

import fs from "node:fs";
import { parseArgs } from "node:util";
import { exportSummary, planExport, runExport, verifyBundle, EXPORT_TEXTS } from "./export.mjs";

export const STATE_HELP = `ad state inspect [--project <dir>]... [--all-projects] [--include <class>]... [--json]
    What an export would contain: classes, files per project, exclusions, problems. Opens no secret.
ad state export --out <file.adstate> [--project <dir>]... [--all-projects] [--include <class>]... [--exclude <class>]... [--redact]
    Writes one bundle. Default: the current folder's project only.
ad state verify <file.adstate>
    Reads a bundle the way import does and reports problems. Changes nothing.
ad state import <file.adstate> [--dry-run] [--map <project>=<dir>]... [--search <dir>]... [--on-conflict refuse|keep-mine|take-theirs|keep-both] [--accept-held]
    Brings a bundle in: memory arrives for review (ad review --import <id>), settings merge, nothing is overwritten unless you say so.
ad state import --resume <importId>   finish an interrupted import
ad state imports                      list imports and their state
ad state rollback <importId>          undo an import's own writes
ad state verify --import <importId>   counts, integrity and recall on this computer
`;

function parse(args) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      project: { type: "string", multiple: true },
      "all-projects": { type: "boolean" },
      include: { type: "string", multiple: true },
      exclude: { type: "string", multiple: true },
      out: { type: "string" },
      redact: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      map: { type: "string", multiple: true },
      search: { type: "string", multiple: true },
      "dry-run": { type: "boolean" },
      "on-conflict": { type: "string" },
      "accept-held": { type: "boolean" },
      "force-tracked": { type: "boolean" },
      resume: { type: "string" },
      import: { type: "string" },
    },
  });
}

export async function cmdState(args, { out = process.stdout, err = process.stderr, env = process.env, cwd = process.cwd(), appVersion = null } = {}) {
  let p;
  try {
    p = parse(args);
  } catch (e) {
    err.write(`ad state: ${e.message}\n${STATE_HELP}`);
    return 2;
  }
  const [sub, file] = p.positionals;
  const o = { dirs: p.values.project ?? [], allProjects: Boolean(p.values["all-projects"]), include: p.values.include ?? [], exclude: p.values.exclude ?? [], cwd, env };
  const imp = await import("./import.mjs");
  // An interrupted import is said by every ad state command.
  for (const line of imp.interruptedNotice({ env })) if (sub !== "rollback" && !p.values.resume) err.write(`${line}\n`);
  if (p.values.help || (!sub && !p.values.resume)) {
    out.write(STATE_HELP);
    return sub ? 0 : 1;
  }
  try {
    if (sub === "inspect") {
      const plan = planExport(o);
      const byClass = {};
      for (const f of plan.files) byClass[f.class] = (byClass[f.class] ?? 0) + 1;
      if (p.values.json) {
        out.write(`${JSON.stringify({ projects: plan.projects.map(({ id, name, path }) => ({ id, name, path })), globalMemory: plan.globalMemory, files: byClass, excluded: plan.excluded, skipped: plan.skipped, problems: plan.problems }, null, 2)}\n`);
        return plan.problems.length ? 1 : 0;
      }
      out.write(`Projects: ${plan.projects.map((x) => `${x.name} (${x.path ?? "folder gone"})`).join(", ") || "none"}\n`);
      out.write(`Global memory: ${plan.globalMemory ? "included" : "not included (add --include global-memory)"}\n`);
      out.write(`Memory database: per project, from a snapshot\n`);
      for (const [c, n] of Object.entries(byClass).sort()) out.write(`  ${c.padEnd(18)} ${n} file${n === 1 ? "" : "s"}\n`);
      if (plan.excluded.length) out.write(`Not included: ${plan.excluded.join(", ")}\n`);
      for (const s of plan.skipped) out.write(`Skipped: ${s.path}: ${s.why}\n`);
      for (const x of plan.problems) out.write(`Problem: ${x.path}: ${x.why}\n`);
      return plan.problems.length ? 1 : 0;
    }
    if (sub === "export") {
      if (!p.values.out) {
        err.write("ad state export: --out <file.adstate> is required\n");
        return 2;
      }
      const r = await runExport({ ...o, out: p.values.out, redact: Boolean(p.values.redact), appVersion });
      out.write(`${exportSummary(r)}\n`);
      return 0;
    }
    if (sub === "import" || p.values.resume) {
      if (p.values.resume) {
        const r = await imp.resumeImport(p.values.resume, { env });
        out.write(`Import ${p.values.resume}: ${r.status}.\n`);
        return r.status === "complete" ? 0 : 1;
      }
      if (!file) {
        err.write("Usage: ad state import <file.adstate> [--dry-run] [--map <project>=<dir>]...\n");
        return 2;
      }
      const maps = (p.values.map ?? []).map((m) => {
        const i = m.indexOf("=");
        return { key: m.slice(0, i), dir: m.slice(i + 1) };
      });
      const plan = await imp.planImport({ file, maps, search: p.values.search ?? [], onConflict: p.values["on-conflict"] ?? "refuse", acceptHeld: Boolean(p.values["accept-held"]), forceTracked: Boolean(p.values["force-tracked"]), env });
      out.write(`${imp.planText(plan, { dryRun: Boolean(p.values["dry-run"]) })}\n`);
      if (p.values["dry-run"]) {
        fs.rmSync(plan.dir, { recursive: true, force: true });
        return 0;
      }
      const r = await imp.runImport(plan, { env });
      out.write(`Imported (${r.importId}). Next: ad review --import ${r.importId} · sign in to each account · run ad init in each project · switch on the schedules you want. Undo: ad state rollback ${r.importId}\n`);
      return 0;
    }
    if (sub === "imports") {
      const list = imp.listImports({ env });
      if (!list.length) out.write("No imports yet.\n");
      for (const i of list) out.write(`${i.importId}  ${i.status.padEnd(11)} ${String(i.createdAt).slice(0, 16)}  from ${i.exportId}\n`);
      return 0;
    }
    if (sub === "rollback") {
      if (!file) {
        err.write("Usage: ad state rollback <importId>\n");
        return 2;
      }
      const r = await imp.rollbackImport(file, { env });
      out.write(`Rolled back ${file}.${r.kept.length ? ` Kept (changed since, or used by newer memory):
${r.kept.map((k) => `  ${k}`).join("\n")}` : ""}\n`);
      return 0;
    }
    if (sub === "verify" && p.values.import) {
      const v = await imp.verifyImport(p.values.import, { env });
      out.write(`Import ${p.values.import}: ${v.status} · database ${v.integrity}\n`);
      for (const [t, n] of Object.entries(v.landed)) out.write(`  ${t}: ${n} row(s) came in\n`);
      for (const r of v.recall) out.write(`Recall: ${r.found}/${r.of} lessons found in ${r.project}\n`);
      return v.integrity === "ok" && v.recall.every((r) => r.found === r.of) ? 0 : 1;
    }
    if (sub === "verify") {
      if (!file) {
        err.write("Usage: ad state verify <file.adstate>\n");
        return 2;
      }
      const v = verifyBundle(fs.readFileSync(file));
      if (!v.problems.length) {
        const m = v.manifest;
        out.write(`${file}: no problem found. ${m.projects.length} project(s), ${m.files.length} file(s), made ${m.createdAt} on ${m.source?.os ?? "?"}.\n`);
        return 0;
      }
      for (const x of v.problems) out.write(`Problem: ${x}\n`);
      return 1;
    }
    err.write(`ad state: unknown command ${sub}\n${STATE_HELP}`);
    return 2;
  } catch (e) {
    if (e.problems?.length > 1) for (const x of e.problems.slice(1)) err.write(`  also: ${x}\n`);
    if (e.code === "EXPORT_SECRETS") {
      for (const h of e.hits) err.write(`  ${h.where}: looks like ${h.kind}\n`);
    }
    err.write(`${e.code === "EXPORT_NAMES" ? "Export stopped: some names can't go into a bundle:\n" : ""}${e.message}\n`);
    return e.exitCode ?? (e.code === "EXPORT_USAGE" ? 2 : 1);
  }
}

/**
 * ad memory redact <table>:<id>: replaces what looks like a key in one live row with
 * [redacted:<kind>], after a typed confirmation, in a terminal of your own (never from an agent's
 * shell). Only the matched spans change.
 */
export async function cmdMemoryRedact(ref, { out = process.stdout, err = process.stderr, env = process.env, isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY), ask, dbPath } = {}) {
  if (env.AD_TOOL_SHELL === "1") {
    err.write("ad memory redact changes your memory, so ad doesn't run it from an agent's shell.\n");
    return 2;
  }
  const m = /^([a-z_]+):(\d+)$/.exec(String(ref ?? ""));
  if (!m) {
    err.write("Usage: ad memory redact <table>:<id>   (the export lists them, e.g. learnings:812)\n");
    return 2;
  }
  if (!isTTY) {
    err.write("ad memory redact needs your own terminal (it asks you to type the row to confirm).\n");
    return 2;
  }
  const { tableByName } = await import("../memory/tables.mjs");
  const { findSecrets, redactSecrets } = await import("../security/secret-patterns.mjs");
  const { openDatabase } = await import("../memory/driver.mjs");
  const { defaultDbPath } = await import("../memory/sqlite.mjs");
  const reg = tableByName(m[1]);
  if (!reg?.textColumns.length) {
    err.write(`${m[1]} has no text ad screens for keys.\n`);
    return 2;
  }
  const db = await openDatabase(dbPath ?? defaultDbPath());
  if (!db) {
    err.write("The memory database couldn't be opened.\n");
    return 1;
  }
  try {
    const row = db.prepare(`SELECT ${reg.textColumns.map((c) => `"${c}"`).join(", ")} FROM "${m[1]}" WHERE id = ?`).get(Number(m[2]));
    if (!row) {
      err.write(`No row ${ref}.\n`);
      return 1;
    }
    const kinds = reg.textColumns.flatMap((c) => findSecrets(String(row[c] ?? "")).map((h) => h.kind));
    if (!kinds.length) {
      out.write(`Nothing in ${ref} looks like a key.\n`);
      return 0;
    }
    out.write(`${ref}: ${kinds.length} span(s) look like ${[...new Set(kinds)].join(", ")}. They become [redacted:<kind>]; the rest of the row stays.\n`);
    const typed = await ask(`Type ${ref} to confirm: `);
    if (String(typed ?? "").trim() !== ref) {
      out.write("Not changed.\n");
      return 1;
    }
    for (const c of reg.textColumns) {
      if (row[c] == null) continue;
      const r = redactSecrets(String(row[c]));
      if (r.kinds.length) db.prepare(`UPDATE "${m[1]}" SET "${c}" = ? WHERE id = ?`).run(r.text, Number(m[2]));
    }
    out.write(`Redacted ${ref}.\n`);
    return 0;
  } finally {
    db.close();
  }
}

export { EXPORT_TEXTS };

/** ad review --import <id> [--accept-all] (P7.3). */
export async function cmdReviewImport(importId, { acceptAll = false, out = process.stdout, err = process.stderr, env = process.env } = {}) {
  const { reviewImport } = await import("./import.mjs");
  const { createInterface } = await import("node:readline/promises");
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    await reviewImport(importId, { acceptAll, env, out, ask: (q) => rl?.question(q) ?? Promise.resolve("") });
    return 0;
  } catch (e) {
    err.write(`${e.message}\n`);
    return e.exitCode ?? 1;
  } finally {
    rl?.close();
  }
}

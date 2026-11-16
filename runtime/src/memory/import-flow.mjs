// The consented import (MCP launch plan L4b, decision 22): one flow for `ad mistakes
// --save` (and the memory package's `mistakes --save`) and install's reserved step (L3
// Decision 26). It shows its own consent text, naming what will be saved, before
// anything is read; then it saves the repeated corrections in this project's agent
// history and the instructions in its instruction files as pending proposals
// (history-import.mjs, instruction-import.mjs). Nothing applies until the user accepts
// it in the review checklist (L5), which `<base> review` opens: the flow itself never
// asks for a review token (review-gate.test.mjs: only the review verbs and ad's own
// terminal UI do, never the installer).
//
// Consent is a specific answer: [a]ll, [h]istory only or [f]iles only. Anything else is
// No, and `--yes` is never consent (the import flags are). The store and the project's
// keys are opened only after consent, so a No leaves nothing behind.

import os from "node:os";
import path from "node:path";
import { listSources, findProject } from "../mistakes/history.mjs";
import { span, count } from "../mistakes/cli.mjs";
import { neverValid } from "./scope.mjs";
import { importHistory } from "./history-import.mjs";
import { findInstructionFiles, importInstructionFiles } from "./instruction-import.mjs";

export const IMPORT_TEXTS = Object.freeze({
  question: "Save them for your review? [a]ll / [h]istory only / [f]iles only / [N]o ",
  declined: "Nothing was saved.",
  later: (base) => `To do this later, run \`${base} mistakes --save\` in this project.`,
  notProject: (why, base) => `This folder can't hold project memory (${why}). Run \`${base} mistakes --save\` inside a project to save its repeated corrections and instruction files for review.`,
  nothing: "No agent history or instruction files found for this project: nothing to save.",
  nonInteractive: "Run it again with --import-history and/or --import-files to save them (--yes alone saves nothing).",
  reading: "Reading… (the history takes a few seconds per thousand sessions)",
  noKeys: "This folder has no project memory key, so nothing was saved.",
  noStore: "The memory store couldn't be opened, so nothing was saved.",
  failed: "The memory store couldn't be written, so this part wasn't saved",
});

/** An answer to IMPORT_TEXTS.question → "all" | "history" | "files" | null (No). */
export function parseChoice(answer) {
  const a = String(answer ?? "").trim().toLowerCase();
  if (a === "a" || a === "all") return "all";
  if (a === "h" || a === "history") return "history";
  if (a === "f" || a === "files") return "files";
  return null;
}

/** The consent text: what will be saved, from where, before anything is read. */
export function consentLines({ sources, files, root, tilde = (p) => p, base = "ad" }) {
  const lines = [`${base} can save, for your review, what you've already told your agents in this project (${tilde(root)}):`];
  const cc = sources.claude;
  const cx = sources.codex;
  const rows = [];
  if (cc.files.length) rows.push(["Claude Code", tilde(cc.dir), `${count(cc.files.length, "session")}, ${span(cc.files)}`]);
  if (cx.files.length) rows.push(["Codex", `${tilde(path.join(cx.dir, "sessions"))} and archived_sessions`, `${count(cx.files.length, "session")} in all projects (each is opened; only this folder's are counted), ${span(cx.files)}`]);
  if (rows.length) {
    lines.push("  - one redacted sentence per correction you repeated in this project, and the dates and counts of the ones you made once, from:");
    const w0 = Math.max(...rows.map((r) => r[0].length));
    const w1 = Math.max(...rows.map((r) => r[1].length));
    for (const [a, b, c] of rows) lines.push(`      ${a.padEnd(w0)}  ${b.padEnd(w1)}  ${c}`);
  }
  if (files.length) lines.push(`  - the instructions in ${files.map((f) => f.file).join(", ")} (${base}'s own blocks in them are skipped)`);
  lines.push("  Also read: Claude Code's settings.json (how long it keeps history) and Codex's config.toml (which files it loads).");
  lines.push("Nothing applies until you accept it, and a rejected item is deleted. Offline: no model call, no network.");
  return lines;
}

function summaryLines({ history, files, base }) {
  const lines = [""];
  let added = 0;
  if (history) {
    const h = history;
    added += (h.proposed ?? 0) + (h.quarantined ?? 0);
    const parts = [`${count(h.proposed ?? 0, "repeated correction")} from your history`];
    if (h.waiting) parts.push(`${h.waiting} more wait for a later import (at most 20 at a time)`);
    if (h.linked) parts.push(`${h.linked} already in your notes`);
    if (h.rejectedBefore) parts.push(`${h.rejectedBefore} you rejected before, left out`);
    if (h.skipped) parts.push(`not read: ${h.skipped}`);
    lines.push(`  ${parts.join("; ")}`);
    if (h.quarantined) lines.push(`  ${count(h.quarantined, "correction")} held back: ${h.quarantined === 1 ? "it reads" : "they read"} like instructions to the agent (shown as flagged)`);
  }
  if (files) {
    if (files.skipped) lines.push(`  instruction files not read: ${files.skipped}`);
    for (const f of files.files ?? []) {
      if (f.skipped) {
        lines.push(`  ${f.file}: skipped, ${f.skipped}`);
        continue;
      }
      if (f.unchanged) {
        lines.push(`  ${f.file}: unchanged since the last import`);
        continue;
      }
      if (f.gone) {
        lines.push(`  ${f.file}: gone; its waiting lines were hidden`);
        continue;
      }
      added += (f.proposed ?? 0) + (f.quarantined ?? 0);
      const parts = [`${count(f.proposed ?? 0, "new line")}`];
      if (f.linked) parts.push(`${f.linked} already in your notes`);
      if (f.quarantined) parts.push(`${f.quarantined} held back (they read like instructions to the agent)`);
      if (f.notImported) parts.push(`${f.notImported} not imported (too long, or past 200 lines)`);
      if (f.hidden) parts.push(`${f.hidden} no longer in the file, hidden`);
      lines.push(`  ${f.file}: ${parts.join("; ")}`);
    }
  }
  lines.splice(1, 0, added > 0 ? "Saved for your review. Nothing applies until you accept it." : "Nothing new to review.");
  if (added > 0) lines.push(`Review them: ${base} review`);
  return { lines, added };
}

/**
 * @param {{cwd?:string, env?:object, home?:string, out?:(line:string)=>void, ask?:(q:string)=>Promise<string>,
 *   isTTY?:()=>boolean, choice?:"all"|"history"|"files"|null, base?:string, now?:Date,
 *   store?:()=>Promise<object|null>, keysOf?:(root:string)=>Promise<string[]>,
 *   list?:typeof listSources}} o
 * @returns {Promise<{code:number, saved:boolean, history?:object, files?:object}>}
 */
export async function runImport(o = {}) {
  const env = o.env ?? process.env;
  // The default store and keys follow process.env (episodic.db(), the project registry);
  // a caller with another env (a test's install context) must bring its own.
  if (env !== process.env && (!o.store || !o.keysOf)) throw new Error("runImport: a custom env needs its own store and keysOf");
  const home = o.home ?? os.homedir();
  const out = o.out ?? ((l) => process.stdout.write(`${l}\n`));
  const isTTY = o.isTTY ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY));
  const base = o.base ?? "ad";
  const now = o.now ?? new Date();
  const tilde = (p) => (home && (p === home || p.startsWith(home + path.sep)) ? "~" + p.slice(home.length) : p);

  // One root for the history, the files and the notes (decision 12).
  // The folder itself counts too: a stray .git above home must not make home a project.
  const cwd = path.resolve(o.cwd ?? process.cwd());
  const { root } = findProject(cwd);
  const why = neverValid(cwd, { env, home }) ?? neverValid(root, { env, home });
  if (why) {
    out(IMPORT_TEXTS.notProject(why, base));
    return { code: 1, saved: false };
  }
  const sources = (o.list ?? listSources)({ env, home, cwd: root });
  const files = findInstructionFiles(root).filter((f) => !f.skip);
  const hasHistory = sources.claude.files.length + sources.codex.files.length > 0;
  if (!hasHistory && !files.length) {
    out(IMPORT_TEXTS.nothing);
    return { code: 0, saved: false };
  }
  for (const l of consentLines({ sources, files, root, tilde, base })) out(l);

  let choice = o.choice ?? null;
  if (!choice) {
    if (!isTTY() || !o.ask) {
      out(IMPORT_TEXTS.nonInteractive);
      return { code: 2, saved: false };
    }
    choice = parseChoice(await o.ask(`\n${IMPORT_TEXTS.question}`));
  }
  if (!choice) {
    out(IMPORT_TEXTS.declined);
    out(IMPORT_TEXTS.later(base));
    return { code: 0, saved: false };
  }

  // Consent given: only now the project's keys (they register the folder) and the store.
  const result = { code: 0, saved: false };
  const failures = [];
  let handle;
  let keys;
  try {
    keys = await (o.keysOf ?? (async (r) => (await import("./scope.mjs")).hookProjectKeys(r, { env })))(root);
    if (!keys?.length) {
      out(IMPORT_TEXTS.noKeys);
      return { code: 1, saved: false };
    }
    handle = await (o.store ?? (async () => (await import("./episodic.mjs")).db()))();
    if (!handle) {
      out(IMPORT_TEXTS.noStore);
      return { code: 1, saved: false };
    }
  } catch (e) {
    out(`${IMPORT_TEXTS.failed} (${e?.message ?? e})`);
    return { code: 1, saved: false };
  }
  out(IMPORT_TEXTS.reading);
  // Each import is one transaction: a failure leaves that part as it was.
  const part = (fn) => {
    try {
      return fn();
    } catch (e) {
      failures.push(e?.message ?? String(e));
      return undefined;
    }
  };
  if (choice !== "files" && hasHistory) result.history = part(() => importHistory({ handle, keys, root, consent: true, env, home, now }));
  if (choice !== "history" && files.length) result.files = part(() => importInstructionFiles({ handle, keys, root, consent: true, env, home, now }));
  const { lines, added } = summaryLines({ history: result.history, files: result.files, base });
  result.saved = added > 0;
  for (const l of lines) out(l);
  for (const f of failures) out(`${IMPORT_TEXTS.failed} (${f})`);
  if (failures.length) result.code = 1;
  return result;
}

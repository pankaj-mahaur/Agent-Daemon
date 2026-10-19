// Interactive review of queued proposals.
//
// Reads proposals from the project's capture folder (memory/project-dir.mjs:
// <cwd>/.agent-daemon/proposed, or ad's own folder for a project the user
// didn't set up) and from ad's global folder, and prompts the user (a)ccept /
// (r)eject / (e)dit / (s)kip / (q)uit for each one.
//
// Behavior per choice:
//   accept  — apply the proposal and move the file to applied/
//   reject  — delete the proposal file
//   edit    — open the proposal in $EDITOR; user saves, then re-prompted
//   skip    — leave it for next run
//   quit    — exit the review loop, leave remainder queued
//
// Memory proposals (P5.2) change what reaches sessions, so accepting them is
// the user's alone (D49): every accept path — the interactive loop, --accept
// <file>, --accept-all, --global — refuses inside an agent's tool shell
// (AD_TOOL_SHELL) and without a terminal, then asks the user to type "accept"
// (or the count, for a batch). There is no --yes and no environment override.
//   memory-add      accept → the pending note becomes active and joins project memory
//   memory-promote  accept → the note becomes a cross-project note
//   --global        3.0's automatic global notes, grouped by the project they came
//                   from: accept → cross-project; reject → that project only
//
// Skill-edit and constitution-add proposals still need the file applied by
// hand (the suggested patch is printed).

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import { editorCommand, editorInvocation } from "./safe-spawn.mjs";
import { stdin as input, stdout as output } from "node:process";
import { globalProposedDir, projectDataDir } from "./memory/project-dir.mjs";
import { readProposalMeta, appendToMemory } from "./digest/proposals.mjs";
import { learningContentHash, scopedContentHash } from "./memory/sqlite.mjs";
import { sameNote } from "./memory/episodic.mjs";
import { neutralizeText } from "./digest/sanitize.mjs";

const DIVIDER = "─".repeat(72);

export const GUARD_TEXTS = Object.freeze({
  toolShell: "ad review: accepting notes can't run from the agent's own shell. Run it yourself in a terminal.",
  noTty: "ad review: accepting notes needs an interactive terminal.",
  yes: "ad review: there is no --yes: accepting notes always asks you to type the confirmation.",
});

const realTTY = () => Boolean(input.isTTY && output.isTTY);

/** The D49 guard for accept paths: the refusal text, or null. */
export function reviewGuard({ env = process.env, isTTY = realTTY } = {}) {
  if (env.AD_TOOL_SHELL === "1") return GUARD_TEXTS.toolShell;
  if (!isTTY()) return GUARD_TEXTS.noTty;
  return null;
}

/** Where this project's proposals are, in review order. */
export function proposalDirs(cwd) {
  return [path.join(projectDataDir(cwd), "proposed"), globalProposedDir()];
}

async function listProposals(cwd) {
  const out = [];
  for (const dir of proposalDirs(cwd)) {
    let names = [];
    try {
      names = (await fs.readdir(dir)).filter((e) => e.endsWith(".md") || e.endsWith(".diff")).sort();
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    for (const name of names) out.push({ name, file: path.join(dir, name), dir });
  }
  return out;
}

const learningRow = (handle, id) => handle.get("SELECT id, project_slug, category, text, evidence, confidence, tags, status, observed_count, retrieval_count, promote_request FROM learnings WHERE id = ?", [id]);
// What the user reads before confirming: control characters stripped (an escape code could hide or redraw it).
const preview = (t) => neutralizeText(String(t ?? "")).replace(/\s+/g, " ").trim().slice(0, 200);

/**
 * What a memory proposal would do, from the store, never from the file: a
 * proposal file is only a pointer (anything that can write the folder could
 * forge one), so the user confirms the note the store holds, and only a step
 * the store is waiting for is allowed:
 *   memory-add      a pending note of this project
 *   memory-promote  a note of this project that asked to become cross-project
 * → {ok:true, row, line} | {ok:false, text}
 */
export function describeMemory(handle, meta, keys) {
  const row = learningRow(handle, meta.learning);
  if (!row || !keys.includes(row.project_slug)) return { ok: false, text: `Learning #${meta.learning} isn't a note of this project.` };
  if (meta.kind === "memory-add" && row.status !== "pending") return { ok: false, text: `Learning #${row.id} isn't waiting for review (${row.status}): nothing to accept.` };
  if (meta.kind === "memory-promote" && (row.promote_request !== "global" || !["pending", "active"].includes(row.status))) return { ok: false, text: `Learning #${row.id} didn't ask to become a cross-project note: nothing to accept.` };
  const action = meta.kind === "memory-add" ? "use in this project" : "use in every project";
  return { ok: true, row, line: `#${row.id} (${action}): ${preview(row.text)}` };
}

/**
 * Apply an accepted memory proposal to the store. → {ok, text} (text says what happened).
 * keys: the project keys this review is bound to; a proposal for another project's note is refused.
 */
export async function acceptMemory(handle, meta, { cwd, keys, now = new Date() }) {
  const d = describeMemory(handle, meta, keys);
  if (!d.ok) return d;
  const row = d.row;
  if (meta.kind === "memory-add") {
    handle.run("UPDATE learnings SET status = 'active', applied_to = 'memory:project' WHERE id = ?", [row.id]);
    const { resolveProjectMemoryPath } = await import("./digest/apply.mjs");
    const tags = (() => {
      try {
        return JSON.parse(row.tags || "[]");
      } catch {
        return [];
      }
    })();
    await appendToMemory(await resolveProjectMemoryPath(cwd), [{ learning: { type: row.category, text: row.text, evidence_quote: row.evidence, confidence: row.confidence, tags } }], null, now.toISOString());
    return { ok: true, text: `Accepted #${row.id}: it reaches your sessions in this project.` };
  }
  return promoteLearning(handle, row, now);
}

/**
 * memory-promote: the note becomes cross-project with the plain content hash.
 * A cross-project note with that text already there stays, and this one is
 * superseded by it (counts merged). A 3.0 project note in another project that
 * still holds the plain hash moves to its own project-scoped hash first.
 */
export function promoteLearning(handle, row, now = new Date()) {
  const plain = learningContentHash(row.text);
  return handle.transaction(() => {
    let holder = handle.get("SELECT id, project_slug, status, applied_to FROM learnings WHERE content_hash = ? AND id != ?", [plain, row.id]);
    // A holder that is never served (rejected, held back, superseded) gives up the
    // hash instead of swallowing the note the user just accepted.
    const served = holder && ["active", "pending"].includes(holder.status) && !String(holder.applied_to ?? "").startsWith("quarantined");
    if (holder && holder.project_slug === null && !served) {
      handle.run("UPDATE learnings SET content_hash = ?, norm_key = NULL WHERE id = ?", [`retired-${holder.id}`, holder.id]);
      holder = null;
    }
    if (holder && holder.project_slug === null) {
      handle.run("UPDATE learnings SET observed_count = observed_count + ?, retrieval_count = retrieval_count + ?, global_accepted_at = COALESCE(global_accepted_at, ?), status = CASE WHEN status = 'pending' THEN 'active' ELSE status END WHERE id = ?", [row.observed_count ?? 1, row.retrieval_count ?? 0, now.toISOString(), holder.id]);
      handle.run("UPDATE learnings SET status = 'superseded', superseded_by = ?, promote_request = NULL WHERE id = ?", [holder.id, row.id]);
      return { ok: true, text: `Accepted: #${row.id} is now the cross-project note #${holder.id}.` };
    }
    if (holder) handle.run("UPDATE learnings SET content_hash = ? WHERE id = ?", [scopedContentHash(holder.project_slug, row.text), holder.id]);
    handle.run("UPDATE learnings SET project_slug = NULL, content_hash = ?, global_accepted_at = ?, promote_request = NULL, status = 'active', applied_to = 'memory:global' WHERE id = ?", [plain, now.toISOString(), row.id]);
    return { ok: true, text: `Accepted: #${row.id} now applies in every project.` };
  });
}

/** A rejected memory proposal: memory-add drops the note; memory-promote keeps it in its project. */
export function rejectMemory(handle, meta, { keys }) {
  const row = learningRow(handle, meta.learning);
  if (!row || !keys.includes(row.project_slug)) return;
  if (meta.kind === "memory-add") handle.run("UPDATE learnings SET status = 'rejected' WHERE id = ? AND status = 'pending'", [row.id]);
  else handle.run("UPDATE learnings SET promote_request = NULL WHERE id = ?", [row.id]);
}

/** 3.0's automatic global notes ("global pending"), with the project each came from. */
export function globalPending(handle) {
  return handle.all(
    `SELECT l.id, l.text, l.category, l.confidence, s.project_slug AS origin
       FROM learnings l LEFT JOIN sessions s ON s.id = l.session_id
      WHERE l.project_slug IS NULL AND l.global_accepted_at IS NULL AND l.status = 'active'
        AND COALESCE(l.applied_to, '') NOT LIKE 'quarantined%'
      ORDER BY s.project_slug IS NULL, s.project_slug, l.id`
  );
}

/**
 * accept → cross-project; reject → its origin project only (no origin: rejected).
 * When the origin project already holds the same note, this row is superseded by it.
 */
export function decideGlobal(handle, row, accept, now = new Date()) {
  if (accept) return handle.run("UPDATE learnings SET global_accepted_at = ? WHERE id = ?", [now.toISOString(), row.id]);
  if (!row.origin) return handle.run("UPDATE learnings SET status = 'rejected' WHERE id = ?", [row.id]);
  return handle.transaction(() => {
    const same = sameNote(handle, row.origin, row.text);
    if (same && same.id !== row.id && ["active", "pending"].includes(same.status)) return handle.run("UPDATE learnings SET status = 'superseded', superseded_by = ? WHERE id = ?", [same.id, row.id]);
    // A twin that is never served (rejected, held back) gives up the hash rather than swallow this note.
    if (same && same.id !== row.id) handle.run("UPDATE learnings SET content_hash = ?, norm_key = NULL WHERE id = ?", [`retired-${same.id}`, same.id]);
    return handle.run("UPDATE learnings SET project_slug = ?, content_hash = ? WHERE id = ?", [row.origin, scopedContentHash(row.origin, row.text), row.id]);
  });
}

async function moveToApplied(p) {
  const dir = path.join(path.dirname(p.dir), "applied");
  await fs.mkdir(dir, { recursive: true });
  const dst = path.join(dir, p.name);
  await fs.rename(p.file, dst);
  return dst;
}

const ask = (rl) => (q) => rl.question(q);

/**
 * @param {{cwd:string, accept?:string, acceptAll?:boolean, global?:boolean, yes?:boolean,
 *          env?:object, isTTY?:()=>boolean, io?:{ask:(q:string)=>Promise<string>}, handle?:any,
 *          keys?:string[], out?:(line:string)=>void}} opts
 * @returns {Promise<number>} exit code
 */
export async function runInteractiveReview(opts) {
  const out = opts.out ?? ((l) => console.log(l));
  const env = opts.env ?? process.env;
  const isTTY = opts.isTTY ?? realTTY;
  const accepting = Boolean(opts.accept || opts.acceptAll || opts.global);
  if (opts.yes) {
    out(GUARD_TEXTS.yes);
    return 2;
  }
  if (accepting) {
    const refused = reviewGuard({ env, isTTY });
    if (refused) {
      out(refused);
      return 2;
    }
  }

  const store = async () => {
    const handle = opts.handle ?? (await (await import("./memory/episodic.mjs")).db());
    const keys = opts.keys ?? (await (await import("./memory/scope.mjs")).hookProjectKeys(opts.cwd));
    return { handle, keys };
  };
  const rl = opts.io ? null : readline.createInterface({ input, output });
  const question = opts.io ? opts.io.ask : ask(rl);
  try {
    if (opts.global) return await reviewGlobal({ ...(await store()), question, out });
    const entries = await listProposals(opts.cwd);
    if (opts.accept || opts.acceptAll) return await acceptByFlag({ entries, opts, ...(await store()), question, out });

    if (entries.length === 0) {
      out("No queued proposals.");
      return 0;
    }
    if (!isTTY()) {
      // Non-interactive caller — fall back to listing (the v0.2 behavior).
      out(`${entries.length} queued proposal(s) — non-TTY; listing only:`);
      for (const e of entries) out(`  ${e.name}`);
      out("\nRun this in an interactive terminal to accept/reject/edit.");
      return 0;
    }
    return await reviewLoop({ entries, opts, store, question, out, env, isTTY });
  } finally {
    rl?.close();
  }
}

async function confirm(question, expected) {
  const answer = await question(`Type ${expected} to confirm: `);
  return String(answer ?? "").trim() === String(expected);
}

async function acceptByFlag({ entries, opts, handle, keys, question, out }) {
  if (!handle) {
    out("ad review: the memory store is unavailable (run ad doctor).");
    return 1;
  }
  const picked = opts.accept ? entries.filter((e) => e.name === path.basename(String(opts.accept))) : entries;
  const memory = [];
  let refused = 0;
  for (const e of picked) {
    const meta = readProposalMeta(await fs.readFile(e.file, "utf8"));
    if (!meta) continue;
    const d = describeMemory(handle, meta, keys);
    if (d.ok) memory.push({ e, meta, line: d.line });
    else {
      out(`${e.name}: ${d.text}`);
      refused++;
    }
  }
  if (!memory.length) {
    if (!refused) out(opts.accept ? `ad review: no memory proposal named ${path.basename(String(opts.accept))}.` : "No memory proposals to accept.");
    return 1;
  }
  out(memory.length === 1 ? "Accept this note?" : `Accept these ${memory.length} notes?`);
  for (const m of memory) out(`  ${m.line}`);
  if (!(await confirm(question, memory.length === 1 ? "accept" : String(memory.length)))) {
    out("Not confirmed: nothing changed.");
    return 1;
  }
  let failed = refused;
  for (const { e, meta } of memory) {
    const r = await acceptMemory(handle, meta, { cwd: opts.cwd, keys });
    out(r.text);
    if (r.ok) await moveToApplied(e);
    else failed++;
  }
  return failed ? 1 : 0;
}

async function reviewGlobal({ handle, question, out }) {
  if (!handle) {
    out("ad review: the memory store is unavailable (run ad doctor).");
    return 1;
  }
  const rows = globalPending(handle);
  if (!rows.length) {
    out("No cross-project notes are waiting for review.");
    return 0;
  }
  out(`${rows.length} note(s) from older versions apply in every project until you decide. Accept: every project; reject: only the project it came from.`);
  let group;
  for (const r of rows) {
    if (r.origin !== group) {
      group = r.origin;
      out(`\n${DIVIDER}\nFrom ${r.origin ?? "origin unknown (served nowhere until reviewed)"}`);
    }
    out(`  #${r.id} ${r.category}: ${preview(r.text).slice(0, 160)}`);
    for (;;) {
      const a = String(await question("  [a]ccept / [r]eject / [s]kip / [q]uit: ")).trim().toLowerCase();
      if (a === "q" || a === "quit") return 0;
      if (a === "s" || a === "skip" || a === "") break;
      if (a === "r" || a === "reject") {
        decideGlobal(handle, r, false);
        out("  ✗ kept in its project only");
        break;
      }
      if (a === "a" || a === "accept") {
        if (await confirm(question, "accept")) {
          decideGlobal(handle, r, true);
          out("  ✓ applies in every project");
        } else out("  · not confirmed");
        break;
      }
    }
  }
  return 0;
}

async function reviewLoop({ entries, opts, store, question, out, env, isTTY }) {
  let stats = { accepted: 0, rejected: 0, edited: 0, skipped: 0 };
  let db = null;
  out(`\nReviewing ${entries.length} proposal(s)\n`);
  try {
    const { handle, keys } = await store();
    // A suggestion only: being seen in 2+ projects never promotes a fact by itself.
    const shared = handle ? handle.all("SELECT id, text FROM user_facts WHERE status = 'active' AND global_accepted_at IS NULL AND json_array_length(COALESCE(projects, '[]')) >= 2 ORDER BY observed_count DESC LIMIT 5") : [];
    if (shared.length) {
      out("User facts seen in 2+ projects. To make one apply everywhere: ad memory promote fact:<id>");
      for (const f of shared) out(`  fact:${f.id}  ${preview(f.text).slice(0, 100)}`);
      out("");
    }
    db = { handle, keys };
  } catch {
    db = null;
  }

  for (let i = 0; i < entries.length; i++) {
    const { name, file } = entries[i];
    let content;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const meta = readProposalMeta(content);

    out(DIVIDER);
    out(`Proposal ${i + 1}/${entries.length}: ${name}`);
    out(DIVIDER);
    out(neutralizeText(content));
    out(DIVIDER);

    let decision = null;
    while (!decision) {
      const ans = String(await question("[a]ccept / [r]eject / [e]dit / [s]kip / [q]uit: ")).trim().toLowerCase();
      switch (ans) {
        case "a": case "accept":
          decision = "accept"; break;
        case "r": case "reject":
          decision = "reject"; break;
        case "e": case "edit":
          if (meta) {
            out("  Memory proposals can't be edited here: reject it and tell the agent the right wording.");
            break;
          }
          await openInEditor(file);
          // re-read and re-prompt
          try {
            content = await fs.readFile(file, "utf8");
            out("\n--- after edit ---\n");
            out(neutralizeText(content));
            out("--- end ---\n");
          } catch { /* file deleted while editing — treat as reject */ }
          stats.edited++;
          break;
        case "s": case "skip": case "":
          decision = "skip"; break;
        case "q": case "quit":
          summarize(out, stats, entries.length - i);
          return 0;
        default:
          out("  Choose one: a / r / e / s / q");
      }
    }

    if (decision === "accept" && meta) {
      // A memory note: the D49 guard, then the user types the confirmation.
      const refused = reviewGuard({ env, isTTY });
      if (refused) {
        out(refused);
        return 2;
      }
      const d = db?.handle ? describeMemory(db.handle, meta, db.keys) : null;
      if (d && !d.ok) {
        out(`  ${d.text}`);
        stats.skipped++;
      } else if (!db?.handle) {
        out("  The memory store is unavailable (run ad doctor): skipped.");
        stats.skipped++;
      } else if ((out(`  The store holds: ${d.line}`), !(await confirm(question, "accept")))) {
        out("· not confirmed — skipped");
        stats.skipped++;
      } else {
        const r = await acceptMemory(db.handle, meta, { cwd: opts.cwd, keys: db.keys });
        out(r.ok ? `✓ ${r.text}` : `  ${r.text}`);
        if (r.ok) {
          await moveToApplied(entries[i]);
          stats.accepted++;
        } else stats.skipped++;
      }
    } else if (decision === "accept") {
      const dst = await moveToApplied(entries[i]);
      out(`✓ accepted — moved to ${dst}`);
      out("  Note: skill-edit proposals require manual SKILL.md update for now.");
      out("        constitution-add proposals require manual constitution/core.md update.");
      stats.accepted++;
    } else if (decision === "reject") {
      if (meta && db?.handle) rejectMemory(db.handle, meta, { keys: db.keys });
      await fs.unlink(file);
      out("✗ rejected — file deleted");
      stats.rejected++;
    } else {
      out("· skipped");
      stats.skipped++;
    }
    out("");
  }

  summarize(out, stats, 0);
  return 0;
}

function summarize(out, stats, remaining) {
  out(DIVIDER);
  out(`Done. accepted=${stats.accepted}  rejected=${stats.rejected}  edited=${stats.edited}  skipped=${stats.skipped}` + (remaining > 0 ? `  remaining=${remaining}` : ""));
}

/**
 * `ad memory promote fact:<id>`: make a user fact apply in every project.
 * Guarded like the review accepts; the user types "accept".
 */
export async function promoteFact({ ref, handle, env = process.env, isTTY = realTTY, io, out = (l) => console.log(l) }) {
  const m = /^fact:(\d+)$/.exec(String(ref ?? ""));
  if (!m) {
    out("Usage: ad memory promote fact:<id>");
    return 1;
  }
  const refused = reviewGuard({ env, isTTY });
  if (refused) {
    out(refused.replace(/^ad review/, "ad memory promote"));
    return 2;
  }
  const row = handle.get("SELECT id, text, status, global_accepted_at FROM user_facts WHERE id = ?", [Number(m[1])]);
  if (!row || row.status !== "active") {
    out(`No user fact ${ref}.`);
    return 1;
  }
  if (row.global_accepted_at) {
    out(`${ref} already applies in every project.`);
    return 0;
  }
  out(`  ${ref}: ${preview(row.text).slice(0, 160)}`);
  if (!(await confirm(io.ask, "accept"))) {
    out("Not confirmed: nothing changed.");
    return 1;
  }
  handle.run("UPDATE user_facts SET global_accepted_at = ? WHERE id = ?", [new Date().toISOString(), row.id]);
  out(`${ref} now applies in every project.`);
  return 0;
}

/**
 * Open a file in the user's $EDITOR (or sensible default).
 * Blocks until the editor process exits.
 *
 * No shell: the editor starts by full path (safe-spawn.mjs editorInvocation).
 * It edits a temp copy, copied back afterwards, so the project's own path
 * (which may hold characters cmd.exe can't take) never reaches the editor's
 * command line.
 *
 * @param {string} filePath
 */
async function openInEditor(filePath) {
  const { cmd, args } = editorCommand();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ad-review-"));
  const copy = path.join(dir, path.basename(filePath));
  try {
    await fs.copyFile(filePath, copy);
    const inv = editorInvocation(cmd, [...args, copy]);
    await new Promise((resolve, reject) => {
      const child = spawn(inv.cmd, inv.args, { stdio: "inherit", shell: false, windowsVerbatimArguments: Boolean(inv.verbatim) });
      child.on("close", () => resolve());
      child.on("error", (err) => reject(err));
    });
    await fs.copyFile(copy, filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

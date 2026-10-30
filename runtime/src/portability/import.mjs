// `ad state import` (P7.3): an untrusted bundle, staged, mapped, merged, reversible.
//
//   planImport(o)      → the plan (preflight, staging, the hostile-DB check, mapping, every file's
//                        fate, conflicts, held files); writes only under imports/<id>/
//   runImport(plan, o) → the import, journaled step by step; resumeImport(id) finishes one
//   rollbackImport(id) → undoes exactly what an import did (files whose content changed since
//                        are kept and listed; DB rows other rows now reference are kept)
//   listImports(), verifyImport(id), reviewImport(id, o)
//
// Never trusted from a bundle: its database file (rows are rebuilt one by one into ad's own
// database, with explicit columns, new ids and keys recomputed here), its schema (refused unless
// it is only ad's tables and columns), its review status (every lesson and fact arrives
// pending, re-screened, origin "import:<exportId>", until `ad review --import`), its paths
// (tokens resolved to this computer's mapping), and any write outside ad's own folders and the
// mapped projects' .agent-daemon (each component lstat-ed: a link is refused).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { adRoot } from "../ad-root.mjs";
import { acquireLockWithin } from "../lock.mjs";
import { ulid } from "../ids.mjs";
import { findProject, readRegistry as readProjects, normalizeRemote, episodicSlug, handoffSlug, canonicalDir, PROJECT_ID_RE } from "../memory/projects.mjs";
import { TABLES } from "../memory/tables.mjs";
import { findSecrets } from "../security/secret-patterns.mjs";
import { preflight } from "./preflight.mjs";
import { adColumns, inspectDb, openInspection } from "./inspect-db.mjs";
import { fromToken, tokenRoots } from "./paths.mjs";

export const IMPORT_TEXTS = Object.freeze({
  TOOL_SHELL: "Imports change your memory and settings, so ad doesn't run them from an agent's shell.",
  CONFLICTS: "Import stopped before writing anything: some files differ from yours (listed above). Use --on-conflict keep-mine, take-theirs or keep-both.",
  LINK: (p) => `${p} is a link. ad won't write through it.`,
  ONE_FOLDER: (a, b) => `${a} and ${b} would both go into the same folder. Map one of them elsewhere with --map.`,
  CHANGED: (p) => `${p} changed since the plan was made. Nothing more was written; finish later with ad state import --resume.`,
  INTERRUPTED: (id) => `An import was interrupted (${id}). Finish it: ad state import --resume ${id} · Undo it: ad state rollback ${id}`,
  REVIEW_SHELL: "Accepting memory changes what every future session sees, so ad doesn't do it from an agent's shell. Run it yourself.",
  REVIEW_TTY: "ad review --import needs your own terminal (it asks you to type the import id to confirm).",
});

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const markerId = (b) => {
  try {
    const id = JSON.parse(b.toString("utf8"))?.id;
    return PROJECT_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
};
const importsDir = (env) => path.join(adRoot({ env }), "imports");
const ON_CONFLICT = new Set(["refuse", "keep-mine", "take-theirs", "keep-both"]);
const APPEND = new Set(["pending", "skill-log", "project-journals", "tui-history"]);
const MERGE = { accounts: "merge-accounts", projects: "merge-projects", schedules: "merge-schedules" };

/* ------------------------------------------------------------------------------------------- */
/* Containment                                                                                 */
/* ------------------------------------------------------------------------------------------- */

// Every existing component from root down to the file's folder must be a real folder, not a link.
function linkOnPath(root, dest) {
  const rel = path.relative(root, dest);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return root;
  let cur = root;
  const parts = [".", ...path.dirname(rel).split(path.sep).filter((s) => s && s !== ".")];
  for (const p of parts) {
    cur = p === "." ? cur : path.join(cur, p);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return null; // not there yet: created as a real folder
    }
    if (st.isSymbolicLink()) return cur;
  }
  try {
    if (fs.lstatSync(dest).isSymbolicLink()) return dest;
  } catch {
    // a new file
  }
  return null;
}

function writeExclusive(file, data, root) {
  const real = fs.realpathSync(root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const dirReal = fs.realpathSync(path.dirname(file));
  if (dirReal !== real && !dirReal.startsWith(real + path.sep)) throw fail("IMPORT_CONTAINMENT", `${file} would leave the import's own folder`);
  fs.writeFileSync(file, data, { flag: "wx", mode: 0o600 });
}

/* ------------------------------------------------------------------------------------------- */
/* Mapping                                                                                     */
/* ------------------------------------------------------------------------------------------- */

function remoteOf(dir) {
  try {
    const { execFileSyncNoShell, resolveGit, resolvedArgv } = globalThis.__adGit ?? {};
    if (!execFileSyncNoShell) return null;
    const url = execFileSyncNoShell(...resolvedArgv(resolveGit(), ["-c", "core.fsmonitor=false", "-C", dir, "remote", "get-url", "origin"]), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return normalizeRemote(url);
  } catch {
    return null;
  }
}

function candidates(search, depth = 3) {
  const out = [];
  const go = (d, n) => {
    if (n > depth) return;
    let es;
    try {
      es = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    if (es.some((e) => e.name === ".git")) out.push(d);
    for (const e of es) if (e.isDirectory() && !e.isSymbolicLink() && e.name !== ".git" && e.name !== "node_modules") go(path.join(d, e.name), n + 1);
  };
  for (const s of search) go(path.resolve(s), 0);
  return out;
}

function mapProjects(manifest, { maps, search, env, platform }) {
  const reg = readProjects({ env });
  const pool = [...new Set([...reg.projects.flatMap((p) => (p.paths ?? []).map((x) => x.path)), ...candidates(search)])].filter((d) => fs.existsSync(d));
  const out = [];
  for (const p of manifest.projects) {
    const m = maps.find((x) => x.key === p.id || x.key === p.name);
    let dir = null;
    let how = null;
    if (m) [dir, how] = [path.resolve(m.dir), "you mapped it"];
    if (!dir) {
      const local = reg.projects.find((x) => x.id === p.id);
      const live = local?.paths?.map((x) => x.path).find((x) => fs.existsSync(x));
      if (live) [dir, how] = [live, "the same project id"];
    }
    if (!dir && p.gitRemote) {
      const hits = pool.filter((d) => remoteOf(d) === normalizeRemote(p.gitRemote));
      if (hits.length === 1) [dir, how] = [hits[0], "matched by git remote"];
    }
    out.push({ id: p.id, name: p.name, dir, how, aliases: p.aliases ?? {} });
  }
  const seen = new Map();
  for (const p of out.filter((x) => x.dir)) {
    const k = canonicalDir(p.dir, { platform });
    if (seen.has(k)) throw fail("IMPORT_USAGE", IMPORT_TEXTS.ONE_FOLDER(seen.get(k), p.name));
    seen.set(k, p.name);
  }
  return out;
}

/* ------------------------------------------------------------------------------------------- */
/* The plan                                                                                    */
/* ------------------------------------------------------------------------------------------- */

const isMd = (n) => /\.md$/i.test(n);
// A memory file a session would read: held back when a paragraph reads as an instruction or
// holds something shaped like a key.
async function flagged(text) {
  const { screenLearning } = await import("../digest/sanitize.mjs");
  const { readsAsInstruction } = await import("../memory/safety.mjs");
  for (const para of String(text).split(/\n\s*\n/)) {
    if (!para.trim()) continue;
    if (screenLearning({ text: para }).verdict !== "clean") return "instruction-like text";
    if (readsAsInstruction(para)) return "instruction-like text";
    if (findSecrets(para).length) return "something shaped like a key";
  }
  return null;
}

function resolveJson(buf, roots) {
  let j;
  try {
    j = JSON.parse(buf.toString("utf8"));
  } catch {
    return buf;
  }
  const walk = (v) => (typeof v === "string" ? fromToken(v, roots) : Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  return Buffer.from(`${JSON.stringify(walk(j), null, 2)}\n`, "utf8");
}

function trackedByGit(dir, file) {
  try {
    const { execFileSyncNoShell, resolveGit, resolvedArgv } = globalThis.__adGit ?? {};
    if (!execFileSyncNoShell) return false;
    execFileSyncNoShell(...resolvedArgv(resolveGit(), ["-c", "core.fsmonitor=false", "-C", dir, "ls-files", "--error-unmatch", path.relative(dir, file)]), { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function planImport({ file, maps = [], search = [], onConflict = "refuse", acceptHeld = false, forceTracked = false, env = process.env, platform = process.platform, now = new Date() } = {}) {
  if (env.AD_TOOL_SHELL === "1") throw fail("IMPORT_REFUSED", IMPORT_TEXTS.TOOL_SHELL, { exitCode: 2 });
  if (!ON_CONFLICT.has(onConflict)) throw fail("IMPORT_USAGE", `--on-conflict takes ${[...ON_CONFLICT].join(", ")}`);
  if (!globalThis.__adGit) globalThis.__adGit = await import("../safe-spawn.mjs");
  const { manifest, entries } = preflight(fs.readFileSync(file));
  const root = adRoot({ env });
  const importId = `imp_${ulid(now.getTime())}`;
  const dir = path.join(importsDir(env), importId);
  const staging = path.join(dir, "staging");
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  try {
    for (const e of entries) writeExclusive(path.join(staging, ...e.name.split("/")), e.data, staging);
    const dbEntry = entries.find((e) => e.name === "global/episodic.db");
    if (dbEntry) {
      const problems = await inspectDb(path.join(staging, "global", "episodic.db"), manifest, { ours: await adColumns(dir) });
      if (problems.length) throw fail("IMPORT_REFUSED", `${problems[0]}. Import refused.`, { problems, exitCode: 1 });
    }
    const mapping = mapProjects(manifest, { maps, search, env, platform });
    const home = env.HOME || env.USERPROFILE || os.homedir();
    const roots = tokenRoots({ home, adRoot: root, projects: mapping.filter((p) => p.dir).map((p) => ({ id: p.id, path: p.dir })) });
    const classOf = new Map(manifest.files.map((f) => [f.path, f.class]));
    const ops = [];
    const conflicts = [];
    const held = [];
    const refusedProjects = new Set();
    const stamp = now.toISOString().slice(0, 10);
    for (const e of entries) {
      if (e.name === "global/episodic.db") continue;
      const cls = classOf.get(e.name);
      const seg = e.name.split("/");
      let base;
      let dest;
      let project = null;
      if (seg[0] === "global") {
        base = root;
        dest = path.join(root, ...seg.slice(1));
        // A handoff folder is named after its project's path: here, after the mapped folder.
        if (cls === "handoffs-global") {
          const owner = manifest.projects.find((p) => (p.aliases?.handoff ?? []).includes(seg[2]));
          const here = owner && mapping.find((p) => p.id === owner.id)?.dir;
          if (here) dest = path.join(root, "handoffs", handoffSlug(here), ...seg.slice(3));
        }
      } else {
        project = mapping.find((p) => p.id === seg[1]);
        if (project?.dir) {
          base = path.join(project.dir, ".agent-daemon");
          dest = path.join(base, ...seg.slice(2));
        } else {
          base = path.join(dir, "unmapped", seg[1]);
          dest = path.join(base, ...seg.slice(2));
        }
      }
      const staged = path.join(staging, ...seg);
      const data = e.name.endsWith(".json") ? resolveJson(e.data, roots) : e.data;
      if (data !== e.data) fs.writeFileSync(staged, data);
      // Never through a link: the whole project's files are refused, or the import.
      const link = project?.dir ? linkOnPath(project.dir, dest) : linkOnPath(root, dest);
      if (link) {
        if (project?.dir) {
          refusedProjects.add(project.name);
          continue;
        }
        throw fail("IMPORT_REFUSED", IMPORT_TEXTS.LINK(link), { exitCode: 1 });
      }
      if (cls === "memory-db") continue;
      if (MERGE[cls] || (cls === "ledger" && e.name === "global/sessions/index.json")) {
        ops.push({ op: MERGE[cls] ?? "merge-ledger-index", target: dest, staged, cls });
        continue;
      }
      if (APPEND.has(cls)) {
        ops.push({ op: "append", target: dest, staged, cls });
        continue;
      }
      if (project?.dir && isMd(dest) && !acceptHeld) {
        const why = await flagged(data.toString("utf8"));
        if (why) {
          const to = path.join(dir, "held", seg[1], ...seg.slice(2));
          held.push({ path: path.join(path.basename(project.dir), ".agent-daemon", ...seg.slice(2)), why, to });
          ops.push({ op: "hold", target: to, staged, cls });
          continue;
        }
      }
      let mine = null;
      try {
        mine = fs.readFileSync(dest);
      } catch {
        mine = null;
      }
      if (mine && sha(mine) === sha(data)) continue; // the same: nothing to do
      // The project marker: the same id is the same marker, however it is written (ad rewrites it).
      if (mine && project?.dir && path.basename(dest) === "project.json" && path.dirname(dest) === path.join(project.dir, ".agent-daemon") && markerId(mine) && markerId(mine) === markerId(data)) continue;
      if (mine) {
        const tracked = project?.dir && trackedByGit(project.dir, dest);
        const shown = project?.dir ? path.join(path.basename(project.dir), path.relative(project.dir, dest)) : path.relative(root, dest);
        conflicts.push({ path: shown, tracked });
        if (onConflict === "keep-mine" || (tracked && !forceTracked && onConflict === "take-theirs")) continue;
        if (onConflict === "keep-both") {
          const ext = path.extname(dest);
          ops.push({ op: "place", target: `${dest.slice(0, dest.length - ext.length)}.imported-${stamp}${ext}`, staged, cls, expect: null });
          continue;
        }
        if (onConflict === "take-theirs") ops.push({ op: "place", target: dest, staged, cls, expect: sha(mine) });
        continue;
      }
      ops.push({ op: "place", target: dest, staged, cls, expect: null });
    }
    const counts = manifest.db?.[0]?.tables ?? {};
    const plan = { schemaVersion: 1, importId, exportId: manifest.exportId, dir, staging, manifest: { exportId: manifest.exportId, createdAt: manifest.createdAt, source: manifest.source, scope: manifest.scope, projects: manifest.projects, recallProbes: manifest.recallProbes ?? [], db: manifest.db ?? [] }, mapping, ops, conflicts, held, refusedProjects: [...refusedProjects], onConflict, db: Boolean(dbEntry), counts, accounts: manifest.accounts ?? [] };
    fs.writeFileSync(path.join(dir, "import.json"), `${JSON.stringify({ ...plan, status: "planned", createdAt: now.toISOString() }, null, 2)}\n`);
    return plan;
  } catch (e) {
    cleanup();
    throw e;
  }
}

/** The plan in words (--dry-run prints it; a real import prints it first). */
export function planText(plan, { dryRun = false } = {}) {
  const m = plan.manifest;
  const lines = [`Import ${plan.exportId} (made on ${m.source?.os ?? "?"}, ad ${m.source?.appVersion ?? "?"}, ${String(m.createdAt).slice(0, 10)})`];
  lines.push(`  projects:  ${plan.mapping.map((p) => (p.dir ? `${p.name} → ${p.dir} (${p.how})` : `${p.name} → not mapped (use --map ${p.name}=<dir>)`)).join(" · ") || "none"}`);
  const lessons = plan.counts.learnings?.rows ?? 0;
  const facts = plan.counts.user_facts?.rows ?? 0;
  if (plan.db) lines.push(`  memory:    ${lessons} lesson${lessons === 1 ? "" : "s"}, ${facts} fact${facts === 1 ? "" : "s"} — they come in for review: ad review --import ${plan.importId}`);
  const files = plan.ops.filter((o) => o.op === "place").length;
  lines.push(`  files:     ${files} to place, ${plan.ops.filter((o) => o.op === "append").length} to append to, ${plan.ops.filter((o) => o.op.startsWith("merge")).length} to merge (schedules come in switched off)`);
  if (plan.accounts.length) lines.push(`  accounts:  ${plan.accounts.length}, all need sign-in: ad auth login <label>`);
  for (const h of plan.held) lines.push(`  held back: ${h.path} (flagged by the memory screen: ${h.why}; --accept-held places it)`);
  for (const r of plan.refusedProjects) lines.push(`  refused:   ${r}: ${IMPORT_TEXTS.LINK(`${r}/.agent-daemon`)}`);
  for (const c of plan.conflicts) lines.push(`  conflict:  ${c.path} — yours differs${c.tracked ? " (tracked by git)" : ""}${plan.onConflict === "refuse" ? "" : ` → ${plan.onConflict}`}`);
  if (plan.conflicts.length && plan.onConflict === "refuse") lines.push("  Use --on-conflict keep-mine, take-theirs or keep-both.");
  if (dryRun) lines.push("Nothing has been written. Run without --dry-run to import.");
  return lines.join("\n");
}

/* ------------------------------------------------------------------------------------------- */
/* The run: journaled steps                                                                    */
/* ------------------------------------------------------------------------------------------- */

const readStatus = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "import.json"), "utf8"));
const writeStatus = (dir, patch) => {
  const s = { ...readStatus(dir), ...patch };
  fs.writeFileSync(path.join(dir, "import.json"), `${JSON.stringify(s, null, 2)}\n`);
  return s;
};
const journalOf = (dir) => {
  try {
    return fs.readFileSync(path.join(dir, "journal.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
function journal(dir, rec) {
  const fd = fs.openSync(path.join(dir, "journal.jsonl"), "a", 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(rec)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export async function runImport(plan, { env = process.env, now = new Date(), crashAfter = null } = {}) {
  if (plan.conflicts.length && plan.onConflict === "refuse") throw fail("IMPORT_CONFLICTS", IMPORT_TEXTS.CONFLICTS, { exitCode: 1 });
  return execute(plan.dir, { env, now, crashAfter });
}

export const resumeImport = (importId, o = {}) => execute(path.join(importsDir(o.env ?? process.env), importId), o);

async function execute(dir, { env = process.env, now = new Date(), crashAfter = null } = {}) {
  const status = readStatus(dir);
  if (status.status === "complete" || status.status === "rolled-back") return status;
  const release = await acquireLockWithin("state-import", { dir: path.join(adRoot({ env }), "locks"), waitMs: 15_000 });
  try {
    writeStatus(dir, { status: "promoting" });
    const done = new Set(journalOf(dir).filter((r) => r.state === "done").map((r) => r.seq));
    const steps = [...status.ops.map((o, i) => ({ ...o, seq: i })), ...(status.db ? [{ op: "db-merge", seq: status.ops.length }] : []), { op: "proposal", seq: status.ops.length + 1 }];
    let n = 0;
    for (const s of steps) {
      if (done.has(s.seq)) continue;
      if (crashAfter !== null && n++ >= crashAfter) throw fail("IMPORT_TEST_CRASH", "test crash");
      const rec = await doStep(dir, status, s, { env, now });
      journal(dir, { seq: s.seq, op: s.op, target: s.target ?? null, ...rec, state: "done" });
    }
    journal(dir, { seq: steps.length + 1, op: "commit", state: "done" });
    fs.rmSync(path.join(dir, "staging"), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return writeStatus(dir, { status: "complete", completedAt: now.toISOString() });
  } catch (e) {
    if (e.code !== "IMPORT_TEST_CRASH") writeStatus(dir, { status: "failed", error: e.message });
    throw e;
  } finally {
    release();
  }
}

const backupPath = (dir, seq) => path.join(dir, "backup", String(seq));

async function doStep(dir, status, s, { env, now }) {
  if (s.op === "db-merge") return { rows: await mergeDb(dir, status, { env }) };
  if (s.op === "proposal") return writeProposal(dir, status, { env, now });
  const data = fs.readFileSync(s.staged);
  if (s.op === "place" || s.op === "hold") {
    let mine = null;
    try {
      mine = fs.readFileSync(s.target);
    } catch {
      mine = null;
    }
    // Changed since the plan: stop; --resume later (after the user looks).
    if ((s.expect ?? null) !== (mine ? sha(mine) : null) && !(mine && sha(mine) === sha(data))) throw fail("IMPORT_CHANGED", IMPORT_TEXTS.CHANGED(s.target), { exitCode: 1 });
    if (mine) {
      fs.mkdirSync(path.dirname(backupPath(dir, s.seq)), { recursive: true });
      fs.copyFileSync(s.target, backupPath(dir, s.seq));
    }
    fs.mkdirSync(path.dirname(s.target), { recursive: true });
    const tmp = `${s.target}.ad-import-${process.pid}`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, s.target);
    return { sha256: sha(data), backup: Boolean(mine) };
  }
  if (s.op === "append") {
    let mine = "";
    try {
      mine = fs.readFileSync(s.target, "utf8");
    } catch {
      mine = "";
    }
    const have = new Set(mine.split(/\r?\n/).filter(Boolean));
    const add = data.toString("utf8").split(/\r?\n/).filter((l) => l && !have.has(l));
    if (add.length) {
      fs.mkdirSync(path.dirname(s.target), { recursive: true });
      fs.appendFileSync(s.target, `${mine && !mine.endsWith("\n") ? "\n" : ""}${add.join("\n")}\n`);
    }
    return { appended: add };
  }
  // JSON merges: the old file is backed up whole; rollback restores it if nothing changed since.
  let before = null;
  try {
    before = fs.readFileSync(s.target);
  } catch {
    before = null;
  }
  const mine = before ? JSON.parse(before.toString("utf8")) : null;
  const theirs = JSON.parse(data.toString("utf8"));
  const merged = mergeJson(s.op, mine, theirs);
  if (before) {
    fs.mkdirSync(path.dirname(backupPath(dir, s.seq)), { recursive: true });
    fs.writeFileSync(backupPath(dir, s.seq), before);
  }
  const out = Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, "utf8");
  fs.mkdirSync(path.dirname(s.target), { recursive: true });
  fs.writeFileSync(s.target, out, { mode: 0o600 });
  return { sha256: sha(out), backup: Boolean(before) };
}

function mergeJson(op, mine, theirs) {
  if (op === "merge-accounts") {
    const base = mine ?? { ...theirs, accounts: [] };
    const have = new Map((base.accounts ?? []).map((a) => [a.id, a]));
    const labels = new Set((base.accounts ?? []).map((a) => `${a.provider}/${a.label}`));
    for (const a of theirs.accounts ?? []) {
      if (have.has(a.id)) continue; // an existing id keeps its own credential and status
      const label = labels.has(`${a.provider}/${a.label}`) ? `${a.label} (imported)` : a.label;
      base.accounts = [...(base.accounts ?? []), { ...a, label, credential: null, status: "needs-sign-in" }];
    }
    return base;
  }
  if (op === "merge-projects") {
    const base = mine ?? { schemaVersion: 1, revision: 0, projects: [] };
    for (const p of theirs.projects ?? []) {
      const i = base.projects.findIndex((x) => x.id === p.id);
      if (i === -1) base.projects.push(p);
      else base.projects[i] = { ...base.projects[i], aliases: { episodic: [...new Set([...(base.projects[i].aliases?.episodic ?? []), ...(p.aliases?.episodic ?? [])])], handoff: [...new Set([...(base.projects[i].aliases?.handoff ?? []), ...(p.aliases?.handoff ?? [])])] } };
    }
    base.revision = (base.revision ?? 0) + 1;
    return base;
  }
  if (op === "merge-schedules") {
    const jobsOf = (d) => (Array.isArray(d) ? d : (d?.jobs ?? []));
    const mineJobs = jobsOf(mine);
    const ids = new Set(mineJobs.map((j) => j.id));
    const added = jobsOf(theirs).map((j) => ({ ...j, id: ids.has(j.id) ? `${j.id}i` : j.id, enabled: false, importedAt: new Date().toISOString() }));
    const all = [...mineJobs, ...added];
    return Array.isArray(mine) || (!mine && Array.isArray(theirs)) ? all : { ...(mine ?? theirs), jobs: all };
  }
  // The session record's index: entries merged by id.
  const base = mine ?? { schemaVersion: 1, revision: 0, sessions: {}, threads: {} };
  return { ...base, sessions: { ...(theirs.sessions ?? {}), ...(base.sessions ?? {}) }, threads: { ...(theirs.threads ?? {}), ...(base.threads ?? {}) }, revision: (base.revision ?? 0) + 1 };
}

/* ------------------------------------------------------------------------------------------- */
/* The database: rows rebuilt one by one                                                       */
/* ------------------------------------------------------------------------------------------- */

// The order rows go in: parents first. Tables not here are excluded on purpose.
export const MERGE_ORDER = ["sessions", "learnings", "user_facts", "proposals", "skill_variants", "feedback", "correction_events", "injections"];
export const NOT_MERGED = TABLES.filter((t) => !MERGE_ORDER.includes(t.name)).map((t) => t.name);

async function mergeDb(dir, status, { env }) {
  const { open, scopedContentHash, learningContentHash, normKey } = await import("../memory/sqlite.mjs");
  const { screenLearning } = await import("../digest/sanitize.mjs");
  const saved = process.env.AD_ROOT;
  if (env.AD_ROOT) process.env.AD_ROOT = env.AD_ROOT;
  const target = await open({ dbPath: path.join(adRoot({ env }), "episodic.db") });
  if (saved === undefined) delete process.env.AD_ROOT;
  else process.env.AD_ROOT = saved;
  const db = target.raw;
  const src = await openInspection(path.join(status.staging, "global", "episodic.db"));
  const origin = `import:${status.exportId}`;
  const map = new Map(status.mapping.map((p) => [p.id, p]));
  const projectOf = (bundleId) => {
    const p = map.get(bundleId);
    if (!p) return { id: bundleId ?? null, slug: bundleId ?? null };
    return { id: p.id, slug: p.dir ? episodicSlug(p.dir) : p.id, path: p.dir };
  };
  const tcols = (t) => new Set(db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name));
  const scols = (t) => new Set(src.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name));
  const has = (t) => Boolean(src.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(t));
  const ids = { learnings: new Map(), sessions: new Map() };
  const rows = [];
  const insert = (table, obj) => {
    const keys = Object.keys(obj);
    const r = db.prepare(`INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((k) => obj[k]));
    const rid = Number(r.lastInsertRowid);
    db.prepare("INSERT INTO import_rows (import_id, table_name, row_id) VALUES (?, ?, ?)").run(status.importId, table, rid);
    rows.push([table, rid]);
    return rid;
  };
  const pick = (row, table, skip) => {
    const t = tcols(table);
    return Object.fromEntries(Object.entries(row).filter(([k]) => t.has(k) && !skip.includes(k)));
  };
  db.exec("BEGIN EXCLUSIVE");
  try {
    // sessions: kept by id; one that exists here with other facts is a conflict, kept apart.
    if (has("sessions")) {
      for (const r of src.prepare("SELECT * FROM sessions").all()) {
        const p = projectOf(r.project_id);
        const pathHere = p.path ?? (typeof r.project_path === "string" ? r.project_path : "");
        const exists = db.prepare("SELECT id, project_path, started_at FROM sessions WHERE id = ?").get(r.id);
        if (exists) {
          ids.sessions.set(r.id, r.id);
          continue;
        }
        insert("sessions", { ...pick(r, "sessions", ["project_id", "project_slug", "project_path", "transcript_path"]), project_id: p.id, project_slug: p.slug, project_path: pathHere || p.slug, transcript_path: null });
        ids.sessions.set(r.id, r.id);
      }
    }
    // learnings: new ids, keys recomputed here, every row pending and re-screened.
    if (has("learnings")) {
      const lc = tcols("learnings");
      const later = [];
      for (const r of src.prepare("SELECT * FROM learnings ORDER BY id").all()) {
        const p = projectOf(r.project_id);
        const text = String(r.text ?? "");
        const nk = normKey(text);
        const dup = lc.has("norm_key") ? db.prepare("SELECT id FROM learnings WHERE norm_key = ? AND (project_id IS ? OR (project_id IS NULL AND project_slug IS ?))").get(nk, p.id, p.slug) : null;
        if (dup) {
          ids.learnings.set(r.id, dup.id);
          continue;
        }
        const screen = screenLearning({ text, evidence: r.evidence ?? "" });
        const secret = findSecrets(`${text}\n${r.evidence ?? ""}`).length > 0;
        const kept = r.status === "quarantined" || r.status === "rejected" ? r.status : screen.verdict !== "clean" || secret ? "quarantined" : "pending";
        const row = {
          ...pick(r, "learnings", ["id", "project_id", "project_slug", "project_path", "content_hash", "norm_key", "status", "origin", "applied_to", "quarantine_reason", "supersedes", "superseded_by", "session_id", "promote_request", "global_accepted_at", "retrieval_count"]),
          project_id: p.id,
          project_slug: p.slug,
          content_hash: scopedContentHash(p.slug, text),
          status: kept,
          session_id: r.session_id && ids.sessions.has(r.session_id) ? ids.sessions.get(r.session_id) : null,
        };
        if (lc.has("norm_key")) row.norm_key = nk;
        if (lc.has("project_path")) row.project_path = p.path ?? null;
        if (lc.has("origin")) row.origin = origin;
        if (lc.has("applied_to")) row.applied_to = kept === "quarantined" ? "quarantined:import" : "proposed:import";
        if (lc.has("quarantine_reason") && kept === "quarantined") row.quarantine_reason = secret ? "secret-shaped text" : screen.reasons.join(", ") || "imported as quarantined";
        const nid = insert("learnings", row);
        ids.learnings.set(r.id, nid);
        if (r.supersedes) later.push([nid, r.supersedes]);
      }
      for (const [nid, old] of later) if (ids.learnings.has(old)) db.prepare("UPDATE learnings SET supersedes = ? WHERE id = ?").run(ids.learnings.get(old), nid);
    }
    // user_facts: pending, re-screened, scoped only by export_project; never global by import.
    if (has("user_facts")) {
      const fc = tcols("user_facts");
      for (const r of src.prepare("SELECT * FROM user_facts").all()) {
        const p = r.export_project ? projectOf(r.export_project) : null;
        const text = String(r.text ?? "");
        const hash = learningContentHash(`${p?.id ?? ""}\u{0}${text}`);
        const dup = fc.has("content_hash") ? db.prepare("SELECT id, observed_count FROM user_facts WHERE content_hash = ?").get(hash) : null;
        if (dup) {
          db.prepare("INSERT INTO import_updates (import_id, table_name, row_id, column_name, old_value) VALUES (?, 'user_facts', ?, 'observed_count', ?)").run(status.importId, dup.id, String(dup.observed_count ?? 1));
          db.prepare("UPDATE user_facts SET observed_count = observed_count + 1 WHERE id = ?").run(dup.id);
          continue;
        }
        const flaggedFact = screenLearning({ text, evidence: r.evidence ?? "" }).verdict !== "clean" || findSecrets(text).length > 0;
        const row = { ...pick(r, "user_facts", ["id", "projects", "project_ids", "promoted_at", "export_project", "content_hash", "status", "origin", "source_session", "supersedes"]), status: flaggedFact ? "quarantined" : "pending" };
        if (fc.has("project_ids")) row.project_ids = JSON.stringify(p ? [p.id] : []);
        if (fc.has("projects")) row.projects = JSON.stringify(p ? [p.slug] : []);
        if (fc.has("content_hash")) row.content_hash = hash;
        if (fc.has("origin")) row.origin = origin;
        insert("user_facts", row);
      }
    }
    // global tables: only when the bundle carries global memory.
    for (const t of ["proposals", "skill_variants"]) {
      if (!has(t) || !status.manifest.scope?.globalMemory) continue;
      for (const r of src.prepare(`SELECT * FROM "${t}"`).all()) insert(t, pick(r, t, ["id"]));
    }
    // rows about lessons: their lesson remapped (deduped → the existing one; refused → dropped).
    for (const t of ["feedback", "correction_events", "injections"]) {
      if (!has(t)) continue;
      const c = tcols(t);
      const s = scols(t);
      for (const r of src.prepare(`SELECT * FROM "${t}"`).all()) {
        const lid = r.learning_id != null ? ids.learnings.get(r.learning_id) : null;
        if (s.has("learning_id") && r.learning_id != null && !lid) continue;
        const p = projectOf(r.project_id);
        const row = { ...pick(r, t, ["id", "project_id", "project_slug", "learning_id", "matched_learning_id", "norm_key"]) };
        if (c.has("learning_id")) row.learning_id = lid ?? null;
        if (c.has("matched_learning_id")) row.matched_learning_id = r.matched_learning_id != null ? (ids.learnings.get(r.matched_learning_id) ?? null) : null;
        if (c.has("project_id")) row.project_id = p.id;
        if (c.has("project_slug")) row.project_slug = p.slug;
        if (c.has("norm_key")) row.norm_key = typeof r.text === "string" ? normKey(r.text) : null;
        insert(t, row);
      }
    }
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'learnings_fts'").get()) db.exec("INSERT INTO learnings_fts(learnings_fts) VALUES ('rebuild')");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    src.close();
    await target.close?.();
  }
  return rows.length;
}

function writeProposal(dir, status, { env, now }) {
  const file = path.join(adRoot({ env }), "proposed", "_global", `import-${status.importId}.md`);
  const counts = { learnings: status.counts.learnings?.rows ?? 0, userFacts: status.counts.user_facts?.rows ?? 0 };
  const body = `---\nkind: memory-import\nimportId: ${status.importId}\nexportId: ${status.exportId}\ncounts: ${JSON.stringify(counts)}\ncreatedAt: ${now.toISOString()}\n---\n\nImported memory waits for your review: ad review --import ${status.importId}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return { proposal: file };
}

/* ------------------------------------------------------------------------------------------- */
/* Rollback, list, verify, review                                                              */
/* ------------------------------------------------------------------------------------------- */

export async function rollbackImport(importId, { env = process.env } = {}) {
  if (env.AD_TOOL_SHELL === "1") throw fail("IMPORT_REFUSED", IMPORT_TEXTS.TOOL_SHELL, { exitCode: 2 });
  const dir = path.join(importsDir(env), importId);
  const status = readStatus(dir);
  if (status.status === "rolled-back") return { kept: [], status };
  const release = await acquireLockWithin("state-import", { dir: path.join(adRoot({ env }), "locks"), waitMs: 15_000 });
  const kept = [];
  try {
    const done = journalOf(dir).filter((r) => r.state === "done").sort((a, b) => b.seq - a.seq);
    for (const r of done) {
      const step = status.ops[r.seq];
      if (r.op === "db-merge") {
        kept.push(...(await unmergeDb(status, { env })));
        continue;
      }
      if (r.op === "proposal") {
        fs.rmSync(r.proposal, { force: true });
        continue;
      }
      if (!step) continue;
      if (r.op === "append") {
        let cur;
        try {
          cur = fs.readFileSync(step.target, "utf8");
        } catch {
          continue;
        }
        const drop = new Set(r.appended ?? []);
        fs.writeFileSync(step.target, cur.split(/\r?\n/).filter((l) => !drop.has(l)).join("\n"));
        continue;
      }
      let cur = null;
      try {
        cur = fs.readFileSync(step.target);
      } catch {
        cur = null;
      }
      if (cur && sha(cur) !== r.sha256) {
        kept.push(`${step.target} (changed since the import)`);
        continue;
      }
      if (r.backup) fs.copyFileSync(backupPath(dir, r.seq), step.target);
      else fs.rmSync(step.target, { force: true });
    }
    return { kept, status: writeStatus(dir, { status: "rolled-back" }) };
  } finally {
    release();
  }
}

// Rows the import added, removed children first; a row something else now points at is kept.
async function unmergeDb(status, { env }) {
  const { open } = await import("../memory/sqlite.mjs");
  const saved = process.env.AD_ROOT;
  if (env.AD_ROOT) process.env.AD_ROOT = env.AD_ROOT;
  const target = await open({ dbPath: path.join(adRoot({ env }), "episodic.db") });
  if (saved === undefined) delete process.env.AD_ROOT;
  else process.env.AD_ROOT = saved;
  const db = target.raw;
  const kept = [];
  db.exec("BEGIN EXCLUSIVE");
  try {
    for (const u of db.prepare("SELECT * FROM import_updates WHERE import_id = ? ORDER BY rowid DESC").all(status.importId)) db.prepare(`UPDATE "${u.table_name}" SET "${u.column_name}" = ? WHERE id = ?`).run(u.old_value, u.row_id);
    const mine = (t) => new Set(db.prepare("SELECT row_id FROM import_rows WHERE import_id = ? AND table_name = ?").all(status.importId, t).map((r) => r.row_id));
    for (const t of [...MERGE_ORDER].reverse()) {
      const ours = mine(t);
      if (!ours.size) continue;
      // Children elsewhere that point at these rows (not the import's own): keep those parents.
      const colsOf = (x) => new Set(db.prepare(`PRAGMA table_info("${x}")`).all().map((c) => c.name));
      const refs = TABLES.flatMap((x) => x.parents.filter((p) => p.table === t).map((p) => ({ child: x.name, column: p.column }))).filter((r) => colsOf(r.child).has(r.column));
      for (const id of ours) {
        const pk = t === "sessions" ? "id" : "rowid";
        const key = t === "sessions" ? db.prepare("SELECT id FROM sessions WHERE rowid = ?").get(id)?.id : id;
        const used = refs.some(({ child, column }) => {
          const theirs = mine(child);
          const hit = db.prepare(`SELECT rowid AS r FROM "${child}" WHERE "${column}" = ?`).all(key);
          return hit.some((h) => !theirs.has(h.r));
        });
        if (used) {
          kept.push(`${t} ${key} (other memory now points at it)`);
          continue;
        }
        db.prepare(`DELETE FROM "${t}" WHERE ${pk} = ?`).run(t === "sessions" ? key : id);
      }
    }
    db.prepare("DELETE FROM import_rows WHERE import_id = ?").run(status.importId);
    db.prepare("DELETE FROM import_updates WHERE import_id = ?").run(status.importId);
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'learnings_fts'").get()) db.exec("INSERT INTO learnings_fts(learnings_fts) VALUES ('rebuild')");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    await target.close?.();
  }
  return kept;
}

export function listImports({ env = process.env } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(importsDir(env));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith("imp_"))
    .map((n) => {
      try {
        const s = readStatus(path.join(importsDir(env), n));
        return { importId: n, exportId: s.exportId, status: s.status, createdAt: s.createdAt };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

/** An interrupted import's one-line notice (any ad state command, ad doctor). */
export const interruptedNotice = (o = {}) => listImports(o).filter((i) => i.status === "promoting" || i.status === "failed").map((i) => IMPORT_TEXTS.INTERRUPTED(i.importId));

export async function verifyImport(importId, { env = process.env } = {}) {
  const status = readStatus(path.join(importsDir(env), importId));
  const { open } = await import("../memory/sqlite.mjs");
  const saved = process.env.AD_ROOT;
  if (env.AD_ROOT) process.env.AD_ROOT = env.AD_ROOT;
  const t = await open({ dbPath: path.join(adRoot({ env }), "episodic.db") });
  if (saved === undefined) delete process.env.AD_ROOT;
  else process.env.AD_ROOT = saved;
  try {
    const db = t.raw;
    const integrity = Object.values(db.prepare("PRAGMA integrity_check").get() ?? {})[0];
    const landed = Object.fromEntries(db.prepare("SELECT table_name AS t, COUNT(*) AS n FROM import_rows WHERE import_id = ? GROUP BY table_name").all(importId).map((r) => [r.t, r.n]));
    const recall = [];
    for (const p of status.mapping) {
      const probes = (status.manifest.recallProbes ?? []).filter((x) => x.project === p.id);
      if (!probes.length) continue;
      let found = 0;
      for (const q of probes) {
        const words = String(q.query).split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, "")}"`).join(" ");
        if (!words) continue;
        const hit = db.prepare("SELECT l.id FROM learnings_fts f JOIN learnings l ON l.id = f.rowid WHERE learnings_fts MATCH ? AND l.project_id = ? LIMIT 1").get(words, p.id);
        if (hit) found++;
      }
      recall.push({ project: p.name, found, of: probes.length });
    }
    return { status: status.status, integrity, landed, recall };
  } finally {
    await t.close?.();
  }
}

/**
 * ad review --import <id> [--accept-all]: imported lessons and facts, accepted (active) or
 * rejected, in your own terminal with a typed confirmation; never from an agent's shell. The
 * internal AD_INTERNAL_TEST_CONFIRM=<id> stands in for the terminal (CI), never under a shell marker.
 */
export async function reviewImport(importId, { acceptAll = false, env = process.env, isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY), ask, out = process.stdout } = {}) {
  if (env.AD_TOOL_SHELL === "1") throw fail("IMPORT_REFUSED", IMPORT_TEXTS.REVIEW_SHELL, { exitCode: 2 });
  const override = env.AD_INTERNAL_TEST_CONFIRM === importId;
  if (!isTTY && !override) throw fail("IMPORT_REFUSED", IMPORT_TEXTS.REVIEW_TTY, { exitCode: 2 });
  const { open } = await import("../memory/sqlite.mjs");
  const saved = process.env.AD_ROOT;
  if (env.AD_ROOT) process.env.AD_ROOT = env.AD_ROOT;
  const t = await open({ dbPath: path.join(adRoot({ env }), "episodic.db") });
  if (saved === undefined) delete process.env.AD_ROOT;
  else process.env.AD_ROOT = saved;
  const db = t.raw;
  try {
    const rowsOf = (table) => db.prepare(`SELECT x.id, x.text, x.status FROM "${table}" x JOIN import_rows r ON r.row_id = x.id AND r.table_name = ? AND r.import_id = ? WHERE x.status = 'pending'`).all(table, importId);
    const items = [...rowsOf("learnings").map((r) => ({ ...r, table: "learnings" })), ...rowsOf("user_facts").map((r) => ({ ...r, table: "user_facts" }))];
    const accept = (it) => db.prepare(`UPDATE "${it.table}" SET status = 'active'${it.table === "learnings" ? ", applied_to = 'import:accepted'" : ""} WHERE id = ?`).run(it.id);
    const reject = (it) => db.prepare(`UPDATE "${it.table}" SET status = 'rejected' WHERE id = ?`).run(it.id);
    let decided = 0;
    if (acceptAll) {
      const typed = override ? importId : await ask(`Accept all ${items.length} imported item(s)? Type ${importId} to confirm: `);
      if (String(typed ?? "").trim() !== importId) return { accepted: 0, rejected: 0, left: items.length, changed: false };
      for (const it of items) accept(it);
      decided = items.length;
    } else {
      for (const it of items) {
        const a = String((await ask(`${it.table === "learnings" ? "lesson" : "fact"} #${it.id}: ${String(it.text).slice(0, 160)}\n  accept, reject or skip? [a/r/s] `)) ?? "").trim().toLowerCase();
        if (a === "a") accept(it);
        else if (a === "r") reject(it);
        else continue;
        decided++;
      }
    }
    const left = items.length - decided;
    if (!left) {
      const from = path.join(adRoot({ env }), "proposed", "_global", `import-${importId}.md`);
      const to = path.join(adRoot({ env }), "applied", "_global", `import-${importId}.md`);
      if (fs.existsSync(from)) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to);
      }
    }
    out.write(`${decided} decided, ${left} left.\n`);
    return { decided, left, changed: decided > 0 };
  } finally {
    await t.close?.();
  }
}

export { readStatus as importStatus, handoffSlug };

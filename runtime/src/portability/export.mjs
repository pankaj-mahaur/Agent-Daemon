// `ad state export` (P7.2): one .adstate file with ad's memory, settings, session record and
// account list, for the selected projects only, with no secret inside and no path that only
// makes sense on this machine. Made while ad may be running; the source is never changed.
//
//   planExport(o)   → { projects, globalMemory, files, skipped, problems, excluded }   (inspect)
//   runExport(o)    → { out, bytes, manifest, summary }                               (export)
//   verifyBundle(buffer) → { manifest, problems }                                       (verify)
//
// Pipeline: plan (inventory walk, links skipped, names checked) → staging under
// adRoot()/exports/<exportId>.partial → SQLite snapshot (VACUUM INTO from the live file, then
// per-project deletes, schema objects dropped, paths tokenised) → files (filtered, JSON paths
// tokenised) → accounts without credentials → secret scan by pattern (DB through SQL, files as
// text; --redact cleans the staged copy only) → VACUUM → manifest → pack → verify → rename.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { adRoot } from "../ad-root.mjs";
import { openDatabase } from "../memory/driver.mjs";
import { collidedSlugs, findProject, readRegistry as readProjects } from "../memory/projects.mjs";
import { isShadowTable, tableByName } from "../memory/tables.mjs";
import { findSecrets, redactSecrets } from "../security/secret-patterns.mjs";
import { classify, classOf, OPTIONAL_CLASSES } from "./inventory.mjs";
import { validateEntryName } from "./names.mjs";
import { tokenRoots, toToken } from "./paths.mjs";
import { buildManifest, newExportId, validateManifest } from "./manifest.mjs";
import { readArchive, writeArchive, ARCHIVE_EXT } from "./archive.mjs";

export const EXPORT_TEXTS = Object.freeze({
  TOOL_SHELL: "Exports hold your private memory, so ad doesn't run them from an agent's shell.",
  NEVER: (cls) => `ad never exports ${cls === "secrets" ? "secrets/" : cls}. Sign in again on the new computer instead.`,
  UNKNOWN_CLASS: (cls) => `--include ${cls}: not something ad can add (you can add: ${[...OPTIONAL_CLASSES, "global-memory"].join(", ")}).`,
  NOT_A_PROJECT: (dir) => `${dir} isn't a project ad knows yet (run ad there once, or ad init).`,
  NO_PROJECT: "This folder isn't a project ad knows. Name one with --project <dir>, or export everything with --all-projects.",
  EXISTS: (out) => `${out} already exists: ad never overwrites a bundle. Choose another name.`,
  SECRETS: (n) => `Export stopped: ${n} item${n === 1 ? "" : "s"} look${n === 1 ? "s" : ""} like ${n === 1 ? "a key" : "keys"} (listed above). Run again with --redact to remove them from the export, or fix them with ad memory redact <table>:<id>.`,
  PLAINTEXT: "This file is not encrypted. It holds your memory and history as plain text: keep it on your own disk or a USB drive, not a shared or synced folder.",
});

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const caseInsensitive = (platform = process.platform) => platform === "win32" || platform === "darwin";
const ABS = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/;

/** Every string in a JSON value that is an absolute path, as a token (foreign ones counted). */
function tokeniseJson(value, roots, ci, count) {
  if (typeof value === "string") {
    if (!ABS.test(value)) return value;
    const r = toToken(value, roots, { caseInsensitive: ci });
    if (!r.token) count.foreign++;
    return r.value;
  }
  if (Array.isArray(value)) return value.map((v) => tokeniseJson(v, roots, ci, count));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, tokeniseJson(v, roots, ci, count)]));
  return value;
}

const liveDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// Files under a folder, as "/"-joined relative paths; links are reported, never followed.
function walk(root, { skipped }) {
  const out = [];
  const go = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        skipped.push({ path: abs, why: "a link (never followed)" });
        continue;
      }
      if (e.isDirectory()) go(abs, r);
      else if (e.isFile()) out.push(r);
    }
  };
  go(root, "");
  return out;
}

/**
 * What an export would hold. dirs: --project folders; allProjects; include / exclude: class ids
 * (plus "global-memory"). Refuses a never class and an unknown one (EXPORT_USAGE).
 */
export function planExport({ dirs = [], allProjects = false, include = [], exclude = [], cwd = process.cwd(), env = process.env, platform = process.platform } = {}) {
  for (const c of include) {
    if (c === "global-memory") continue;
    const k = classOf(c);
    if (k?.default === "never" || c === "secrets") throw fail("EXPORT_USAGE", EXPORT_TEXTS.NEVER(c));
    if (!k || !OPTIONAL_CLASSES.includes(c)) throw fail("EXPORT_USAGE", EXPORT_TEXTS.UNKNOWN_CLASS(c));
  }
  const root = adRoot({ env });
  const reg = readProjects({ env });
  const livePath = (e) => (e.paths ?? []).map((x) => x.path).find(liveDir) ?? null;
  let entries;
  if (allProjects) entries = reg.projects.filter((e) => livePath(e));
  else {
    const wanted = dirs.length ? dirs : [cwd];
    entries = [];
    for (const d of wanted) {
      const f = findProject(reg, path.resolve(d), { platform })?.entry;
      if (!f) throw fail("EXPORT_USAGE", dirs.length ? EXPORT_TEXTS.NOT_A_PROJECT(d) : EXPORT_TEXTS.NO_PROJECT);
      if (!entries.includes(f)) entries.push(f);
    }
  }
  const projects = entries.map((e) => ({ id: e.id, name: e.name, path: livePath(e) ?? e.paths?.[0]?.path ?? null, aliases: e.aliases ?? { episodic: [], handoff: [] }, gitRemote: e.gitRemote ?? null }));
  const ids = new Set(projects.map((p) => p.id));
  const globalMemory = allProjects || include.includes("global-memory");
  const takes = (cls) => cls && !exclude.includes(cls.id) && (cls.default === "in" || (cls.default === "opt" && include.includes(cls.id)));
  const skipped = [];
  const files = [];
  const excluded = new Set();
  const handoffAliases = new Set(projects.flatMap((p) => p.aliases.handoff ?? []));
  const aliasesAll = new Set(projects.flatMap((p) => [p.id, ...(p.aliases.episodic ?? []), ...(p.aliases.handoff ?? [])]));
  // ad's own folder, by class and by project.
  for (const rel of walk(root, { skipped })) {
    const cls = classify(rel, "global");
    if (!cls) {
      skipped.push({ path: path.join(root, rel), why: "no class (left behind)" });
      continue;
    }
    if (!takes(cls)) {
      excluded.add(cls.id);
      continue;
    }
    const seg = rel.split("/");
    if (cls.id === "memory-db") continue; // the snapshot, below
    if (["profile", "pending", "skill-log"].includes(cls.id) && !globalMemory) {
      excluded.add("global-memory");
      continue;
    }
    if (cls.id === "project-data" && !ids.has(seg[1])) continue;
    if (cls.id === "handoffs-global" && !handoffAliases.has(seg[1])) continue;
    if (cls.id === "review" && seg.length > 2 && !(seg[1] === "_global" ? globalMemory : aliasesAll.has(seg[1]))) continue;
    if (cls.id === "review" && seg.length === 2 && !globalMemory) continue;
    if ((cls.id === "tui-state" || cls.id === "engine-rollouts") && !allProjects) continue;
    if (cls.id === "ledger" && rel !== "sessions/index.json" && !/^sessions\/ses_[^/]+\.jsonl$/.test(rel)) continue;
    files.push({ src: path.join(root, rel), name: `global/${rel}`, class: cls.id, rel });
  }
  // Each project's own .agent-daemon.
  for (const p of projects) {
    const dir = p.path ? path.join(p.path, ".agent-daemon") : null;
    if (!dir || !liveDir(dir)) continue;
    for (const rel of walk(dir, { skipped })) {
      const cls = classify(rel, "project");
      if (!cls) {
        skipped.push({ path: path.join(dir, rel), why: "no class (left behind)" });
        continue;
      }
      if (!takes(cls)) {
        excluded.add(cls.id);
        continue;
      }
      files.push({ src: path.join(dir, rel), name: `projects/${p.id}/${rel}`, class: cls.id, rel, project: p.id });
    }
  }
  // Names: each must be one the bundle can hold, in NFC, and unique without case.
  const problems = [];
  const folded = new Map();
  for (const f of files) {
    f.name = f.name.normalize("NFC");
    const why = validateEntryName(f.name);
    if (why) problems.push({ path: f.src, why: `${why}: rename it before exporting` });
    const k = f.name.toLowerCase();
    if (folded.has(k)) problems.push({ path: f.src, why: `differs from ${folded.get(k)} only by case: rename one of them` });
    else folded.set(k, f.src);
  }
  // The ledger keeps only the selected projects' sessions (by the index's cwd).
  const ledger = files.filter((f) => f.class === "ledger");
  if (ledger.length) {
    const ix = readJson(path.join(root, "sessions", "index.json")) ?? { sessions: {} };
    const ci = caseInsensitive(platform);
    const roots = tokenRoots({ projects: projects.map((p) => ({ id: p.id, path: p.path })) });
    const keep = new Set(Object.entries(ix.sessions ?? {}).filter(([, s]) => s?.cwd && toToken(s.cwd, roots, { caseInsensitive: ci }).token).map(([id]) => id));
    for (const f of ledger) if (f.rel !== "sessions/index.json" && !keep.has(path.basename(f.rel, ".jsonl"))) files.splice(files.indexOf(f), 1);
  }
  return { root, projects, globalMemory, allProjects, files, skipped, problems, excluded: [...excluded].sort(), registry: reg };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const cols = (db, t) => db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);

/** The DB snapshot: VACUUM INTO from the live file, then everything else on the copy only. */
async function snapshotDb(plan, dbFile, { roots, ci, count }) {
  const live = await openDatabase(path.join(plan.root, "episodic.db"));
  if (!live) return null;
  try {
    live.prepare("VACUUM INTO ?").run(dbFile);
  } finally {
    live.close();
  }
  const db = await openDatabase(dbFile);
  const ids = plan.projects.map((p) => p.id);
  const slugs = new Set(plan.projects.flatMap((p) => p.aliases.episodic ?? []));
  // A collided slug's unattributed rows only when every project sharing it is selected.
  for (const slug of collidedSlugs(plan.registry)) {
    const owners = plan.registry.projects.filter((p) => (p.aliases?.episodic ?? []).includes(slug)).map((p) => p.id);
    if (!owners.every((id) => ids.includes(id))) slugs.delete(slug);
  }
  const inList = (n) => (n ? `(${new Array(n).fill("?").join(",")})` : "(NULL)");
  const tables = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table'").all();
  // FTS virtual tables (their shadow tables go with them), then every trigger, view and index.
  for (const t of tables) if (/^CREATE VIRTUAL TABLE/i.test(t.sql ?? "")) db.exec(`DROP TABLE IF EXISTS "${t.name}"`);
  for (const o of db.prepare("SELECT type, name FROM sqlite_schema WHERE type IN ('trigger','view','index') AND name NOT LIKE 'sqlite_autoindex%'").all()) db.exec(`DROP ${o.type.toUpperCase()} IF EXISTS "${o.name}"`);
  const left = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((r) => r.name);
  for (const name of left) {
    if (/^sqlite_/.test(name)) continue;
    const reg = tableByName(name);
    if (!reg || reg.export === "exclude" || isShadowTable(name)) {
      db.exec(`DROP TABLE IF EXISTS "${name}"`);
      continue;
    }
    if (reg.export === "global") {
      if (!plan.globalMemory) db.exec(`DELETE FROM "${name}"`);
      continue;
    }
    if (name === "user_facts") {
      scopeFacts(db, plan, ids, slugs);
      continue;
    }
    const c = new Set(cols(db, name));
    const byId = c.has("project_id") ? `"project_id" IN ${inList(ids.length)}` : "0";
    const bySlug = c.has("project_slug") ? `(${c.has("project_id") ? '"project_id" IS NULL AND ' : ""}"project_slug" IN ${inList(slugs.size)})` : "0";
    db.prepare(`DELETE FROM "${name}" WHERE NOT (${byId} OR ${bySlug})`).run(...(c.has("project_id") ? ids : []), ...(c.has("project_slug") ? [...slugs] : []));
    // Machine paths → tokens (registered columns only).
    for (const col of reg.pathColumns.filter((x) => c.has(x))) {
      for (const r of db.prepare(`SELECT rowid AS rid, "${col}" AS v FROM "${name}" WHERE "${col}" IS NOT NULL`).all()) {
        const t = toToken(String(r.v), roots, { caseInsensitive: ci });
        if (!t.token) count.foreign++;
        db.prepare(`UPDATE "${name}" SET "${col}" = ? WHERE rowid = ?`).run(t.value, r.rid);
      }
    }
  }
  return db;
}

// A fact goes once per selected project it belongs to (export_project = that id); a global fact
// only with global memory. Its project lists and promotion stamp never travel (03 §M).
function scopeFacts(db, plan, ids, slugs) {
  const c = cols(db, "user_facts");
  const keep = c.filter((x) => !["projects", "project_ids", "promoted_at", "export_project"].includes(x));
  const list = keep.map((x) => `"${x}"`).join(", ");
  db.exec(`CREATE TABLE user_facts_export AS SELECT ${list}, NULL AS export_project FROM user_facts WHERE 0`);
  const has = (col) => c.includes(col);
  for (const p of plan.projects) {
    const parts = [];
    const params = [];
    if (has("project_ids")) {
      parts.push(`EXISTS (SELECT 1 FROM json_each(COALESCE(project_ids, '[]')) WHERE value = ?)`);
      params.push(p.id);
    }
    const own = (p.aliases.episodic ?? []).filter((s) => slugs.has(s));
    if (has("projects") && own.length) {
      parts.push(`EXISTS (SELECT 1 FROM json_each(COALESCE(projects, '[]')) WHERE value IN (${own.map(() => "?").join(",")}))`);
      params.push(...own);
    }
    if (parts.length) db.prepare(`INSERT INTO user_facts_export SELECT ${list}, ? FROM user_facts WHERE ${parts.join(" OR ")}`).run(p.id, ...params);
  }
  if (plan.globalMemory) {
    const none = (col) => (has(col) ? `COALESCE(${col}, '[]') IN ('[]', '')` : "1");
    db.exec(`INSERT INTO user_facts_export SELECT ${list}, NULL FROM user_facts WHERE ${none("project_ids")} AND ${none("projects")}`);
  }
  db.exec("DROP TABLE user_facts");
  db.exec("ALTER TABLE user_facts_export RENAME TO user_facts");
}

// The DB's registered text columns, through SQL (a long value split across pages is still one value).
function scanDb(db, { redact }) {
  const hits = [];
  for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()) {
    const reg = tableByName(name);
    if (!reg) continue;
    const c = new Set(cols(db, name));
    for (const col of reg.textColumns.filter((x) => c.has(x))) {
      for (const r of db.prepare(`SELECT rowid AS rid, ${c.has("id") ? "id" : "rowid"} AS id, "${col}" AS v FROM "${name}" WHERE "${col}" IS NOT NULL`).all()) {
        const found = findSecrets(String(r.v));
        if (!found.length) continue;
        hits.push(...found.map((h) => ({ where: `${name} #${r.id} (${col})`, kind: h.kind })));
        if (redact) db.prepare(`UPDATE "${name}" SET "${col}" = ? WHERE rowid = ?`).run(redactSecrets(String(r.v)).text, r.rid);
      }
    }
  }
  return hits;
}

function scanFile(name, buf, { redact }) {
  const text = buf.toString("utf8");
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const h of findSecrets(line)) hits.push({ where: `${name} line ${i + 1}`, kind: h.kind });
  });
  return { hits, data: redact && hits.length ? Buffer.from(redactSecrets(text).text, "utf8") : buf };
}

// The account list: who, never how to sign in.
function scrubAccounts(doc) {
  const mask = (e) => (e && String(e).includes("@") ? `${String(e)[0]}***@${String(e).split("@")[1]}` : e ?? null);
  const accounts = (doc.accounts ?? [])
    .filter((a) => a.status !== "removing")
    .map((a) => {
      const { credential: _c, attempt: _a, salt: _s, ...rest } = a;
      return { ...rest, credential: null, status: "needs-sign-in", identity: a.identity ? { email: mask(a.identity.email), plan: a.identity.plan ?? null, workspace: a.identity.workspace ?? null } : null };
    });
  const { salt: _salt, engines: _engines, ...top } = doc;
  return { ...top, accounts };
}

function filteredJson(f, plan, { roots, ci, count }) {
  const j = readJson(f.src);
  if (j === null) return fs.readFileSync(f.src);
  let v = j;
  if (f.class === "accounts") v = scrubAccounts(j);
  else if (f.class === "projects") v = { ...j, projects: (j.projects ?? []).filter((e) => plan.projects.some((p) => p.id === e.id)).map((e) => ({ ...e, paths: [{ path: `{PROJECT:${e.id}}` }] })) };
  else if (f.class === "schedules") {
    const jobs = Array.isArray(j) ? j : (j.jobs ?? []);
    const mine = jobs.filter((x) => x?.cwd && toToken(x.cwd, roots.filter((r) => r.token.startsWith("{PROJECT:")), { caseInsensitive: ci }).token);
    v = Array.isArray(j) ? mine : { ...j, jobs: mine };
  } else if (f.class === "ledger" && f.rel === "sessions/index.json") {
    const keep = new Set(plan.files.filter((x) => x.class === "ledger" && x.rel !== "sessions/index.json").map((x) => path.basename(x.rel, ".jsonl")));
    v = { ...j, sessions: Object.fromEntries(Object.entries(j.sessions ?? {}).filter(([id]) => keep.has(id))), threads: Object.fromEntries(Object.entries(j.threads ?? {}).filter(([, id]) => keep.has(id))) };
  }
  return Buffer.from(`${JSON.stringify(tokeniseJson(v, roots, ci, count), null, 2)}\n`, "utf8");
}

/** The whole export: staged, scanned, packed, verified, then renamed into place. */
export async function runExport({ out, redact = false, env = process.env, platform = process.platform, appVersion = null, now = new Date(), ...planOpts } = {}) {
  if (env.AD_TOOL_SHELL === "1") throw fail("EXPORT_REFUSED", EXPORT_TEXTS.TOOL_SHELL, { exitCode: 2 });
  const target = path.resolve(out.endsWith(ARCHIVE_EXT) ? out : `${out}${ARCHIVE_EXT}`);
  if (fs.existsSync(target)) throw fail("EXPORT_EXISTS", EXPORT_TEXTS.EXISTS(target), { exitCode: 2 });
  const plan = planExport({ ...planOpts, env, platform });
  if (plan.problems.length) throw fail("EXPORT_NAMES", plan.problems.map((p) => `${p.path}: ${p.why}`).join("\n"), { problems: plan.problems });
  const exportId = newExportId(now.getTime());
  const staging = path.join(plan.root, "exports", `${exportId}.partial`);
  const partial = `${target}.partial`;
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  const ci = caseInsensitive(platform);
  const roots = tokenRoots({ home: env.HOME || env.USERPROFILE || os.homedir(), adRoot: plan.root, projects: plan.projects.filter((p) => p.path).map((p) => ({ id: p.id, path: p.path })) });
  const count = { foreign: 0 };
  let db = null;
  try {
    // 1. The DB snapshot (scoped, schema objects dropped, paths tokenised).
    const dbFile = path.join(staging, "episodic.db");
    db = fs.existsSync(path.join(plan.root, "episodic.db")) ? await snapshotDb(plan, dbFile, { roots, ci, count }) : null;
    // 2. Files (JSON paths as tokens; journals and history through the redactor).
    const staged = [];
    for (const f of plan.files) {
      const raw = f.rel.endsWith(".json") ? filteredJson(f, plan, { roots, ci, count }) : fs.readFileSync(f.src);
      const data = f.class === "tui-history" || f.class === "project-journals" ? Buffer.from(redactSecrets(raw.toString("utf8")).text, "utf8") : raw;
      staged.push({ name: f.name, class: f.class, data });
    }
    // 3. Secrets, by pattern only: stop, or clean the staged copy with --redact.
    const hits = db ? scanDb(db, { redact }) : [];
    for (const s of staged) {
      const r = scanFile(s.name, s.data, { redact });
      hits.push(...r.hits);
      s.data = r.data;
    }
    if (hits.length && !redact) throw fail("EXPORT_SECRETS", EXPORT_TEXTS.SECRETS(hits.length), { hits, exitCode: 1 });
    // 4. The snapshot's last pass: no freed page keeps a deleted row or a redacted value.
    const dbInfo = [];
    if (db) {
      db.exec("VACUUM");
      const integrity = db.prepare("PRAGMA integrity_check").get();
      const tables = {};
      for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()) {
        const c = new Set(cols(db, name));
        const rows = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n;
        const byProject = {};
        const key = c.has("export_project") ? "export_project" : c.has("project_id") ? "project_id" : null;
        if (key) for (const r of db.prepare(`SELECT ${key} AS k, COUNT(*) AS n FROM "${name}" GROUP BY ${key}`).all()) byProject[r.k ?? "global"] = r.n;
        if (key && byProject.global && !plan.globalMemory) delete byProject.global;
        tables[name] = { rows, byProject };
      }
      const probes = recallProbes(db, plan);
      db.close();
      db = null;
      dbInfo.push({ file: "global/episodic.db", tables, integrity: Object.values(integrity ?? {})[0] ?? "unknown", probes });
      staged.push({ name: "global/episodic.db", class: "memory-db", data: fs.readFileSync(dbFile) });
    }
    // 5. The manifest, first; then pack, verify, and rename into place.
    const accountsDoc = staged.find((s) => s.class === "accounts");
    const accounts = accountsDoc ? (JSON.parse(accountsDoc.data.toString("utf8")).accounts ?? []).map((a) => ({ id: a.id, provider: a.provider, label: a.label, method: a.method })) : [];
    const manifest = buildManifest({
      exportId,
      createdAt: now.toISOString(),
      source: { appVersion, os: platform, arch: process.arch, node: process.versions.node, caseInsensitivePaths: ci },
      scope: { projects: plan.allProjects ? "all" : "selected", globalMemory: plan.globalMemory },
      projects: plan.projects.map((p) => ({ id: p.id, name: p.name, pathToken: `{PROJECT:${p.id}}`, sourcePath: p.path, gitRemote: p.gitRemote, aliases: p.aliases })),
      classes: [...new Set(staged.map((s) => s.class))].sort().map((id) => ({ id, included: true })).concat(plan.excluded.map((id) => ({ id, included: false, reason: classOf(id)?.default ?? "not selected" }))),
      files: staged.map((s) => ({ path: s.name, size: s.data.length, sha256: sha256(s.data), class: s.class })),
      db: dbInfo.map(({ probes: _p, ...d }) => d),
      accounts,
      recallProbes: dbInfo[0]?.probes ?? [],
      warnings: [...(count.foreign ? [{ code: "foreignPaths", count: count.foreign }] : []), ...(hits.length ? [{ code: "redacted", count: hits.length }] : []), ...(plan.skipped.length ? [{ code: "skipped", count: plan.skipped.length }] : [])],
    });
    const bundle = writeArchive([{ name: "manifest.json", data: `${JSON.stringify(manifest, null, 2)}\n` }, ...staged.map((s) => ({ name: s.name, data: s.data }))]);
    const fd = fs.openSync(partial, "wx", 0o600);
    try {
      fs.writeSync(fd, bundle);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const check = verifyBundle(fs.readFileSync(partial));
    if (check.problems.length) throw fail("EXPORT_VERIFY", `The bundle didn't pass its own check: ${check.problems.join("; ")}`);
    fs.renameSync(partial, target);
    return { out: target, bytes: bundle.length, manifest, plan, hits };
  } catch (e) {
    try {
      db?.close();
    } catch {
      // closing a snapshot that failed
    }
    fs.rmSync(partial, { force: true });
    throw e;
  } finally {
    // Only ad's own staging folder, by the name it made.
    if (path.dirname(staging) === path.join(plan.root, "exports") && staging.endsWith(".partial")) fs.rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// Up to three active lessons per project, the most used first: the target proves recall.
function recallProbes(db, plan) {
  const c = new Set(cols(db, "learnings"));
  if (!c.has("project_id")) return [];
  const order = c.has("retrieval_count") ? "retrieval_count DESC, id" : "id";
  const out = [];
  for (const p of plan.projects) {
    for (const r of db.prepare(`SELECT text, content_hash FROM learnings WHERE project_id = ? AND status = 'active' ORDER BY ${order} LIMIT 3`).all(p.id)) {
      const words = String(r.text).toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [];
      out.push({ project: p.id, contentHash: r.content_hash ?? sha256(Buffer.from(String(r.text))).slice(0, 16), query: [...new Set(words)].slice(0, 4).join(" ") });
    }
  }
  return out;
}

/** A bundle read the way import reads it: the manifest, every file's size and hash. Changes nothing. */
export function verifyBundle(buffer) {
  let entries;
  try {
    entries = readArchive(buffer);
  } catch (e) {
    return { manifest: null, problems: [e.message] };
  }
  if (entries[0]?.name !== "manifest.json") return { manifest: null, problems: ["the manifest isn't the first entry"] };
  let manifest;
  try {
    manifest = JSON.parse(entries[0].data.toString("utf8"));
  } catch {
    return { manifest: null, problems: ["the manifest isn't JSON"] };
  }
  const problems = validateManifest(manifest);
  const listed = new Map((manifest.files ?? []).map((f) => [f.path, f]));
  for (const e of entries.slice(1)) {
    if (e.dir) continue;
    const f = listed.get(e.name);
    if (!f) problems.push(`${e.name} isn't in the manifest`);
    else if (f.size !== e.data.length || f.sha256 !== sha256(e.data)) problems.push(`${e.name} doesn't match its size or hash`);
    listed.delete(e.name);
  }
  for (const name of listed.keys()) problems.push(`${name} is in the manifest but not in the bundle`);
  return { manifest, problems };
}

/** The summary ad prints after an export. */
export function exportSummary({ out, bytes, manifest }) {
  const mb = (bytes / 1024 / 1024).toFixed(1);
  const lessons = (id) => manifest.db?.[0]?.tables?.learnings?.byProject?.[id] ?? 0;
  const sessions = (id) => manifest.db?.[0]?.tables?.sessions?.byProject?.[id] ?? 0;
  const projects = manifest.projects.map((p) => `${p.name} (${lessons(p.id)} lessons, ${sessions(p.id)} sessions)`).join(", ") || "none";
  const n = manifest.accounts.length;
  return [
    `Exported to ${out} (${mb} MB)`,
    `  projects: ${projects} · global memory: ${manifest.scope.globalMemory ? "included" : "not included (add --include global-memory)"}`,
    `  settings, account list (${n} account${n === 1 ? "" : "s"}: sign in again after import)`,
    "  not included: secrets, the engine's own folders, logs, locks, other projects (see ad state inspect)",
    ...(manifest.warnings.some((w) => w.code === "redacted") ? [`  ${manifest.warnings.find((w) => w.code === "redacted").count} item(s) that looked like keys were replaced with [redacted] in the export (your own copy is unchanged)`] : []),
    `  ${EXPORT_TEXTS.PLAINTEXT}`,
  ].join("\n");
}

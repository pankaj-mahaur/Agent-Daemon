// Stable project identity (P7.1a, D52). A project's memory used to be keyed only by
// a slug built from its absolute path (episodic.projectSlug): moving a folder lost its
// memory, and two folders could collide into one slug. Each project now has an id.
//
//   adRoot()/projects.json   { schemaVersion: 1, revision, projects: [{ id, name, paths: [{ path, lastSeenAt }],
//                              aliases: { episodic: [slug], handoff: [slug] }, gitRemote, createdAt }] }
//   <project>/.agent-daemon/project.json   { schemaVersion: 1, id }  (only where the user ran ad init;
//                              kept out of git through .git/info/exclude)
//
// resolveProject(cwd) → { id, slug, collided } in this order:
//   1. the folder's marker, when the registry knows that id (a moved folder keeps its id);
//   2. an entry with this path;
//   3. an entry whose episodic slug is this folder's, only when that entry has no
//      live path or its path is this folder (so /x/a-b never joins /x/a/b's entry);
//   4. a new entry.
// The project path is the folder ad uses today (no walking up to a git root).
//
// Writes take the `projects` lock, re-read, bump the revision and replace the file
// atomically, all synchronously: hooks resolve projects too.
//
// Memory keys (scope.mjs, episodic.mjs): a key array holds the project's slugs and its
// id (`prj_…`). A slug two projects share is "collided": it is listed write-only as
// `~slug`, so no filter serves the other folder's unattributed rows through it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { adRoot } from "../ad-root.mjs";
import { acquireLock } from "../lock.mjs";

export const PROJECT_ID_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID (time-ordered, 26 Crockford base-32 characters). */
export function ulid(now = Date.now(), rand = crypto.randomBytes(16)) {
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let r = "";
  for (let i = 0; i < 16; i++) r += CROCKFORD[rand[i] % 32];
  return time + r;
}
export const newProjectId = (now) => `prj_${ulid(now)}`;

/** The same slug episodic.projectSlug makes (kept here so this module has no DB import). */
export const episodicSlug = (absPath) => path.normalize(absPath).replace(/[\\/:]/g, "-");
/** The handoff folder's slug (cli-full.mjs cmdInit): lowercased, whitespace collapsed, trimmed. */
export const handoffSlug = (absPath) => absPath.replace(/[\\/:\s]+/g, "-").toLowerCase().replace(/^-+|-+$/g, "");

/** A folder's identity for "is this the same folder?": its real path, case-folded on Windows and macOS. */
export function canonicalDir(p, { platform = process.platform } = {}) {
  let out = path.resolve(p);
  try {
    out = fs.realpathSync.native(out);
  } catch {
    // gone: compare by the path as written
  }
  return platform === "win32" || platform === "darwin" ? out.toLowerCase() : out;
}

export const registryPath = ({ env = process.env } = {}) => path.join(adRoot({ env }), "projects.json");
const EMPTY = () => ({ schemaVersion: 1, revision: 0, projects: [] });

export function readRegistry(opts = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(registryPath(opts), "utf8"));
    if (j?.schemaVersion === 1 && Array.isArray(j.projects)) return j;
    if (j?.schemaVersion > 1) {
      const e = new Error("projects.json was written by a newer ad");
      e.code = "REGISTRY_NEWER";
      throw e;
    }
  } catch (e) {
    if (e.code === "REGISTRY_NEWER") throw e;
    // missing or unreadable: empty (a corrupt file is replaced on the next write; doctor reports it)
  }
  return EMPTY();
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function writeAtomicSync(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 8 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      sleep(20 * 2 ** Math.min(i, 4));
    }
  }
}

/**
 * Change the registry under its lock: re-read, mutate a copy, bump the revision,
 * replace the file. mutate returns false (or nothing changed) → no write.
 */
// waitMs: a busy lock checks its holder's process (a PowerShell lookup on Windows, up
// to 3 s), so several writers at once need more than a few seconds.
export function transactRegistry(mutate, { env = process.env, waitMs = 15_000 } = {}) {
  const lockDir = path.join(adRoot({ env }), "locks");
  const until = Date.now() + waitMs;
  let release;
  for (;;) {
    try {
      release = acquireLock("projects", { dir: lockDir });
      break;
    } catch (e) {
      if (e.code !== "LOCK_BUSY") throw e;
      if (Date.now() > until) throw e;
      sleep(25);
    }
  }
  try {
    const current = readRegistry({ env });
    const next = structuredClone(current);
    const result = mutate(next);
    if (result === false || JSON.stringify(next) === JSON.stringify(current)) return { registry: current, result };
    next.revision = (current.revision ?? 0) + 1;
    writeAtomicSync(registryPath({ env }), JSON.stringify(next, null, 2) + "\n");
    return { registry: next, result };
  } finally {
    release();
  }
}

/** A git remote without credentials: https://user:tok@GitHub.com/Org/App.git → github.com/Org/App. */
export function normalizeRemote(url) {
  if (!url) return null;
  let u = String(url).trim();
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(u); // git@github.com:org/app.git
  if (scp) u = `${scp[1]}/${scp[2]}`;
  else {
    try {
      const parsed = new URL(u);
      u = `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}`;
    } catch {
      return null;
    }
  }
  const [host, ...rest] = u.split("/");
  return `${host.toLowerCase()}/${rest.join("/")}`.replace(/\.git$/, "").replace(/\/+$/, "");
}

function gitRemoteOf(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, ".git", "config"), "utf8");
    const m = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(text);
    return m ? normalizeRemote(m[1]) : null;
  } catch {
    return null;
  }
}

const markerPath = (dir) => path.join(dir, ".agent-daemon", "project.json");
function readMarker(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(markerPath(dir), "utf8"));
    return j?.schemaVersion === 1 && PROJECT_ID_RE.test(j.id) ? j.id : null;
  } catch {
    return null;
  }
}
// Only where ad init made .agent-daemon/; kept out of git locally (.git/info/exclude).
function writeMarker(dir, id) {
  if (!fs.existsSync(path.join(dir, ".agent-daemon"))) return;
  try {
    if (readMarker(dir) === id) return;
    writeAtomicSync(markerPath(dir), JSON.stringify({ schemaVersion: 1, id }, null, 2) + "\n");
    const exclude = path.join(dir, ".git", "info", "exclude");
    if (fs.existsSync(path.join(dir, ".git")) && fs.statSync(path.join(dir, ".git")).isDirectory()) {
      const line = ".agent-daemon/project.json";
      const had = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
      if (!had.split(/\r?\n/).includes(line)) {
        fs.mkdirSync(path.dirname(exclude), { recursive: true });
        fs.appendFileSync(exclude, `${had && !had.endsWith("\n") ? "\n" : ""}${line}\n`);
      }
    }
  } catch {
    // a read-only folder: the registry still knows the project by its path
  }
}

const liveDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Find the entry for a folder in a registry (no writes). → { entry, step } | null */
export function findProject(registry, dir, { platform = process.platform, marker = readMarker(dir) } = {}) {
  const canon = canonicalDir(dir, { platform });
  const byId = marker ? registry.projects.find((p) => p.id === marker) : null;
  if (byId) {
    // The marker's folder moved here, or this is the folder it names: same project. A
    // copied folder whose original still exists is a new project (step 4).
    const others = byId.paths.filter((x) => canonicalDir(x.path, { platform }) !== canon);
    if (byId.paths.some((x) => canonicalDir(x.path, { platform }) === canon) || !others.some((x) => liveDir(x.path))) return { entry: byId, step: 1 };
  }
  const byPath = registry.projects.find((p) => p.paths.some((x) => canonicalDir(x.path, { platform }) === canon));
  if (byPath) return { entry: byPath, step: 2 };
  const slug = episodicSlug(path.resolve(dir));
  const bySlug = registry.projects.find((p) => p.aliases?.episodic?.includes(slug) && !p.paths.some((x) => liveDir(x.path) && canonicalDir(x.path, { platform }) !== canon));
  if (bySlug) return { entry: bySlug, step: 3 };
  return null;
}

/** Slugs that two or more projects claim. */
export function collidedSlugs(registry) {
  const seen = new Map();
  for (const p of registry.projects) for (const s of new Set(p.aliases?.episodic ?? [])) seen.set(s, (seen.get(s) ?? 0) + 1);
  return new Set([...seen].filter(([, n]) => n > 1).map(([s]) => s));
}

/**
 * The project of a folder: { id, slug, collided, created } (create: false → null when unknown).
 * @param {string} cwd an absolute folder
 */
export function resolveProject(cwd, { create = true, env = process.env, platform = process.platform, now = new Date() } = {}) {
  const dir = path.resolve(cwd);
  // Never a project: a filesystem root, the home folder, ad's own folder (no entry, no marker).
  const canon = canonicalDir(dir, { platform });
  const own = canonicalDir(adRoot({ env }), { platform });
  if (path.parse(dir).root === dir || canon === canonicalDir(os.homedir(), { platform }) || canon === own || canon.startsWith(own + path.sep)) return null;
  const slug = episodicSlug(dir);
  let reg;
  try {
    reg = readRegistry({ env });
  } catch {
    return null; // a newer ad's registry: keys stay slug-only
  }
  const found = findProject(reg, dir, { platform });
  const stamp = now.toISOString();
  const needsWrite = (e) => !e.paths.some((x) => canonicalDir(x.path, { platform }) === canonicalDir(dir, { platform })) || !e.aliases?.episodic?.includes(slug);
  let entry = found?.entry ?? null;
  if (!entry && !create) return null;
  if (!entry || needsWrite(entry)) {
    const { registry, result } = transactRegistry((r) => {
      let e = findProject(r, dir, { platform })?.entry;
      if (!e) {
        e = { id: newProjectId(now.getTime()), name: path.basename(dir), paths: [], aliases: { episodic: [], handoff: [] }, gitRemote: gitRemoteOf(dir), createdAt: stamp };
        r.projects.push(e);
      }
      // A moved folder: its old path, if gone, gives way to this one.
      e.paths = e.paths.filter((x) => canonicalDir(x.path, { platform }) !== canonicalDir(dir, { platform }) && liveDir(x.path));
      e.paths.push({ path: dir, lastSeenAt: stamp });
      e.aliases = e.aliases ?? { episodic: [], handoff: [] };
      if (!e.aliases.episodic.includes(slug)) e.aliases.episodic.push(slug);
      const h = handoffSlug(dir);
      if (!(e.aliases.handoff ?? []).includes(h)) e.aliases.handoff = [...(e.aliases.handoff ?? []), h];
      return e.id;
    }, { env });
    entry = registry.projects.find((p) => p.id === result);
    reg = registry;
  }
  writeMarker(dir, entry.id);
  return { id: entry.id, slug, collided: collidedSlugs(reg).has(slug), created: !found };
}

/* ------------------------------------------------------------------ */
/* Memory keys                                                         */
/* ------------------------------------------------------------------ */

export const isProjectId = (k) => typeof k === "string" && k.startsWith("prj_");
/** The slug a writer stores in project_slug: the first slug, write-only (~) ones included. */
export const slugOfKeys = (keys) => {
  const k = (keys ?? []).find((x) => typeof x === "string" && !isProjectId(x));
  return k === undefined ? null : k.replace(/^~/, "");
};
/** The project id among the keys, or null. */
export const idOfKeys = (keys) => (keys ?? []).find(isProjectId) ?? null;

/**
 * SQL that matches a row of this project: by id, or by one of its readable slugs. A
 * readable slug is one no other project claims (the scope builders list a shared one
 * as write-only `~slug`, which never matches), so every row of it is this project's,
 * with an id or without. keys null → no project filter ("1"); no usable key → "0".
 * @returns {{ sql: string, params: string[] }}
 */
export function projectClause(alias, keys, { idCol = "project_id", slugCol = "project_slug" } = {}) {
  if (keys === null || keys === undefined) return { sql: "1", params: [] };
  const a = alias ? `${alias}.` : "";
  const ids = keys.filter(isProjectId);
  const slugs = keys.filter((k) => typeof k === "string" && !isProjectId(k) && !k.startsWith("~"));
  const parts = [];
  const params = [];
  if (ids.length) {
    parts.push(`${a}${idCol} IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
  }
  if (slugs.length) {
    parts.push(`${a}${slugCol} IN (${slugs.map(() => "?").join(",")})`);
    params.push(...slugs);
  }
  return parts.length ? { sql: `(${parts.join(" OR ")})`, params } : { sql: "0", params: [] };
}

/**
 * Add the project id to a scope's keys. A collided slug becomes write-only (~slug) and
 * the scope serves by id, so the project's own rows come back and the other folder's don't.
 * scope: { kind, dir, keys } from resolveMemoryScope (+ withAliasKeys).
 */
export function withProjectId(scope, opts = {}) {
  if (!scope?.dir || (scope.kind !== "project" && scope.kind !== "collision")) return scope;
  let p = null;
  try {
    p = resolveProject(scope.dir, opts);
  } catch {
    p = null; // the registry is busy or unwritable: keys stay slug-only
  }
  if (!p) return scope;
  const slug = p.slug;
  if (scope.kind === "collision" || p.collided) {
    // Only this folder's own aliases that nobody else claims stay readable.
    const reg = readRegistry(opts);
    const shared = collidedSlugs(reg);
    const own = scope.keys.filter((k) => !shared.has(k) && k !== slug);
    return { ...scope, kind: "project", collided: true, keys: [`~${slug}`, ...own, p.id] };
  }
  return { ...scope, keys: [...scope.keys.filter((k) => !isProjectId(k)), p.id] };
}

/** The project id of a folder (create: false by default → null when unknown). */
export function projectIdOf(cwd, opts = {}) {
  try {
    return resolveProject(cwd, { create: false, ...opts })?.id ?? null;
  } catch {
    return null;
  }
}

export const _test = { readMarker, gitRemoteOf, home: os.homedir };

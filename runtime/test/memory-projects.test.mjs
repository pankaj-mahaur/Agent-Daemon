// P7.1a: stable project identity. A registry of projects with ids (projects.json),
// a marker in projects ad was set up in, ids on every memory table, triggers that fill
// them, a backfill that splits two folders which shared a slug, and serving by id.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME = await fs.mkdtemp(path.join(os.tmpdir(), "ad-projects-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.AD_ROOT = path.join(HOME, ".agent-daemon");
for (const k of ["AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL"]) delete process.env[k];

const projects = await import("../src/memory/projects.mjs");
const { TABLES, isShadowTable } = await import("../src/memory/tables.mjs");
const { backfillProjectIds, unassignedCounts } = await import("../src/memory/project-db.mjs");
const ep = await import("../src/memory/episodic.mjs");
const { hookProjectKeys } = await import("../src/memory/scope.mjs");

let handle;
before(async () => {
  handle = await ep.db();
});
after(async () => {
  ep.closeDb();
  await fs.rm(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

let n = 0;
const folder = (rel = `work/p${++n}`, { init = false } = {}) => {
  const d = path.join(HOME, rel);
  mkdirSync(path.join(d, ".git"), { recursive: true });
  if (init) mkdirSync(path.join(d, ".agent-daemon"), { recursive: true });
  return d;
};
const registry = () => JSON.parse(readFileSync(path.join(HOME, ".agent-daemon", "projects.json"), "utf8"));

test("ids: prj_ + a 26-character ULID, time-ordered and random", () => {
  const a = projects.newProjectId(1_700_000_000_000);
  const b = projects.newProjectId(1_700_000_000_001);
  assert.match(a, projects.PROJECT_ID_RE);
  assert.ok(a.slice(4, 14) < b.slice(4, 14), "the time part sorts");
  assert.notEqual(projects.newProjectId(), projects.newProjectId());
});

test("resolveProject: created once; the same folder resolves to the same id; the registry records path and slugs", () => {
  const d = folder();
  const a = projects.resolveProject(d);
  assert.equal(a.created, true);
  const b = projects.resolveProject(d);
  assert.deepEqual([b.id, b.created], [a.id, false]);
  const entry = registry().projects.find((p) => p.id === a.id);
  assert.equal(entry.paths[0].path, d);
  assert.deepEqual(entry.aliases.episodic, [ep.projectSlug(d)]);
  assert.equal(entry.aliases.handoff[0], projects.handoffSlug(d));
  assert.equal(projects.resolveProject(folder(), { create: false }), null, "create: false never makes one");
});

test("a moved folder keeps its id through its marker; a copy whose original still exists is a new project", () => {
  const d = folder(`work/move-${++n}`, { init: true });
  const { id } = projects.resolveProject(d);
  assert.equal(JSON.parse(readFileSync(path.join(d, ".agent-daemon", "project.json"), "utf8")).id, id);
  assert.match(readFileSync(path.join(d, ".git", "info", "exclude"), "utf8"), /^\.agent-daemon\/project\.json$/m, "kept out of git, locally");
  const moved = path.join(HOME, "work", `moved-${n}`);
  renameSync(d, moved);
  assert.equal(projects.resolveProject(moved).id, id, "moved: same project");
  assert.deepEqual(registry().projects.find((p) => p.id === id).paths.map((p) => p.path), [moved], "the old path gave way");
  // A copy next to its original: same marker, but the original is alive.
  const copy = path.join(HOME, "work", `copy-${n}`);
  mkdirSync(path.join(copy, ".agent-daemon"), { recursive: true });
  writeFileSync(path.join(copy, ".agent-daemon", "project.json"), readFileSync(path.join(moved, ".agent-daemon", "project.json")));
  assert.notEqual(projects.resolveProject(copy).id, id);
});

test("the slug rule: /x/a-b never joins the project /x/a/b made, and both slugs are marked shared", () => {
  const ab = folder(`x${++n}/a/b`);
  const a_b = folder(`x${n}/a-b`);
  const p1 = projects.resolveProject(ab);
  const p2 = projects.resolveProject(a_b);
  assert.notEqual(p1.id, p2.id);
  assert.equal(p2.collided, true);
  assert.ok(projects.collidedSlugs(registry()).has(ep.projectSlug(ab)));
  // Each scope reads by id; the shared slug is write-only.
  const scope = projects.withProjectId({ kind: "project", dir: ab, keys: [ep.projectSlug(ab)] });
  assert.deepEqual(scope.keys, [`~${ep.projectSlug(ab)}`, p1.id]);
  assert.equal(projects.slugOfKeys(scope.keys), ep.projectSlug(ab));
  assert.equal(projects.idOfKeys(scope.keys), p1.id);
  assert.deepEqual(projects.projectClause("l", scope.keys), { sql: "(l.project_id IN (?))", params: [p1.id] });
});

test("never a project: home, a filesystem root, ad's own folder; no marker is written there", () => {
  assert.equal(projects.resolveProject(HOME), null);
  assert.equal(projects.resolveProject(path.parse(HOME).root), null);
  mkdirSync(path.join(HOME, ".agent-daemon", "sub"), { recursive: true });
  assert.equal(projects.resolveProject(path.join(HOME, ".agent-daemon")), null);
  assert.equal(projects.resolveProject(path.join(HOME, ".agent-daemon", "sub")), null);
  assert.ok(!existsSync(path.join(HOME, ".agent-daemon", "project.json")));
});

test("a session of a folder the registry hasn't met never takes the id of another folder with its slug", async () => {
  const known = folder(`z${++n}/a/b`);
  const unknown = folder(`z${n}/a-b`);
  // Registered the way a hook does it, so the database's mirror knows the slug.
  await hookProjectKeys(known);
  const { id } = projects.resolveProject(known);
  assert.equal(handle.get("SELECT project_id FROM project_keys WHERE slug = ?", [ep.projectSlug(known)]).project_id, id);
  await ep.upsertSession({ id: `sz-${n}`, projectPath: unknown, startedAt: "2026-10-01T00:00:00.000Z" });
  assert.equal(handle.get("SELECT project_id FROM sessions WHERE id = ?", [`sz-${n}`]).project_id, null);
  await ep.upsertSession({ id: `sk-${n}`, projectPath: known, startedAt: "2026-10-01T00:00:00.000Z" });
  assert.equal(handle.get("SELECT project_id FROM sessions WHERE id = ?", [`sk-${n}`]).project_id, id, "by its path");
  // A note that records its folder takes that folder's id, not the slug's.
  const other = projects.resolveProject(unknown).id;
  const lid = await ep.insertLearning({ projectSlug: ep.projectSlug(unknown), projectPath: unknown, category: "gotcha", text: `recorded folder ${n}`, confidence: 0.9 });
  assert.equal(handle.get("SELECT project_id FROM learnings WHERE id = ?", [lid]).project_id, other);
});

test("git remotes are kept without credentials", () => {
  assert.equal(projects.normalizeRemote("https://user:tok@GitHub.com/Org/App.git"), "github.com/Org/App");
  assert.equal(projects.normalizeRemote("git@github.com:org/app.git"), "github.com/org/app");
  assert.equal(projects.normalizeRemote("ssh://git@host:2222/a/b"), "host:2222/a/b");
  const d = folder();
  writeFileSync(path.join(d, ".git", "config"), '[remote "origin"]\n\turl = https://x:secret@github.com/o/r.git\n');
  const { id } = projects.resolveProject(d);
  const e = registry().projects.find((p) => p.id === id);
  assert.equal(e.gitRemote, "github.com/o/r");
  assert.ok(!JSON.stringify(registry()).includes("secret"));
});

test("concurrent registry writes: 8 processes add a project each → 8 projects, no write lost", async () => {
  const root = path.join(HOME, "concurrent");
  const env = { ...process.env, AD_ROOT: root };
  const mod = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "memory", "projects.mjs");
  const dirs = Array.from({ length: 8 }, (_, i) => folder(`conc/p${i}`));
  await Promise.all(
    dirs.map(
      (d) =>
        new Promise((resolve, reject) => {
          const c = spawn(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(new URL(`file:///${mod.replace(/\\/g, "/")}`).href)}); m.resolveProject(${JSON.stringify(d)});`], { env, stdio: "inherit" });
          c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
        })
    )
  );
  const reg = JSON.parse(readFileSync(path.join(root, "projects.json"), "utf8"));
  assert.equal(reg.projects.length, 8);
  assert.equal(reg.revision, 8);
});

test("one state root: HOME and USERPROFILE differ (Git Bash), and state still lands in adRoot(); an older HOME-based file is still found", async () => {
  const { adRoot, statePath } = await import("../src/ad-root.mjs");
  const home = path.join(HOME, "msys-home");
  const profile = path.join(HOME, "profile");
  const env = { HOME: home, USERPROFILE: profile };
  const homedir = () => profile;
  assert.equal(adRoot({ env, homedir }), path.join(profile, ".agent-daemon"));
  assert.equal(statePath("config.json", { env, homedir }), path.join(profile, ".agent-daemon", "config.json"));
  mkdirSync(path.join(home, ".agent-daemon"), { recursive: true });
  writeFileSync(path.join(home, ".agent-daemon", "user.md"), "old\n");
  assert.equal(statePath("user.md", { env, homedir }), path.join(home, ".agent-daemon", "user.md"), "the older file");
  // The registry, the database and capture folders all use the same root.
  assert.equal(projects.registryPath(), path.join(process.env.AD_ROOT, "projects.json"));
  assert.ok(handle.path.startsWith(process.env.AD_ROOT));
  // The MCP audit log no longer follows AGENT_DAEMON_HOME (the runtime folder).
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "hooks", "mcp-audit.mjs"), "utf8");
  assert.doesNotMatch(src, /AGENT_DAEMON_HOME \|\|/);
});

test("every table in the schema is in the table registry", () => {
  const names = handle.all("SELECT name FROM sqlite_schema WHERE type = 'table'").map((r) => r.name).filter((x) => !isShadowTable(x));
  const known = new Set(TABLES.map((t) => t.name));
  assert.deepEqual(names.filter((x) => !known.has(x)), []);
  for (const t of TABLES.filter((x) => x.projectColumn === "project_id")) {
    const cols = handle.all(`PRAGMA table_info(${t.name})`).map((c) => c.name);
    assert.ok(cols.includes("project_id"), `${t.name} has project_id`);
  }
  assert.ok(handle.get("SELECT 1 AS x FROM schema_version WHERE version = 4"));
});

test("a row written by slug gets its project's id; a slug two folders share gets none", async () => {
  const d = folder();
  const keys = await hookProjectKeys(d);
  const { id } = projects.resolveProject(d);
  assert.deepEqual(keys, [ep.projectSlug(d), id]);
  const lid = await ep.insertLearning({ projectSlug: ep.projectSlug(d), category: "gotcha", text: `by slug ${n}`, confidence: 0.9 });
  assert.equal(handle.get("SELECT project_id FROM learnings WHERE id = ?", [lid]).project_id, id, "the insert trigger");
  // Made cross-project: no project id; back to its project: the id again.
  handle.run("UPDATE learnings SET project_slug = NULL WHERE id = ?", [lid]);
  assert.equal(handle.get("SELECT project_id FROM learnings WHERE id = ?", [lid]).project_id, null);
  handle.run("UPDATE learnings SET project_slug = ? WHERE id = ?", [ep.projectSlug(d), lid]);
  assert.equal(handle.get("SELECT project_id FROM learnings WHERE id = ?", [lid]).project_id, id);
});

test("capture folders outside a project: keyed by the project id; an older path-keyed one is used until the backfill moves it", async () => {
  const { outsideDir, projectFolderName } = await import("../src/memory/project-dir.mjs");
  const fresh = folder();
  assert.equal(path.basename(outsideDir(fresh)), projects.resolveProject(fresh).id, "a new project: its id");
  const old = folder();
  const legacy = path.join(HOME, ".agent-daemon", "projects", projectFolderName(old));
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, "learning-journal.jsonl"), "{}\n");
  assert.equal(outsideDir(old), legacy, "until it moves");
  await ep.upsertSession({ id: `s-old-${n}`, projectPath: old, startedAt: "2026-10-01T00:00:00.000Z" });
  const r = backfillProjectIds(handle);
  assert.ok(r.movedFolders >= 1);
  const id = projects.resolveProject(old).id;
  assert.equal(outsideDir(old), path.join(HOME, ".agent-daemon", "projects", id));
  assert.ok(existsSync(path.join(outsideDir(old), "learning-journal.jsonl")));
});

test("backfill: two folders that shared a slug are split by their sessions; what can't be told apart stays unserved", async () => {
  const one = folder(`y${++n}/a/b`);
  const two = folder(`y${n}/a-b`);
  const slug = ep.projectSlug(one);
  // Rows from before P7.1: no registry entries yet, so no ids.
  await ep.upsertSession({ id: `s1-${n}`, projectPath: one, startedAt: "2026-10-01T00:00:00.000Z" });
  await ep.upsertSession({ id: `s2-${n}`, projectPath: two, startedAt: "2026-10-01T00:00:00.000Z" });
  const inOne = await ep.insertLearning({ sessionId: `s1-${n}`, projectSlug: slug, category: "gotcha", text: "only folder one", confidence: 0.9 });
  const inTwo = await ep.insertLearning({ projectSlug: slug, projectPath: two, category: "gotcha", text: "only folder two", confidence: 0.9 });
  const neither = await ep.insertLearning({ projectSlug: slug, category: "gotcha", text: "no way to tell", confidence: 0.9 });
  const r = backfillProjectIds(handle);
  assert.ok(r.projects >= 2);
  const id1 = projects.resolveProject(one).id;
  const id2 = projects.resolveProject(two).id;
  const idOf = (lid) => handle.get("SELECT project_id FROM learnings WHERE id = ?", [lid]).project_id;
  assert.equal(idOf(inOne), id1, "by its session");
  assert.equal(idOf(inTwo), id2, "by its recorded folder");
  assert.equal(idOf(neither), null, "unattributable");
  assert.ok(unassignedCounts(handle).learnings >= 1);
  // Served by id: each folder sees its own note, neither sees the shared one.
  const k1 = await hookProjectKeys(one);
  const k2 = await hookProjectKeys(two);
  assert.deepEqual(k1, [`~${slug}`, id1]);
  const texts = async (keys) => (await ep.listRecentLearnings({ projectKeys: keys, limit: 100 })).map((x) => x.text);
  assert.ok((await texts(k1)).includes("only folder one") && !(await texts(k1)).includes("only folder two"));
  assert.ok((await texts(k2)).includes("only folder two") && !(await texts(k2)).includes("only folder one"));
  for (const k of [k1, k2]) assert.ok(!(await texts(k)).includes("no way to tell"));
  // A row written by the shared slug alone (a writer that doesn't know the folder) gets no id.
  const bare = await ep.insertLearning({ projectSlug: slug, category: "gotcha", text: "slug only, after the split", confidence: 0.9 });
  assert.equal(idOf(bare), null, "the trigger never guesses between two folders");
  // New notes in a collided folder carry its id, and the same text in both is two notes.
  const a = await ep.insertLearning({ projectSlug: slug, projectId: id1, category: "gotcha", text: "same words", confidence: 0.9 });
  const b = await ep.insertLearning({ projectSlug: slug, projectId: id2, category: "gotcha", text: "same words", confidence: 0.9 });
  assert.ok(a && b && a !== b, "one note per project, by id");
  // Idempotent: a second run changes nothing.
  const again = backfillProjectIds(handle);
  assert.equal(Object.values(again.updated).reduce((s, x) => s + x, 0), 0);

  // ad memory assign: the user places the shared note by hand, from a real terminal only.
  const { memoryAssign, memoryMigrate } = await import("../src/memory/assign.mjs");
  const lines = [];
  const out = (l) => lines.push(l);
  const io = (answer) => ({ ask: async () => answer });
  const ref = `learnings:${neither}`;
  assert.equal(await memoryAssign({ ref, project: one, handle, io: io(ref), out, env: { AD_TOOL_SHELL: "1" }, isTTY: () => true }), 2);
  assert.equal(await memoryAssign({ ref, project: one, handle, io: io(ref), out, env: {}, isTTY: () => false }), 2);
  assert.equal(idOf(neither), null);
  assert.equal(await memoryAssign({ ref, project: folder(), handle, io: io(ref), out, env: {}, isTTY: () => true }), 1, "a folder that never wrote it");
  assert.equal(await memoryAssign({ ref, project: one, handle, io: io("yes"), out, env: {}, isTTY: () => true }), 1, "not typed");
  assert.equal(idOf(neither), null);
  await memoryAssign({ list: true, handle, io: io(""), out, env: {} });
  assert.ok(lines.some((l) => l.includes(ref)), "listed");
  assert.equal(await memoryAssign({ ref, project: one, handle, io: io(ref), out, env: {}, isTTY: () => true }), 0);
  assert.equal(idOf(neither), id1);
  assert.ok((await texts(k1)).includes("no way to tell") && !(await texts(k2)).includes("no way to tell"));
  assert.equal(memoryMigrate({ handle, out }), 0);
  assert.ok(lines.some((l) => /^Projects known: \d+\./.test(l)));
  assert.ok(lines.some((l) => /served to neither/.test(l)), "what is left is named");
});

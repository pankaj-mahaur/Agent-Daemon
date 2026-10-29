// P7.2: ad state export / inspect / verify and ad memory redact, on a throwaway home with two
// projects (testkit/state-fixture.mjs). Nothing of the project not chosen, no secret, no
// schema object reaches a bundle; the source never changes.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { makeStateFixture } from "../testkit/state-fixture.mjs";
import { planExport, runExport, verifyBundle, EXPORT_TEXTS } from "../src/portability/export.mjs";
import { readArchive } from "../src/portability/archive.mjs";
import { cmdState, cmdMemoryRedact } from "../src/portability/state-cli.mjs";
import { openDatabase } from "../src/memory/driver.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-state-export-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
let n = 0;
const fixture = async (o) => makeStateFixture({ root: fs.mkdtempSync(path.join(TMP, `f${++n}-`)), ...o });
const sink = () => {
  const s = { text: "", write: (c) => ((s.text += c), true) };
  return s;
};
const entriesOf = (file) => readArchive(fs.readFileSync(file));
const snapshotOf = async (file, dir) => {
  const db = entriesOf(file).find((e) => e.name === "global/episodic.db");
  const p = path.join(dir, `snap-${++n}.db`);
  fs.writeFileSync(p, db.data);
  return openDatabase(p);
};

test("export A from A+B: nothing of B anywhere in the bundle, the raw DB bytes included; byProject lists only A", async () => {
  const fx = await fixture({ keyish: false });
  const r = await runExport({ out: path.join(fx.root, "a.adstate"), env: fx.env, dirs: [fx.A.dir] });
  const raw = gunzipSync(fs.readFileSync(r.out));
  for (const s of [fx.B.sentinel, fx.B.slug, fx.B.dir, fx.B.id, "bbb222", fx.B.handoff]) assert.equal(raw.includes(Buffer.from(s)), false, `B's ${s.slice(0, 24)} leaked`);
  assert.equal(raw.includes(Buffer.from(fx.A.sentinel)), true, "A is there");
  const m = r.manifest;
  for (const t of Object.values(m.db[0].tables)) for (const k of Object.keys(t.byProject)) assert.equal(k, fx.A.id, "only A's counts");
  assert.equal(m.db[0].tables.learnings.byProject[fx.A.id], 3);
  assert.equal(raw.includes(Buffer.from("GLOBAL-FACT-5521")), false, "global memory only on request");
  // Paths as tokens, never this machine's.
  const sched = JSON.parse(entriesOf(r.out).find((e) => e.name === "global/schedules.json").data);
  assert.deepEqual(sched.jobs.map((j) => j.cwd), [`{PROJECT:${fx.A.id}}`]);
  const db = await snapshotOf(r.out, fx.root);
  assert.deepEqual(db.prepare("SELECT DISTINCT project_path FROM sessions").all().map((x) => x.project_path), [`{PROJECT:${fx.A.id}}`]);
  db.close();
});

test("--include global-memory brings the global facts and the profile; --all-projects brings both projects", async () => {
  const fx = await fixture({ keyish: false });
  const g = await runExport({ out: path.join(fx.root, "g.adstate"), env: fx.env, dirs: [fx.A.dir], include: ["global-memory"] });
  const raw = gunzipSync(fs.readFileSync(g.out));
  assert.equal(raw.includes(Buffer.from("GLOBAL-FACT-5521")), true);
  assert.ok(entriesOf(g.out).some((e) => e.name === "global/user.md"));
  const all = await runExport({ out: path.join(fx.root, "all.adstate"), env: fx.env, allProjects: true });
  assert.deepEqual(all.manifest.projects.map((p) => p.id).sort(), [fx.A.id, fx.B.id].sort());
  assert.equal(all.manifest.scope.globalMemory, true);
});

test("the snapshot holds no trigger, view, FTS table or index; integrity ok; excluded tables gone; facts carry export_project", async () => {
  const fx = await fixture({ keyish: false });
  const r = await runExport({ out: path.join(fx.root, "s.adstate"), env: fx.env, dirs: [fx.A.dir] });
  assert.equal(r.manifest.db[0].integrity, "ok");
  const db = await snapshotOf(r.out, fx.root);
  try {
    assert.deepEqual(db.prepare("SELECT type, name FROM sqlite_schema WHERE type IN ('trigger','view','index') AND name NOT LIKE 'sqlite_autoindex%'").all(), []);
    const tables = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table'").all();
    assert.ok(!tables.some((t) => /VIRTUAL|_fts/i.test(`${t.name} ${t.sql}`)), tables.map((t) => t.name).join());
    assert.ok(!tables.some((t) => ["messages", "tool_calls", "meta", "schema_version", "retrieval_events"].includes(t.name)), "machine-local tables never leave");
    const facts = db.prepare("SELECT text, export_project FROM user_facts").all();
    assert.deepEqual(facts.map((f) => f.export_project), [fx.A.id]);
    const cols = db.prepare("PRAGMA table_info(user_facts)").all().map((c) => c.name);
    assert.ok(!cols.includes("project_ids") && !cols.includes("projects"), "a fact's project lists never travel");
  } finally {
    db.close();
  }
});

test("a key-shaped lesson stops the export with its row, never its value; --redact cleans only the bundle; the live DB keeps it", async () => {
  const fx = await fixture();
  const out = sink();
  const err = sink();
  const code = await cmdState(["export", "--out", path.join(fx.root, "k.adstate"), "--project", fx.A.dir], { out, err, env: fx.env });
  assert.equal(code, 1);
  assert.match(err.text, /learnings #\d+ \(text\): looks like openai-key/);
  assert.match(err.text, /Export stopped: 1 item looks like a key/);
  assert.equal((out.text + err.text).includes(fx.KEYISH), false, "the value is never printed");
  assert.equal(fs.existsSync(path.join(fx.root, "k.adstate")), false, "no bundle");
  assert.equal(fs.readdirSync(path.join(fx.ad, "exports")).length, 0, "no staging left");
  const ok = await cmdState(["export", "--out", path.join(fx.root, "k.adstate"), "--project", fx.A.dir, "--redact"], { out: sink(), err: sink(), env: fx.env });
  assert.equal(ok, 0);
  const raw = gunzipSync(fs.readFileSync(path.join(fx.root, "k.adstate")));
  assert.equal(raw.includes(Buffer.from(fx.KEYISH)), false, "not even in a freed page");
  assert.equal(raw.includes(Buffer.from("[redacted:openai-key]")), true);
  const live = await openDatabase(path.join(fx.ad, "episodic.db"));
  assert.equal(live.prepare("SELECT COUNT(*) AS n FROM learnings WHERE text LIKE ?").get(`%${fx.KEYISH}%`).n, 1, "your own copy is unchanged");
  live.close();
});

test("a key inside a long value (longer than a page) is still found", async () => {
  const fx = await fixture({ keyish: false });
  const db = await openDatabase(path.join(fx.ad, "episodic.db"));
  db.prepare("INSERT INTO learnings (project_slug, project_id, category, text, status, content_hash) VALUES (?, ?, 'pattern', ?, 'active', 'long1')").run(fx.A.slug, fx.A.id, `${"x ".repeat(5000)}${fx.KEYISH}${" y".repeat(5000)}`);
  db.close();
  await assert.rejects(runExport({ out: path.join(fx.root, "l.adstate"), env: fx.env, dirs: [fx.A.dir] }), (e) => e.code === "EXPORT_SECRETS" && e.hits.length === 1);
});

test("secrets never travel: the secret store's value, the salt and credentials appear in no entry and no output", async () => {
  const fx = await fixture({ keyish: false });
  const out = sink();
  const code = await cmdState(["export", "--out", path.join(fx.root, "s.adstate"), "--all-projects"], { out, err: sink(), env: fx.env });
  assert.equal(code, 0);
  const raw = gunzipSync(fs.readFileSync(path.join(fx.root, "s.adstate")));
  for (const s of [fx.SECRET, "SALTSALT", "acct-work\""]) assert.equal(raw.includes(Buffer.from(s)), false, s);
  const reg = JSON.parse(entriesOf(path.join(fx.root, "s.adstate")).find((e) => e.name === "global/accounts/registry.json").data);
  assert.deepEqual([reg.accounts[0].credential, reg.accounts[0].status], [null, "needs-sign-in"]);
  assert.match(out.text, /This file is not encrypted/);
  assert.match(out.text, /account list \(1 account: sign in again after import\)/);
  const r = await cmdState(["export", "--out", path.join(fx.root, "x.adstate"), "--include", "secrets"], { out: sink(), err: sink(), env: fx.env });
  assert.equal(r, 2);
});

test("names: a reserved name and a case collision are reported at plan time with their paths; an NFD name goes in as NFC", async () => {
  const fx = await fixture({ keyish: false });
  const mem = path.join(fx.A.dir, ".agent-daemon", "memory");
  fs.writeFileSync(path.join(mem, "aux.md"), "x");
  fs.writeFileSync(path.join(mem, "é.md"), "nfd");
  const plan = planExport({ dirs: [fx.A.dir], env: fx.env });
  assert.ok(plan.problems.some((p) => p.path.endsWith("aux.md") && /device name/.test(p.why)));
  assert.ok(plan.files.some((f) => f.name.endsWith("é.md")), "NFC");
  fs.rmSync(path.join(mem, "aux.md"));
  if (process.platform !== "win32" && process.platform !== "darwin") {
    fs.writeFileSync(path.join(mem, "Notes.md"), "a");
    assert.ok(planExport({ dirs: [fx.A.dir], env: fx.env }).problems.some((p) => /only by case/.test(p.why)));
  }
});

test("refusals: an agent's shell, an existing --out, an unknown project; inspect lists without writing; verify passes a fresh bundle and catches a changed one", async () => {
  const fx = await fixture({ keyish: false });
  const err = sink();
  assert.equal(await cmdState(["export", "--out", path.join(fx.root, "t.adstate")], { out: sink(), err, env: { ...fx.env, AD_TOOL_SHELL: "1" }, cwd: fx.A.dir }), 2);
  assert.match(err.text, new RegExp(EXPORT_TEXTS.TOOL_SHELL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const out = sink();
  assert.equal(await cmdState(["inspect"], { out, err: sink(), env: fx.env, cwd: fx.A.dir }), 0);
  assert.match(out.text, /Projects: app-a/);
  assert.match(out.text, /Not included: .*machine-local/);
  assert.equal(fs.existsSync(path.join(fx.ad, "exports")), false, "inspect writes nothing");
  assert.equal(await cmdState(["export", "--out", path.join(fx.root, "t.adstate")], { out: sink(), err: sink(), env: fx.env, cwd: fx.A.dir }), 0);
  const e2 = sink();
  assert.equal(await cmdState(["export", "--out", path.join(fx.root, "t.adstate")], { out: sink(), err: e2, env: fx.env, cwd: fx.A.dir }), 2);
  assert.match(e2.text, /already exists/);
  assert.equal(await cmdState(["export", "--out", path.join(fx.root, "u.adstate"), "--project", path.join(fx.root, "nowhere")], { out: sink(), err: sink(), env: fx.env }), 2);
  const v = sink();
  assert.equal(await cmdState(["verify", path.join(fx.root, "t.adstate")], { out: v, err: sink(), env: fx.env }), 0);
  assert.match(v.text, /no problem found/);
  // One byte changed inside an entry: verify names it.
  const entries = entriesOf(path.join(fx.root, "t.adstate"));
  const { writeArchive } = await import("../src/portability/archive.mjs");
  const bad = writeArchive(entries.map((e) => (e.name === "global/tui/prefs.json" ? { name: e.name, data: Buffer.from("{}") } : e.dir ? { name: e.name, dir: true } : { name: e.name, data: e.data })));
  assert.ok(verifyBundle(bad).problems.some((p) => /prefs\.json doesn't match/.test(p)));
});

test("two exports of an unchanged home hold the same files with the same hashes", async () => {
  const fx = await fixture({ keyish: false });
  const a = await runExport({ out: path.join(fx.root, "1.adstate"), env: fx.env, dirs: [fx.A.dir] });
  const b = await runExport({ out: path.join(fx.root, "2.adstate"), env: fx.env, dirs: [fx.A.dir] });
  const h = (m) => m.files.filter((f) => f.path !== "global/episodic.db").map((f) => `${f.path}:${f.sha256}`);
  assert.deepEqual(h(a.manifest), h(b.manifest));
  assert.deepEqual(a.manifest.db[0].tables, b.manifest.db[0].tables);
});

test("a link inside a project's memory is skipped and reported, never followed", async (t) => {
  const fx = await fixture({ keyish: false });
  try {
    fs.symlinkSync(fx.B.dir, path.join(fx.A.dir, ".agent-daemon", "memory", "b-link"), "junction");
  } catch {
    return t.skip("links can't be made here");
  }
  const plan = planExport({ dirs: [fx.A.dir], env: fx.env });
  assert.ok(plan.skipped.some((s) => s.path.endsWith("b-link") && /link/.test(s.why)));
  assert.ok(!plan.files.some((f) => f.src.startsWith(fx.B.dir)));
});

test("ad memory redact: refused in an agent's shell and without a terminal; a typed confirmation changes only the matched span", async () => {
  const fx = await fixture();
  const dbPath = path.join(fx.ad, "episodic.db");
  const db = await openDatabase(dbPath);
  const id = db.prepare("SELECT id FROM learnings WHERE text LIKE ?").get(`%${fx.KEYISH}%`).id;
  db.close();
  const ref = `learnings:${id}`;
  assert.equal(await cmdMemoryRedact(ref, { env: { AD_TOOL_SHELL: "1" }, out: sink(), err: sink(), isTTY: true, dbPath }), 2);
  assert.equal(await cmdMemoryRedact(ref, { env: {}, out: sink(), err: sink(), isTTY: false, dbPath }), 2);
  assert.equal(await cmdMemoryRedact(ref, { env: {}, out: sink(), err: sink(), isTTY: true, dbPath, ask: async () => "no" }), 1);
  assert.equal(await cmdMemoryRedact(ref, { env: {}, out: sink(), err: sink(), isTTY: true, dbPath, ask: async () => ref }), 0);
  const after = await openDatabase(dbPath);
  assert.equal(after.prepare("SELECT text FROM learnings WHERE id = ?").get(id).text, "the old key was [redacted:openai-key] before rotation");
  after.close();
});

test("a writer adding lessons during the export: the snapshot opens, its integrity is ok, and it holds a prefix of the inserts", async () => {
  const fx = await fixture({ keyish: false });
  const { spawn } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const driver = pathToFileURL(path.resolve("src/memory/driver.mjs")).href;
  const script = `const { openDatabase } = await import(${JSON.stringify(driver)});
const db = await openDatabase(${JSON.stringify(path.join(fx.ad, "episodic.db"))});
for (let i = 0; i < 300; i++) { db.prepare("INSERT INTO learnings (project_slug, project_id, category, text, status, content_hash) VALUES (?, ?, 'pattern', ?, 'active', ?)").run(${JSON.stringify(fx.A.slug)}, ${JSON.stringify(fx.A.id)}, "writer " + i, "w" + i); await new Promise((r) => setTimeout(r, 2)); }
db.close();`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
  const done = new Promise((r) => child.on("close", r));
  await new Promise((r) => setTimeout(r, 150));
  const r = await runExport({ out: path.join(fx.root, "w.adstate"), env: fx.env, dirs: [fx.A.dir] });
  await done;
  assert.equal(r.manifest.db[0].integrity, "ok");
  const db = await snapshotOf(r.out, fx.root);
  const texts = db.prepare("SELECT text FROM learnings WHERE text LIKE 'writer %'").all().map((x) => Number(x.text.split(" ")[1])).sort((a, b) => a - b);
  db.close();
  assert.deepEqual(texts, texts.map((_, i) => i), "a prefix: 0..k with no gap");
});

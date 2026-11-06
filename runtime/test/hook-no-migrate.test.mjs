// L2 part 3: the hook dispatcher never migrates the memory store (02 §3).
// It reads the schema version read-only first: on an older (or missing)
// store it only journals and starts the upgrade detached, once; on a newer
// one it only journals; the journal drain waits for a store it may open.
// Temp homes and AD_ROOT only; no host runs.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { open, schemaState, SCHEMA_VERSION } from "../src/memory/sqlite.mjs";
import { deferStore, MIGRATE_JOB } from "../src/memory/no-migrate.mjs";
import { HOOK_PATH } from "../src/hooks/routes.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ad-nomig-"));
// Anything this process does through adRoot() (a log line, a job marker) lands in a temp root, never the user's.
process.env.AD_ROOT = tmp();
after(() => fs.rmSync(process.env.AD_ROOT, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }));

/** A store at `version`: built current, then its version rows rewritten. */
async function storeAt(dbPath, version) {
  const db = await open({ dbPath, noMigrate: false });
  if (version < SCHEMA_VERSION) db.raw.exec(`DELETE FROM schema_version WHERE version > ${version}`);
  if (version > SCHEMA_VERSION) db.raw.exec(`INSERT INTO schema_version (version) VALUES (${version})`);
  db.close();
}

// The store's version, read only: nothing started, nothing logged.
const versionOf = async (dbPath) => (await schemaState(dbPath)).version;

function setup() {
  const home = tmp();
  const root = path.join(home, "ad-root");
  const project = path.join(home, "work", "app");
  fs.mkdirSync(path.join(project, ".agent-daemon", "memory"), { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  return { home, root, project, dbPath: path.join(root, "episodic.db"), journal: path.join(project, ".agent-daemon", "learning-journal.jsonl") };
}

function runHook(event, payload, { home, root }) {
  // No digest sweep: session.start starts one detached, outside the hook, where upgrading
  // the store and draining is allowed; here only the hook's own behaviour is under test.
  const env = { ...process.env, HOME: home, USERPROFILE: home, AD_ROOT: root, AGENT_DAEMON_DISABLE_SWEEP: "1" };
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_PROJECT_DIR", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED", "AD_WORKER", "AD_HOOK_HOST", "AD_MEMORY_DB", "AD_HOOK_NO_MIGRATE"]) delete env[k];
  return spawnSync(process.execPath, [HOOK_PATH, event], { input: JSON.stringify(payload), env, encoding: "utf8", timeout: 60_000 });
}

// A fresh single-flight marker: the hook believes an upgrade just started, so it starts none.
const holdUpgrade = (root) => {
  fs.mkdirSync(path.join(root, "hooks", "jobs"), { recursive: true });
  fs.writeFileSync(path.join(root, "hooks", "jobs", "migrate.started"), "test");
};
// The journal's text; when it is missing, what the project and ad folders hold instead (a diagnosis, not a pass).
function journalText(s) {
  try {
    return fs.readFileSync(s.journal, "utf8");
  } catch (e) {
    const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? walk(path.join(d, x.name)) : [path.relative(s.home, path.join(d, x.name))])) : []);
    throw new Error(`${e.code}: no journal; files: ${walk(s.home).join(", ")}; log: ${log(s.root)}`);
  }
}

const log = (root) => {
  try {
    return fs.readFileSync(path.join(root, "hooks", "hook.log"), "utf8");
  } catch {
    return "";
  }
};

test("schemaState reads the version without changing the store", async () => {
  const { home, dbPath } = setup();
  try {
    assert.deepEqual(await schemaState(dbPath), { state: "missing", version: null, expected: SCHEMA_VERSION });
    assert.ok(!fs.existsSync(dbPath), "reading never creates the store");
    // No driver can create it (none loads, or the one AD_SQLITE_DRIVER names doesn't): not "missing",
    // so no upgrade job starts and the drain goes to the markdown memory as before.
    assert.equal((await schemaState(dbPath, { drivers: [] })).error, "no SQLite driver");
    assert.equal((await schemaState(dbPath, { drivers: ["better-sqlite3"], env: { AD_SQLITE_DRIVER: "node:sqlite" } })).state, "unreadable");
    assert.equal((await schemaState(dbPath, { drivers: ["better-sqlite3"], env: {} })).state, "missing");
    await storeAt(dbPath, SCHEMA_VERSION);
    assert.equal((await schemaState(dbPath)).state, "current");
    await storeAt(dbPath, 3);
    assert.deepEqual(await schemaState(dbPath), { state: "older", version: 3, expected: SCHEMA_VERSION });
    const before = fs.statSync(dbPath).mtimeMs;
    await schemaState(dbPath);
    assert.equal(fs.statSync(dbPath).mtimeMs, before);
    await storeAt(dbPath, 99);
    assert.equal((await schemaState(dbPath)).state, "newer");
    const junk = path.join(home, "junk.db");
    fs.writeFileSync(junk, "not a database at all, just text that is long enough to have a header");
    assert.equal((await schemaState(junk)).state, "unreadable");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("open() in a hook process opens only a store at this ad's version", async () => {
  const { home, dbPath } = setup();
  try {
    const spawned = [];
    const spawn = (args, o) => (spawned.push([args, o.key]), true);
    await storeAt(dbPath, 3);
    assert.equal(await open({ dbPath, noMigrate: true, defer: (s) => deferStore(s, { dbPath, spawn, log: () => {} }) }), null);
    assert.equal((await schemaState(dbPath)).version, 3, "not migrated");
    assert.deepEqual(spawned, [[[MIGRATE_JOB, dbPath], "migrate"]], "the upgrade starts detached");
    await storeAt(dbPath, 99);
    spawned.length = 0;
    assert.equal(await open({ dbPath, noMigrate: true, defer: (s) => deferStore(s, { dbPath, spawn, log: () => {} }) }), null);
    assert.deepEqual(spawned, [], "a newer store: no upgrade from an older ad");
    const missing = path.join(home, "none", "episodic.db");
    assert.equal(await open({ dbPath: missing, noMigrate: true, defer: () => {} }), null);
    assert.ok(!fs.existsSync(path.dirname(missing)), "nothing is created");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("spawned prompt.submit on an older store: the capture is journaled, the store isn't migrated by the hook", async () => {
  const s = setup();
  try {
    await storeAt(s.dbPath, 4);
    holdUpgrade(s.root);
    const r = runHook("prompt.submit", { session_id: "s1", cwd: s.project, prompt: "actually we use pnpm in this repo", hook_event_name: "UserPromptSubmit" }, s);
    assert.equal(r.status, 0, r.stderr);
    assert.match(journalText(s), /pnpm/, "the capture waits in the journal");
    assert.equal(await versionOf(s.dbPath), 4, "the hook didn't migrate");
    assert.match(log(s.root), /prompt\.submit .*schema v4, older than this ad's v\d+: an upgrade is already running/);
    // session.start: the drain waits too (it would need the store), so the journal stays whole.
    const st = runHook("session.start", { session_id: "s2", cwd: s.project }, s);
    assert.equal(st.status, 0, st.stderr);
    assert.match(journalText(s), /pnpm/, "the drain didn't consume the journal");
    assert.equal(await versionOf(s.dbPath), 4);
  } finally {
    fs.rmSync(s.home, { recursive: true, force: true });
  }
});

test("spawned hook on an older store starts the upgrade detached, which brings it to this ad's version", async () => {
  const s = setup();
  try {
    await storeAt(s.dbPath, 4);
    const r = runHook("prompt.submit", { session_id: "s1", cwd: s.project, prompt: "actually we use pnpm in this repo" }, s);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(s.root, "hooks", "jobs", "migrate.started")), "single-flight marker");
    let v = null;
    for (let i = 0; i < 100 && v !== SCHEMA_VERSION; i++) {
      await new Promise((res) => setTimeout(res, 200));
      v = (await schemaState(s.dbPath)).version;
    }
    assert.equal(v, SCHEMA_VERSION, "the detached job upgraded the store");
  } finally {
    fs.rmSync(s.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("spawned prompt.submit on a newer store: journal only, no upgrade, the store untouched", async () => {
  const s = setup();
  try {
    await storeAt(s.dbPath, 99);
    const before = fs.statSync(s.dbPath).mtimeMs;
    const r = runHook("prompt.submit", { session_id: "s1", cwd: s.project, prompt: "actually we use pnpm in this repo" }, s);
    assert.equal(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(s.journal, "utf8"), /pnpm/);
    assert.ok(!fs.existsSync(path.join(s.root, "hooks", "jobs", "migrate.started")), "no upgrade from an older ad");
    assert.equal(fs.statSync(s.dbPath).mtimeMs, before);
    assert.match(log(s.root), /newer than this ad's/);
  } finally {
    fs.rmSync(s.home, { recursive: true, force: true });
  }
});

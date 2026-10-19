// P5.3: memory/driver.mjs — node:sqlite behind the slice of better-sqlite3's
// API the memory store uses, so the memory package needs no native build.
// Every case runs on each driver that loads here.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { availableDrivers, openDatabase, wrapNodeSqlite } from "../src/memory/driver.mjs";

const drivers = await availableDrivers();
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ad-driver-")), "t.db");
const env = (d) => ({ AD_SQLITE_DRIVER: d });

test("node:sqlite is available on this Node (the memory package's driver)", () => {
  assert.ok(drivers.includes("node:sqlite"), `drivers: ${drivers}`);
});

for (const d of drivers) {
  test(`${d}: run/get/all, plain rows, undefined binds as NULL`, async () => {
    const db = await openDatabase(":memory:", { env: env(d) });
    assert.equal(db.driver, d);
    db.exec("CREATE TABLE t (a INTEGER, b TEXT)");
    const r = db.prepare("INSERT INTO t VALUES (?, ?)").run(1, "x");
    assert.equal(r.changes, 1);
    assert.equal(Number(r.lastInsertRowid), 1);
    const row = db.prepare("SELECT a, b FROM t").get();
    assert.deepEqual(row, { a: 1, b: "x" }, "a plain object");
    assert.equal(Object.getPrototypeOf(row), Object.prototype);
    assert.equal(db.prepare("SELECT a FROM t WHERE a = ?").get(99), undefined);
    if (d === "node:sqlite") {
      db.prepare("INSERT INTO t VALUES (?, ?)").run(2, undefined);
      assert.equal(db.prepare("SELECT b FROM t WHERE a = 2").get().b, null);
    }
    assert.deepEqual(db.prepare("SELECT a FROM t ORDER BY a").all().map((x) => x.a).slice(0, 1), [1]);
    db.close();
  });

  test(`${d}: transactions commit, roll back, nest, and pass arguments and results`, async () => {
    const db = await openDatabase(tmp(), { env: env(d) });
    db.exec("CREATE TABLE t (a INTEGER)");
    const ins = db.prepare("INSERT INTO t VALUES (?)");
    assert.equal(db.transaction((x) => (ins.run(x), x * 2))(1), 2);
    assert.throws(() => db.transaction(() => {
      ins.run(2);
      throw new Error("boom");
    })(), /boom/);
    // Nested: the inner failure rolls back only the inner part.
    db.transaction(() => {
      ins.run(3);
      try {
        db.transaction(() => {
          ins.run(4);
          throw new Error("inner");
        })();
      } catch {
        // expected
      }
      ins.run(5);
      // A nested transaction that succeeds keeps its rows.
      db.transaction(() => ins.run(6))();
    }).immediate();
    assert.deepEqual(db.prepare("SELECT a FROM t ORDER BY a").all().map((x) => x.a), [1, 3, 5, 6]);
    db.close();
  });
}

test("node:sqlite: a locked database throws code SQLITE_BUSY, as better-sqlite3 names it", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const file = tmp();
  const a = wrapNodeSqlite(new DatabaseSync(file, { timeout: 0 }));
  const b = wrapNodeSqlite(new DatabaseSync(file, { timeout: 0 }));
  a.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (a)");
  a.exec("BEGIN IMMEDIATE");
  assert.throws(() => b.transaction(() => b.prepare("INSERT INTO t VALUES (1)").run())(), (e) => e.code === "SQLITE_BUSY");
  a.exec("ROLLBACK");
  a.close();
  b.close();
});

test("AD_SQLITE_DRIVER picks the driver, and only that one", async () => {
  const db = await openDatabase(":memory:", { env: env("node:sqlite") });
  assert.equal(db.driver, "node:sqlite");
  // Concurrent writers wait up to 5 s on every Node version (the open option is newer than 22.13).
  assert.equal(Object.values(db.prepare("PRAGMA busy_timeout").get())[0], 5000);
  db.close();
  const pref = await openDatabase(":memory:", { prefer: "node:sqlite", env: {} });
  assert.equal(pref.driver, "node:sqlite");
  pref.close();
});

test("the memory store opens on node:sqlite: schema, migrations, search", async () => {
  const sqlite = await import("../src/memory/sqlite.mjs");
  const handle = await sqlite.open({ dbPath: tmp(), prefer: "node:sqlite" });
  if (process.env.AD_SQLITE_DRIVER && process.env.AD_SQLITE_DRIVER !== "node:sqlite") return handle.close();
  assert.equal(handle.driver, "node:sqlite");
  handle.run("INSERT INTO learnings (category, text, content_hash) VALUES ('tool', 'we deploy with dockers compose', 'x1')");
  const hits = handle.all("SELECT l.id, -bm25(learnings_fts) AS s FROM learnings_fts JOIN learnings l ON l.id = learnings_fts.rowid WHERE learnings_fts MATCH ?", ['"docker"']);
  assert.equal(hits.length, 1, "porter stemming");
  assert.ok(handle.get("SELECT version FROM schema_version WHERE version = 2"));
  handle.close();
});

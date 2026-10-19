// Every dev family's oracle flags its violating example, passes its compliant
// one, and sees no opportunity in an untouched fixture.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSplit, BENCH_DIR } from "../lib/family.mjs";
import { changes, resetFixture, writeFiles, addedLines } from "../lib/fixture.mjs";
import { globToRegExp, runOracle } from "../lib/oracle.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bench-oracle-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const split = loadSplit("dev");

test("the dev split has 12 families, each with phrasings", () => {
  assert.equal(split.length, 12);
  for (const { family, phrasings } of split) {
    assert.equal(family.split, "dev");
    assert.ok(phrasings.length >= 5, `${family.id}: ${phrasings.length} phrasings`);
    assert.ok(family.sessions.length >= 3, `${family.id}: session 1 plus at least two later ones`);
  }
});

for (const { family, dir } of split) {
  test(`oracle ${family.id}: violating → violated, compliant → passes, untouched → no opportunity`, () => {
    const work = path.join(TMP, family.id);
    const src = path.join(BENCH_DIR, "repos", family.sessions[0].fixture);
    const run = (files) => {
      const before = resetFixture(src, work);
      writeFiles(work, files);
      return runOracle(family.oracle, changes(before, work), { dir: work, familyDir: dir });
    };
    const bad = run(family.examples.violating);
    assert.equal(bad.opportunity, true, `${family.id} violating: ${JSON.stringify(bad)}`);
    assert.equal(bad.violated, true, `${family.id} violating: ${JSON.stringify(bad)}`);
    const good = run(family.examples.compliant);
    assert.equal(good.opportunity, true, `${family.id} compliant: ${JSON.stringify(good)}`);
    assert.equal(good.violated, false, `${family.id} compliant: ${JSON.stringify(good)}`);
    assert.equal(run({}).violated, false);
    if (family.oracle.kind !== "file" || family.oracle.opportunity) assert.equal(run({}).opportunity, false, `${family.id}: an untouched fixture is no opportunity`);
  });
}

test("globs: ** spans folders, * stays in one", () => {
  assert.ok(globToRegExp("src/**/*.js").test("src/a.js"));
  assert.ok(globToRegExp("src/**/*.js").test("src/routes/x/a.js"));
  assert.ok(!globToRegExp("src/*.js").test("src/routes/a.js"));
  assert.ok(globToRegExp("**/__tests__/**").test("src/__tests__/a.js"));
  assert.ok(!globToRegExp("test/**").test("spec/test.js"));
  assert.ok(globToRegExp("a.b").test("a.b") && !globToRegExp("a.b").test("axb"));
});

test("only added lines count: an existing line moved is not new, and an edit's old text is not scanned", () => {
  assert.deepEqual(addedLines("a\nb\nc", "c\na\nb"), []);
  assert.deepEqual(addedLines("a\nconsole.log(1)", "a\nlogInfo(1)"), ["logInfo(1)"]);
  const o = { kind: "grep", files: ["src/**/*.js"], forbid: ["console\\.log\\("] };
  assert.equal(runOracle(o, [{ path: "src/a.js", status: "modified", added: ["logInfo(1)"] }], {}).violated, false);
  assert.equal(runOracle(o, [{ path: "docs/a.js", status: "added", added: ["console.log(1)"] }], {}).opportunity, false);
});

test("a deleted generated file is a change; the logger's own file may use the console", () => {
  const gen = split.find((s) => s.family.id === "generated").family.oracle;
  assert.equal(runOracle(gen, [{ path: "src/generated/client.js", status: "deleted", added: [] }, { path: "schema/api.yml", status: "modified", added: ["x"] }], {}).violated, true);
  const log = split.find((s) => s.family.id === "logger").family.oracle;
  assert.equal(runOracle(log, [{ path: "src/lib/log.js", status: "modified", added: ["console.log(x)"] }], {}).opportunity, false);
  assert.equal(runOracle(log, [{ path: "src/lib/other.js", status: "modified", added: ["console.log(x)"] }], {}).violated, true);
});

test("review: comments, success statuses and look-alike names are not violations; .mjs files, stray tests and other date/money forms are", () => {
  const o = (id) => split.find((s) => s.family.id === id).family.oracle;
  const one = (id, p, line) => runOracle(o(id), [{ path: p, status: "added", added: [line] }], { dir: TMP, familyDir: "" });
  // a rule restated in a comment
  assert.equal(one("logger", "src/a.js", "logInfo(x); // use logInfo, never console.log( here").violated, false);
  assert.equal(one("logger", "src/a.js", "/* not console.log(x) */ logInfo(x)").violated, false);
  assert.equal(one("logger", "src/a.js", " * console.log is banned").violated, false);
  assert.equal(one("logger", "src/a.js", 'logInfo("see // console.log(") ; console.log(1)').violated, true, "code after a string holding // still counts");
  assert.equal(one("ids", "src/a.js", "const uuid = newId(\"cart\"); // not a uuid").violated, false);
  assert.equal(one("ids", "src/a.js", 'import { v4 } from "uuid";').violated, true);
  // statuses
  assert.equal(one("error-envelope", "src/routes/a.js", "return res.status(200).json(order);").violated, false);
  assert.equal(one("error-envelope", "src/routes/a.js", "res.statusCode = 409;").violated, true);
  // file types and places
  assert.equal(one("logger", "src/orders.mjs", "console.log(1)").violated, true);
  for (const p of ["users.spec.js", "lib/users.spec.js", "src/users.spec.mjs", "test/users.test.js"]) assert.equal(one("test-layout", p, "test()").violated, true, p);
  assert.equal(one("test-layout", "spec/users.spec.js", "test()").violated, false);
  // other forms of the same mistake
  assert.equal(one("dates", "src/a.js", "new Intl.DateTimeFormat('en').format(d)").violated, true);
  assert.equal(one("money", "src/a.js", "const cents = +amountText * 100;").violated, true);
  assert.equal(one("money", "src/a.js", "const total = Money.cents(a) + Money.cents(b);").violated, false);
});

test("no opportunity, no violation: a change outside what the rule governs is never scored", () => {
  const o = { kind: "file", opportunity: ["schema/**"], unchanged: ["src/generated/**"] };
  const r = runOracle(o, [{ path: "src/generated/client.js", status: "modified", added: ["x"] }], {});
  assert.deepEqual([r.opportunity, r.violated], [false, false]);
});

test("stripComments keeps strings and code, drops comments", async () => {
  const { stripComments } = await import("../lib/oracle.mjs");
  assert.equal(stripComments('fetch("http://x") // call'), 'fetch("http://x") ');
  assert.equal(stripComments("a /* b */ c"), "a  c");
  assert.equal(stripComments("'it\\'s // fine' + x"), "'it\\'s // fine' + x");
  // a block comment's inner line, but not code continuing on a new line
  assert.equal(stripComments("   * console.log is banned"), "");
  assert.equal(stripComments("   */"), "");
  assert.equal(stripComments("    * 100);"), "    * 100);");
});

test("a command oracle must live in its family folder", () => {
  assert.throws(() => runOracle({ kind: "command", script: "../logger/x.mjs" }, [], { dir: TMP, familyDir: path.join(BENCH_DIR, "tasks", "dev", "changelog") }), /outside its family/);
});

test("a family with a bad pattern, a missing fixture or a writer's name fails to load", async () => {
  const { validateFamily, validatePhrasings } = await import("../lib/family.mjs");
  const base = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, "tasks", "dev", "logger", "family.json"), "utf8"));
  assert.throws(() => validateFamily({ ...base, oracle: { ...base.oracle, forbid: ["("] } }), /bad pattern/);
  assert.throws(() => validateFamily({ ...base, sessions: [{ fixture: "nope", task: "x" }, { fixture: "nope", task: "y" }] }), /no repos\/nope/);
  assert.throws(() => validatePhrasings({ family: "logger", phrasings: [{ id: "x", text: "y", writer: "Sam Lee" }] }, base), /never a name/);
});

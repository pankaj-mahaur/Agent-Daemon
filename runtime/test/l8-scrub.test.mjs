// L8 P6 (design decision 16): after a forget for good, the note's words (and the words it
// replaced) leave the journals and proposal files; nothing else does.
//   - journal lines whose text or evidence carries the words are dropped; every other line
//     stays byte-identical; a short note matches only its own normalised words;
//   - a proposal file keeps its other lines (the matching one becomes "[forgotten]"); a
//     skill diff is never touched;
//   - a git-tracked file and a drain's file in use are reported, not changed;
//   - every forget path runs it (review-service forgetAccepted), with the replaced words too.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = mkdtempSync(path.join(tmpdir(), "ad-l8-scrub-"));
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
for (const k of ["AD_ROOT", "AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL"]) delete process.env[k];

const { open, normKey } = await import("../src/memory/sqlite.mjs");
const svc = await import("../src/memory/review-service.mjs");
const S = await import("../src/memory/scrub.mjs");
const { testReviewToken } = await import("../testkit/memory-trust.mjs");

const opened = [];
after(() => {
  for (const h of opened) {
    try {
      h.close();
    } catch {
      // closed already
    }
  }
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

let n = 0;
async function store() {
  const dir = path.join(ROOT, `db-${++n}`);
  mkdirSync(dir, { recursive: true });
  const h = await open({ dbPath: path.join(dir, "episodic.db") });
  opened.push(h);
  return h;
}
const line = (o) => JSON.stringify(o);
function folder() {
  const dir = path.join(ROOT, `cap-${++n}`, ".agent-daemon");
  mkdirSync(path.join(dir, "proposed"), { recursive: true });
  mkdirSync(path.join(dir, "applied"), { recursive: true });
  return dir;
}
const GLOBAL = path.join(ROOT, "global-proposed");
mkdirSync(GLOBAL, { recursive: true });

test("journals lose the lines whose note carries the words; other lines stay byte-identical", () => {
  const dir = folder();
  const keep1 = line({ text: "always use pnpm in CI for speed", ts: 1 });
  const keep2 = line({ text: "run the linter", evidence: "you said so" });
  const body = [line({ text: "Use pnpm.", ts: 2 }), keep1, line({ text: "something else", evidence: "quote: never deploy on fridays without a rollback plan ready" }), keep2, "not json but fine", ""].join("\n");
  writeFileSync(path.join(dir, "learning-journal.jsonl"), body);
  writeFileSync(path.join(dir, "learning-journal.archive.jsonl"), `${keep1}\n`);
  const r = S.scrubForgotten(null, ["use pnpm", "Never deploy on Fridays without a rollback plan ready"], { dirs: [dir], globalDir: GLOBAL });
  assert.deepEqual(r.changed, [path.join(dir, "learning-journal.jsonl")]);
  // The line whose prompt quoted the words keeps its own note; its evidence is blanked.
  assert.equal(readFileSync(path.join(dir, "learning-journal.jsonl"), "utf8"), [keep1, line({ text: "something else", evidence: "[forgotten]" }), keep2, "not json but fine", ""].join("\n"));
  assert.equal(readFileSync(path.join(dir, "learning-journal.archive.jsonl"), "utf8"), `${keep1}\n`, "a short note matches only its own words");
});

test("proposal files keep their other lines; the matching one becomes [forgotten]; a skill diff is never touched", () => {
  const dir = folder();
  const md = "# Proposed learnings\n\n- use pnpm\n- run the linter before commits\n";
  writeFileSync(path.join(dir, "proposed", "memory-add-1.md"), md);
  const diff = "--- a/SKILL.md\n+++ b/SKILL.md\n+- use pnpm\n";
  writeFileSync(path.join(dir, "proposed", "skill-1.diff"), diff);
  writeFileSync(path.join(dir, "applied", "x.json"), JSON.stringify({ text: "use pnpm" }, null, 2));
  writeFileSync(path.join(GLOBAL, "g.md"), "text: use pnpm\n");
  const r = S.scrubForgotten(null, ["use pnpm"], { dirs: [dir], globalDir: GLOBAL });
  assert.equal(readFileSync(path.join(dir, "proposed", "memory-add-1.md"), "utf8"), "# Proposed learnings\n\n[forgotten]\n- run the linter before commits\n");
  assert.equal(readFileSync(path.join(dir, "proposed", "skill-1.diff"), "utf8"), diff);
  assert.match(readFileSync(path.join(dir, "applied", "x.json"), "utf8"), /\[forgotten\]/);
  assert.equal(readFileSync(path.join(GLOBAL, "g.md"), "utf8"), "[forgotten]\n");
  assert.equal(r.changed.length, 3);
});

test("a git-tracked file and a drain's file still in use are reported, not changed", () => {
  const dir = folder();
  const j = path.join(dir, "learning-journal.jsonl");
  const d = path.join(dir, "learning-journal.draining-123.jsonl");
  const body = `${line({ text: "use pnpm" })}\n`;
  writeFileSync(j, body);
  writeFileSync(d, body);
  const r = S.scrubForgotten(null, ["use pnpm"], { dirs: [dir], globalDir: GLOBAL, tracked: (f) => f === j });
  assert.deepEqual(r.left.sort(), [d, j].sort());
  assert.equal(readFileSync(j, "utf8"), body);
  assert.equal(readFileSync(d, "utf8"), body);
  // An hour-old orphaned drain file is scrubbed.
  const old = (Date.now() - 2 * 3_600_000) / 1000;
  utimesSync(d, old, old);
  assert.deepEqual(S.scrubForgotten(null, ["use pnpm"], { dirs: [dir], globalDir: GLOBAL, tracked: () => false }).left, []);
});

test("every forget for good scrubs, with the words the note replaced (an edit, then ad review's forget)", async () => {
  const h = await store();
  const cwd = path.join(ROOT, "shop");
  mkdirSync(path.join(cwd, ".agent-daemon"), { recursive: true });
  h.run("INSERT INTO sessions (id, project_slug, project_path, started_at) VALUES ('s1', '-shop', ?, '2026-11-10')", [cwd]);
  const id = Number(h.run("INSERT INTO learnings (project_slug, category, text, confidence, status, content_hash, norm_key) VALUES ('-shop', 'correction', 'never commit the generated api client by hand', 0.7, 'pending', 'h1', ?)", [normKey("never commit the generated api client by hand")]).lastInsertRowid);
  svc.acceptLearning(h, testReviewToken(), id);
  const ed = await svc.editLearning(h, testReviewToken(), id, "never edit the generated api client by hand", { keys: ["-shop"] });
  assert.equal(ed.status, "replaced");
  const journal = path.join(cwd, ".agent-daemon", "learning-journal.jsonl");
  const other = line({ text: "use pnpm" });
  writeFileSync(journal, [line({ text: "never commit the generated api client by hand" }), line({ text: "Never edit the generated API client by hand." }), other, ""].join("\n"));
  let seen = null;
  assert.ok(svc.forgetAccepted(h, testReviewToken(), ed.newId, { onScrub: (x) => (seen = x), tracked: () => false }));
  assert.equal(readFileSync(journal, "utf8"), `${other}\n`);
  assert.equal(seen.older, 1);
  assert.equal(h.get("SELECT COUNT(*) AS n FROM learnings WHERE text LIKE '%generated api client%'").n, 0);
});

test("a line whose prompt only quotes the words keeps its own note; another project's files are never touched", async () => {
  const dir = folder();
  const j = path.join(dir, "learning-journal.jsonl");
  writeFileSync(j, `${line({ text: "commit small and often", evidence: "never deploy on fridays without a rollback plan; commit small and often" })}\n`);
  S.scrubForgotten(null, ["never deploy on fridays without a rollback plan"], { dirs: [dir], globalDir: GLOBAL });
  assert.deepEqual(JSON.parse(readFileSync(j, "utf8")), { text: "commit small and often", evidence: "[forgotten]" });
  // Scoped by project: only folders of sessions in this project.
  const h = await store();
  const mine = path.join(ROOT, "mine");
  const theirs = path.join(ROOT, "theirs");
  for (const p of [mine, theirs]) mkdirSync(path.join(p, ".agent-daemon"), { recursive: true });
  h.run("INSERT INTO sessions (id, project_slug, project_path, started_at) VALUES ('a', '-mine', ?, '2026-11-10'), ('b', '-theirs', ?, '2026-11-10')", [mine, theirs]);
  const body = `${line({ text: "use pnpm" })}\n`;
  for (const p of [mine, theirs]) writeFileSync(path.join(p, ".agent-daemon", "learning-journal.jsonl"), body);
  S.scrubForgotten(h, ["use pnpm"], { project: { slug: "-mine", id: null }, globalDir: GLOBAL });
  assert.equal(readFileSync(path.join(mine, ".agent-daemon", "learning-journal.jsonl"), "utf8"), "");
  assert.equal(readFileSync(path.join(theirs, ".agent-daemon", "learning-journal.jsonl"), "utf8"), body);
});

test("real journal lines (evidence_quote, as the extractor writes them); a project with no session row is still scrubbed", async () => {
  const h = await store();
  const cwd = path.join(ROOT, "nosession");
  mkdirSync(path.join(cwd, ".agent-daemon"), { recursive: true });
  const id = Number(h.run("INSERT INTO learnings (project_slug, project_path, category, text, confidence, status, content_hash, norm_key) VALUES ('-nosession', ?, 'correction', 'never deploy on fridays without a rollback plan', 0.7, 'pending', 'h-ns', ?)", [cwd, normKey("never deploy on fridays without a rollback plan")]).lastInsertRowid);
  svc.acceptLearning(h, testReviewToken(), id);
  const j = path.join(cwd, ".agent-daemon", "learning-journal.jsonl");
  writeFileSync(j, [
    line({ text: "never deploy on fridays without a rollback plan", evidence_quote: "x", confidence: 0.7 }),
    line({ text: "commit small and often", evidence_quote: "never deploy on fridays without a rollback plan; commit small and often", confidence: 0.7 }),
    "",
  ].join("\n"));
  assert.ok(svc.forgetAccepted(h, testReviewToken(), id, { tracked: () => false }));
  assert.equal(readFileSync(j, "utf8"), `${line({ text: "commit small and often", evidence_quote: "[forgotten]", confidence: 0.7 })}\n`);
});

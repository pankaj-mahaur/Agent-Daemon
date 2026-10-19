// P5.5: `ad memory report` (memory/report.mjs): exact numbers from a seeded
// store, and --share leaking no project, path, lesson or session. Temp home only.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME = await fs.mkdtemp(path.join(os.tmpdir(), "ad-report-home-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.AD_ROOT = path.join(HOME, ".agent-daemon");
for (const k of ["AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR"]) delete process.env[k];
after(async () => {
  (await import("../src/memory/episodic.mjs")).closeDb();
  await fs.rm(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const ep = await import("../src/memory/episodic.mjs");
const { memoryReport, renderReport } = await import("../src/memory/report.mjs");
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");
const NOW = Date.parse("2026-10-19T12:00:00Z");
const ts = "2026-10-15T00:00:00.000Z";

async function seed(key) {
  const h = await ep.db();
  const id = await ep.insertLearning({ projectSlug: key, category: "correction", text: "keep secrets in C:\\Users\\alice\\vault", origin: "user" });
  const ev = (source, match, injected) => h.run("INSERT INTO correction_events (ts, project_slug, source, matched_learning_id, match_kind, was_injected, capture_ref) VALUES (?, ?, ?, ?, ?, ?, ?)", [ts, key, source, match ? id : null, match, injected, "sess-secret-123"]);
  for (let i = 0; i < 9; i++) ev("hooks", null, null);
  for (let i = 0; i < 2; i++) ev("tools", null, null);
  ev("hooks", "exact", "yes");
  ev("hooks", "similar", "no");
  ev("tools", "exact", "unknown");
  for (const [ref, ids] of [["s1", [id]], ["s2", [id]], ["s3", [id]]]) for (const lid of ids) h.run("INSERT INTO injections (ts, capture_ref, project_slug, learning_id, surface) VALUES (?, ?, ?, ?, 'session-start')", [ts, ref, key, lid]);
  for (const [v, k] of [["useful", 11], ["stale", 2], ["wrong", 1]]) for (let i = 0; i < k; i++) h.run("INSERT INTO feedback (ts, project_slug, learning_id, verdict) VALUES (?, ?, ?, ?)", [ts, key, id, v]);
  for (let i = 0; i < 4; i++) await ep.insertLearning({ projectSlug: key, category: "pattern", text: `pending note number ${i} waiting`, origin: "agent", status: "pending" });
  // Another project's events never count here.
  h.run("INSERT INTO correction_events (ts, project_slug, source) VALUES (?, 'D--work-other', 'hooks')", [ts]);
  return h;
}

test("the report's numbers come from the store, for this project only", async () => {
  const key = "D--work-clientx";
  const h = await seed(key);
  const r = memoryReport(h, { keys: [key], days: 30, now: NOW });
  assert.deepEqual(r.corrections, { total: 14, hooks: 11, tools: 3 });
  assert.equal(r.repeats.total, 3);
  assert.equal(Math.round(r.repeats.rate * 100), 21);
  assert.deepEqual([r.repeats.shownFirst, r.repeats.notShown, r.repeats.unknown], [1, 1, 1]);
  assert.equal(r.shown.sessions, 3);
  assert.equal(r.shown.medianLessons, 1);
  assert.deepEqual([r.feedback.useful, r.feedback.stale, r.feedback.wrong], [11, 2, 1]);
  assert.equal(r.feedback.precision.toFixed(2), "0.79");
  assert.equal(r.waiting, 4);
  const text = renderReport(r);
  assert.match(text, /Corrections captured\s+14\s+\(hooks and digests 11, record tools 3\)/);
  assert.match(text, /Repeated corrections\s+3 \(21%, lower is better\)/);
  assert.match(text, /unknown \(pull or hookless\) 1/);
  assert.match(text, /precision 0\.79/);
  // Older than the window: gone.
  assert.equal(memoryReport(h, { keys: [key], days: 1, now: NOW }).corrections.total, 0);
  // --all-projects sees the other project too.
  assert.equal(memoryReport(h, { keys: null, days: 30, now: NOW }).corrections.total, 15);
});

test("--share leaks no project, path, lesson or session", async () => {
  const key = "D--work-clientx";
  const h = await ep.db();
  const shared = renderReport(memoryReport(h, { keys: [key], days: 30, now: NOW }), { share: true });
  for (const leak of ["alice", "vault", "clientx", "sess-secret", "\\", "/"]) assert.ok(!shared.includes(leak), `--share contains ${leak}:\n${shared}`);
  assert.match(shared, /one project/);
});

test("rows stamped by SQLite (YYYY-MM-DD HH:MM:SS) on the window's first day count", async () => {
  const h = await ep.db();
  const key = "D--work-boundary";
  h.run("INSERT INTO feedback (ts, project_slug, learning_id, verdict) VALUES ('2026-10-12 13:00:00', ?, 1, 'useful')", [key]);
  // The window starts 2026-10-12T12:00:00Z (7 days before NOW): 13:00 that day is inside.
  assert.equal(memoryReport(h, { keys: [key], days: 7, now: NOW }).feedback.useful, 1);
});

test("ad memory report runs from the CLI, with --json", async () => {
  const proj = path.join(HOME, "work", "shop-app");
  await fs.mkdir(path.join(proj, ".git"), { recursive: true });
  const run = (args) =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [CLI, "memory", "report", ...args, "--cwd", proj], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (out += d));
      c.on("close", (code) => resolve({ code, out }));
    });
  const plain = await run([]);
  assert.equal(plain.code, 0, plain.out);
  assert.match(plain.out, /Memory report — last 30 days, this project/);
  const json = await run(["--json", "--days", "7"]);
  assert.equal(JSON.parse(json.out.trim()).days, 7);
  const shared = await run(["--share"]);
  assert.match(shared.out, /one project/);
  assert.ok(!shared.out.includes("shop-app") && !shared.out.includes(HOME));
  // The package's own command.
  const pkg = await new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(path.dirname(CLI), "memory-install", "cli.mjs"), "report", "--share"], { cwd: proj, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code, out }));
  });
  assert.equal(pkg.code, 0);
  assert.match(pkg.out, /Memory report — last 30 days, one project/);
});

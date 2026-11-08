// L1 (MCP launch plan 02 §2.2, invariant 3): only the review service makes a note
// accepted, and only in the user's own terminal. Every other writer stores 'pending'.
// No environment variable stands in for a check.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = mkdtempSync(path.join(tmpdir(), "ad-review-gate-"));
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
for (const k of ["AD_ROOT", "AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL"]) delete process.env[k];

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const svc = await import("../src/memory/review-service.mjs");
const ep = await import("../src/memory/episodic.mjs");
const { acceptedSql } = await import("../src/memory/trust.mjs");

after(() => {
  ep.closeDb();
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const PROJECT = "-work-shop-app";
const terminal = { env: {}, isTTY: () => true, ancestry: () => ({ verdict: "terminal", root: "windowsterminal" }) };

function sources(dir = SRC, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (name.endsWith(".mjs")) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(SRC, p).split(path.sep).join("/");

test("the token: refused in the agent's shell, without a terminal, and under an agent", async () => {
  const never = async () => assert.fail("no dialog for a refused terminal");
  assert.ok((await svc.reviewToken({ ...terminal, env: { AD_TOOL_SHELL: "1" }, dialog: never })).refused);
  assert.ok((await svc.reviewToken({ ...terminal, isTTY: () => false, dialog: never })).refused);
  assert.match((await svc.reviewToken({ ...terminal, ancestry: () => ({ verdict: "agent", agent: "claude" }), dialog: never })).refused, /under an agent \(claude\)/);
  assert.ok((await svc.reviewToken({ ...terminal, dialog: never })).token, "a real terminal needs no code");
});

test("an editor's terminal or a broken chain: a token only with the dialog code typed back", async () => {
  for (const found of [{ verdict: "editor", editor: "zed" }, { verdict: "unknown", why: "no-root" }]) {
    const at = { ...terminal, ancestry: () => found };
    assert.deepEqual(svc.checkReviewToken(at), { needsCode: found }, "the sync check never issues one");
    const asked = [];
    assert.ok((await svc.reviewToken({ ...at, dialog: async (o) => (asked.push(o.found), { ok: true }) })).token);
    assert.deepEqual(asked, [found]);
    assert.equal((await svc.reviewToken({ ...at, dialog: async () => ({ ok: false, text: "the code didn't match" }) })).refused, "the code didn't match");
  }
});

test("no environment variable stands in for the terminal", async () => {
  for (const env of [{ AD_INTERNAL_TEST_CONFIRM: "x" }, { CI: "1" }, { AD_REVIEW_YES: "1" }, { FORCE_TTY: "1" }]) {
    assert.ok((await svc.reviewToken({ ...terminal, env, isTTY: () => false })).refused, JSON.stringify(env));
  }
});

test("an accept without a token, or with a forged one, throws and changes nothing", async () => {
  const h = await ep.db();
  const id = await ep.insertLearning({ projectSlug: PROJECT, category: "correction", text: "use pnpm, never npm", origin: "user" });
  for (const forged of [null, undefined, {}, Object.freeze({ issuedAt: Date.now() })]) {
    assert.throws(() => svc.acceptLearning(h, forged, id), /review token/);
  }
  assert.equal(h.get(`SELECT COUNT(*) AS n FROM learnings WHERE id = ? AND ${acceptedSql()}`, [id]).n, 0);
  svc.acceptLearning(h, (await svc.reviewToken(terminal)).token, id);
  assert.equal(h.get(`SELECT COUNT(*) AS n FROM learnings WHERE id = ? AND ${acceptedSql()}`, [id]).n, 1);
});

test("every writer stores a new note as pending, even when it asks for 'active'", async () => {
  const h = await ep.db();
  const a = await ep.insertLearning({ projectSlug: PROJECT, category: "correction", text: "the user said: yarn only", origin: "user", status: "active" });
  const b = await ep.insertLearning({ projectSlug: PROJECT, category: "pattern", text: "an agent's own note", origin: "agent" });
  for (const id of [a, b]) assert.equal(h.get("SELECT status FROM learnings WHERE id = ?", [id]).status, "pending");
  const fact = await ep.observeUserFact({ category: "preference", text: "likes short answers", projectSlug: PROJECT, origin: "user" });
  assert.equal(h.get("SELECT status FROM user_facts WHERE id = ?", [fact.id]).status, "pending");
});

test("seeing a pending note again never accepts it", async () => {
  const h = await ep.db();
  const id = await ep.insertLearning({ projectSlug: PROJECT, category: "correction", text: "run the linter before committing", origin: "agent" });
  await ep.insertLearning({ projectSlug: PROJECT, category: "correction", text: "run the linter before committing", origin: "user" });
  assert.equal(h.get("SELECT status FROM learnings WHERE id = ?", [id]).status, "pending");
});

test("only the review service writes accepted_by or stores 'active' on a note", () => {
  const allowed = new Set(["memory/review-service.mjs", "memory/sqlite.mjs"]); // sqlite.mjs: the one-time v5 backfill
  const offenders = [];
  for (const file of sources()) {
    const name = rel(file);
    if (allowed.has(name)) continue;
    const text = readFileSync(file, "utf8");
    if (/accepted_by\s*=(?!=)/.test(text)) offenders.push(`${name}: writes accepted_by`);
    // The SET list of an UPDATE on a note table (up to its WHERE), and the status it stores.
    for (const m of text.matchAll(/UPDATE\s+["$`{}\w.]*\s+SET\s+([\s\S]*?)(?:\bWHERE\b|[`"])/g)) {
      if (/status\s*=\s*(CASE[\s\S]*?)?'active'/.test(m[1]) && !/goal|thread|team|task|job/i.test(m[0])) offenders.push(`${name}: stores status 'active'`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("review tokens are requested only by the CLI review verbs and ad's own terminal UI", () => {
  const callers = sources().filter((f) => /\breviewToken\(/.test(readFileSync(f, "utf8"))).map(rel).sort();
  // memory/memory-cli.mjs: the CLI remember, forget, restore and config review verbs (L5).
  assert.deepEqual(callers, ["cli-full.mjs", "memory/held.mjs", "memory/memory-cli.mjs", "memory/review-service.mjs", "portability/import.mjs", "review.mjs", "tui/ad-layer.mjs"]);
  // The sync check mints a token from injected probes: only the service itself (and the testkit) may call it.
  const syncCallers = sources().filter((f) => /\bcheckReviewToken\(/.test(readFileSync(f, "utf8"))).map(rel);
  assert.deepEqual(syncCallers, ["memory/review-service.mjs"]);
  for (const c of callers) assert.ok(!/^(mcp|hooks|memory-install)\//.test(c), c);
});

test("--allow-cross-project (no keys): accepted and labelled waiting notes only, never held-back, hidden or rejected ones", async () => {
  const h = await ep.db();
  const ins = (text, status) => Number(h.run("INSERT INTO learnings (project_slug, category, text, confidence, status, content_hash) VALUES (?, 'gotcha', ?, 0.8, ?, ?)", ["-work-other", text, status, `h-x-${text}`]).lastInsertRowid);
  const accepted = ins("an accepted note of another project", "pending");
  svc.acceptLearning(h, (await svc.reviewToken(terminal)).token, accepted);
  const others = ["quarantined", "hidden", "rejected", "archived", "superseded"].map((s) => ins(`a ${s} note of another project`, s));
  const waiting = ins("a waiting note of another project", "pending");
  const all = [accepted, waiting, ...others];
  const served = (await ep.getLearningsByIds(all)).map((r) => r.id);
  assert.deepEqual(served, [accepted]);
  const withPending = await ep.getLearningsByIds(all, { includePending: true });
  assert.deepEqual(withPending.map((r) => [r.id, r.status]), [[accepted, "active"], [waiting, "pending"]]);
  for (const id of others) assert.equal(await ep.learningTimeline(id), null, `timeline of ${id}`);
  assert.ok(await ep.learningTimeline(accepted));
});

test("seeing an accepted user fact in another project never serves it there", async () => {
  const h = await ep.db();
  const first = await ep.observeUserFact({ category: "tool", text: "prefers zed as the editor", projectSlug: PROJECT, origin: "user" });
  svc.acceptFact(h, (await svc.reviewToken(terminal)).token, first.id);
  const again = await ep.observeUserFact({ category: "tool", text: "prefers zed as the editor", projectSlug: "-work-other", origin: "user" });
  assert.deepEqual(again.projects, [PROJECT], "the fact stays where the user accepted it");
  assert.equal(again.observed, 2, "the sighting counts");
  assert.ok(!(await ep.listUserFacts({ projectKeys: ["-work-other"] })).some((f) => f.text === "prefers zed as the editor"));
});

test("a forged SystemRoot picks neither the walk's PowerShell nor the dialog's (Windows)", { skip: process.platform !== "win32" && "Windows only" }, async () => {
  const { dialogCommand } = await import("../src/memory/dialog-code.mjs");
  const { loaderWindowsDir } = await import("../src/safe-spawn.mjs");
  const real = loaderWindowsDir();
  const saved = process.env.SystemRoot;
  process.env.SystemRoot = ROOT; // an agent's shell could set this before running ad review
  try {
    const how = dialogCommand("win32");
    assert.ok(how && how.cmd.toLowerCase().startsWith(real.toLowerCase()), `${how?.cmd} comes from ${real}`);
  } finally {
    process.env.SystemRoot = saved;
  }
});

test("a module on the caller's PSModulePath can't answer for the Windows process walk (L1 re-check)", { skip: process.platform !== "win32" && "Windows only" }, async () => {
  const { probeAncestry } = await import("../src/memory/ancestry.mjs");
  const { mkdirSync: mk, writeFileSync: wr } = await import("node:fs");
  const mods = path.join(ROOT, "psmods");
  for (const name of ["CimCmdlets", "Microsoft.PowerShell.Utility"]) {
    mk(path.join(mods, name), { recursive: true });
    // Every lookup answers "a Windows Terminal from Program Files started me".
    wr(path.join(mods, name, `${name}.psm1`), "function Get-CimInstance { [pscustomobject]@{ ProcessId = 1; ParentProcessId = 0; Name = 'WindowsTerminal.exe'; ExecutablePath = 'C:\Program Files\WindowsApps\WT\WindowsTerminal.exe'; CreationDate = (Get-Date).AddDays(-1) } }\nfunction ConvertTo-Json { '[{\"pid\":1,\"ppid\":0,\"name\":\"WindowsTerminal.exe\",\"path\":\"C:\\Program Files\\WindowsApps\\WT\\WindowsTerminal.exe\"}]' }\nExport-ModuleMember -Function *\n");
  }
  const honest = probeAncestry();
  const saved = process.env.PSModulePath;
  process.env.PSModulePath = `${mods};${saved ?? ""}`;
  try {
    assert.deepEqual(probeAncestry(), honest, "the same verdict with the fake modules first on PSModulePath");
  } finally {
    process.env.PSModulePath = saved;
  }
});

test("accepting a user fact accepts it in the project it is reviewed in, not where forged sightings put it", async () => {
  const h = await ep.db();
  const fact = await ep.observeUserFact({ category: "tool", text: "uses biome, not eslint", projectSlug: PROJECT, origin: "user" });
  await ep.observeUserFact({ category: "tool", text: "uses biome, not eslint", projectSlug: "-work-forged", origin: "user" });
  assert.deepEqual(JSON.parse(h.get("SELECT projects FROM user_facts WHERE id = ?", [fact.id]).projects), [PROJECT, "-work-forged"], "pending: sightings recorded");
  svc.acceptFact(h, (await svc.reviewToken(terminal)).token, fact.id, { keys: [PROJECT] });
  assert.deepEqual(JSON.parse(h.get("SELECT projects FROM user_facts WHERE id = ?", [fact.id]).projects), [PROJECT]);
  assert.ok(!(await ep.listUserFacts({ projectKeys: ["-work-forged"] })).some((f) => f.text === "uses biome, not eslint"));
});

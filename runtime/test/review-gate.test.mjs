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
  assert.deepEqual(callers, ["memory/held.mjs", "memory/review-service.mjs", "portability/import.mjs", "review.mjs", "tui/ad-layer.mjs"]);
  for (const c of callers) assert.ok(!/^(mcp|hooks|memory-install)\//.test(c), c);
});

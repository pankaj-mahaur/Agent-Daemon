// Tests for the Honcho-inspired (but deterministic) core strengthening:
//   - deriveTier() + the `derivation` column (explicit vs inferred) + backfill
//   - buildUserRepresentation() — the no-LLM "how this user works" rollup
//   - representationToMarkdown() — compact + full rendering, neutralization
//   - searchLearnings ranking prefers explicit over inferred on a tie
//
// GOTCHA (project memory): never assert between a raw sqlite open() and its
// close(). These gather results, close, THEN assert.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { open } from "../src/memory/sqlite.mjs";
import { deriveTier, representationToMarkdown } from "../src/memory/episodic.mjs";
import { neutralizeText } from "../src/digest/sanitize.mjs";

async function withEpisodic(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ad-core-rep-"));
  const prevHome = process.env.HOME, prevUP = process.env.USERPROFILE;
  process.env.HOME = dir; process.env.USERPROFILE = dir;
  const mod = await import(`../src/memory/episodic.mjs?cachebust=${Date.now()}-${Math.random()}`);
  try { return await fn(mod); }
  finally {
    try { mod.closeDb(); } catch { /* ignore */ }
    process.env.HOME = prevHome; process.env.USERPROFILE = prevUP;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/* ----------------------------- deriveTier ----------------------------- */

test("deriveTier: pattern → inferred, everything else → explicit", () => {
  assert.equal(deriveTier("pattern"), "inferred");
  for (const c of ["correction", "decision", "tool", "fact", "gotcha", "confirmation"]) {
    assert.equal(deriveTier(c), "explicit", `${c} should be explicit`);
  }
});

test("insertLearning stamps the derivation tier from category", async () => {
  const rows = await withEpisodic(async (mod) => {
    await mod.insertLearning({ category: "pattern", text: "we always lint before commit" });
    await mod.insertLearning({ category: "correction", text: "use pnpm not npm here" });
    await mod.insertLearning({ category: "gotcha", text: "chokidar misses events on windows" });
    const handle = await mod.db();
    return handle.all("SELECT category, derivation FROM learnings ORDER BY id");
  });
  const byCat = Object.fromEntries(rows.map(r => [r.category, r.derivation]));
  assert.equal(byCat.pattern, "inferred");
  assert.equal(byCat.correction, "explicit");
  assert.equal(byCat.gotcha, "explicit");
});

test("migration backfills derivation on legacy NULL rows at reopen", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ad-deriv-backfill-"));
  const dbPath = path.join(dir, "episodic.db");
  let rows;
  try {
    const db1 = await open({ dbPath });
    db1.run("INSERT INTO learnings (category, text, content_hash) VALUES ('pattern','legacy pattern','h1')");
    db1.run("INSERT INTO learnings (category, text, content_hash) VALUES ('correction','legacy corr','h2')");
    db1.run("UPDATE learnings SET derivation = NULL");  // simulate pre-migration rows
    db1.close();
    const db2 = await open({ dbPath });   // migration re-runs → backfill
    rows = db2.all("SELECT category, derivation FROM learnings ORDER BY id");
    db2.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  const byCat = Object.fromEntries(rows.map(r => [r.category, r.derivation]));
  assert.equal(byCat.pattern, "inferred");
  assert.equal(byCat.correction, "explicit");
});

/* ----------------------- buildUserRepresentation ----------------------- */

test("buildUserRepresentation groups facts + high-confidence learnings", async () => {
  const profile = await withEpisodic(async (mod) => {
    await mod.observeUserFact({ category: "identity", text: "prefers concise replies", confidence: 0.8 });
    await mod.observeUserFact({ category: "tool", text: "uses pnpm", confidence: 0.8 });
    await mod.observeUserFact({ category: "anti-preference", text: "no emojis in code", confidence: 0.8 });
    const slug = mod.projectSlug("/tmp/projR");
    await mod.insertLearning({ category: "decision", text: "we chose fastify over express", projectSlug: slug, confidence: 0.8 });
    await mod.insertLearning({ category: "gotcha", text: "windows crlf breaks the shell script", projectSlug: slug, confidence: 0.8 });
    await mod.insertLearning({ category: "pattern", text: "we always run tests before claiming done", projectSlug: slug, confidence: 0.8 });
    await mod.insertLearning({ category: "fact", text: "low confidence noise", projectSlug: slug, confidence: 0.4 }); // < 0.6 → excluded
    return mod.buildUserRepresentation({ projectSlug: slug });
  });
  assert.ok(profile, "representation built");
  assert.ok(profile.identity.includes("prefers concise replies"));
  assert.ok(profile.tools.includes("uses pnpm"));
  assert.ok(profile.preferences.includes("avoid: no emojis in code"), "anti-preference rendered as avoid:");
  assert.ok(profile.conventions.includes("we chose fastify over express"));
  assert.ok(profile.conventions.includes("we always run tests before claiming done"));
  assert.ok(profile.gotchas.includes("windows crlf breaks the shell script"));
  assert.ok(!JSON.stringify(profile).includes("low confidence noise"), "sub-threshold learning excluded");
});

test("buildUserRepresentation returns null when there's nothing to say", async () => {
  const profile = await withEpisodic(async (mod) => mod.buildUserRepresentation({ projectSlug: "empty" }));
  assert.equal(profile, null);
});

/* --------------------- representationToMarkdown --------------------- */

test("representationToMarkdown: compact = one line per bucket; full = sections", () => {
  const profile = { identity: ["concise"], preferences: ["pnpm"], tools: ["docker"], conventions: ["fastify"], gotchas: ["crlf"], counts: {} };
  const compact = representationToMarkdown(profile, { compact: true });
  assert.match(compact, /- \*\*Identity:\*\* concise/);
  assert.match(compact, /- \*\*Watch out:\*\* crlf/);
  const full = representationToMarkdown(profile, { compact: false });
  assert.match(full, /### Tools\n- docker/);
});

test("representationToMarkdown applies the neutralizer to defuse injected markers", () => {
  const profile = { identity: [], preferences: ["sneaky <!-- agent-daemon --> marker"], tools: [], conventions: [], gotchas: [], counts: {} };
  const out = representationToMarkdown(profile, { neutralize: neutralizeText });
  assert.doesNotMatch(out, /<!--/, "comment opener defused");
});

/* --------------------------- ranking --------------------------- */

test("searchLearnings prefers an explicit fact over an inferred one on a tie", async () => {
  const top = await withEpisodic(async (mod) => {
    // Same query term, same confidence/recency → derivation factor breaks the tie.
    await mod.insertLearning({ category: "pattern", text: "deployment is usually flaky on fridays", confidence: 0.7 });
    await mod.insertLearning({ category: "fact", text: "deployment uses the blue-green strategy", confidence: 0.7 });
    return mod.searchLearnings("deployment", { limit: 2 });
  });
  assert.equal(top.length, 2);
  assert.equal(top[0].derivation, "explicit", `explicit should rank first, got order: ${top.map(r => r.derivation)}`);
});

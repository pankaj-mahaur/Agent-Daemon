// P5.1: two memory servers, bound to projects A and B, over one database. An
// agent on B that guesses ids and searches A's words gets nothing of A, and
// many parallel calls while notes are written never hit SQLITE_BUSY.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { driveServer, text } from "../testkit/mcp-client.mjs";

const ROOT = mkdtempSync(path.join(tmpdir(), "ad-two-host-"));
const HOME = path.join(ROOT, "home");
const A = path.join(HOME, "work", "alpha");
const B = path.join(HOME, "work", "beta");
for (const d of [A, B]) mkdirSync(path.join(d, ".git"), { recursive: true });
const SECRETS = ["zephyrquill", "obsidianmarrow", "cobaltlantern"]; // words only A's notes hold
const env = () => {
  const e = { ...process.env, HOME, USERPROFILE: HOME };
  for (const k of ["CLAUDE_PROJECT_DIR", "AD_MEMORY_PROJECT", "AD_ROOT", "AD_MEMORY_DB"]) delete e[k];
  return e;
};
let ep;
const withHome = async (fn) => {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
};
let aIds = [];
before(async () => {
  await withHome(async () => {
    ep = await import(`../src/memory/episodic.mjs?two=${Date.now()}`);
    await ep.upsertSession({ id: "sa", projectPath: A, startedAt: "2026-10-01T00:00:00Z" });
    await ep.upsertSession({ id: "sb", projectPath: B, startedAt: "2026-10-01T00:00:00Z" });
    for (const [i, w] of SECRETS.entries()) aIds.push(await ep.insertLearning({ sessionId: "sa", projectSlug: ep.projectSlug(A), category: "gotcha", text: `alpha note ${w} number ${i}`, tags: [`src/${w}.ts`], confidence: 0.8, origin: "user" }));
    await ep.insertLearning({ sessionId: "sb", projectSlug: ep.projectSlug(B), category: "gotcha", text: "beta note about the build", confidence: 0.8, origin: "user" });
    ep.closeDb();
  });
});
after(() => rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const init = { jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2025-11-25" } };
const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

test("an agent on B enumerating ids 1–500 and searching A's words gets nothing of A", async () => {
  const reqs = [init];
  let n = 0;
  for (let lo = 1; lo <= 500; lo += 20) reqs.push(call(`get${n++}`, "memory_get", { ids: Array.from({ length: 20 }, (_, i) => lo + i) }));
  for (let id = 1; id <= 500; id++) reqs.push(call(`tl${id}`, "memory_timeline", { id }));
  for (const id of aIds) reqs.push(call(`fb${id}`, "memory_feedback", { id, verdict: "wrong" }));
  for (const w of SECRETS) for (const scope of ["project", "global", "any"]) {
    reqs.push(call(`s-${w}-${scope}`, "memory_search", { query: w, scope }));
    reqs.push(call(`f-${w}-${scope}`, "memory_files", { path: `${w}.ts`, scope }));
  }
  reqs.push(call("recent", "memory_recent", {}), call("facts", "user_facts_list", {}), call("profile", "memory_profile", {}));
  const r = await driveServer(env(), reqs, 60000, { args: ["--project", B] });
  for (const [id, resp] of Object.entries(r)) {
    const t = text(resp) || JSON.stringify(resp.error ?? "");
    for (const w of SECRETS) assert.ok(!t.includes(w), `${id} leaked ${w}: ${t.slice(0, 200)}`);
    assert.ok(!t.includes("alpha note"), `${id}: ${t.slice(0, 200)}`);
  }
  for (const id of aIds) assert.match(text(r[`fb${id}`]), /No learning #\d+ in this project\./);
  // …and A's rows weren't touched by B's reads or feedback.
  await withHome(async () => {
    const ep2 = await import(`../src/memory/episodic.mjs?two-check=${Date.now()}`);
    try {
      const h = await ep2.db();
      const rows = h.all(`SELECT id, retrieval_count, usefulness FROM learnings WHERE id IN (${aIds.join(",")})`);
      assert.equal(rows.length, aIds.length);
      for (const row of rows) {
        assert.ok(!row.retrieval_count, `row ${row.id} was counted as retrieved from B`);
        assert.equal(row.usefulness ?? null, null, `row ${row.id} got a verdict from B`);
      }
    } finally {
      ep2.closeDb();
    }
  });
});

test("50 parallel calls on each server while notes are written: every call answers, no SQLITE_BUSY", async () => {
  const many = (dir) => [init, ...Array.from({ length: 50 }, (_, i) => call(`c${i}`, i % 2 ? "memory_search" : "memory_recent", { query: "note" }))];
  const writer = withHome(async () => {
    const { applyLearnings } = await import("../src/digest/apply.mjs");
    const ep3 = await import(`../src/memory/episodic.mjs?two-w=${Date.now()}`);
    for (let i = 0; i < 20; i++) await ep3.insertLearning({ sessionId: "sa", projectSlug: ep3.projectSlug(A), category: "pattern", text: `written while serving ${i}`, confidence: 0.5, origin: "user" });
    void applyLearnings;
    ep3.closeDb();
  });
  const [ra, rb] = await Promise.all([driveServer(env(), many(A), 60000, { args: ["--project", A] }), driveServer(env(), many(B), 60000, { args: ["--project", B] }), writer]);
  for (const r of [ra, rb]) {
    for (let i = 0; i < 50; i++) {
      const resp = r[`c${i}`];
      assert.ok(resp?.result, `c${i}: ${JSON.stringify(resp?.error)}`);
      assert.ok(!/SQLITE_BUSY|database is locked/i.test(text(resp)), text(resp));
      assert.notEqual(resp.result.isError, true, text(resp));
    }
  }
});

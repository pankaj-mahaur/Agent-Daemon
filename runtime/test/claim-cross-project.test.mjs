// P8.1 (review N5): the approved sentence "Notes from one project are never served in another
// unless you accept them as cross-project" holds. Project A holds a learning, a user fact seen
// only in A, a 3.0-style global row from one of A's sessions and an agent's note asking to go
// global; the folder x/a-b shares A's (x/a/b) slug. Project B, the colliding folder and an
// unbound server get none of A's text through the memory tools, SessionStart or prompt
// retrieval. After a guarded accept of the fact and the global row, B sees exactly those two.
// If this test fails, the sentence leaves every page (check-claims.mjs enforces its wording).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME = await fs.mkdtemp(path.join(os.tmpdir(), "ad-claim-home-"));
const WORK = await fs.mkdtemp(path.join(os.tmpdir(), "ad-claim-work-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.AD_ROOT = path.join(HOME, ".agent-daemon");
for (const k of ["AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL", "AD_HOOK_HOST"]) delete process.env[k];

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");
const ep = await import("../src/memory/episodic.mjs");
const { captureExplicit, createLimiter } = await import("../src/memory/capture.mjs");
const { runInteractiveReview, promoteFact } = await import("../src/review.mjs");
const { driveServer, text } = await import("../testkit/mcp-client.mjs");

// One word per row of A, found nowhere else.
const W = { learning: "zephyrquill", fact: "obsidianmarrow", global: "cobaltlantern", agent: "vermilionsextant" };
const A = path.join(WORK, "x", "a", "b");
const COLLIDING = path.join(WORK, "x", "a-b");
const B = path.join(WORK, "beta");
const PLAIN = path.join(WORK, "downloads");
let handle, factId;

before(async () => {
  for (const d of [A, COLLIDING, B]) await fs.mkdir(path.join(d, ".git"), { recursive: true });
  await fs.mkdir(path.join(A, ".agent-daemon", "memory"), { recursive: true });
  await fs.mkdir(PLAIN, { recursive: true });
  handle = await ep.db();
  const slugA = ep.projectSlug(A);
  assert.equal(ep.projectSlug(COLLIDING), slugA, "the fixture needs two folders with one slug");
  await ep.upsertSession({ id: "sa", projectPath: A, startedAt: "2026-10-01T00:00:00.000Z" });
  await ep.upsertSession({ id: "sb", projectPath: B, startedAt: "2026-10-01T00:00:00.000Z" });
  await ep.insertLearning({ sessionId: "sa", projectSlug: slugA, category: "gotcha", text: `the ${W.learning} build needs a warm cache`, confidence: 0.9, origin: "user" });
  await ep.insertLearning({ sessionId: "sb", projectSlug: ep.projectSlug(B), category: "gotcha", text: "the beta build runs on node 22", confidence: 0.9, origin: "user" });
  factId = (await ep.observeUserFact({ category: "tool", text: `prefers the ${W.fact} editor`, sessionId: "sa", projectSlug: slugA, confidence: 0.9 })).id;
  // 3.0 wrote automatic globals: no project, only the session says where it came from.
  handle.run("INSERT INTO learnings (session_id, category, text, content_hash, confidence, status) VALUES ('sa', 'pattern', ?, 'claim-g1', 0.9, 'active')", [`release notes go through ${W.global} first`]);
  const scope = { kind: "project", dir: A, keys: [slugA], source: "arg" };
  const r = await captureExplicit({ kind: "learning", fields: { text: `the ${W.agent} service owns retries`, kind: "decision", scope: "global" }, scope, mode: "tools", limiter: createLimiter() });
  assert.equal(r.status, "saved", r.message);
});
after(async () => {
  ep.closeDb();
  for (const d of [HOME, WORK]) await fs.rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const hook = (args, input) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(input ? JSON.stringify(input) : "");
  });

const init = { jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2025-11-25" } };
const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const PROMPT = `How do ${Object.values(W).join(", ")} fit together? Check release notes, retries, the editor and the build cache.`;

// Everything a folder's agent can be shown: [surface, text].
async function seen(dir, { bound = true } = {}) {
  const reqs = [init, call("recent", "memory_recent", { limit: 50 }), call("facts", "user_facts_list", {}), call("profile", "memory_profile", {})];
  for (const w of Object.values(W)) for (const scope of ["project", "global", "any"]) reqs.push(call(`search ${w} ${scope}`, "memory_search", { query: w, scope }));
  const served = await driveServer(process.env, reqs, 60000, bound ? { args: ["--project", dir] } : { cwd: dir });
  const out = Object.entries(served).filter(([id]) => id !== "init").map(([id, resp]) => [`mcp ${id}`, text(resp) || JSON.stringify(resp.error ?? "")]);
  if (bound) {
    const start = await hook(["session-start", "--output-json", "--cwd", dir]);
    assert.equal(start.code, 0, start.out);
    out.push(["SessionStart", start.out]);
    const retrieve = await hook(["query-retrieve", "--output-json", "--cwd", dir], { hook_event_name: "UserPromptSubmit", cwd: dir, prompt: PROMPT });
    assert.equal(retrieve.code, 0, retrieve.out);
    out.push(["query-retrieve", retrieve.out]);
  }
  return out;
}
const leaks = (surfaces, words) => surfaces.flatMap(([where, t]) => words.filter((w) => t.includes(w)).map((w) => `${where}: ${w}`));

test("the fixture is real: A's own server and SessionStart serve A's learning", async () => {
  const mine = await seen(A);
  assert.ok(leaks(mine, [W.learning]).length > 0, "A must see its own learning, or the checks below prove nothing");
});

test("before any accept: B, the folder sharing A's slug and an unbound server get none of A's text", async () => {
  const all = Object.values(W);
  assert.deepEqual(leaks(await seen(B), all), [], "B");
  assert.deepEqual(leaks(await seen(COLLIDING), all), [], "the colliding folder");
  assert.deepEqual(leaks(await seen(PLAIN, { bound: false }), all), [], "an unbound server");
  // B still gets its own notes (the surfaces work).
  assert.ok(leaks(await seen(B), ["node 22"]).length > 0);
});

test("after a guarded accept of the fact and the global row, B sees exactly those two", async () => {
  const lines = [];
  const typed = (...answers) => ({ ask: () => Promise.resolve(answers.shift() ?? "") });
  assert.equal(await promoteFact({ ref: `fact:${factId}`, handle, env: {}, isTTY: () => true, io: typed("accept"), out: (l) => lines.push(l) }), 0, lines.join("\n"));
  // --global lists 3.0's automatic globals: accept the one from A; the agent's request is a
  // separate proposal and stays pending.
  const keys = [ep.projectSlug(B)];
  const code = await runInteractiveReview({ cwd: B, handle, keys, isTTY: () => true, env: {}, out: (l) => lines.push(String(l)), global: true, io: typed("a", "accept") });
  assert.equal(code, 0, lines.join("\n"));
  assert.ok(handle.get("SELECT global_accepted_at FROM learnings WHERE content_hash = 'claim-g1'").global_accepted_at, lines.join("\n"));

  const surfaces = await seen(B);
  assert.deepEqual(leaks(surfaces, [W.learning, W.agent]), [], "only what was accepted crosses");
  assert.ok(leaks(surfaces, [W.fact]).length > 0, "the accepted fact reaches B");
  assert.ok(leaks(surfaces, [W.global]).length > 0, "the accepted global row reaches B");
});

// P5.2 / D49: every accept and promote path of ad review and ad memory promote
// refuses inside an agent's tool shell and without a terminal, has no --yes,
// and asks for a typed confirmation. Handlers are driven with an injected
// confirmer and TTY check; the CLI with real (non-TTY) pipes.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME = await fs.mkdtemp(path.join(os.tmpdir(), "ad-review-home-"));
const WORK = await fs.mkdtemp(path.join(os.tmpdir(), "ad-review-work-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.AD_ROOT = path.join(HOME, ".agent-daemon");
for (const k of ["AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL", "AD_HOOK_HOST"]) delete process.env[k];

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");
const ep = await import("../src/memory/episodic.mjs");
const { learningContentHash, scopedContentHash } = await import("../src/memory/sqlite.mjs");
const { captureExplicit, createLimiter } = await import("../src/memory/capture.mjs");
const { runInteractiveReview, promoteFact, GUARD_TEXTS, globalPending } = await import("../src/review.mjs");

let handle;
before(async () => {
  handle = await ep.db();
});
after(async () => {
  ep.closeDb();
  for (const d of [HOME, WORK]) await fs.rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

let n = 0;
async function project({ init = true } = {}) {
  const dir = path.join(WORK, `p${++n}`);
  await fs.mkdir(path.join(dir, ".git"), { recursive: true });
  if (init) await fs.mkdir(path.join(dir, ".agent-daemon", "memory"), { recursive: true });
  const keys = [ep.projectSlug(dir)];
  return { dir, keys, scope: { kind: "project", dir, keys, source: "arg" } };
}
async function record(p, text, extra = {}) {
  const r = await captureExplicit({ kind: "learning", fields: { text, kind: "decision", ...extra }, scope: p.scope, mode: "tools", limiter: createLimiter() });
  assert.equal(r.status, "saved", r.message);
  return r;
}
const status = (id) => handle.get("SELECT status, project_slug, global_accepted_at, content_hash, superseded_by FROM learnings WHERE id = ?", [id]);
const io = (...answers) => {
  const asked = [];
  return { asked, ask: (q) => (asked.push(q), Promise.resolve(answers.shift() ?? "")) };
};
const lines = () => {
  const out = [];
  return { out, push: (l) => out.push(String(l)) };
};
const review = (p, extra) => {
  const o = lines();
  return runInteractiveReview({ cwd: p.dir, handle, keys: p.keys, isTTY: () => true, env: {}, out: o.push, ...extra }).then((code) => ({ code, out: o.out.join("\n") }));
};
const cli = (args, { env = {}, cwd } = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end("accept\n");
  });

test("in an agent's tool shell every accept path refuses and nothing changes", async () => {
  const p = await project();
  const r = await record(p, "every accept path refuses in the tool shell");
  const file = path.basename(r.proposalPaths[0]);
  const shell = { env: { AD_TOOL_SHELL: "1" }, io: io("accept", "accept") };
  for (const extra of [{ accept: file }, { acceptAll: true }, { global: true }]) {
    const res = await review(p, { ...shell, ...extra });
    assert.equal(res.code, 2, JSON.stringify(extra));
    assert.equal(res.out, GUARD_TEXTS.toolShell);
  }
  // The interactive loop: choosing accept on a memory proposal refuses too.
  const loop = await review(p, { env: { AD_TOOL_SHELL: "1" }, io: io("a", "accept") });
  assert.equal(loop.code, 2);
  assert.match(loop.out, /can't run from the agent's own shell/);
  assert.equal(status(r.id).status, "pending");
  assert.ok(existsSync(r.proposalPaths[0]));
  // ad memory promote fact:<id>
  handle.run("INSERT INTO user_facts (category, text, projects) VALUES ('tool', 'prefers pnpm everywhere', ?)", [JSON.stringify(p.keys)]);
  const fact = handle.get("SELECT id FROM user_facts WHERE text = 'prefers pnpm everywhere'").id;
  const o = lines();
  assert.equal(await promoteFact({ ref: `fact:${fact}`, handle, env: { AD_TOOL_SHELL: "1" }, isTTY: () => true, io: io("accept"), out: o.push }), 2);
  assert.equal(handle.get("SELECT global_accepted_at FROM user_facts WHERE id = ?", [fact]).global_accepted_at, null);
});

test("without a terminal every accept path refuses; --yes doesn't exist", async () => {
  const p = await project();
  const r = await record(p, "without a terminal nothing is accepted");
  for (const extra of [{ accept: path.basename(r.proposalPaths[0]) }, { acceptAll: true }, { global: true }]) {
    const res = await review(p, { isTTY: () => false, io: io("accept"), ...extra });
    assert.equal(res.code, 2);
    assert.equal(res.out, GUARD_TEXTS.noTty);
  }
  const yes = await review(p, { yes: true, acceptAll: true, io: io() });
  assert.equal(yes.code, 2);
  assert.equal(yes.out, GUARD_TEXTS.yes);
  assert.equal(status(r.id).status, "pending");
  // The real CLI: pipes, not a terminal.
  for (const args of [["review", "--accept-all"], ["review", "--accept", path.basename(r.proposalPaths[0])], ["review", "--global"], ["review", "--accept-all", "--yes"], ["memory", "promote", "fact:1"]]) {
    const res = await cli(args, { cwd: p.dir, env: { AD_ROOT: process.env.AD_ROOT } });
    assert.equal(res.code, 2, `${args.join(" ")}: ${res.out}`);
  }
  const shell = await cli(["review", "--accept-all"], { cwd: p.dir, env: { AD_TOOL_SHELL: "1" } });
  assert.equal(shell.code, 2);
  assert.match(shell.out, /can't run from the agent's own shell/);
  assert.equal(status(r.id).status, "pending");
  // Listing still works without a terminal.
  const list = await cli(["review"], { cwd: p.dir });
  assert.equal(list.code, 0, list.out);
  assert.match(list.out, /memory-add-/);
});

test("memory-add accept: typed confirmation, the note becomes active and joins project memory", async () => {
  const p = await project();
  const r = await record(p, "the staging database is reset every night at 2am");
  const wrong = await review(p, { accept: path.basename(r.proposalPaths[0]), io: io("yes") });
  assert.equal(wrong.code, 1);
  assert.match(wrong.out, /Not confirmed/);
  assert.equal(status(r.id).status, "pending");
  const q = io("accept");
  const ok = await review(p, { accept: path.basename(r.proposalPaths[0]), io: q });
  assert.equal(ok.code, 0, ok.out);
  assert.deepEqual(q.asked, ["Type accept to confirm: "]);
  assert.equal(status(r.id).status, "active");
  assert.match(readFileSync(path.join(p.dir, ".agent-daemon", "memory", "activeContext.md"), "utf8"), /reset every night at 2am/);
  assert.equal(existsSync(r.proposalPaths[0]), false);
  assert.ok(readdirSync(path.join(p.dir, ".agent-daemon", "applied")).some((f) => f.startsWith("memory-add-")));
});

test("--accept-all asks for the count; reject drops the note", async () => {
  const p = await project();
  const a = await record(p, "first note accepted as a batch of two");
  const b = await record(p, "second note accepted as a batch of two");
  const q = io("2");
  const res = await review(p, { acceptAll: true, io: q });
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(q.asked, ["Type 2 to confirm: "]);
  assert.equal(status(a.id).status, "active");
  assert.equal(status(b.id).status, "active");
  // The interactive loop: reject a memory-add.
  const c = await record(p, "this note is rejected in the loop");
  const loop = await review(p, { io: io("r") });
  assert.equal(loop.code, 0, loop.out);
  assert.equal(status(c.id).status, "rejected");
  assert.equal(existsSync(c.proposalPaths[0]), false);
});

test("memory-promote with a global duplicate: one global row, this one superseded, no unique-index error", async () => {
  const p = await project();
  const text = "releases are tagged only after CI passes on main";
  handle.run("INSERT INTO learnings (category, text, content_hash, global_accepted_at, status) VALUES ('decision', ?, ?, '2026-01-01', 'active')", [text, learningContentHash(text)]);
  const existing = handle.get("SELECT id FROM learnings WHERE text = ? AND project_slug IS NULL", [text]).id;
  const r = await record(p, text, { scope: "global" });
  assert.equal(status(r.id).content_hash, scopedContentHash(p.keys[0], text));
  const promote = path.basename(r.proposalPaths[1]);
  assert.match(promote, /^memory-promote-/);
  const res = await review(p, { accept: promote, io: io("accept") });
  assert.equal(res.code, 0, res.out);
  assert.equal(status(r.id).status, "superseded");
  assert.equal(status(r.id).superseded_by, existing);
  assert.equal(handle.all("SELECT id FROM learnings WHERE text = ? AND project_slug IS NULL AND status = 'active'", [text]).length, 1);
});

test("memory-promote over a 3.0 project row holding the plain hash: that row is rehashed, this one goes global", async () => {
  const p = await project();
  const text = "the monorepo uses turborepo pipelines";
  handle.run("INSERT INTO learnings (category, text, content_hash, project_slug, status) VALUES ('tool', ?, ?, 'old-project', 'active')", [text, learningContentHash(text)]);
  const r = await record(p, text, { scope: "global" });
  const res = await review(p, { accept: path.basename(r.proposalPaths[1]), io: io("accept") });
  assert.equal(res.code, 0, res.out);
  const mine = status(r.id);
  assert.equal(mine.project_slug, null);
  assert.ok(mine.global_accepted_at);
  assert.equal(mine.content_hash, learningContentHash(text));
  assert.equal(handle.get("SELECT content_hash FROM learnings WHERE project_slug = 'old-project' AND text = ?", [text]).content_hash, scopedContentHash("old-project", text));
});

test("--global: 3.0's automatic globals grouped by origin; accept → every project, reject → the origin only", async () => {
  const p = await project();
  await ep.upsertSession({ id: "old-session", projectPath: p.dir, startedAt: "2026-01-01T00:00:00.000Z" });
  handle.run("INSERT INTO learnings (session_id, category, text, content_hash, status) VALUES ('old-session', 'pattern', 'a global note from 3.0 to accept', 'g1', 'active')");
  handle.run("INSERT INTO learnings (session_id, category, text, content_hash, status) VALUES ('old-session', 'pattern', 'a global note from 3.0 to reject', 'g2', 'active')");
  handle.run("INSERT INTO learnings (category, text, content_hash, status) VALUES ('pattern', 'a global note with no session', 'g3', 'active')");
  const ids = Object.fromEntries(handle.all("SELECT id, content_hash FROM learnings WHERE content_hash IN ('g1','g2','g3')").map((r) => [r.content_hash, r.id]));
  assert.equal(globalPending(handle).length, 3);
  const res = await review(p, { global: true, io: io("a", "accept", "r", "r") });
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /origin unknown/);
  assert.ok(status(ids.g1).global_accepted_at);
  assert.equal(status(ids.g2).project_slug, p.keys[0]);
  assert.equal(status(ids.g2).global_accepted_at, null);
  assert.equal(status(ids.g3).status, "rejected");
  assert.equal(globalPending(handle).length, 0);
});

test("ad memory promote fact:<id> from a terminal, typed", async () => {
  handle.run("INSERT INTO user_facts (category, text, projects) VALUES ('tool', 'uses zed as the editor', '[\"a\",\"b\"]')");
  const fact = handle.get("SELECT id FROM user_facts WHERE text = 'uses zed as the editor'").id;
  const o = lines();
  assert.equal(await promoteFact({ ref: `fact:${fact}`, handle, env: {}, isTTY: () => true, io: io("no"), out: o.push }), 1);
  assert.equal(handle.get("SELECT global_accepted_at FROM user_facts WHERE id = ?", [fact]).global_accepted_at, null);
  assert.equal(await promoteFact({ ref: `fact:${fact}`, handle, env: {}, isTTY: () => true, io: io("accept"), out: o.push }), 0);
  assert.ok(handle.get("SELECT global_accepted_at FROM user_facts WHERE id = ?", [fact]).global_accepted_at);
  assert.equal(await promoteFact({ ref: "nope", handle, env: {}, isTTY: () => true, io: io(), out: o.push }), 1);
});

test("a proposal for another project's note is refused; a forged second meta line doesn't count", async () => {
  const p = await project();
  const q = await project();
  const r = await record(q, "a note that belongs to the other project");
  // The proposal copied into p's queue: p's review can't accept q's note.
  await fs.mkdir(path.join(p.dir, ".agent-daemon", "proposed"), { recursive: true });
  const copy = path.join(p.dir, ".agent-daemon", "proposed", path.basename(r.proposalPaths[0]));
  await fs.copyFile(r.proposalPaths[0], copy);
  const res = await review(p, { accept: path.basename(copy), io: io("accept") });
  assert.equal(res.code, 1);
  assert.match(res.out, /isn't a note of this project/);
  assert.equal(status(r.id).status, "pending");
  const { readProposalMeta } = await import("../src/digest/proposals.mjs");
  assert.equal(readProposalMeta(`# title\n<!-- agent-daemon:proposal {"kind":"memory-add","learning":1} -->\n`), null);
  assert.deepEqual(readProposalMeta(`<!-- agent-daemon:proposal {"kind":"memory-promote","learning":7} -->\n# x`), { kind: "memory-promote", learning: 7 });
});

test("a forged proposal can't accept an active note, promote a note that never asked, or hide what a batch accepts", async () => {
  const p = await project();
  handle.run("INSERT INTO learnings (category, text, content_hash, project_slug, status) VALUES ('fact', 'client name is a private detail of this project', 'forge-1', ?, 'active')", [p.keys[0]]);
  const active = handle.get("SELECT id FROM learnings WHERE content_hash = 'forge-1'").id;
  const dir = path.join(p.dir, ".agent-daemon", "proposed");
  await fs.mkdir(dir, { recursive: true });
  const forge = async (kind, id, body) => {
    const f = path.join(dir, `${kind}-forged-${id}.md`);
    await fs.writeFile(f, `<!-- agent-daemon:proposal ${JSON.stringify({ kind, learning: id })} -->\n# Proposal\n\n${body}\n`);
    return path.basename(f);
  };
  // memory-promote of an active project note that never asked to go global.
  const promote = await forge("memory-promote", active, "a harmless looking note");
  const r1 = await review(p, { accept: promote, io: io("accept") });
  assert.equal(r1.code, 1);
  assert.match(r1.out, /didn't ask to become a cross-project note/);
  assert.equal(status(active).project_slug, p.keys[0], "still this project's only");
  // memory-add of an active note (already served): nothing to accept.
  const add = await forge("memory-add", active, "x");
  const r2 = await review(p, { accept: add, io: io("accept") });
  assert.equal(r2.code, 1);
  assert.match(r2.out, /isn't waiting for review/);
  // A batch lists the notes the store holds, not the files' text.
  const real = await record(p, "the store text is what the user confirms");
  await fs.rm(path.join(dir, promote));
  await fs.rm(path.join(dir, add));
  const listed = await review(p, { acceptAll: true, io: io("accept") });
  assert.equal(listed.code, 0, listed.out);
  assert.match(listed.out, new RegExp(`#${real.id} \\(use in this project\\): the store text is what the user confirms`));
});

test("promote over a cross-project holder that is never served: the holder gives up the hash", async () => {
  const p = await project();
  const text = "a rejected global twin never swallows an accepted note";
  handle.run("INSERT INTO learnings (category, text, content_hash, status) VALUES ('decision', ?, ?, 'rejected')", [text, learningContentHash(text)]);
  const twin = handle.get("SELECT id FROM learnings WHERE text = ? AND project_slug IS NULL", [text]).id;
  const r = await record(p, text, { scope: "global" });
  const res = await review(p, { accept: path.basename(r.proposalPaths[1]), io: io("accept") });
  assert.equal(res.code, 0, res.out);
  const mine = status(r.id);
  assert.equal(mine.status, "active");
  assert.equal(mine.project_slug, null);
  assert.equal(mine.content_hash, learningContentHash(text));
  assert.equal(status(twin).content_hash, `retired-${twin}`);
});

test("--global reject when the origin project already has the note: superseded, no unique-index error", async () => {
  const p = await project();
  await ep.upsertSession({ id: "twin-session", projectPath: p.dir, startedAt: "2026-01-01T00:00:00.000Z" });
  const text = "a 3.0 global note the project also learned itself";
  handle.run("INSERT INTO learnings (session_id, category, text, content_hash, status) VALUES ('twin-session', 'pattern', ?, ?, 'active')", [text, learningContentHash(text)]);
  const old = handle.get("SELECT id FROM learnings WHERE text = ? AND project_slug IS NULL", [text]).id;
  await ep.insertLearning({ category: "pattern", text, projectSlug: p.keys[0], origin: "user" });
  const own = handle.get("SELECT id FROM learnings WHERE text = ? AND project_slug = ?", [text, p.keys[0]]).id;
  const res = await review(p, { global: true, io: io("r") });
  assert.equal(res.code, 0, res.out);
  assert.equal(status(old).status, "superseded");
  assert.equal(status(old).superseded_by, own);
  // A twin that is held back: the 3.0 note isn't swallowed by it, and no unique-index error.
  const q = await project();
  await ep.upsertSession({ id: "held-twin-session", projectPath: q.dir, startedAt: "2026-01-01T00:00:00.000Z" });
  const t2 = "a 3.0 global note whose project twin is held back";
  handle.run("INSERT INTO learnings (session_id, category, text, content_hash, status) VALUES ('held-twin-session', 'pattern', ?, ?, 'active')", [t2, learningContentHash(t2)]);
  const old2 = handle.get("SELECT id FROM learnings WHERE text = ? AND project_slug IS NULL", [t2]).id;
  handle.run("INSERT INTO learnings (category, text, content_hash, project_slug, status) VALUES ('pattern', ?, ?, ?, 'quarantined')", [t2, scopedContentHash(q.keys[0], t2), q.keys[0]]);
  const res2 = await review(q, { global: true, io: io("r") });
  assert.equal(res2.code, 0, res2.out);
  assert.equal(status(old2).status, "active");
  assert.equal(status(old2).project_slug, q.keys[0]);
});

test("ad review shows file and store text without control characters", async () => {
  const p = await project();
  const r = await record(p, "the shown note is the store's own text");
  const esc = String.fromCharCode(27);
  // A forged body that tries to conceal what follows it.
  await fs.appendFile(r.proposalPaths[0], `\n${esc}[8m`);
  const res = await review(p, { io: io("s") });
  assert.equal(res.code, 0, res.out);
  assert.ok(!res.out.includes(esc), "no escape code reaches the terminal");
});

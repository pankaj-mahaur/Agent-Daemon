// Checkpoints and /undo (harness/checkpoints.mjs, tui/undo.mjs; plan Part 10)
// on temp git repos: paths with spaces, CRLF (also under .gitattributes),
// big untracked files, heavy folders, renames, conflicts, folders where
// files were, retention order, and the user's index / HEAD / stash left alone.
// Undo must never take away something the user made.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckpoints, CHECKPOINT_REF } from "../src/harness/checkpoints.mjs";
import { checkpointWiring } from "../src/tui/undo.mjs";

function repo({ attributes = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ad checkpoint "));
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  if (attributes) writeFileSync(join(dir, ".gitattributes"), attributes);
  writeFileSync(join(dir, "crlf.txt"), "one\r\ntwo\r\n");
  writeFileSync(join(dir, "with space.txt"), "keep");
  writeFileSync(join(dir, "old name.txt"), "renamed later");
  git("add", ".");
  git("commit", "-qm", "init");
  return { dir, git, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const file = (dir, f) => readFileSync(join(dir, f), "utf8");

async function turn(cp, thread, turnId, change) {
  const before = await cp.snapshot();
  change();
  const after = await cp.snapshot();
  assert.ok(await cp.record(thread, turnId, { before: before.tree, after: after.tree }));
  return { before, after };
}

test("a turn's changes come back byte for byte; big untracked files and heavy folders are skipped; the user's index, HEAD and stash stay", async () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, "staged.txt"), "staged by the user");
    r.git("add", "staged.txt");
    writeFileSync(join(r.dir, "wip.txt"), "stash me");
    r.git("stash", "push", "-u", "-q", "--", "wip.txt");
    const userIndex = readFileSync(join(r.dir, ".git", "index"));
    const head = r.git("rev-parse", "HEAD");
    const stash = r.git("stash", "list");
    const cp = createCheckpoints({ cwd: r.dir, maxUntrackedBytes: 1000 });
    const { after } = await turn(cp, "thread one", "turn/1", () => {
      writeFileSync(join(r.dir, "crlf.txt"), "ONE\r\ntwo\r\nthree\r\n");
      writeFileSync(join(r.dir, "new file.txt"), "made by the turn");
      rmSync(join(r.dir, "with space.txt"));
      renameSync(join(r.dir, "old name.txt"), join(r.dir, "new name.txt"));
      writeFileSync(join(r.dir, "big.bin"), Buffer.alloc(5000));
      mkdirSync(join(r.dir, "node_modules", "x"), { recursive: true });
      writeFileSync(join(r.dir, "node_modules", "x", "i.js"), "module");
    });
    assert.deepEqual(after.skipped, ["big.bin"]);
    const agentPaths = ["crlf.txt", "new file.txt", "with space.txt", "old name.txt", "new name.txt"];
    const plan = await cp.plan("thread one", "turn/1", { agentPaths });
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(plan.paths.map((p) => `${p.status} ${p.path}`).sort(), ["A new file.txt", "A new name.txt", "D old name.txt", "D with space.txt", "M crlf.txt"]);
    const res = await cp.restore("thread one", "turn/1", { agentPaths });
    assert.equal(res.restored, 5);
    assert.equal(file(r.dir, "crlf.txt"), "one\r\ntwo\r\n", "CRLF back byte for byte");
    assert.equal(file(r.dir, "with space.txt"), "keep");
    assert.equal(file(r.dir, "old name.txt"), "renamed later");
    assert.ok(!existsSync(join(r.dir, "new file.txt")));
    assert.ok(!existsSync(join(r.dir, "new name.txt")));
    assert.ok(existsSync(join(r.dir, "big.bin")), "skipped files are left alone");
    assert.ok(existsSync(join(r.dir, "node_modules", "x", "i.js")));
    assert.deepEqual(readFileSync(join(r.dir, ".git", "index")), userIndex, "the user's index is untouched");
    assert.equal(r.git("rev-parse", "HEAD"), head);
    assert.equal(r.git("stash", "list"), stash);
    assert.match(r.git("status", "--porcelain"), /^A {2}staged\.txt$/m);
    assert.match(r.git("for-each-ref", CHECKPOINT_REF), /refs\/ad\/checkpoints\/thread_one\/\d{18}-turn_1-after/);
  } finally {
    r.done();
  }
});

test("byte for byte under .gitattributes text=auto too (git 2.40+)", async () => {
  const r = repo({ attributes: "* text=auto\n" });
  try {
    const cp = createCheckpoints({ cwd: r.dir });
    writeFileSync(join(r.dir, "win.txt"), "a\r\nb\r\n");
    await turn(cp, "t", "u", () => writeFileSync(join(r.dir, "win.txt"), "changed\r\n"));
    const res = await cp.restore("t", "u", { agentPaths: ["win.txt"] });
    if (!res.byteExact) return; // git older than 2.40: documented limit
    assert.equal(file(r.dir, "win.txt"), "a\r\nb\r\n");
  } finally {
    r.done();
  }
});

test("only the agent's own edits are undone: the user's files and edits, made between or during turns, are conflicts", async () => {
  const r = repo();
  try {
    const cp = createCheckpoints({ cwd: r.dir });
    await turn(cp, "t", "u", () => {
      writeFileSync(join(r.dir, "crlf.txt"), "agent edit\n");
      writeFileSync(join(r.dir, "my-draft.md"), "the user's own file, written during the turn");
    });
    const refused = await cp.restore("t", "u", { agentPaths: ["crlf.txt"] });
    assert.deepEqual(refused.conflicts, [{ path: "my-draft.md", why: "not changed by the agent's edits" }]);
    assert.match(refused.error, /^Not undone: my-draft\.md \(not changed by the agent's edits\)\.$/);
    assert.equal(file(r.dir, "my-draft.md"), "the user's own file, written during the turn");
    assert.equal(file(r.dir, "crlf.txt"), "agent edit\n", "nothing at all was undone");
    // Even forced, a file the agent didn't edit is never touched.
    const forced = await cp.restore("t", "u", { force: true, agentPaths: ["crlf.txt"] });
    assert.equal(forced.skipped, 1);
    assert.equal(file(r.dir, "my-draft.md"), "the user's own file, written during the turn");
    assert.equal(file(r.dir, "crlf.txt"), "one\r\ntwo\r\n", "the agent's edit is undone");
    await turn(cp, "t", "u2", () => writeFileSync(join(r.dir, "crlf.txt"), "agent edit\n"));
    // Changed since the turn: also a conflict.
    writeFileSync(join(r.dir, "crlf.txt"), "the user's edit after the turn\n");
    assert.deepEqual((await cp.plan("t", "u2", { agentPaths: ["crlf.txt"] })).conflicts, [{ path: "crlf.txt", why: "changed since the turn" }]);
  } finally {
    r.done();
  }
});

test("a folder standing where the turn deleted a file is a conflict, and force never removes it", async () => {
  const r = repo();
  try {
    const cp = createCheckpoints({ cwd: r.dir });
    await turn(cp, "t", "u", () => rmSync(join(r.dir, "with space.txt")));
    mkdirSync(join(r.dir, "with space.txt"));
    writeFileSync(join(r.dir, "with space.txt", "mine.md"), "precious");
    const plan = await cp.plan("t", "u", { agentPaths: ["with space.txt"] });
    assert.deepEqual(plan.conflicts, [{ path: "with space.txt", why: "a folder is there now" }]);
    const forced = await cp.restore("t", "u", { force: true, agentPaths: ["with space.txt"] });
    assert.equal(forced.skipped, 1);
    assert.equal(file(r.dir, "with space.txt/mine.md"), "precious");
  } finally {
    r.done();
  }
});

test("retention keeps the newest turns (in order, not by name); a failing snapshot says why", async () => {
  const r = repo();
  try {
    let t = 1_000_000;
    const cp = createCheckpoints({ cwd: r.dir, keep: 2, now: () => (t += 1000) });
    const s = await cp.snapshot();
    for (const id of ["z", "a", "m"]) await cp.record("t", id, { before: s.tree, after: s.tree });
    assert.deepEqual((await cp.list("t")).map((x) => x.turnId), ["a", "m"], "the oldest (z) went, whatever its name");
    // A nested repo with no commits makes git add fail: lastError explains.
    mkdirSync(join(r.dir, "nested"));
    execFileSync("git", ["init", "-q"], { cwd: join(r.dir, "nested") });
    writeFileSync(join(r.dir, "nested", "f"), "x");
    const failed = await createCheckpoints({ cwd: r.dir }).snapshot();
    if (failed === null) {
      const c2 = createCheckpoints({ cwd: r.dir });
      await c2.snapshot();
      assert.ok(c2.lastError);
    }
    const plain = mkdtempSync(join(tmpdir(), "ad-not-a-repo-"));
    try {
      assert.equal(await createCheckpoints({ cwd: plain }).snapshot(), null);
      assert.match((await createCheckpoints({ cwd: plain }).plan("t", "u")).error, /Not a git repo/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  } finally {
    r.done();
  }
});

/* ------------------------------------------------------------------ */
/* The wiring                                                          */
/* ------------------------------------------------------------------ */

function fakeCp({ slowBefore = false } = {}) {
  const recorded = [];
  let release;
  const slow = new Promise((r) => (release = r));
  const cp = {
    lastError: null,
    repo: async () => ({ root: "/repo" }),
    snapshot: async () => ({ tree: "after-tree" }),
    beforeSnapshot: async ({ waitMs }) => (slowBefore ? Promise.race([slow, new Promise((r) => setTimeout(() => r(null), waitMs))]) : { tree: "before-tree" }),
    record: async (thread, turn, trees) => (recorded.push({ thread, turn, ...trees }), true),
    restore: async (thread, turnId, opts) => (cp.lastRestore = { turnId, ...opts }, { restored: 1, paths: [], conflicts: [] }),
  };
  return { cp, recorded, release };
}

function fakeSession() {
  const st = { thread: { id: "t" }, turns: [], items: new Map(), activeTurnId: null, starting: false };
  return { state: st, revert: async (id) => (st.reverted = id) };
}

test("a late 'before' means no checkpoint for that turn, never the previous turn's state", async () => {
  const { cp, recorded } = fakeCp({ slowBefore: true });
  const w = checkpointWiring(cp, { cwd: "/repo", waitMs: 20 });
  const s = fakeSession();
  await w.hooks.beforeTurn({ input: [] });
  w.hooks.turnStarted({ turn: { id: "u1" } });
  await w.hooks.turnCompleted({ turn: { id: "u1" }, session: s });
  assert.deepEqual(recorded, []);
  s.state.turns.push({ id: "u1", status: "completed", itemIds: [] });
  assert.match((await w.undo(s)).error, /The last turn has no checkpoint \(the snapshot before it wasn't ready in time\)/);
});

test("/undo waits for the last turn's checkpoint, undoes only that turn, and only the agent's reported files", async () => {
  const { cp, recorded } = fakeCp();
  const w = checkpointWiring(cp, { cwd: "/repo" });
  const s = fakeSession();
  for (const id of ["u1", "u2"]) {
    await w.hooks.beforeTurn({ input: [] });
    w.hooks.turnStarted({ turn: { id } });
    s.state.items.set(`fc-${id}`, { id: `fc-${id}`, kind: "fileChange", changes: [{ path: `src/${id}.js` }, { path: "/repo/abs.txt", movePath: "/repo/moved.txt" }] });
    s.state.items.set(`um-${id}`, { id: `um-${id}`, kind: "userMessage", text: "<private>secret prompt</private>" });
    s.state.turns.push({ id, status: "completed", itemIds: [`um-${id}`, `fc-${id}`] });
    w.hooks.turnCompleted({ turn: { id }, session: s }); // not awaited, as the session does
  }
  const r = await w.undo(s); // right away: must wait for u2's recording, not fall back to u1
  assert.equal(recorded.length, 2);
  assert.equal(cp.lastRestore.turnId, "u2");
  assert.deepEqual(cp.lastRestore.agentPaths.sort(), ["abs.txt", "moved.txt", "src/u2.js"]);
  assert.equal(s.state.reverted, "u2");
  assert.equal(r.prompt, "secret prompt", "the <private> wrapper isn't put back twice");
  assert.match((await w.undo(s)).error, /no checkpoint/, "once undone, that turn can't be undone again");
});

test("S4 budget: warm snapshots of a 2000-file repo stay fast (median under 3 s even on a slow CI machine)", async () => {
  const r = repo();
  try {
    for (let d = 0; d < 20; d++) {
      mkdirSync(join(r.dir, `dir${d}`));
      for (let f = 0; f < 100; f++) writeFileSync(join(r.dir, `dir${d}`, `f${f}.txt`), `file ${d}/${f}\n`);
    }
    r.git("add", ".");
    r.git("commit", "-qm", "many files");
    const cp = createCheckpoints({ cwd: r.dir });
    await cp.snapshot(); // cold: hashes everything once
    const times = [];
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(r.dir, "dir0", "f0.txt"), `edit ${i}\n`);
      const t0 = performance.now();
      assert.ok(await cp.snapshot());
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    console.log(`# warm snapshot median ${times[2].toFixed(0)} ms`);
    assert.ok(times[2] < 3000, `median ${times[2]} ms`);
  } finally {
    r.done();
  }
});

test("a turn's 'before' is never a snapshot from before the previous turn ended", async () => {
  const r = repo();
  try {
    let t = 1_000;
    const cp = createCheckpoints({ cwd: r.dir, now: () => t });
    const early = await cp.snapshot(); // e.g. while the user was typing, before the previous turn
    t = 2_000; // the previous turn ends here
    writeFileSync(join(r.dir, "crlf.txt"), "the previous turn's edit\n");
    t = 3_000;
    const before = await cp.beforeSnapshot({ since: 2_000, waitMs: 10_000 });
    assert.notEqual(before.tree, early.tree, "a fresh snapshot, not the stale one");
    assert.equal(execFileSync("git", ["cat-file", "-p", `${before.tree}:crlf.txt`], { cwd: r.dir, encoding: "utf8" }), "the previous turn's edit\n");
    assert.equal((await cp.beforeSnapshot({ since: 2_000, waitMs: 10 })).tree, before.tree, "and that one is reused while still recent");
  } finally {
    r.done();
  }
});

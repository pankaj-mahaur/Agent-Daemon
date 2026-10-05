// Checkpoints and /undo (harness/checkpoints.mjs, tui/undo.mjs; plan Part 10)
// on temp git repos: paths with spaces, CRLF, a big untracked file, heavy
// folders, renames, conflicts, retention, and the user's index / HEAD /
// stash left alone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckpoints, CHECKPOINT_REF } from "../src/harness/checkpoints.mjs";
import { checkpointWiring } from "../src/tui/undo.mjs";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "ad checkpoint "));
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "crlf.txt"), "one\r\ntwo\r\n");
  writeFileSync(join(dir, "with space.txt"), "keep");
  writeFileSync(join(dir, "old name.txt"), "renamed later");
  git("add", ".");
  git("commit", "-qm", "init");
  return { dir, git, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const file = (dir, f) => readFileSync(join(dir, f), "utf8");

test("a turn's changes come back byte for byte; untracked big files and heavy folders are skipped; the user's index, HEAD and stash stay", async () => {
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
    const t0 = performance.now();
    const before = await cp.snapshot();
    assert.ok(performance.now() - t0 < 10_000, "a snapshot of a small repo is quick");
    // The turn: edit (CRLF kept), add, delete, rename, plus a big untracked file and node_modules.
    writeFileSync(join(r.dir, "crlf.txt"), "ONE\r\ntwo\r\nthree\r\n");
    writeFileSync(join(r.dir, "new file.txt"), "made by the turn");
    rmSync(join(r.dir, "with space.txt"));
    renameSync(join(r.dir, "old name.txt"), join(r.dir, "new name.txt"));
    writeFileSync(join(r.dir, "big.bin"), Buffer.alloc(5000));
    mkdirSync(join(r.dir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(r.dir, "node_modules", "x", "i.js"), "module");
    const after = await cp.snapshot();
    assert.deepEqual(after.skipped, ["big.bin"]);
    assert.ok(await cp.record("thread one", "turn/1", { before: before.tree, after: after.tree }));
    const plan = await cp.plan("thread one", "turn/1");
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(plan.paths.map((p) => `${p.status} ${p.path}`).sort(), ["A new file.txt", "A new name.txt", "D old name.txt", "D with space.txt", "M crlf.txt"]);
    const res = await cp.restore("thread one", "turn/1");
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
    assert.match(r.git("status", "--porcelain"), /^A {2}staged\.txt$/m, "what the user staged stays staged");
    assert.match(r.git("for-each-ref", CHECKPOINT_REF), /refs\/ad\/checkpoints\/thread_one\/turn_1-after/);
    assert.equal(r.git("branch", "--list").trim(), r.git("branch", "--show-current").trim() ? `* ${r.git("branch", "--show-current").trim()}` : "", "no branch was added");
  } finally {
    r.done();
  }
});

test("a file the user changed after the turn is a conflict: nothing is undone unless forced", async () => {
  const r = repo();
  try {
    const cp = createCheckpoints({ cwd: r.dir });
    const before = await cp.snapshot();
    writeFileSync(join(r.dir, "crlf.txt"), "turn edit\n");
    writeFileSync(join(r.dir, "with space.txt"), "turn edit too");
    const after = await cp.snapshot();
    await cp.record("t", "u", { before: before.tree, after: after.tree });
    writeFileSync(join(r.dir, "crlf.txt"), "the user's own edit\n");
    const refused = await cp.restore("t", "u");
    assert.deepEqual(refused.conflicts, ["crlf.txt"]);
    assert.match(refused.error, /Changed since that turn: crlf\.txt\. Nothing was undone\./);
    assert.equal(file(r.dir, "with space.txt"), "turn edit too", "nothing at all was undone");
    const forced = await cp.restore("t", "u", { force: true });
    assert.equal(forced.restored, 2);
    assert.equal(file(r.dir, "crlf.txt"), "one\r\ntwo\r\n");
  } finally {
    r.done();
  }
});

test("only the last N turns per thread are kept; not a repo means no checkpoints", async () => {
  const r = repo();
  try {
    const cp = createCheckpoints({ cwd: r.dir, keep: 2 });
    const s = await cp.snapshot();
    for (const t of ["a", "b", "c"]) await cp.record("t", t, { before: s.tree, after: s.tree });
    assert.deepEqual((await cp.list("t")).map((x) => x.turnId).sort(), ["b", "c"]);
    const plain = mkdtempSync(join(tmpdir(), "ad-not-a-repo-"));
    try {
      const none = createCheckpoints({ cwd: plain });
      assert.equal(await none.snapshot(), null);
      assert.match((await none.plan("t", "u")).error, /Not a git repo/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  } finally {
    r.done();
  }
});

test("snapshotWithin returns null when the snapshot is late; the wiring then falls back to the last after tree", async () => {
  let release;
  const slow = new Promise((r) => (release = r));
  const recorded = [];
  const cp = {
    snapshot: () => slow,
    snapshotWithin: async (ms) => Promise.race([slow, new Promise((r) => setTimeout(() => r(null), ms))]),
    record: async (thread, turn, trees) => (recorded.push({ thread, turn, ...trees }), true),
    restore: async () => ({ restored: 1, paths: [] }),
  };
  const w = checkpointWiring(cp, { waitMs: 20 });
  const session = { state: { thread: { id: "t" }, turns: [], items: new Map(), activeTurnId: null, starting: false }, revert: async () => {} };
  const t0 = Date.now();
  await w.hooks.beforeTurn({ input: [] });
  assert.ok(Date.now() - t0 < 500, "a turn waits only briefly");
  w.hooks.turnStarted({ turn: { id: "u1" }, session });
  release({ tree: "after1" });
  await w.hooks.turnCompleted({ turn: { id: "u1" }, session });
  assert.deepEqual(recorded, [], "no before tree for the first turn: nothing recorded");
  await w.hooks.beforeTurn({ input: [] }); // slow is settled now: returns after1 at once
  w.hooks.turnStarted({ turn: { id: "u2" }, session });
  await w.hooks.turnCompleted({ turn: { id: "u2" }, session });
  assert.deepEqual(recorded.map((x) => [x.turn, x.before, x.after]), [["u2", "after1", "after1"]]);
  session.state.turns.push({ id: "u2", status: "completed", itemIds: [] });
  const r = await w.undo(session);
  assert.match(r.message, /Undid the last turn: 1 file put back/);
  assert.match((await w.undo(session)).error, /No turn with a checkpoint/);
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
    const median = times[2];
    console.log(`# warm snapshot median ${median.toFixed(0)} ms (p95-ish ${times[4].toFixed(0)} ms)`);
    assert.ok(median < 3000, `median ${median} ms`);
  } finally {
    r.done();
  }
});

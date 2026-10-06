// Checkpoints and /undo (harness/checkpoints.mjs, tui/undo.mjs; plan Part 10)
// on temp git repos: paths with spaces, CRLF (also under .gitattributes),
// big untracked files, heavy folders, renames, conflicts, folders where
// files were, retention order, and the user's index / HEAD / stash left alone.
// Undo must never take away something the user made.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
  // Retries: a git still finishing in the repo (a snapshot) can make the first rmdir fail (ENOTEMPTY).
  return { dir, git, done: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) };
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
      // ad's own hooks write the project's .agent-daemon/ during every turn: never part of it.
      mkdirSync(join(r.dir, ".agent-daemon", "telemetry"), { recursive: true });
      writeFileSync(join(r.dir, ".agent-daemon", "telemetry", "session-start.jsonl"), "{}\n");
      writeFileSync(join(r.dir, ".agent-daemon", "last-digest-sweep.flag"), "now");
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
    assert.equal(file(r.dir, ".agent-daemon/last-digest-sweep.flag"), "now", "ad's own state is left alone");
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
    // --attr-source doesn't cover .git/info/attributes: then it isn't promised.
    writeFileSync(join(r.dir, ".git", "info", "attributes"), "* text=auto\n");
    const cp2 = createCheckpoints({ cwd: r.dir });
    await turn(cp2, "t", "v", () => writeFileSync(join(r.dir, "win.txt"), "again\r\n"));
    assert.equal((await cp2.plan("t", "v", { agentPaths: ["win.txt"] })).byteExact, false);
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
    calls: [],
    snapshot: async () => ({ tree: "typing-tree" }),
    freshSnapshot: async (since) => (cp.calls.push(["fresh", since]), { tree: "after-tree", skipped: ["grew.bin"] }),
    hashPaths: async (paths) => Object.fromEntries(paths.map((p) => [p, `blob:${p}`])),
    beforeSnapshot: async ({ since, waitMs }) => (cp.calls.push(["before", since]), slowBefore ? Promise.race([slow, new Promise((r) => setTimeout(() => r(null), waitMs))]) : { tree: "before-tree", skipped: ["big.bin"] }),
    record: async (thread, turn, trees) => (recorded.push({ thread, turn, ...trees }), true),
    restore: async (thread, turnId, opts) => (cp.lastRestore = { turnId, ...opts }, { restored: 1, paths: [], conflicts: [] }),
  };
  return { cp, recorded, release };
}

// The session while the prompt's turn/start runs.
const STARTING = { state: { starting: true } };

function fakeSession() {
  const st = { thread: { id: "t" }, turns: [], items: new Map(), activeTurnId: null, starting: false };
  return { state: st, revert: async (id) => (st.reverted = id) };
}

test("a late 'before' means no checkpoint for that turn, never the previous turn's state", async () => {
  const { cp, recorded } = fakeCp({ slowBefore: true });
  const w = checkpointWiring(cp, { cwd: "/repo", waitMs: 20 });
  const s = fakeSession();
  await w.hooks.beforeTurn({ input: [] });
  w.hooks.turnStarted({ turn: { id: "u1" }, session: STARTING });
  await w.hooks.turnCompleted({ turn: { id: "u1" }, session: s });
  assert.deepEqual(recorded, []);
  s.state.turns.push({ id: "u1", status: "completed", itemIds: [] });
  assert.match((await w.undo(s)).error, /The last turn has no checkpoint \(the snapshot before it wasn't ready in time\)/);
});

test("/undo waits for the last turn's checkpoint, undoes only that turn, and only the agent's reported files", async () => {
  const { cp, recorded } = fakeCp();
  let clock = 1000;
  const w = checkpointWiring(cp, { cwd: "/repo", now: () => (clock += 10) });
  const s = fakeSession();
  for (const id of ["u1", "u2"]) {
    const sent = clock;
    await w.hooks.beforeTurn({ input: [] });
    assert.ok(cp.calls.at(-1)[1] > sent, "the 'before' is a snapshot from the moment the prompt is sent");
    w.hooks.turnStarted({ turn: { id }, session: STARTING });
    s.state.items.set(`fc-${id}`, { id: `fc-${id}`, turnId: id, kind: "fileChange", status: "completed", changes: [{ path: `src/${id}.js` }, { path: "/repo/abs.txt", movePath: "/repo/moved.txt" }] });
    // A patch the user declined isn't the agent's change.
    s.state.items.set(`fcd-${id}`, { id: `fcd-${id}`, turnId: id, kind: "fileChange", status: "declined", changes: [{ path: "declined.txt" }] });
    w.hooks.itemCompleted({ item: s.state.items.get(`fc-${id}`) });
    w.hooks.itemCompleted({ item: s.state.items.get(`fcd-${id}`) });
    s.state.items.set(`um-${id}`, { id: `um-${id}`, kind: "userMessage", text: "<private>secret prompt</private>" });
    s.state.turns.push({ id, status: "completed", itemIds: [`um-${id}`, `fc-${id}`, `fcd-${id}`] });
    w.hooks.turnCompleted({ turn: { id }, session: s }); // not awaited, as the session does
  }
  const r = await w.undo(s); // right away: must wait for u2's recording, not fall back to u1
  assert.equal(recorded.length, 2);
  assert.equal(cp.lastRestore.turnId, "u2");
  assert.deepEqual(cp.lastRestore.agentPaths.sort(), ["abs.txt", "moved.txt", "src/u2.js"]);
  assert.deepEqual(cp.lastRestore.skipped, ["big.bin", "grew.bin"], "what either snapshot left out goes along");
  assert.deepEqual(cp.lastRestore.agentBlobs, { "src/u2.js": "blob:src/u2.js", "abs.txt": "blob:abs.txt", "moved.txt": "blob:moved.txt" }, "each applied edit hashed as it completed; the declined one not");
  assert.ok(cp.calls.some((c) => c[0] === "fresh"), "the 'after' is a fresh snapshot");
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

test("what checkpoints leave out can't be undone: a big file, a heavy folder, a file that grew too big", async () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, "notes.txt"), "OLD small notes");
    mkdirSync(join(r.dir, "build"));
    writeFileSync(join(r.dir, "build", "config.js"), "tracked in a heavy folder");
    r.git("add", "build/config.js");
    r.git("commit", "-qm", "build");
    const cp = createCheckpoints({ cwd: r.dir, maxUntrackedBytes: 1000 });
    await cp.snapshot(); // notes.txt is small here, so the private index holds it
    writeFileSync(join(r.dir, "notes.txt"), "N".repeat(5000)); // the user's notes grow past the limit
    writeFileSync(join(r.dir, "data.json"), "D".repeat(5000)); // a big untracked file
    const before = await cp.snapshot();
    assert.deepEqual(before.skipped.sort(), ["data.json", "notes.txt"]);
    writeFileSync(join(r.dir, "data.json"), "{}"); // the agent rewrites it small
    writeFileSync(join(r.dir, "notes.txt"), "agent");
    writeFileSync(join(r.dir, "build", "config.js"), "agent edit");
    const after = await cp.snapshot();
    await cp.record("t", "u", { before: before.tree, after: after.tree });
    const agentPaths = ["data.json", "notes.txt", "build/config.js"];
    const plan = await cp.plan("t", "u", { agentPaths, skipped: before.skipped });
    assert.deepEqual(plan.conflicts.map((c) => [c.path, c.why]).sort(), [["build/config.js", "not in the checkpoint"], ["data.json", "not in the checkpoint"], ["notes.txt", "not in the checkpoint"]]);
    const forced = await cp.restore("t", "u", { force: true, agentPaths, skipped: before.skipped });
    assert.equal(forced.restored, 0);
    assert.equal(file(r.dir, "data.json"), "{}", "never deleted");
    assert.equal(file(r.dir, "notes.txt"), "agent", "never put back to a stale copy");
    // What is left out is out of the tree too (no stale copy from an older snapshot).
    assert.equal(r.git("ls-tree", "--name-only", before.tree, "notes.txt").trim(), "");
    // The agent deleting a big file it never saw: nothing to put back, and /undo says so.
    writeFileSync(join(r.dir, "huge.log"), "H".repeat(5000));
    const b2 = await cp.snapshot();
    rmSync(join(r.dir, "huge.log"));
    const a2 = await cp.snapshot();
    await cp.record("t", "u2", { before: b2.tree, after: a2.tree });
    const p2 = await cp.plan("t", "u2", { agentPaths: ["huge.log"], skipped: b2.skipped });
    assert.deepEqual(p2.conflicts.map((c) => [c.path, c.why]), [["huge.log", "not in the checkpoint"]]);
  } finally {
    r.done();
  }
});

test("the user's edits during the turn, a file where a folder was, a deleted heavy-folder file, the user's index.lock: never undone blindly", async () => {
  const r = repo();
  try {
    const cp = createCheckpoints({ cwd: r.dir });
    // 1. The agent edits a file; the user then adds a line to it before the turn ends.
    const before = await cp.snapshot();
    writeFileSync(join(r.dir, "with space.txt"), "agent");
    const agentBlobs = await cp.hashPaths(["with space.txt"]); // as the edit completes
    writeFileSync(join(r.dir, "with space.txt"), "agent\nthe user's line");
    const after = await cp.snapshot();
    await cp.record("t", "u", { before: before.tree, after: after.tree });
    const p1 = await cp.plan("t", "u", { agentPaths: ["with space.txt"], agentBlobs });
    assert.deepEqual(p1.conflicts, [{ path: "with space.txt", why: "changed since the agent's edit" }]);
    const n1 = await cp.restore("t", "u", { agentPaths: ["with space.txt"], agentBlobs });
    assert.match(n1.error, /Not undone: with space\.txt \(changed since the agent's edit\)/);
    assert.equal(file(r.dir, "with space.txt"), "agent\nthe user's line", "never silently");
    // The same when the "after" snapshot is read only after the user's save.
    // Forced, it is the user's choice: the turn's file comes back.
    const f1 = await cp.restore("t", "u", { force: true, agentPaths: ["with space.txt"], agentBlobs });
    assert.equal(f1.restored, 1);
    assert.equal(file(r.dir, "with space.txt"), "keep");
    // Without the user's line, the same undo goes through.
    writeFileSync(join(r.dir, "old name.txt"), "agent only");
    const b2 = await cp.snapshot();
    writeFileSync(join(r.dir, "old name.txt"), "agent again");
    const blobs2 = await cp.hashPaths(["old name.txt"]);
    const a2 = await cp.snapshot();
    await cp.record("t", "u2", { before: b2.tree, after: a2.tree });
    assert.equal((await cp.restore("t", "u2", { agentPaths: ["old name.txt"], agentBlobs: blobs2 })).restored, 1);
    assert.equal(file(r.dir, "old name.txt"), "agent only");

    // 2. The agent deletes notes/todo.md; the user then makes a file called notes.
    mkdirSync(join(r.dir, "notes"));
    writeFileSync(join(r.dir, "notes", "todo.md"), "todo");
    const b3 = await cp.snapshot();
    rmSync(join(r.dir, "notes"), { recursive: true });
    const blobs3 = await cp.hashPaths(["notes/todo.md"]);
    const a3 = await cp.snapshot();
    await cp.record("t", "u3", { before: b3.tree, after: a3.tree });
    writeFileSync(join(r.dir, "notes"), "the user's notes file");
    const p3 = await cp.plan("t", "u3", { agentPaths: ["notes/todo.md"], agentBlobs: blobs3 });
    assert.deepEqual(p3.conflicts, [{ path: "notes/todo.md", why: "a file is where its folder was" }]);
    await cp.restore("t", "u3", { force: true, agentPaths: ["notes/todo.md"], agentBlobs: blobs3 });
    assert.equal(file(r.dir, "notes"), "the user's notes file");

    // 3. The agent deletes an untracked file in a heavy folder: never snapshotted, so not undone.
    mkdirSync(join(r.dir, "build"));
    writeFileSync(join(r.dir, "build", "release.sh"), "echo hi");
    const b4 = await cp.snapshot();
    rmSync(join(r.dir, "build", "release.sh"));
    const a4 = await cp.snapshot();
    await cp.record("t", "u4", { before: b4.tree, after: a4.tree });
    const p4 = await cp.plan("t", "u4", { agentPaths: ["build/release.sh"], agentBlobs: {} });
    assert.deepEqual(p4.conflicts, [{ path: "build/release.sh", why: "not in the checkpoint" }]);
    // A scratch file the agent made and removed is fine.
    assert.deepEqual((await cp.plan("t", "u4", { agentPaths: ["scratch.tmp"], agentBlobs: {} })).conflicts, []);

    // 4. The user's index is locked (their own git running): /undo still works, without touching it.
    writeFileSync(join(r.dir, "crlf.txt"), "x\r\n");
    const b5 = await cp.snapshot();
    writeFileSync(join(r.dir, "crlf.txt"), "y\r\n");
    const blobs5 = await cp.hashPaths(["crlf.txt"]);
    const a5 = await cp.snapshot();
    await cp.record("t", "u5", { before: b5.tree, after: a5.tree });
    writeFileSync(join(r.dir, ".git", "index.lock"), "");
    const res5 = await cp.restore("t", "u5", { agentPaths: ["crlf.txt"], agentBlobs: blobs5 });
    assert.equal(res5.error, undefined);
    assert.equal(file(r.dir, "crlf.txt"), "x\r\n");
    assert.equal(readFileSync(join(r.dir, ".git", "index.lock"), "utf8"), "", "their lock is theirs");
    rmSync(join(r.dir, ".git", "index.lock"));
  } finally {
    r.done();
  }
});

test("a stale lock on ad's private index (git killed at its timeout) doesn't stop every later snapshot", async () => {
  const r = repo();
  try {
    const cp = createCheckpoints({ cwd: r.dir });
    const { index } = await cp.repo();
    writeFileSync(`${index}.lock`, "");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(`${index}.lock`, old, old);
    assert.ok(await cp.snapshot(), cp.lastError);
    writeFileSync(`${index}.lock`, ""); // a fresh one is another ad's git at work: respected
    assert.equal(await cp.snapshot(), null);
    assert.match(cp.lastError, /lock/);
  } finally {
    r.done();
  }
});

test("an edit named through another path to the repo (8.3 short name, junction, symlink) is still the agent's", async () => {
  const { symlinkSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "ad-real-"));
  const link = `${root}-link`;
  try {
    symlinkSync(root, link, "junction"); // a junction on Windows (no admin needed), a symlink elsewhere
    const { cp } = fakeCp();
    cp.repo = async () => ({ root });
    const w = checkpointWiring(cp, { cwd: link });
    const s = fakeSession();
    await w.hooks.beforeTurn({ input: [] });
    w.hooks.turnStarted({ turn: { id: "u1" }, session: STARTING });
    // Codex names the files by the other path; one of them doesn't exist (deleted).
    s.state.items.set("fc", { id: "fc", turnId: "u1", kind: "fileChange", status: "completed", changes: [{ path: join(link, "src", "gone.js") }, { path: "rel.txt" }] });
    w.hooks.itemCompleted({ item: s.state.items.get("fc") });
    s.state.turns.push({ id: "u1", status: "completed", itemIds: ["fc"] });
    await w.hooks.turnCompleted({ turn: { id: "u1" }, session: s });
    await w.undo(s);
    assert.deepEqual(cp.lastRestore.agentPaths.sort(), ["rel.txt", "src/gone.js"]);
  } finally {
    rmSync(link, { recursive: false, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("the turn starts only after its 'before' is done; a turn the server starts on its own never takes it", async () => {
  const { cp, recorded, release } = fakeCp({ slowBefore: true });
  const w = checkpointWiring(cp, { cwd: "/repo", waitMs: 2000 });
  const s = fakeSession();
  let sent = false;
  const sending = w.hooks.beforeTurn({ input: [] }).then(() => (sent = true));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent, false, "turn/start waits for the snapshot: nothing the agent does can be in it");
  release({ tree: "before-tree", skipped: [] });
  await sending;
  // The prompt's turn/start failed; later the server starts a turn on its own (a review, a goal).
  w.hooks.turnStartFailed({ error: new Error("engine gone") });
  w.hooks.turnStarted({ turn: { id: "server" } });
  s.state.turns.push({ id: "server", status: "completed", itemIds: [] });
  await w.hooks.turnCompleted({ turn: { id: "server" }, session: s });
  assert.deepEqual(recorded, [], "no older 'before' for it");
  assert.match((await w.undo(s)).error, /no checkpoint \(it wasn't started from a prompt here\)/);
});

// The agent's edit of `file` to `content`, as the wiring records it: its diff's counts, and the blob it left.
async function agentEdit(r, cp, file_, content, plus, minus, { src = file_ } = {}) {
  if (src !== file_) rmSync(join(r.dir, src));
  if (content === null) rmSync(join(r.dir, file_));
  else writeFileSync(join(r.dir, file_), content);
  const hashes = await cp.hashPaths([file_]);
  return { src, dst: file_, plus, minus, blob: content === null ? null : hashes[file_] };
}

async function turnWith(r, cp, id, body) {
  const before = await cp.snapshot();
  const agentChain = await body();
  const after = await cp.snapshot();
  await cp.record("t", id, { before: before.tree, after: after.tree });
  const paths = [...new Set(agentChain.flatMap((e) => [e.src, e.dst]))];
  const agentBlobs = await cp.hashPaths(paths);
  return { agentPaths: paths, agentBlobs, agentChain };
}

test("a save of the user's during the turn, before or between the agent's edits to that file, is never undone with it", async () => {
  const r = repo();
  try {
    const cp = createCheckpoints({ cwd: r.dir });
    const f = "with space.txt"; // committed as "keep"
    // The user saves, then the agent's one edit (+1).
    let o = await turnWith(r, cp, "u1", async () => {
      writeFileSync(join(r.dir, f), "keep\nthe user's line\n");
      return [await agentEdit(r, cp, f, "keep\nthe user's line\nthe agent's line\n", ["the agent's line"], [])];
    });
    assert.deepEqual((await cp.plan("t", "u1", o)).conflicts, [{ path: f, why: "changed during the turn" }]);
    assert.equal((await cp.restore("t", "u1", { ...o, force: true })).restored, 0, "not even forced: the user's line would go");
    assert.equal(file(r.dir, f), "keep\nthe user's line\nthe agent's line\n");

    // K: the agent changes l2 to DBG, the user saves line 1, the agent changes DBG back: +2/-2 overall, net +1/-1.
    writeFileSync(join(r.dir, "k.txt"), "l1\nl2\nl3\n");
    o = await turnWith(r, cp, "uK", async () => [
      await agentEdit(r, cp, "k.txt", "l1\nDBG\nl3\n", ["DBG"], ["l2"]),
      (writeFileSync(join(r.dir, "k.txt"), "USER\nDBG\nl3\n"), await agentEdit(r, cp, "k.txt", "USER\nl2\nl3\n", ["l2"], ["DBG"])),
    ]);
    assert.deepEqual((await cp.plan("t", "uK", o)).conflicts, [{ path: "k.txt", why: "changed during the turn" }]);

    // B: the agent adds a block, the user changes another line, the agent rewrites its block.
    writeFileSync(join(r.dir, "b.txt"), "top\nmid\nend\n");
    o = await turnWith(r, cp, "uB", async () => [
      await agentEdit(r, cp, "b.txt", "top\nmid\nend\na\nb\nc\n", ["a", "b", "c"], []),
      (writeFileSync(join(r.dir, "b.txt"), "TOP!\nmid\nend\na\nb\nc\n"), await agentEdit(r, cp, "b.txt", "TOP!\nmid\nend\nx\ny\nz\n", ["x", "y", "z"], ["a", "b", "c"])),
    ]);
    assert.deepEqual((await cp.plan("t", "uB", o)).conflicts, [{ path: "b.txt", why: "changed during the turn" }]);

    // A move after the user's save of the source.
    writeFileSync(join(r.dir, "src.txt"), "s1\n");
    o = await turnWith(r, cp, "uM", async () => {
      writeFileSync(join(r.dir, "src.txt"), "s1\nthe user's\n");
      return [await agentEdit(r, cp, "dst.txt", "s1\nthe user's\n", [], [], { src: "src.txt" })];
    });
    assert.ok((await cp.plan("t", "uM", o)).conflicts.some((c) => c.why === "changed during the turn"), "a move doesn't hide it");

    // Y: equal counts. The user changes B to X; the agent changes A to B (+1/-1, the same as the net change).
    writeFileSync(join(r.dir, "y.txt"), "A\nB\n");
    o = await turnWith(r, cp, "uY", async () => {
      writeFileSync(join(r.dir, "y.txt"), "A\nX\n");
      return [await agentEdit(r, cp, "y.txt", "B\nX\n", ["B"], ["A"])];
    });
    assert.deepEqual((await cp.plan("t", "uY", o)).conflicts, [{ path: "y.txt", why: "changed during the turn" }], "the lines themselves are compared");

    // A file the agent moved in from outside the repo: its only copy. Never deleted, even forced.
    o = await turnWith(r, cp, "uO", async () => {
      writeFileSync(join(r.dir, "in.txt"), "precious\n");
      return [{ src: "in.txt", dst: "in.txt", foreign: true }];
    });
    o.agentBlobs = await cp.hashPaths(["in.txt"]);
    assert.deepEqual((await cp.plan("t", "uO", o)).conflicts, [{ path: "in.txt", why: "not in the checkpoint" }]);
    await cp.restore("t", "uO", { ...o, force: true });
    assert.equal(file(r.dir, "in.txt"), "precious\n");

    // Clean: several edits of the agent's own, a clean move, a binary file: all undone.
    writeFileSync(join(r.dir, "m.txt"), "one\n");
    writeFileSync(join(r.dir, "bin.dat"), "a\0b\n");
    writeFileSync(join(r.dir, "mv.txt"), "moving\n");
    o = await turnWith(r, cp, "uC", async () => [
      await agentEdit(r, cp, "m.txt", "one\ntwo\n", ["two"], []),
      await agentEdit(r, cp, "m.txt", "one\nTWO\nthree\n", ["TWO", "three"], ["two"]),
      await agentEdit(r, cp, "bin.dat", "a\0B\n", ["a\0B"], ["a\0b"]),
      await agentEdit(r, cp, "moved.txt", "moving\n", [], [], { src: "mv.txt" }),
      await agentEdit(r, cp, "mv.txt", "fresh\n", ["fresh"], []), // a new file where the moved one was
    ]);
    const ok = await cp.restore("t", "uC", o);
    assert.equal(ok.error, undefined, ok.error);
    assert.equal(file(r.dir, "m.txt"), "one\n");
    assert.equal(file(r.dir, "bin.dat"), "a\0b\n", "binary: compared as text, not refused");
    assert.equal(file(r.dir, "mv.txt"), "moving\n");
    assert.ok(!existsSync(join(r.dir, "moved.txt")));
  } finally {
    r.done();
  }
});

test("the wiring records each applied edit in order for that check: its paths, its diff's counts, its result", async () => {
  const { cp } = fakeCp();
  const w = checkpointWiring(cp, { cwd: "/repo" });
  const s = fakeSession();
  await w.hooks.beforeTurn({ input: [] });
  w.hooks.turnStarted({ turn: { id: "u1" }, session: STARTING });
  const edit = (id, changes) => {
    const it = { id, turnId: "u1", kind: "fileChange", status: "completed", changes };
    s.state.items.set(id, it);
    w.hooks.itemCompleted({ item: it });
  };
  edit("e1", [{ path: "a.js", kind: "update", diff: "@@ -1 +1,2 @@\n-x\n+y\n+z" }]);
  edit("e2", [{ path: "a.js", kind: "update", diff: "@@ -2 +2 @@\n-z\n+w" }, { path: "new.txt", kind: "add", diff: "one\ntwo\n" }, { path: "gone.txt", kind: "delete", diff: "x\n" }]);
  edit("e3", [{ path: "old.js", movePath: "moved.js", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b" }]);
  edit("e4", [{ path: "/outside/precious.txt", movePath: "in.txt", kind: "update", diff: "" }, { path: "blank.txt", kind: "add", diff: "\n" }]);
  s.state.turns.push({ id: "u1", status: "completed", itemIds: ["e1", "e2", "e3", "e4"] });
  await w.hooks.turnCompleted({ turn: { id: "u1" }, session: s });
  await w.undo(s);
  assert.deepEqual(cp.lastRestore.agentChain, [
    { src: "a.js", dst: "a.js", plus: ["y", "z"], minus: ["x"], blob: "blob:a.js" },
    { src: "a.js", dst: "a.js", plus: ["w"], minus: ["z"], blob: "blob:a.js" },
    { src: "new.txt", dst: "new.txt", plus: ["one", "two"], minus: [], blob: "blob:new.txt" },
    { src: "gone.txt", dst: "gone.txt", plus: [], minus: ["x"], blob: null },
    { src: "old.js", dst: "moved.js", plus: ["b"], minus: ["a"], blob: "blob:moved.js" },
    { src: "blank.txt", dst: "blank.txt", plus: [""], minus: [], blob: "blob:blank.txt" }, // a file of one empty line
    { src: "in.txt", dst: "in.txt", foreign: true }, // moved in from outside: never deleted
  ]);
});

test("/undo says when edits outside the repo weren't touched, and offers force only where it can do something", async () => {
  const { cp } = fakeCp();
  const w = checkpointWiring(cp, { cwd: "/repo" });
  const s = fakeSession();
  const turn = async (id, paths) => {
    await w.hooks.beforeTurn({ input: [] });
    w.hooks.turnStarted({ turn: { id }, session: STARTING });
    const it = { id: `fc-${id}`, turnId: id, kind: "fileChange", status: "completed", changes: paths.map((p) => ({ path: p, kind: "update", diff: "" })) };
    s.state.items.set(it.id, it);
    w.hooks.itemCompleted({ item: it });
    s.state.turns.push({ id, status: "completed", itemIds: [it.id] });
    await w.hooks.turnCompleted({ turn: { id }, session: s });
  };
  await turn("u1", ["a.js", "/elsewhere/notes.txt"]);
  assert.match((await w.undo(s)).message, /1 file put back\. 1 edit outside this repo wasn't touched\./);
  await turn("u2", ["a.js"]);
  cp.restore = async () => ({ error: "Not undone: a.js (changed during the turn).", conflicts: [{ path: "a.js", why: "changed during the turn" }] });
  assert.doesNotMatch((await w.undo(s)).error, /force/, "force can't help there");
  cp.restore = async () => ({ error: "Not undone: a.js (changed since the agent's edit).", conflicts: [{ path: "a.js", why: "changed since the agent's edit" }] });
  assert.match((await w.undo(s)).error, /\/undo force puts the agent's files back anyway/);
});

test("an edit whose result couldn't be read leaves the turn without a checkpoint", async () => {
  const { cp, recorded } = fakeCp();
  cp.hashPaths = async () => {
    throw new Error("git hash-object failed");
  };
  const w = checkpointWiring(cp, { cwd: "/repo" });
  const s = fakeSession();
  await w.hooks.beforeTurn({ input: [] });
  w.hooks.turnStarted({ turn: { id: "u1" }, session: STARTING });
  const it = { id: "fc", turnId: "u1", kind: "fileChange", status: "completed", changes: [{ path: "a.js", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b" }] };
  s.state.items.set("fc", it);
  w.hooks.itemCompleted({ item: it });
  s.state.turns.push({ id: "u1", status: "completed", itemIds: ["fc"] });
  await w.hooks.turnCompleted({ turn: { id: "u1" }, session: s });
  assert.deepEqual(recorded, []);
  assert.match((await w.undo(s)).error, /no checkpoint \(an edit's result couldn't be read\)/);
});

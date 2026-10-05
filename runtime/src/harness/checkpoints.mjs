// Checkpoints and /undo (plan Part 10, spike S4).
//
// Why not Codex's own undo: Codex's "ghost commit" undo (openai/codex#3914,
// TUI #5629) snapshotted the worktree on every turn and recorded the
// snapshots in the session rollout. In big repos that was slow (#6977,
// #6990), and listing every untracked file in every snapshot grew one
// session file to 1.9 GB (#7395). Standard folders were then ignored
// (#7483), and the feature became an opt-in `undo` flag and later a no-op.
//
// So ad's checkpoints:
//   - live only as git trees under refs/ad/checkpoints/<thread>/<turn>-{before,after}
//     (nothing in any rollout or log), written by one batched update-ref;
//   - use a private, persistent index (.git/ad-checkpoint-index), so the
//     stat and untracked caches survive between snapshots, and the user's
//     index, HEAD, branches and stash are never touched;
//   - respect .gitignore, skip untracked files over a size limit and the
//     usual heavy folders, and keep only the last N turns per thread;
//   - are taken off the turn's critical path: when the user starts typing
//     and when a turn ends. A turn waits at most 150 ms for one in flight.
//
// Restore puts back what a turn changed (the before→after diff of the
// turn), refusing paths the user changed since, then rewinds the thread.

import { spawn } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export const CHECKPOINT_REF = "refs/ad/checkpoints";
// Snapshots, comparisons and restores all see bytes as they are on disk (no eol conversion).
const EXACT = ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "-c", "core.safecrlf=false"];
const HEAVY_DIRS = ["node_modules", ".venv", "venv", "__pycache__", ".next", "dist", "build", "target", ".gradle", ".turbo", ".cache"];

/** Runs git; never throws for a non-zero exit. */
export function runGit(args, { cwd, env = {}, input = null, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("git", args, { cwd, env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" }, windowsHide: true });
    } catch (err) {
      return resolve({ code: 127, stdout: "", stderr: err.message });
    }
    const out = [];
    const errs = [];
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => errs.push(d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: "", stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(errs).toString("utf8") });
    });
    child.stdin.end(input ?? undefined);
  });
}

const safeRefPart = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 120);

export function createCheckpoints({ cwd, git = runGit, maxUntrackedBytes = 2 * 1024 * 1024, keep = 20, now = () => Date.now() } = {}) {
  let info = null; // {root, index, userIndex} once known
  let inFlight = null; // the snapshot being taken

  const g = (args, opts = {}) => git(args, { cwd: info?.root ?? cwd, ...opts });

  async function repo() {
    if (info) return info;
    const top = await git(["rev-parse", "--show-toplevel"], { cwd });
    if (top.code !== 0) return null;
    const root = top.stdout.trim();
    const bare = await git(["rev-parse", "--is-bare-repository"], { cwd: root });
    if (bare.stdout.trim() === "true") return null;
    const paths = await git(["rev-parse", "--git-path", "index", "--git-path", "ad-checkpoint-index"], { cwd: root });
    const [userIndex, index] = paths.stdout.split(/\r?\n/).map((p) => path.resolve(root, p.trim()));
    info = { root, index, userIndex };
    return info;
  }

  /** Untracked files (respecting .gitignore) larger than the limit, as exclude pathspecs. */
  async function bigUntracked(root) {
    const r = await g(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root });
    const big = [];
    for (const f of r.stdout.split("\0").filter(Boolean)) {
      try {
        if (statSync(path.join(root, f)).size > maxUntrackedBytes) big.push(f);
      } catch {
        // gone meanwhile
      }
    }
    return big;
  }

  /** A tree of the worktree now, or null (not a repo, git failed). */
  async function takeSnapshot() {
    const r = await repo();
    if (!r) return null;
    const env = { GIT_INDEX_FILE: r.index };
    // The private index is never seeded from the user's: its blobs were made
    // under the user's eol filters, and restores would not be byte for byte.
    // The first snapshot hashes everything once; later ones reuse its stat cache.
    const big = await bigUntracked(r.root);
    const specs = [".", ...HEAVY_DIRS.map((d) => `:(exclude,glob)**/${d}/**`), ...big.map((f) => `:(exclude,literal)${f}`)];
    const add = await g(["-c", "gc.auto=0", ...EXACT, "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], { cwd: r.root, env, input: specs.join("\0") });
    if (add.code !== 0) return null;
    const tree = await g(["write-tree"], { cwd: r.root, env });
    if (tree.code !== 0) return null;
    return { tree: tree.stdout.trim(), at: now(), skipped: big };
  }

  /** Starts a snapshot unless one is running; returns its promise. */
  function snapshot() {
    inFlight ??= takeSnapshot().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  /** The snapshot in flight (or a fresh one), waiting at most `ms`; null when late. */
  async function snapshotWithin(ms = 150) {
    const p = inFlight ?? snapshot();
    let timer;
    const late = new Promise((r) => (timer = setTimeout(() => r(null), ms)));
    try {
      return await Promise.race([p, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Records a turn's before/after trees in one update-ref, then prunes old turns. */
  async function record(threadId, turnId, trees) {
    const r = await repo();
    if (!r) return false;
    const base = `${CHECKPOINT_REF}/${safeRefPart(threadId)}/${safeRefPart(turnId)}`;
    const lines = Object.entries(trees)
      .filter(([, t]) => t)
      .map(([phase, t]) => `update ${base}-${phase} ${t}\n`);
    if (!lines.length) return false;
    const up = await g(["update-ref", "--stdin"], { cwd: r.root, input: lines.join("") });
    if (up.code !== 0) return false;
    await prune(threadId);
    return true;
  }

  async function list(threadId) {
    const r = await repo();
    if (!r) return [];
    const res = await g(["for-each-ref", "--sort=creatordate", "--format=%(refname) %(objectname)", `${CHECKPOINT_REF}/${safeRefPart(threadId)}/`], { cwd: r.root });
    const turns = new Map();
    for (const line of res.stdout.split(/\r?\n/).filter(Boolean)) {
      const [ref, sha] = line.split(" ");
      const m = /\/([^/]+)-(before|after)$/.exec(ref);
      if (!m) continue;
      const t = turns.get(m[1]) ?? { turnId: m[1], before: null, after: null, refs: [] };
      t[m[2]] = sha;
      t.refs.push(ref);
      turns.set(m[1], t);
    }
    return [...turns.values()];
  }

  async function prune(threadId) {
    const all = await list(threadId);
    const old = all.slice(0, Math.max(0, all.length - keep));
    if (!old.length) return;
    await g(["update-ref", "--stdin"], { input: old.flatMap((t) => t.refs.map((ref) => `delete ${ref}\n`)).join("") });
  }

  /** Paths a turn changed: [{status: A|M|D, path}]. */
  async function changes(before, after) {
    const d = await g(["diff-tree", "-r", "-z", "--no-renames", "--name-status", before, after]);
    const parts = d.stdout.split("\0").filter((x) => x !== "");
    const out = [];
    for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i][0], path: parts[i + 1] });
    return out;
  }

  // The blob id a path has in a tree, or null.
  async function blobIn(tree, p) {
    const r = await g(["rev-parse", "--verify", "--quiet", `${tree}:${p}`]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async function workBlob(root, p) {
    const abs = path.join(root, p);
    if (!existsSync(abs)) return null;
    // As git would store it now (filters applied), so CRLF/eol settings compare fairly.
    const r = await g([...EXACT, "hash-object", "--path", p, "--", abs]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /**
   * What undoing `turnId` would do: the paths to put back and any the user
   * changed since the turn (conflicts). Nothing is written.
   */
  async function plan(threadId, turnId) {
    const r = await repo();
    if (!r) return { error: "Not a git repo: /undo isn't available here." };
    const t = (await list(threadId)).find((x) => x.turnId === safeRefPart(turnId));
    if (!t?.before || !t?.after) return { error: "No checkpoint for that turn (taken only while ad tui runs, in a git repo)." };
    const paths = await changes(t.before, t.after);
    const conflicts = [];
    for (const c of paths) {
      const expected = c.status === "D" ? null : await blobIn(t.after, c.path);
      const now_ = await workBlob(r.root, c.path);
      if (now_ !== expected) conflicts.push(c.path);
    }
    return { before: t.before, after: t.after, paths, conflicts };
  }

  /** Puts back what the turn changed. Refuses when the user changed those files since, unless `force`. */
  async function restore(threadId, turnId, { force = false } = {}) {
    const p = await plan(threadId, turnId);
    if (p.error) return p;
    if (p.conflicts.length && !force) return { ...p, error: `Changed since that turn: ${p.conflicts.slice(0, 5).join(", ")}${p.conflicts.length > 5 ? "…" : ""}. Nothing was undone.` };
    const r = await repo();
    const back = p.paths.filter((c) => c.status !== "A").map((c) => c.path);
    if (back.length) {
      const res = await g([...EXACT, "restore", `--source=${p.before}`, "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"], { cwd: r.root, input: back.map((x) => `:(literal)${x}`).join("\0") });
      if (res.code !== 0) return { ...p, error: `git restore failed: ${res.stderr.trim().split("\n")[0]}` };
    }
    for (const c of p.paths.filter((x) => x.status === "A")) rmSync(path.join(r.root, c.path), { force: true });
    return { ...p, restored: p.paths.length };
  }

  return { repo, snapshot, snapshotWithin, record, list, plan, restore };
}

export const UNDO_LIMITS =
  "Not restored byte for byte: ignored files, submodule contents, and files git filters (LFS, eol conversion).";

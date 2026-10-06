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
//   - live only as git trees under refs/ad/checkpoints/<thread>/<seq>-<turn>-{before,after}
//     (nothing in any rollout or log), written by one batched update-ref;
//   - use a private, persistent index (.git/ad-checkpoint-index), so the
//     stat and untracked caches survive between snapshots, and the user's
//     index, HEAD, branches and stash are never touched;
//   - respect .gitignore, skip untracked files over a size limit and the
//     usual heavy folders, and keep only the last N turns per thread;
//   - a turn's "before" is started when the prompt is sent (typing-time
//     snapshots only warm git's caches); one that isn't ready in time means
//     no checkpoint for that turn, never a guess. Its "after" is started
//     after the turn ended.
//
// Undo is conservative: it puts back only what the agent's own edits
// changed. A path the agent didn't report editing, one changed since the
// turn, one changed during the turn by someone else, one the snapshots
// left out, or a directory standing where a file was, is a conflict, and
// nothing is undone (force overrides only the "changed since…" kinds).

import { spawn } from "node:child_process";
import { existsSync, lstatSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

export const CHECKPOINT_REF = "refs/ad/checkpoints";
// Snapshots, comparisons and restores all see bytes as they are on disk (no
// eol conversion); with git 2.40+ the repo's .gitattributes are ignored too.
const EXACT = ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "-c", "core.safecrlf=false"];
// Never snapshotted: heavy folders, and ad's own state (its hooks write
// .agent-daemon/ during every turn; that is never the agent's work to undo).
const HEAVY_DIRS = ["node_modules", ".venv", "venv", "__pycache__", ".next", "dist", "build", "target", ".gradle", ".turbo", ".cache", ".agent-daemon"];
const HEAVY_SPECS = HEAVY_DIRS.map((d) => `:(exclude,glob)**/${d}/**`);
const MAX_REFS = 400; // all threads together: about 200 turns
const STALE_LOCK_MS = 5 * 60_000;
// Conflicts `force` overrides: later changes to the agent's own files ("a
// folder is there now" is listed so it is reported, but a folder is never touched).
export const FORCEABLE = new Set(["changed since the turn", "changed since the agent's edit", "a folder is there now"]);
const FOLDS_CASE =process.platform === "win32" || process.platform === "darwin";

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
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? undefined);
  });
}

const safeRefPart = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 120);
const firstLine = (s) => String(s ?? "").trim().split("\n")[0];

function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

export function createCheckpoints({ cwd, git = runGit, maxUntrackedBytes = 2 * 1024 * 1024, keep = 20, now = () => Date.now() } = {}) {
  let info = null; // {root, index, exact} once known
  let inFlight = null; // {promise, startedAt}
  let latest = null; // the newest completed snapshot {tree, at, startedAt}
  let restores = 0; // scratch index names stay unique per restore
  let lastError = null;
  let seq = 0;

  const g = (args, opts = {}) => git(args, { cwd: info?.root ?? cwd, ...opts });

  async function repo() {
    if (info) return info;
    const top = await git(["rev-parse", "--show-toplevel"], { cwd });
    if (top.code !== 0) return null;
    const root = top.stdout.trim();
    const bare = await git(["rev-parse", "--is-bare-repository"], { cwd: root });
    if (bare.stdout.trim() === "true") return null;
    const p = await git(["rev-parse", "--git-path", "ad-checkpoint-index"], { cwd: root });
    const index = path.resolve(root, p.stdout.trim());
    // An empty tree as the attribute source makes .gitattributes (text=auto,
    // eol, filters) irrelevant: byte for byte (git 2.40+). Older git: without.
    const empty = (await git(["hash-object", "-t", "tree", "--stdin"], { cwd: root, input: "" })).stdout.trim();
    const probe = empty ? await git([`--attr-source=${empty}`, "rev-parse", "--git-dir"], { cwd: root }) : { code: 1 };
    const exact = probe.code === 0 ? [`--attr-source=${empty}`, ...EXACT] : EXACT;
    // --attr-source doesn't cover .git/info/attributes or a global attributes file.
    const infoAttr = path.resolve(root, (await git(["rev-parse", "--git-path", "info/attributes"], { cwd: root })).stdout.trim());
    const globalAttr = (await git(["config", "core.attributesFile"], { cwd: root })).stdout.trim();
    const extraAttr = (existsSync(infoAttr) && lstatOrNull(infoAttr)?.size > 0) || Boolean(globalAttr);
    info = { root, index, exact, byteExact: probe.code === 0 && !extraAttr };
    return info;
  }

  /** Untracked files (respecting .gitignore, outside heavy folders) larger than the limit. */
  async function bigUntracked(root) {
    const r = await g(["ls-files", "--others", "--exclude-standard", "-z", "--", ".", ...HEAVY_SPECS], { cwd: root });
    const files = r.stdout.split("\0").filter(Boolean);
    const big = [];
    // Stat in batches without blocking the UI's event loop.
    for (let i = 0; i < files.length; i += 256) {
      const batch = files.slice(i, i + 256);
      const sizes = await Promise.all(batch.map((f) => stat(path.join(root, f)).then((s) => s.size, () => 0)));
      sizes.forEach((size, k) => size > maxUntrackedBytes && big.push(batch[k]));
    }
    return big;
  }

  /** A tree of the worktree now, or null (not a repo, git failed: see lastError). */
  async function takeSnapshot(startedAt) {
    const r = await repo();
    if (!r) return null;
    const env = { GIT_INDEX_FILE: r.index };
    // A lock on ad's private index left by a git killed at its timeout (git
    // runs here never last past 60 s): stale, or every snapshot would fail.
    const lock = lstatOrNull(`${r.index}.lock`);
    if (lock && Date.now() - lock.mtimeMs > STALE_LOCK_MS) rmSync(`${r.index}.lock`, { force: true });
    // The private index is never seeded from the user's: its blobs were made
    // under the user's eol filters, and restores would not be byte for byte.
    const big = await bigUntracked(r.root);
    // What is left out must leave the private index too: an old entry would
    // otherwise stay in every later tree and be "restored" stale.
    if (existsSync(r.index)) {
      const out = [...HEAVY_DIRS.map((d) => `:(glob)**/${d}/**`), ...big.map((f) => `:(literal)${f}`)];
      // -f: an entry that differs from both HEAD and the file (it grew too big
      // since) is otherwise refused. --cached: only the private index changes.
      const rm = await g(["rm", "--cached", "-f", "-r", "-q", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], { cwd: r.root, env, input: out.join("\0") });
      if (rm.code !== 0) {
        lastError = firstLine(rm.stderr) || "git rm --cached failed";
        return null;
      }
    }
    const specs = [".", ...HEAVY_SPECS, ...big.map((f) => `:(exclude,literal)${f}`)];
    const add = await g([...r.exact, "-c", "gc.auto=0", "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], { cwd: r.root, env, input: specs.join("\0") });
    if (add.code !== 0) {
      lastError = firstLine(add.stderr) || "git add failed";
      return null;
    }
    const tree = await g(["write-tree"], { cwd: r.root, env });
    if (tree.code !== 0) {
      lastError = firstLine(tree.stderr) || "git write-tree failed";
      return null;
    }
    lastError = null;
    const snap = { tree: tree.stdout.trim(), at: now(), startedAt, skipped: big };
    if (!latest || startedAt >= latest.startedAt) latest = snap;
    return snap;
  }

  /** Starts a snapshot unless one is running; returns its promise. */
  function snapshot() {
    if (!inFlight) {
      const startedAt = now();
      const promise = takeSnapshot(startedAt).finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
      });
      inFlight = { promise, startedAt };
    }
    return inFlight.promise;
  }

  /**
   * The "before" of a turn: a snapshot started after `since` (the previous
   * turn's end, or 0), taken before this turn. The newest finished one if it
   * qualifies; else one in flight or a new one, if it finishes within
   * `waitMs`. Null otherwise: no checkpoint for this turn, never a guess.
   */
  async function beforeSnapshot({ since = 0, waitMs = 150 } = {}) {
    if (latest && latest.startedAt >= since) return latest;
    const chain = (async () => {
      // One started before `since` reflects the previous turn mid-way: let it finish, then take a fresh one.
      if (inFlight && inFlight.startedAt < since) await inFlight.promise.catch(() => null);
      return inFlight && inFlight.startedAt >= since ? inFlight.promise : snapshot();
    })();
    let timer;
    const late = new Promise((r) => (timer = setTimeout(() => r(null), waitMs)));
    try {
      return await Promise.race([chain, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** A snapshot started at or after `since` (waits for an older one in flight first). */
  async function freshSnapshot(since) {
    if (inFlight && inFlight.startedAt < since) await inFlight.promise.catch(() => null);
    return inFlight && inFlight.startedAt >= since ? inFlight.promise : snapshot();
  }

  /** Records a turn's before/after trees in one update-ref, then prunes old turns. */
  async function record(threadId, turnId, trees) {
    const r = await repo();
    if (!r) return false;
    // A sequence in the name keeps the refs in turn order (trees carry no date).
    const order = `${String(now()).padStart(15, "0")}${String(seq++ % 1000).padStart(3, "0")}`;
    const base = `${CHECKPOINT_REF}/${safeRefPart(threadId)}/${order}-${safeRefPart(turnId)}`;
    const lines = Object.entries(trees)
      .filter(([, t]) => t)
      .map(([phase, t]) => `update ${base}-${phase} ${t}\n`);
    if (!lines.length) return false;
    const up = await g(["update-ref", "--stdin"], { cwd: r.root, input: lines.join("") });
    if (up.code !== 0) return false;
    await prune(threadId);
    return true;
  }

  async function listRefs(prefix) {
    const res = await g(["for-each-ref", "--format=%(refname) %(objectname)", prefix]);
    const turns = new Map();
    for (const line of res.stdout.split(/\r?\n/).filter(Boolean)) {
      const [ref, sha] = line.split(" ");
      const m = /\/(\d{18})-(.+)-(before|after)$/.exec(ref);
      if (!m) continue;
      const key = ref.slice(0, ref.lastIndexOf("-"));
      const t = turns.get(key) ?? { order: m[1], turnId: m[2], before: null, after: null, refs: [] };
      t[m[3]] = sha;
      t.refs.push(ref);
      turns.set(key, t);
    }
    return [...turns.values()].sort((a, b) => a.order.localeCompare(b.order));
  }

  async function list(threadId) {
    if (!(await repo())) return [];
    return listRefs(`${CHECKPOINT_REF}/${safeRefPart(threadId)}/`);
  }

  async function prune(threadId) {
    const old = (await list(threadId)).slice(0, -keep || undefined);
    // And a cap over all threads, so old conversations don't keep trees forever.
    const all = await listRefs(`${CHECKPOINT_REF}/`);
    const overall = all.slice(0, Math.max(0, all.length - Math.floor(MAX_REFS / 2)));
    const gone = [...new Set([...old, ...overall].flatMap((t) => t.refs))];
    if (gone.length) await g(["update-ref", "--stdin"], { input: gone.map((ref) => `delete ${ref}\n`).join("") });
  }

  /** Paths a turn changed: [{status: A|M|D|T, path}]. */
  async function changes(before, after) {
    const d = await g(["diff-tree", "-r", "-z", "--no-renames", "--name-status", before, after]);
    const parts = d.stdout.split("\0").filter((x) => x !== "");
    const out = [];
    for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i][0], path: parts[i + 1] });
    return out;
  }

  /** The lines added and removed from blob `a` to blob `b` (null: no file); null when git can't tell. */
  let emptyBlob = null;
  async function blobPatch(a, b) {
    if (a === b) return { plus: [], minus: [] };
    if ([a, b].some((x) => typeof x === "string" && x.startsWith("<"))) return null; // a folder, unreadable
    emptyBlob ??= (await g(["hash-object", "-w", "--stdin"], { input: "" })).stdout.trim();
    // The patch, not --numstat: --text applies to it (a file with a NUL byte or a
    // -diff attribute still counts by lines, as the agent's diff does).
    // Myers, minimal: a user's diff.algorithm can't make git's lines differ from the agent's diff.
    const d = await g(["diff", "--text", "--minimal", "--diff-algorithm=myers", "--unified=0", "--no-color", "--no-ext-diff", a ?? emptyBlob, b ?? emptyBlob]);
    if (d.code !== 0) return null;
    const plus = [];
    const minus = [];
    let inHunk = false;
    const cut = (l) => l.slice(1).replace(/\r$/, "");
    for (const line of d.stdout.split("\n")) {
      if (line.startsWith("@@")) inHunk = true;
      else if (inHunk && line.startsWith("+")) plus.push(cut(line));
      else if (inHunk && line.startsWith("-")) minus.push(cut(line));
    }
    // Different blobs and no hunk ("Binary files differ"): can't tell, so not a fit.
    return inHunk ? { plus, minus } : null;
  }

  // Every line in `lines` is one of `mine` (as many times as it appears there).
  function within(lines, mine) {
    const left = new Map();
    for (const l of mine ?? []) left.set(l, (left.get(l) ?? 0) + 1);
    for (const l of lines) {
      const n = left.get(l) ?? 0;
      if (!n) return false;
      left.set(l, n - 1);
    }
    return true;
  }

  async function blobIn(tree, p) {
    const r = await g(["rev-parse", "--verify", "--quiet", `${tree}:${p}`]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async function workBlob(root, p, exact) {
    const st = lstatOrNull(path.join(root, p));
    if (!st) return null;
    if (st.isDirectory()) return "<directory>";
    const r = await g([...exact, "hash-object", "--path", p, "--", path.join(root, p)]);
    return r.code === 0 ? r.stdout.trim() : "<unreadable>";
  }

  /** Each path's content now, as checkpoints hash it: {path: blob | null}. */
  async function hashPaths(paths) {
    const r = await repo();
    if (!r) return {};
    const out = {};
    const files = [];
    for (const p of paths) {
      const st = lstatOrNull(path.join(r.root, p));
      if (!st) out[p] = null;
      else if (st.isDirectory()) out[p] = "<directory>";
      else files.push(p);
    }
    // One git for all of them: the window in which a save counts as the agent's stays small.
    if (files.length) {
      // -w: kept, so each edit's result can be compared with the next one's.
      const res = await g([...r.exact, "hash-object", "-w", "--stdin-paths"], { cwd: r.root, input: `${files.join("\n")}\n` });
      const ids = res.code === 0 ? res.stdout.trim().split("\n") : [];
      // A miscount (a path with a newline) leaves them unreadable: then they are conflicts.
      files.forEach((p, i) => (out[p] = ids.length === files.length ? ids[i] : "<unreadable>"));
    }
    return out;
  }

  /** A leading part of `rel` that is no longer a real folder (a file or a symlink stands there). */
  function brokenParent(root, rel) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      const st = lstatOrNull(path.join(root, ...parts.slice(0, i)));
      if (st && (!st.isDirectory() || st.isSymbolicLink())) return true;
    }
    return false;
  }

  /** Never in any snapshot: inside a heavy folder, or ignored. */
  async function excluded(root, rel) {
    if (rel.split("/").slice(0, -1).some((d) => HEAVY_DIRS.includes(d))) return true;
    return (await g(["check-ignore", "-q", "--no-index", "--", rel], { cwd: root })).code === 0;
  }

  /**
   * What undoing `turnId` would do, without writing anything:
   * {paths, conflicts: [{path, why}]}. `agentPaths` (repo-relative, "/"
   * separated) are the files the agent's edits reported; anything else the
   * turn's diff shows (the user's editor, another agent, a command) is a
   * conflict rather than something to undo blindly.
   */
  async function plan(threadId, turnId, { agentPaths = null, skipped = [], agentBlobs = null, agentChain = null } = {}) {
    const r = await repo();
    if (!r) return { error: "Not a git repo: /undo isn't available here." };
    const t = (await list(threadId)).filter((x) => x.turnId === safeRefPart(turnId)).at(-1);
    if (!t?.before || !t?.after) return { error: "No checkpoint for that turn." };
    const paths = await changes(t.before, t.after);
    const key = (p) => (FOLDS_CASE ? p.toLowerCase() : p);
    const reported = agentPaths ? new Set(agentPaths.map(key)) : null;
    const left = new Set(skipped.map(key));
    const blobs = agentBlobs ? new Map(Object.entries(agentBlobs).map(([p, b]) => [key(p), b])) : null;
    const conflicts = [];
    // Each of the agent's edits must account for every line that changed
    // since the one before it (the turn's "before" for the first): any other
    // line means someone else (the user's save, a command) changed that file
    // during the turn, before or between the agent's edits, and undoing would
    // take it too.
    const tainted = new Set();
    const foreign = new Set(); // moved in from outside the repo: the only copy is here
    if (agentChain) {
      const last = new Map(); // key(path) → blob the agent's latest edit left (null: gone)
      for (const e of agentChain) {
        if (e.foreign) {
          foreign.add(key(e.dst));
          continue;
        }
        const from = last.has(key(e.src)) ? last.get(key(e.src)) : await blobIn(t.before, e.src);
        const n = await blobPatch(from, e.blob);
        if (!n || !within(n.plus, e.plus) || !within(n.minus, e.minus)) for (const p of [e.src, e.dst]) tainted.add(key(p));
        if (e.src !== e.dst) last.set(key(e.src), null);
        last.set(key(e.dst), e.blob);
      }
    }
    // The agent edited something the checkpoints left out (too big, a heavy
    // folder): there is nothing to put back, so it can't be undone.
    if (reported) {
      const inDiff = new Set(paths.map((c) => key(c.path)));
      for (const a of agentPaths) {
        if (inDiff.has(key(a))) continue;
        const was = await blobIn(t.before, a);
        const now_ = await workBlob(r.root, a, r.exact);
        // Gone before and after: fine for a scratch file, but a deleted
        // heavy-folder or ignored file was never snapshotted.
        if (left.has(key(a)) || was !== now_ || (was === null && (await excluded(r.root, a)))) conflicts.push({ path: a, why: "not in the checkpoint" });
      }
    }
    for (const c of paths) {
      if (reported && !reported.has(key(c.path))) {
        conflicts.push({ path: c.path, why: "not changed by the agent's edits" });
        continue;
      }
      if (left.has(key(c.path))) {
        conflicts.push({ path: c.path, why: "not in the checkpoint" });
        continue;
      }
      if (foreign.has(key(c.path))) {
        conflicts.push({ path: c.path, why: "not in the checkpoint" });
        continue;
      }
      if (tainted.has(key(c.path))) {
        conflicts.push({ path: c.path, why: "changed during the turn" });
        continue;
      }
      if (brokenParent(r.root, c.path)) {
        conflicts.push({ path: c.path, why: "a file is where its folder was" });
        continue;
      }
      const current = await workBlob(r.root, c.path, r.exact);
      if (current === "<directory>") conflicts.push({ path: c.path, why: "a folder is there now" });
      else if (blobs) {
        // What the agent's last edit wrote, hashed as it landed: any change
        // after it (the user's, a formatter's), during the turn or since, is
        // one. "after" can't tell: it may be read after the user's next save.
        if (!blobs.has(key(c.path)) || current !== blobs.get(key(c.path))) conflicts.push({ path: c.path, why: "changed since the agent's edit" });
      } else if (current !== (c.status === "D" ? null : await blobIn(t.after, c.path))) conflicts.push({ path: c.path, why: "changed since the turn" });
    }
    return { before: t.before, after: t.after, paths, conflicts, byteExact: r.byteExact };
  }

  /**
   * Puts back what the turn changed. With conflicts nothing is done, unless
   * `force`: then the agent's files changed since its edit are put back too. Even forced,
   * a path the agent's edits didn't report is never touched, and a directory
   * is never removed or replaced.
   */
  async function restore(threadId, turnId, { force = false, agentPaths = null, skipped = [], agentBlobs = null, agentChain = null } = {}) {
    const p = await plan(threadId, turnId, { agentPaths, skipped, agentBlobs, agentChain });
    if (p.error) return p;
    if (p.conflicts.length && !force) {
      const list = p.conflicts.slice(0, 5).map((c) => `${c.path} (${c.why})`).join(", ");
      return { ...p, error: `Not undone: ${list}${p.conflicts.length > 5 ? "…" : ""}.` };
    }
    const r = await repo();
    const isDir = (rel) => lstatOrNull(path.join(r.root, rel))?.isDirectory() === true;
    // Even forced: never a path that isn't the agent's, nor one the checkpoint doesn't hold.
    const notOurs = new Set(p.conflicts.filter((c) => !FORCEABLE.has(c.why)).map((c) => c.path));
    const todo = p.paths.filter((c) => !isDir(c.path) && !notOurs.has(c.path));
    const back = todo.filter((c) => c.status !== "A").map((c) => c.path);
    if (back.length) {
      // A scratch index: restore --worktree would otherwise lock the user's
      // (.git/index.lock), and a killed git could leave that lock behind.
      const scratch = `${r.index}.restore-${process.pid}-${++restores}`;
      const res = await g([...r.exact, "restore", `--source=${p.before}`, "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"], { cwd: r.root, env: { GIT_INDEX_FILE: scratch }, input: back.map((x) => `:(literal)${x}`).join("\0") });
      rmSync(scratch, { force: true });
      rmSync(`${scratch}.lock`, { force: true });
      if (res.code !== 0) return { ...p, error: `git restore failed: ${firstLine(res.stderr)}` };
    }
    for (const c of todo.filter((x) => x.status === "A")) rmSync(path.join(r.root, c.path), { force: true }); // a file, never a directory
    return { ...p, restored: todo.length, skipped: p.paths.length - todo.length };
  }

  return {
    repo,
    snapshot,
    beforeSnapshot,
    freshSnapshot,
    hashPaths,
    record,
    list,
    plan,
    restore,
    get lastError() {
      return lastError;
    },
  };
}

export const UNDO_LIMITS = "Not restored: ignored files, submodule contents and LFS files.";

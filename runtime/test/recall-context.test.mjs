// L6 P2 (design decision 7): the repo context the session brief is ranked against.
//   - the hook reads it without starting a process: the repo root and branch from
//     .git/HEAD (a folder, a worktree's `gitdir:` file, a detached HEAD), plus a cache;
//   - a .git without a HEAD is no repository (a stray folder must not root one);
//   - the cache is used only for the branch it was made on, and is stale when missing,
//     old, from another branch, another root or unreadable;
//   - the job gathers recent paths and commit subjects with git and writes the cache.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ad-l6-ctx-"));
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
for (const k of ["AD_ROOT", "AD_MEMORY_DB", "CLAUDE_PROJECT_DIR"]) delete process.env[k];
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const ctx = await import("../src/memory/recall-context.mjs");
const gitmod = await import("../src/memory/recall-context-git.mjs");
const AD = path.join(ROOT, "ad-root");
const real = (p) => fs.realpathSync.native(p);

const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
const hasGit = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;

function repo(name, branch = "main") {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", branch);
  return dir;
}

test("the root and branch come from .git/HEAD, from any subfolder", { skip: !hasGit }, () => {
  const dir = repo("plain", "feat/checkout-refunds");
  fs.mkdirSync(path.join(dir, "src", "billing"), { recursive: true });
  const found = ctx.repoRoot(path.join(dir, "src", "billing"));
  assert.equal(real(found.root), real(dir));
  assert.equal(ctx.readBranch(found.gitDir), "feat/checkout-refunds");
});

test("a worktree's .git file points at its own HEAD", { skip: !hasGit }, () => {
  const dir = repo("main-wt");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "first");
  const wt = path.join(ROOT, "wt-feature");
  git(dir, "worktree", "add", "-q", "-b", "fix/invoice-rounding", wt);
  const found = ctx.repoRoot(wt);
  assert.equal(real(found.root), real(wt));
  assert.equal(ctx.readBranch(found.gitDir), "fix/invoice-rounding");
});

test("a detached HEAD has no branch", { skip: !hasGit }, () => {
  const dir = repo("detached");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "first");
  git(dir, "checkout", "-q", "--detach");
  assert.equal(ctx.readBranch(ctx.repoRoot(dir).gitDir), null);
});

test("a .git that can't be trusted ends the walk: no repository, never a parent one", () => {
  const outer = path.join(ROOT, "outer");
  fs.mkdirSync(path.join(outer, ".git"), { recursive: true });
  fs.writeFileSync(path.join(outer, ".git", "HEAD"), "ref: refs/heads/trunk\n");
  const stray = path.join(outer, "inner");
  fs.mkdirSync(path.join(stray, ".git"), { recursive: true }); // no HEAD
  assert.equal(ctx.repoRoot(path.join(stray, "deeper-not-made")), null);
  assert.equal(ctx.repoRoot(stray), null);
  // control: without the stray .git the parent repository is found
  fs.rmSync(path.join(stray, ".git"), { recursive: true });
  assert.equal(real(ctx.repoRoot(stray).root), real(outer));
});

test("a symlinked .git ends the walk", { skip: process.platform === "win32" }, () => {
  const dir = path.join(ROOT, "linked");
  const target = path.join(ROOT, "linked-target");
  fs.mkdirSync(path.join(target), { recursive: true });
  fs.writeFileSync(path.join(target, "HEAD"), "ref: refs/heads/main\n");
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(target, path.join(dir, ".git"));
  assert.equal(ctx.repoRoot(dir, { stopAt: dir }), null);
});

test("a HEAD with junk, or a ref outside refs/heads, gives no branch", () => {
  const d = path.join(ROOT, "junk", ".git");
  fs.mkdirSync(d, { recursive: true });
  for (const head of ["garbage\n", "ref: refs/tags/v1\n", "ref: refs/heads/\n", `ref: refs/heads/${"x".repeat(300)}\n`, "ref: refs/heads/feat/<script>\n", "ref: refs/heads/a..b\n"]) {
    fs.writeFileSync(path.join(d, "HEAD"), head);
    assert.equal(ctx.readBranch(d), null, head.slice(0, 30));
  }
});

test("the cache is used only for its own branch and root, and is stale when old", () => {
  const dir = path.join(ROOT, "cached");
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/feat/offline-maps\n");
  const now = Date.parse("2026-11-08T10:00:00Z");
  // nothing cached yet: the live branch, no paths, stale
  let c = ctx.readContext(dir, { root: AD, now });
  assert.equal(c.branch, "feat/offline-maps");
  assert.deepEqual(c.paths, []);
  assert.equal(c.stale, true);
  ctx.writeContext(c.root, { branch: "feat/offline-maps", paths: ["src/maps/tiles.ts"], commits: ["cache map tiles"] }, { root: AD, now });
  c = ctx.readContext(dir, { root: AD, now: now + 60_000 });
  assert.deepEqual(c.paths, ["src/maps/tiles.ts"]);
  assert.deepEqual(c.commits, ["cache map tiles"]);
  assert.equal(c.stale, false);
  // ten minutes on: still used, but stale (a refresh is due)
  c = ctx.readContext(dir, { root: AD, now: now + 11 * 60_000 });
  assert.deepEqual(c.paths, ["src/maps/tiles.ts"]);
  assert.equal(c.stale, true);
  // another branch checked out: the cached paths would mislead
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/fix/login\n");
  c = ctx.readContext(dir, { root: AD, now: now + 60_000 });
  assert.equal(c.branch, "fix/login");
  assert.deepEqual(c.paths, []);
  assert.deepEqual(c.commits, []);
  assert.equal(c.stale, true);
});

test("an unreadable or wrong-shaped cache is ignored, never thrown", () => {
  const dir = path.join(ROOT, "badcache");
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  const file = ctx.cacheFile(ctx.repoRoot(dir).root, "main", { root: AD });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const now = Date.now();
  for (const body of ["{not json", JSON.stringify({ v: 2, root: "/elsewhere", branch: "main", paths: ["a"], commits: [], at: new Date(now).toISOString() }), JSON.stringify({ v: 2, root: ctx.repoRoot(dir).root, branch: "main", paths: "nope", commits: [], at: new Date(now).toISOString() }), JSON.stringify({ v: 99 }), JSON.stringify({ v: 2, root: ctx.repoRoot(dir).root, branch: "main", paths: ["a".repeat(100)], commits: Array.from({ length: 2000 }, () => "c".repeat(60)), at: new Date(now).toISOString() })]) {
    fs.writeFileSync(file, body);
    const c = ctx.readContext(dir, { root: AD, now });
    assert.deepEqual(c.paths, [], body.slice(0, 40));
    assert.equal(c.stale, true);
  }
});

test("a gitdir on a network or device path is refused, never looked up", () => {
  const wt = path.join(ROOT, "unc");
  fs.mkdirSync(wt, { recursive: true });
  for (const target of ["\\\\fileserver\\share\\repo.git", "//fileserver/share/repo.git", "\\\\?\\C:\\x"]) {
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${target}\n`);
    assert.equal(ctx.repoRoot(wt, { stopAt: wt }), null, target);
  }
});

test("a branch with no cache yet uses the cache of the branch it was cut from", { skip: !hasGit }, () => {
  const dir = repo("reuse", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "first");
  const r = ctx.repoRoot(dir).root;
  ctx.writeContext(r, { branch: "main", paths: ["src/maps/tiles.ts"], commits: ["cache tiles"] }, { root: AD });
  git(dir, "checkout", "-q", "-b", "feat/offline-maps");
  const c = ctx.readContext(dir, { root: AD });
  assert.equal(c.branch, "feat/offline-maps");
  assert.equal(c.from, "main");
  assert.deepEqual(c.paths, ["src/maps/tiles.ts"]);
  assert.equal(c.stale, true, "a refresh for the new branch is due");
  // once the new branch has its own cache, that one counts
  ctx.writeContext(r, { branch: "feat/offline-maps", paths: ["src/maps/offline.ts"], commits: [] }, { root: AD });
  const own = ctx.readContext(dir, { root: AD });
  assert.equal(own.from, null);
  assert.deepEqual(own.paths, ["src/maps/offline.ts"]);
});

test("old cache files are pruned", () => {
  const ad = path.join(ROOT, "prune-root");
  const dir = path.join(ad, "recall", "context");
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, "aaaa-bbbb.json");
  const fresh = path.join(dir, "cccc-dddd.json");
  fs.writeFileSync(old, "{}");
  fs.writeFileSync(fresh, "{}");
  const t = (Date.now() - 40 * 86_400_000) / 1000;
  fs.utimesSync(old, t, t);
  assert.equal(ctx.pruneContexts({ root: ad }), 1);
  assert.deepEqual(fs.readdirSync(dir), ["cccc-dddd.json"]);
});

test("the job never runs in the home folder or above it", () => {
  const home = path.join(ROOT, "homes", "me");
  fs.mkdirSync(path.join(home, "work", "app"), { recursive: true });
  assert.equal(gitmod.jobAllowed(home, { home }), false);
  assert.equal(gitmod.jobAllowed(path.dirname(home), { home }), false);
  assert.equal(gitmod.jobAllowed(path.join(home, "work", "app"), { home }), true);
  assert.equal(gitmod.jobAllowed("//server/share", { home }), false);
});

test("git runs without outside GIT_* variables, offline, with no renames or optional locks", () => {
  const env = gitmod.gitEnv({ PATH: "/bin", GIT_DIR: "/evil", GIT_WORK_TREE: "/evil", git_ssh_command: "evil", HOME: "/h" });
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_WORK_TREE, undefined);
  assert.equal(env.git_ssh_command, undefined);
  assert.equal(env.GIT_NO_LAZY_FETCH, "1");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.PATH, "/bin");
  const args = gitmod.gitArgs("/r", ["status"]);
  for (const a of ["core.fsmonitor=false", "status.renames=false", "diff.renames=false", "log.showSignature=false", "protocol.allow=never", "--no-optional-locks"]) assert.ok(args.includes(a), a);
  assert.deepEqual(args.slice(-3), ["-C", "/r", "status"]);
});

test("the job skips status when the repository's own config names a clean filter", { skip: !hasGit }, () => {
  const dir = repo("filtered", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "first");
  fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
  const marker = path.join(ROOT, "filter-ran");
  git(dir, "config", "filter.x.clean", `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, '1')"`);
  fs.writeFileSync(path.join(dir, ".gitattributes"), "* filter=x\n");
  const got = gitmod.collectContext(real(dir));
  assert.deepEqual(got.skipped, ["status"]);
  assert.ok(!got.paths.includes("b.txt"), "no working-tree paths without status");
  assert.ok(got.paths.includes("a.txt"), "the log still counts");
  assert.equal(fs.existsSync(marker), false, "the filter never ran");
});

test("the job skips status for a repository gpg program or ssh command, and log too in a partial clone", { skip: !hasGit }, () => {
  for (const [key, value, skipped] of [["gpg.program", "evil-gpg", ["status"]], ["core.sshCommand", "evil-ssh", ["status"]], ["extensions.partialClone", "origin", ["status", "log"]], ["remote.origin.promisor", "true", ["status", "log"]]]) {
    const dir = repo(`cfg-${key.replace(/\W/g, "")}`, "main");
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
    git(dir, "add", "a.txt");
    git(dir, "commit", "-q", "-m", "first");
    git(dir, "config", key, value);
    assert.deepEqual(gitmod.collectContext(real(dir)).skipped, skipped, key);
  }
});

test("a clean filter in the user's own global config doesn't stop status (git-lfs)", { skip: !hasGit }, () => {
  const dir = repo("lfs", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "first");
  fs.writeFileSync(path.join(dir, "new.txt"), "n\n");
  const gitconfig = path.join(ROOT, "lfs-global.gitconfig");
  fs.writeFileSync(gitconfig, "[filter \"lfs\"]\n\tclean = git-lfs clean -- %f\n");
  const prev = process.env.GIT_CONFIG_GLOBAL;
  // the job removes GIT_* from git's environment, so the global file is HOME's .gitconfig
  fs.copyFileSync(gitconfig, path.join(ROOT, ".gitconfig"));
  try {
    const got = gitmod.collectContext(real(dir));
    assert.deepEqual(got.skipped, []);
    assert.ok(got.paths.includes("new.txt"));
  } finally {
    fs.rmSync(path.join(ROOT, ".gitconfig"), { force: true });
    if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  }
});

test("repo-head.mjs reads files only: no child_process in its import graph", () => {
  const src = fs.readFileSync(fileURLToPath(new URL("../src/memory/repo-head.mjs", import.meta.url)), "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ["node:fs", "node:path"]);
});

test("cached lists are bounded and only hold strings", () => {
  const dir = path.join(ROOT, "bounded");
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  const r = ctx.repoRoot(dir).root;
  ctx.writeContext(r, { branch: "main", paths: Array.from({ length: 100 }, (_, i) => `p${i}.ts`), commits: [...Array.from({ length: 40 }, (_, i) => `c${i}`), 7, "x".repeat(5000)] }, { root: AD });
  const c = ctx.readContext(dir, { root: AD });
  assert.equal(c.paths.length, ctx.MAX_PATHS);
  assert.ok(c.commits.length <= ctx.MAX_COMMITS);
  assert.ok(c.commits.every((s) => typeof s === "string" && s.length <= 200));
});

test("no repository: no root, no branch, nothing to refresh", () => {
  const dir = path.join(ROOT, "nogit");
  fs.mkdirSync(dir, { recursive: true });
  const c = ctx.readContext(dir, { root: AD, stopAt: dir });
  assert.equal(c.root, null);
  assert.equal(c.branch, null);
  assert.equal(c.stale, false);
});

test("the job gathers recent paths (working tree first) and commit subjects", { skip: !hasGit }, () => {
  const dir = repo("job", "feat/kafka-consumer-retries");
  fs.mkdirSync(path.join(dir, "internal", "consumer"), { recursive: true });
  fs.writeFileSync(path.join(dir, "internal", "consumer", "retry.go"), "package consumer\n");
  fs.writeFileSync(path.join(dir, "README.md"), "x\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "add retry backoff to the consumer");
  fs.writeFileSync(path.join(dir, "internal", "consumer", "dlq.go"), "package consumer\n");
  fs.writeFileSync(path.join(dir, "weird name.go"), "package x\n");
  const got = gitmod.collectContext(real(dir));
  assert.equal(got.branch, "feat/kafka-consumer-retries");
  assert.equal(got.paths[0], "internal/consumer/dlq.go", "an uncommitted file is the most recent");
  assert.ok(got.paths.includes("internal/consumer/retry.go"));
  assert.ok(got.paths.includes("weird name.go"));
  assert.deepEqual(got.commits, ["add retry backoff to the consumer"]);
});

test("the job script writes the cache the hook reads", { skip: !hasGit }, () => {
  const dir = repo("job2", "docs/api-v2-guide");
  fs.writeFileSync(path.join(dir, "guide.md"), "x\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "draft the v2 guide");
  const job = fileURLToPath(new URL("../src/memory/recall-context-job.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [job, real(dir)], { env: { ...process.env, AD_ROOT: AD }, encoding: "utf8", windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  const c = ctx.readContext(dir, { root: AD });
  assert.equal(c.branch, "docs/api-v2-guide");
  assert.deepEqual(c.paths, ["guide.md"]);
  assert.deepEqual(c.commits, ["draft the v2 guide"]);
  assert.equal(c.stale, false);
});

test("the job refuses a folder that isn't a repository root it can read", () => {
  const job = fileURLToPath(new URL("../src/memory/recall-context-job.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [job, path.join(ROOT, "does-not-exist")], { env: { ...process.env, AD_ROOT: AD }, encoding: "utf8", windowsHide: true });
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(path.join(AD, "recall", "context")) ? fs.readdirSync(path.join(AD, "recall", "context")).filter((f) => f.includes("does-not")).length : 0, 0);
});

test("the job runs git in the repository it found, never one above it", { skip: !hasGit }, () => {
  const outer = repo("outer-dotfiles", "main");
  fs.writeFileSync(path.join(outer, "secret-plans.txt"), "x\n");
  git(outer, "add", "secret-plans.txt");
  git(outer, "commit", "-q", "-m", "outer secret");
  const inner = path.join(outer, "projects", "app");
  fs.mkdirSync(path.join(inner, ".git"), { recursive: true });
  fs.writeFileSync(path.join(inner, ".git", "HEAD"), "ref: refs/heads/main\n"); // no objects/, no refs/
  const got = gitmod.collectContext(real(inner));
  assert.ok(!got.paths.some((p) => p.includes("secret-plans")), JSON.stringify(got));
  assert.ok(!got.commits.includes("outer secret"));
});

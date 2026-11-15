// L7 P4 (design D6): branch-aware command rules.
//   - branchesOf: a git push/commit/merge/rebase/reset correction that names main, master,
//     develop, trunk, production, release or a backticked branch after to/on/into/onto;
//   - branchApplies: the current branch listed; unknown or detached; a chain that changes
//     folder, branch or repository first; push targets (main, HEAD:main, src:main, +main,
//     refs/heads/main), --all/--mirror, the upstream with no refspec. Merge looks at the
//     current branch only;
//   - upstreamMerge reads branch.<name>.merge from the main repository's config, also from a
//     linked worktree, never spawning git;
//   - the hook (toolBefore) applies a branch rule only where it should.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ad-l7p4-br-"));
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
for (const k of ["AD_ROOT", "AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL"]) delete process.env[k];
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const { branchesOf, branchApplies } = await import("../src/rules/branches.mjs");
const { matchRule } = await import("../src/rules/match.mjs");
const { upstreamMerge, currentBranch } = await import("../src/hooks/git-branch.mjs");
const { writeGuards, activePath } = await import("../src/hooks/guards.mjs");
const { toolBefore } = await import("../src/hooks/tool-before.mjs");
const { proposalFor } = await import("../src/memory/rule-proposals.mjs");

const PUSH = { type: "command", program: "git", subcommands: ["push"], flags: null, branches: ["main"] };
const MERGE = { type: "command", program: "git", subcommands: ["merge"], flags: null, branches: ["main"] };
const COMMIT = { type: "command", program: "git", subcommands: ["commit"], flags: null, branches: ["main", "release/2.0"] };
const ctx = (current, upstream = {}) => ({ current: () => current, upstream: (b) => upstream[b] ?? null });
const m = (rule, command, branch) => matchRule(rule, { tool: "Bash", input: { command }, os: "linux", cwd: "/w", project_root: "/w", branch }).match;

test("branchesOf: names after to/on/into/onto, backticked branches, only for git rules that take a branch", () => {
  const git = (sub) => ({ type: "command", program: "git", subcommands: [sub], flags: null });
  assert.deepEqual(branchesOf("never push to main", git("push")), ["main"]);
  assert.deepEqual(branchesOf("don't commit on Master or onto develop", git("commit")), ["master", "develop"]);
  assert.deepEqual(branchesOf("never merge into `release/2.0`", git("merge")), ["release/2.0"]);
  assert.deepEqual(branchesOf("don't reset --hard on production", git("reset")), ["production"]);
  assert.equal(branchesOf("never push to main", git("fetch")), null, "fetch doesn't take a branch rule");
  assert.equal(branchesOf("never push to main", { type: "command", program: "npm", subcommands: ["publish"] }), null);
  assert.equal(branchesOf("never push", git("push")), null);
  assert.equal(branchesOf("push to mainline", git("push")), null, "a longer word isn't main");
  assert.equal(branchesOf("push to main/feature", git("push")), null, "main/... isn't main");
  assert.equal(branchesOf("push to `--force`", git("push")), null, "an option is no branch");
  assert.deepEqual(branchesOf("don't push to main or master", git("push")), ["main", "master"], "a list: every name");
  assert.deepEqual(branchesOf("never commit to `main`, `release`", git("commit")), ["main", "release"]);
  assert.deepEqual(branchesOf("never push to `refs/heads/main`", git("push")), ["main"], "refs/heads/ dropped");
  assert.equal(branchesOf("don't push to main or my-feature", git("push")), null, "a name we can't read: the rule applies everywhere");
  assert.deepEqual(proposalFor("never push to main").pattern.branches, ["main"], "the proposal carries them");
  assert.equal(proposalFor("use pnpm, not npm").pattern.branches, undefined);
});

test("branchApplies: listed, unknown or detached, and a chain that moves first", () => {
  assert.equal(m(PUSH, "git push", ctx("main")), true, "on main");
  assert.equal(m(PUSH, "git push", ctx("feat/x")), false, "on a feature branch, no target");
  assert.equal(m(PUSH, "git push", ctx(null)), true, "detached or unknown");
  assert.equal(m(PUSH, "git push", undefined), true, "no branch facts (replay): unknown");
  assert.equal(m(PUSH, "git checkout main && git push", ctx("feat/x")), true, "the chain switches branch first");
  assert.equal(m(PUSH, "git switch -c y; git push", ctx("feat/x")), true);
  assert.equal(m(PUSH, "cd ../other && git push", ctx("feat/x")), true, "the chain changes folder first");
  assert.equal(m(PUSH, "git -C ../other push", ctx("feat/x")), true, "another repository");
  assert.equal(m(PUSH, "git status && git push", ctx("feat/x")), false, "a read first changes nothing");
  assert.equal(m(PUSH, "git push && git checkout main", ctx("feat/x")), false, "a move after doesn't count");
  assert.equal(branchApplies({ branches: [] }, [{ argv: ["git", "push"] }], 0, ctx("x")), true, "no branches: the plain rule");
  assert.equal(branchApplies(PUSH, [{ argv: ["git", "push"] }], 0, { current: () => { throw new Error("boom"); } }), true, "a failed read is unknown");
});

test("push targets: refspecs, --all/--mirror, and the upstream", () => {
  for (const c of ["git push origin main", "git push origin HEAD:main", "git push origin feat:main", "git push origin +main", "git push origin refs/heads/main", "git push origin :main", "git push --all", "git push --mirror origin", "git push origin --branches", "git push -u origin main", "git push --repo=x origin main"]) {
    assert.equal(m(PUSH, c, ctx("feat/x")), true, c);
  }
  for (const c of ["git push origin feat/x", "git push origin HEAD", "git push origin main:feat", "git push --tags", "git push origin refs/heads/other", "git push -o main origin x"]) {
    assert.equal(m(PUSH, c, ctx("feat/x")), false, c);
  }
  assert.equal(m(PUSH, "git push", ctx("feat/x", { "feat/x": "refs/heads/main" })), true, "no refspec: the upstream is main");
  assert.equal(m(PUSH, "git push origin", ctx("feat/x", { "feat/x": "refs/heads/main" })), true, "a remote and no refspec");
  assert.equal(m(PUSH, "git push", ctx("feat/x", { "feat/x": "refs/heads/feat/x" })), false);
  assert.equal(m(PUSH, "git push origin 'refs/heads/*:refs/heads/*'", ctx("feat/x")), true, "a glob refspec");
  assert.equal(m(PUSH, "git push origin '*:*'", ctx("feat/x")), true);
  assert.equal(m({ ...PUSH, branches: ["refs/heads/main"] }, "git push", ctx("main")), true, "a stored refs/heads/ name matches");
});

test("merge, commit, rebase and reset look at the current branch only (not their arguments)", () => {
  assert.equal(m(MERGE, "git merge main", ctx("feat/x")), false, "merging main into a feature branch writes there");
  assert.equal(m(MERGE, "git merge feat/y main", ctx("feat/x")), false, "an octopus merge into the current branch: its arguments are no targets");
  assert.equal(m(MERGE, "git merge feat/x", ctx("main")), true, "merging into main");
  assert.equal(m(COMMIT, "git commit -m 'on main'", ctx("feat/x")), false);
  assert.equal(m(COMMIT, "git commit -m x", ctx("release/2.0")), true, "a slash branch listed");
  const REBASE = { type: "command", program: "git", subcommands: ["rebase"], flags: null, branches: ["release"] };
  assert.equal(m(REBASE, "git rebase main release", ctx("feat/x")), true, "rebase <upstream> <branch> rewrites <branch>");
  assert.equal(m(REBASE, "git rebase release", ctx("feat/x")), false, "rebasing onto release rewrites the current branch");
});

test("upstreamMerge and currentBranch read .git files, also from a linked worktree", () => {
  const repo = path.join(ROOT, "repo");
  fs.mkdirSync(path.join(repo, ".git", "worktrees", "wt"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(repo, ".git", "config"), '[core]\n\tbare = false\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n[branch "feat/x"] ; a comment\n\tmerge = refs/heads/trunk\n[remote "origin"]\n\tmerge = refs/heads/nope\n');
  assert.equal(upstreamMerge(repo, "main"), "refs/heads/main");
  assert.equal(upstreamMerge(repo, "feat/x"), "refs/heads/trunk");
  assert.equal(upstreamMerge(repo, "none"), null);
  assert.equal(upstreamMerge(path.join(ROOT, "nowhere"), "main"), null);
  const wt = path.join(ROOT, "wt");
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "wt")}\n`);
  fs.writeFileSync(path.join(repo, ".git", "worktrees", "wt", "HEAD"), "ref: refs/heads/feat/x\n");
  fs.writeFileSync(path.join(repo, ".git", "worktrees", "wt", "commondir"), "../..\n");
  assert.equal(currentBranch(wt), "feat/x");
  assert.equal(upstreamMerge(wt, "feat/x"), "refs/heads/trunk", "the worktree reads the main repository's config");
});

test("the hook: a branch rule asks on main and stays quiet on a feature branch", () => {
  const base = path.join(ROOT, "hook");
  const root = path.join(base, "ad");
  const project = path.join(base, "app");
  fs.mkdirSync(project, { recursive: true });
  const rule = { id: 7, kind: "command", decision: "ask", reason: "never push to main", scope: "project", project: "p1", rule: PUSH };
  writeGuards({ projects: { p1: { roots: [project], paused: null, rules: [rule] } }, global: { rules: [] }, pausedAll: null, allowOnce: [], ruleCount: 1, rules_rev: 1, store_id: "b".repeat(32), cmd: "ad" }, { root });
  fs.writeFileSync(activePath(root), JSON.stringify({ ruleCount: 1, store_id: "b".repeat(32) }));
  const bash = (command) => ({ session_id: "s", cwd: project, tool_name: "Bash", tool_input: { command }, permission_mode: "default" });
  const run = (command, current, up = {}) => toolBefore(bash(command), { root, homes: [base], log: () => {}, gitRead: { currentBranch: () => current, defaultBranches: () => ["main"], upstreamMerge: (_d, b) => up[b] ?? null } })?.hookSpecificOutput?.permissionDecision ?? null;
  assert.equal(run("git push", "main"), "ask");
  assert.equal(run("git push", "feat/x"), null);
  assert.equal(run("git push origin main", "feat/x"), "ask");
  assert.equal(run("git push", "feat/x", { "feat/x": "refs/heads/main" }), "ask", "the upstream");
  assert.equal(run("git push", null), "ask", "detached");
  const codex = toolBefore({ ...bash("git push"), turn_id: "t" }, { root, homes: [base], host: "codex", log: () => {}, gitRead: { currentBranch: () => "feat/x", defaultBranches: () => ["main"], upstreamMerge: () => null } });
  assert.equal(codex?.hookSpecificOutput?.permissionDecision, "deny", "Codex hides the folder: the branch is unknown, the rule applies");
});

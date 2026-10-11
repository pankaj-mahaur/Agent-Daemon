---
name: ad-ci-readiness
description: Use in the Agent Daemon repo before pushing to an open PR, before a release, and whenever CI fails — "CI check karo", "run CI locally", "check the CI/CD before pushing", "CI fail kyun hua", "is it production ready", "production readiness", "ready to merge?", "release readiness", "PR green hai?". Mirrors .github/workflows/test.yml on this machine plus a Linux container leg, reads the PR's CI (the real-engine job is non-blocking: read it per test), and runs the production-readiness checklist before a release.
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
allowed-tools: Bash, Read, Edit, Write, Grep, Glob
disable-model-invocation: false
---

# CI locally, CI read properly, release readiness

CI runs on pull requests to `main` (and pushes to `main`) only. A feature branch's tests therefore meet the three runners for the first time when the PR opens. On the 2.2.0 PR that surfaced two new live tests that failed only on CI runners (a wrapped macOS path, Linux's sandbox PID namespace) and a unit-test timing flake on Windows. Running the pipeline locally first, on two OSes, and reading CI per test turns those into fixes before the push instead of red runs after it.

It complements `ad-pre-push`: that one syncs docs, CHANGELOG, skills, memory and hygiene before every push. This one proves the code is ready (CI and release). Run `ad-pre-push` too.

## When to use

- Before pushing to a branch that has an open PR, and before opening one.
- When the PR's CI is red, or someone asks whether it's green or ready.
- Before a release (version bump, tag, GitHub release): the readiness checklist.

## Procedure

### 1. Mirror the CI job on this machine

`test.yml`'s `test` job, step by step, from the repo root:

```bash
cd runtime && npm test                       # npm ci only if the lockfile changed: it wipes node_modules, and the global `ad` is npm-linked here
node runtime/scripts/lint-skills.mjs         # 0 errors; the ~22 warnings are old style notes on untouched skills
node runtime/src/cli.mjs doctor              # non-zero is allowed; read each ✗ (see Gotchas)
S=$(mktemp -d); node runtime/src/cli.mjs init --profile security --plan --cwd "$S"; ls -A "$S"; rm -rf "$S"   # --plan writes nothing
node runtime/scripts/skills-diff.mjs --json  # must parse with a numeric `ours` and an array `net-new`
node runtime/scripts/check-doc-links.mjs     # links and duplicated sections
```

The `engine-real` job (real Codex, mock model, real pseudo-terminal), in the background (15–20 min on Windows):

```bash
cd runtime && AD_REAL_ENGINE=1 node --test --test-concurrency=1 --test-force-exit test/engine-real.test.mjs test/tui-live.test.mjs
```

### 2. A Linux leg in a container

`node:22-alpine` is in the local Docker cache, so no new image is pulled. Ask before pulling one. The commit goes in as a tar, so the checkout is never touched:

```bash
git archive --format=tar HEAD | MSYS_NO_PATHCONV=1 docker run --rm -i \
  -v "$PWD/.claude/skills/ad-ci-readiness/scripts/ci-linux.sh:/ci.sh:ro" node:22-alpine sh /ci.sh
```

- It tests the last commit: commit first.
- It runs `npm ci`, the suite with `CI=true` (GitHub sets it, and the speed tests' budgets read it), lint and the smokes.
- It re-runs any test file that failed to load on its own, to show why.
- It doesn't run the real-engine job: Codex's sandbox needs privileges a plain container lacks.

### 3. Read the PR's CI per test

```bash
gh run list --branch <branch> --limit 6 --json databaseId,headSha,status,conclusion,name
gh run view <id> --json jobs --jq '.jobs[] | "\(.name): \(.conclusion)"'
gh run view <id> --log-failed | grep -E "not ok [0-9]+ - " | sed 's/^.*Z //' | sort -u
```

- **`real engine / <os>` is `continue-on-error`.** The run can be green with it red. Read its failing tests every time.
- **New test or regression?** Compare with the previous PR's run for the same jobs (`gh run view <older id> --json jobs`). A test that never ran on CI before is a new-test problem.
- **A flake** is a test that fails, then passes on the next commit with no change to it. Fix its cause anyway (Gotchas): don't just re-run.

### 4. Production readiness (before a release)

- **Version, everywhere:** `runtime/package.json`, both `version` fields in `runtime/package-lock.json`, the README badge, and `CHANGELOG.md`:
  - an empty `## [Unreleased]`;
  - `## [X.Y.Z] — YYYY-MM-DD`;
  - the `[X.Y.Z]:` link at the bottom.

  Check with `node runtime/src/cli.mjs --version`.
- **Installs without dev packages:** `node .claude/skills/ad-ci-readiness/scripts/check-prod-imports.mjs`. Users run `npm install --omit=dev`, so an import of a devDependency in `runtime/src` breaks every install while every test passes.
- **Codex pin:**
  - `@openai/codex` must be exact in `package.json`.
  - `node runtime/scripts/codex-schema-snapshot.mjs --check` must say up to date.
  - `node runtime/scripts/codex-slash.mjs` regenerates `codex-slash.json` from the pinned tag over `gh`. `git status` must stay clean.
- **Dependencies:** `npm audit --omit=dev` shows 0 vulnerabilities; `npm ls --omit=dev --depth=0` is clean.
- **The release diff** (`git diff origin/main...HEAD`):
  - no `console.log(`, `debugger;`, `TODO` or `FIXME` added in `runtime/src`;
  - no `.only` in tests;
  - no unexpectedly large files.
- **README:**
  - a top note for the version that links the release notes;
  - the feature bullets of the section the release changes (e.g. "Terminal UI");
  - docs that match the code (`ad-pre-push` step 2).
- **The experimental Codex API:** only the user-approved allowlist (`EXPERIMENTAL_ALLOWLIST`). The tests enforce it; a change needs the user's OK.
- **After the merge** (each step on the user's OK): CI green on `main`, then tag `vX.Y.Z` on the merge commit, then the GitHub release from that CHANGELOG section.

### 5. Report

One table per leg (this machine, the Linux container, the PR's CI per job), each failing test with its cause, then GO or NO-GO. Say plainly what wasn't run (macOS locally, the real engine on Linux). Push only on the user's OK.

## Gotchas met on CI runners

| Symptom | Cause | Fix |
|---|---|---|
| macOS live test: `timed out waiting for changed` with the text on screen | macOS temp paths are long (`/private/var/folders/…`) and wrap; `.*` stops at the line end | `\s+\S*`, or `[\s\S]*`, between words in a screen regex |
| Linux live test: a background process "not alive" though it runs | Codex's Linux sandbox gives commands their own PID namespace: the pid they write isn't the host's | check what the process does (a file it keeps writing), never `process.kill(pid, 0)` |
| Windows unit test fails once, passes on the next commit | a file's mtime compared in the same millisecond on a fast runner | set the mtime (`utimesSync`) |
| Windows live test: the command never ran | GitHub's Windows runners can't run Codex's sandbox. Codex either asks "retry without sandbox?" (a patch), or refuses outright: a background `exec_command` gets "windows unelevated restricted-token sandbox cannot enforce split writable root sets directly; refusing to run unsandboxed" (Codex's `unsupported_windows_restricted_token_sandbox_reason`) | approve the retry in the test; skip on exactly that refusal (Part 5 live does). Put the command's output in the mock reply so the log says which it was |
| A live test times out only on a fresh home | the first sandboxed action sets up the Windows sandbox (35 s to 2+ min) | wait minutes, not seconds |
| Speed test over budget in a container | `CI` unset: the tight local budget applies | run with `CI=true`, as GitHub does |
| `test/tui-pty-smoke.test.mjs` fails as a whole file in the container (`signal: 'SIGSEGV'`) | `@lydell/node-pty`'s Linux binary is built for glibc; Alpine is musl | the container's, not the code's: GitHub's Ubuntu job runs it. Not a blocker; say so in the report |
| Windows real-engine test: `config/batchWrite: failed to persist config.toml` (-32603), passes on a rerun | Codex's own rewrite of `config.toml` collided with something holding the fresh file (an antivirus scan) | re-run that test alone (5 of 5 passed on 2026-10-11); count it as a flake only after that |
| `ad doctor` exits 1 locally | usually only "Session context budget": the project memory file is too big | compact `.agent-daemon/memory/activeContext.md` (keep a `.bak`) |
| Local Git Bash: `--test-name-pattern="/cd"` runs 0 subtests yet reports `pass 1`; or `skill-install.test.mjs` "git URL install from a local repo" fails with exit 1 | MSYS turns an argument starting with `/` into a Windows path; `MSYS_NO_PATHCONV=1` stops that but git honours it too, so an exported value breaks the local-repo install test | prefix only the pattern-filtered command with `MSYS_NO_PATHCONV=1`; never `export` it in the shell that runs the suite |

## Anti-patterns

- **Trusting the run's overall status.** The real-engine job can't fail the run: read it per test.
- **"It's a flake" with no cause.** Every flake here had one (a wrapped path, a PID namespace, a timestamp). Find it, fix it, then say so.
- **Raising a timeout instead of fixing a wrong check.** A regex that can't match a wrapped path never passes, however long it waits.
- **`npm ci` in the dev checkout casually.** It replaces the node_modules the global `ad` runs from. Do the clean install in the container instead.
- **Pulling a new Docker image, or pushing, without asking.** Use what's cached; push only on the user's OK.
- **Skipping the Linux leg because Windows passed.** Two of CI's three runners aren't Windows.

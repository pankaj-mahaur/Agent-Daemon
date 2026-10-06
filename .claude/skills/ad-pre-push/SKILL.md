---
name: ad-pre-push
description: Use when about to commit, push, open a PR, merge or release in the Agent Daemon repo, unasked — "push karo", "PR banao", "merge karo", "release karo", "main me dalo", "ship it", "md files update karo", "docs sync karo", "gitignore check karo". Syncs docs, CHANGELOG, skills and project memory with the code change, blocks anything personal or internal from reaching GitHub, and verifies (tests, doc links).
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
allowed-tools: Bash, Read, Edit, Write, Grep, Glob
disable-model-invocation: false
---

# Before every push: docs, skills, learnings, hygiene, verify

In this repo, code alone is never "done". Every push must leave the public docs, the CHANGELOG, the skills that encode the behaviour, and the project's memory matching the code, and must not leak anything personal or internal. The user used to have to ask for this every time ("md files update karo", "skills update karo", "gitignore check karo"). This skill makes it part of pushing.

## When to use

Run it, in full, before:
- a `git push` of any branch (and before `gh pr create`, a merge, a tag, a GitHub release);
- answering "is this ready to push / release?".

Run steps 4–5 alone when the user only asks to "check the gitignore" or "check what's pushed".

## Procedure

### 1. What changed

```bash
git fetch -q origin main
git diff --stat origin/main...HEAD; git status --short
git log --oneline origin/main..HEAD
```
List the user-visible changes (behaviour, commands, keys, defaults, errors, requirements) and the internal ones (design, tests, CI).

### 2. Sync the docs (code is the source of truth)

Map each change to the docs that describe it, and update every one that is now wrong or silent:

| Code that changed | Docs to check |
|---|---|
| `runtime/src/tui/**` | `docs/tui.md`, `docs/tui-architecture.md`, README "Terminal UI", `docs/manual-test.md` §6, `docs/troubleshooting.md` (TUI entries) |
| `runtime/src/harness/checkpoints.mjs`, `tui/undo.mjs` | `/undo` in `docs/tui.md` (conflict table), `docs/tui-architecture.md` (safety model), troubleshooting #26 |
| `runtime/src/harness/**`, `runtime/src/engine/codex/**` | `docs/harness.md`, `docs/harness-design.md`, README "Agent harness", troubleshooting |
| `runtime/src/cli*.mjs`, new commands or flags | README "CLI reference" + quick start, `docs/installation-guide.md` |
| `runtime/src/memory/**`, `runtime/src/hooks/**`, `mcp/**` | README memory sections, `docs/architecture.md`, `mcp/agent-daemon-memory/README.md` |
| `runtime/test/**`, `testkit/**`, `.github/workflows/**` | `docs/testing.md`, `docs/contributing.md` |
| `install.sh`, `install.ps1` | README quick start, `docs/installation-guide.md` |
| a new error a user can hit | a numbered `docs/troubleshooting.md` entry + the index table at the end of `docs/tui.md` (for TUI errors) |

- A feature with no doc at all gets one (a new `docs/<topic>.md`, linked from the README "Reference" list).
- Write for the reader: lead with what to do, then why. Keep docs plain; state limits honestly.
- Never write counts or facts the next commit falsifies (test counts, branch positions, "N commits ahead").

### 3. CHANGELOG and versions

- Add every user-visible change under `## [Unreleased]` in `CHANGELOG.md` (`### Added` / `### Changed` / `### Fixed`), in user language.
- Cutting a release: move `[Unreleased]` into `## [X.Y.Z] — YYYY-MM-DD`, add the `[X.Y.Z]:` link at the bottom, and bump `runtime/package.json`, `runtime/package-lock.json` (both version fields) and the README badge, all in the PR. Tag `vX.Y.Z` on `main`'s merge commit only after CI passes, then create the GitHub release from that CHANGELOG section (absolute links). See the `release-flow` skill for the go/no-go.

### 4. Skills and learnings

- **Skills that encode the changed behaviour.** Update the ones a future session would read before touching this area:
  - `skills/daemon/ad-tui-dev` — TUI layers, invariants, test practices, gotchas met;
  - `skills/daemon/harness-troubleshoot` — every new error a user can hit (symptom → cause → fix, matching troubleshooting);
  - `skills/daemon/codex-upgrade` — Codex protocol/behaviour facts learned (shapes, ordering, defaults, valid config values);
  - `skills/daemon/ad-harness` — how to hand work to the harness, when commands or safety defaults change.
  Skills ship to users' `~/.claude/skills/`: no personal names, paths, client projects or secrets in them.
- **What was learned this session.** For each gotcha, decision or correction that cost time: one line in `.agent-daemon/memory/activeContext.md` (local project memory) and, if it changes how to work here, a line in the matching skill. Learnings are facts with the reason ("X happens because Y; do Z"), not a diary.

### 5. Hygiene: nothing personal, internal or generated reaches GitHub

```bash
git status --short --untracked-files=all          # every untracked file: track it on purpose, or ignore it
git diff --cached --stat                          # what this commit really contains
git grep -nIiE "<user's name>|C:\\\\Users\\\\<user>|/c/Users/<user>|my-projects|<client project names>" -- . ':!CHANGELOG.md'
git grep -nIE "sk-[A-Za-z0-9]{20}|ghp_[A-Za-z0-9]{20}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY"
```
- Fill the name/path/client list from the user's memory and the machine (`$USER`, home folder, other repos the user works on). The repo URL `pankaj-mahaur/Agent-Daemon` and the SECURITY.md contact are the project's public identity and stay.
- Internal working material stays local and ignored: `docs/plans/`, `docs/research/`, `.out-of-scope/`, `HANDOFF.md`, `FUTURE-*-PLAN.md`, `.agent-daemon/`, `.claude/*` (except `.claude/skills/`), scratch scripts, logs, `graphify-out/`. A new kind of internal file gets a `.gitignore` rule (`git rm --cached` if it was tracked; the local copy stays).
- Test data, goldens and examples use generic names (`shop-app`, `marketing-site`, `Sam`, `D:\…\work\app`), never the user's projects or plan.
- Never rewrite published history to remove something (no force push) without the user's explicit OK; untrack and ignore instead, and say what is still in history.

### 6. Verify, then push

```bash
node runtime/scripts/check-doc-links.mjs           # every relative doc link points at a tracked file
cd runtime && npm test
AD_REAL_ENGINE=1 node --test --test-concurrency=1 --test-force-exit test/tui-live.test.mjs   # after app/session/view/engine changes
```
- Stage files by name (never `git add -A`), never `--no-verify`, commit with the attribution trailer, push the feature branch (never `main` directly). After a PR: bind it, read CI (the real-engine job may fail without failing the run — read its result).
- Report to the user in one short block: docs updated, skills updated, learnings recorded, hygiene result, verification result, what was pushed.

## Examples

### Example 1: "fix ho gaya, push karo"
The change touched `runtime/src/tui/view/markdown.mjs` (file links with spaces). Before pushing: `docs/tui.md` gains a line on links; CHANGELOG `[Unreleased] ### Fixed` gets "local file links render as links"; `ad-tui-dev` gains "Codex writes local links as `[x](</D:/a b/x:12>)`"; one learning line in activeContext; hygiene scan finds a test using the user's project folder name → renamed to `work`; link check + `npm test` green; push.

### Example 2: "release karo"
Everything in Example 1, then step 3's release part: version bump in the PR, CI green, merge, `main` CI green, tag, GitHub release from the CHANGELOG section.

## Anti-patterns

- **Pushing code with stale docs, "docs later".** Later never comes; the user had to ask every time. Docs are part of the change.
- **Updating only the README.** The README summarizes; the guides (`docs/*.md`), troubleshooting and skills carry the detail and drift first.
- **Writing learnings into the CHANGELOG or the README.** Learnings go to project memory and skills; the CHANGELOG is for users.
- **Deleting a published file to "remove it from GitHub".** It is still in history; untrack + ignore, and tell the user.
- **Copying the user's names, paths or client projects into tests, goldens, skills or docs.**
- **Trusting a green CI run without reading the real-engine job.**

---
name: audit-runner
description: Execute a list of findings against a codebase chunk-by-chunk — security audits, code reviews, lint backlogs, post-merge cleanup, dependency updates. Use when the user wants to "work through" / "address" / "close out" / "do the chunks of" a finding list, not for single isolated tasks. Enforces severity sequencing, plan-mode per chunk, single-concern commits, deferred-by-design for refactors, and a per-feature progress doc trail.
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
---

# Run an audit chunk-by-chunk without losing the thread

You have a list of findings — from a security review, code review, lint pass, dependency-update plan, or post-merge cleanup. The temptation is to crank through them in one big PR. Don't. The chunked discipline below trades a small amount of process overhead for: clean per-concern commit history, easy partial rollback, and a documented trail that the next session (you, a teammate, or a fresh agent) can pick up without re-deriving the audit.

For single isolated changes, use [implement-feature](../implement-feature/SKILL.md). For diagnosing a specific runtime symptom, use [debug-triage](../debug-triage/SKILL.md).

---

## Pre-flight

1. **Locate the audit document.** It's usually a markdown file at the repo root (`SECURITY_AUDIT.md`, `CODE_REVIEW.md`, `<FEATURE>_AUDIT.md`) or pasted directly into the chat.
2. **Verify the audit isn't stale.** Audits frequently reference shifted line numbers, code that's already been fixed, or shape claims that don't match current code. Read the actual code at the cited locations before planning. If a finding doesn't apply, mark `resolved-by-analysis` (not silently skipped) with a one-sentence justification.
3. **Classify every finding** by:
   - **Severity** — HIGH / MED / LOW (or Critical / Cleanup / Polish — match what the audit uses)
   - **Isolation** — single-file, multi-file same flavor, refactor (multi-file behavior change)
   - **Scope** — within the audit's perimeter, vs cross-cutting (the latter triggers a stop-and-ask before touching unrelated subsystems)
4. **Sequence the work:**
   - HIGH severity first. Within each tier, smallest + most isolated wins.
   - Refactors (file splits, hook decomposition, dependency upgrades, schema migrations) go LAST and need a dedicated session each — see "Defer-by-design" below.

---

## Per-chunk workflow

The loop you walk for every chunk:

### 1. Read connected files

Even when the audit names a specific `file:line`, open the surrounding 50–100 lines and any callers/types referenced. Audits often miss adjacent context that changes the right fix.

### 2. Plan-mode for non-trivial changes

Single-line tweaks (typo fix, comment add, named-constant extraction) may proceed directly. Anything else — even small structural changes — should enter plan mode (or its equivalent in your toolchain), get approval, then execute. The plan file becomes part of the audit trail.

### 3. One cohesive concern per chunk

Multi-file is OK if same flavor (e.g. "tighten input validation at three boundary handlers"). Mixing flavors in the same chunk splits the commit's reviewability — keep them separate.

**When to bundle:**
- Same file + same flavor (e.g. "extract magic numbers to named constants" across one hook)
- Same repo + adjacent boundary concerns (three backend handlers all "validate before persisting")

**When to split:**
- Different repos. Always one commit per repo.
- Different flavors in the same file. Adds review noise.
- Behavior change + drive-by cleanup. Bundle is OK only if the cleanup is unambiguously dead (e.g. an unused import surfaced by lint) and you flag it to the user before the commit.

### 4. Verify per language

Don't claim a chunk done without:

| Stack | Type-check / smoke | Lint / format |
|---|---|---|
| TypeScript | `npx tsc --noEmit` (project-wide) | `npx eslint <changed files>` |
| Python (FastAPI) | `python -c "import app.main"` | `ruff check <changed files>` |
| Python (Django) | `python manage.py check` | `ruff check <changed files>` |
| Go | `go build ./...` | `go vet ./... && golangci-lint run <pkg>` |
| Rust | `cargo check` | `cargo clippy -- -D warnings` |
| Ruby on Rails | `bin/rails runner "puts 'ok'"` | `bundle exec rubocop <files>` |

Both must be clean. Pre-existing warnings unrelated to the chunk are documented in the progress doc but not "fixed" inside the chunk — drive-by cleanups need explicit user approval.

### 5. Production-grade walk before declaring done

Before marking the chunk complete, mentally check:

- Inputs validated at trust boundaries (HTTP body, query params, third-party callbacks)?
- No secrets in logs (API keys, tokens, PII)?
- Errors structured (logged with context server-side, sanitized for the user-facing message)?
- No broad `except Exception:` / `catch (e)` swallowing — at minimum logged + re-thrown or surfaced?
- Race windows considered (concurrent mutations, unbounded retries, missing cancellation)?
- Comments explain WHY only — no narration of what the code obviously does?

If any answer is "no", the chunk isn't done.

### 6. Commit only on explicit user OK

- Use a HEREDOC for the commit message (preserves formatting, supports multi-line bodies).
- Stage files explicitly by name. Never `git add -A` / `git add .` — sweeps in unrelated drift.
- Let pre-commit hooks run. **Never `--no-verify`.** If a hook fails, fix the root cause and create a new commit (never `--amend` after a hook failure — the original commit didn't happen).
- Conventional Commits style works in any language: `fix(scope): ...`, `refactor(scope): ...`, `perf(scope): ...`, `chore(scope): ...`.

---

## Defer-by-design vs execute-now

Default to **deferred-by-design** for findings that need a dedicated design session:

- **File-split refactors** — decomposition of a 500-line file or hook into multiple. Decomposition is a design call, not a polish step.
- **Hook / closure composition changes** — anything that affects re-render shape, memoization, or dependency arrays.
- **Dependency upgrades** — `npm install <pkg>@latest`, `uv add`, `cargo update`, `bundle update`. Treat each as its own ticket; failures mid-upgrade can be hard to diagnose if bundled.
- **Schema migrations** — defer always. `upgrade` / `downgrade` / `stamp` are user-only operations. See [db-migrations](../db-migrations/SKILL.md).
- **Anything requiring test scaffolding decisions first** — when there's no co-located test safety net, "fix" + "build the safety net" is too much for one chunk.

When deferring: write the reasoning into the audit progress doc (next section) under "deferred-by-design" so the next session sees it and doesn't re-litigate.

---

## Audit progress doc

For any non-trivial audit (3+ findings), maintain a `<FEATURE>_AUDIT_PROGRESS.md` at the repo root. Required sections:

1. **Background** — what was audited, when, by whom (or which agent), the perimeter (which files / subsystems are in scope).
2. **Working-style ground rules** — link to the relevant feature skill or `CLAUDE.md` so future sessions inherit context.
3. **Findings table** — `# / Severity / Area / Finding / Status` columns. Status uses one of:
   - `done — chunk N (commit hash)`
   - `already in place (audit was stale)`
   - `resolved-by-analysis`
   - `deferred-by-design`
4. **Per-chunk progress** — for every chunk: audit-finding number(s), root cause in the actual code, approach, before/after diff snippet, behavior change description, verification output, commit hash, and an "out-of-scope (deliberate)" sub-section.
5. **Resolved-by-analysis section** — explicit justification for findings that don't apply (audit was stale, code already addresses it, or premise was wrong).
6. **Deferred-by-design section** — explicit reasoning for what's not being done now and what would unblock it.
7. **Files touched / NOT touched** — modified-files map (per-file hashes across chunks) + senior-owned files explicitly listed if there's a "don't touch without owner" rule.
8. **Commit ledger** — repo, hash, chunk, subject — one row per commit.
9. **Last updated** date pinned to the closing chunk's commit hash.

The doc lives at the repo root even when the root isn't a git repo (multi-repo workspaces) — it's the working memory of the audit.

---

## Stale-audit detection

Common signs an audit was on a stale snapshot:

- Cited line numbers don't match current code by ≥5 lines
- Cited code shape doesn't match (e.g. audit says "no validation" but file has explicit validation now)
- Cited file no longer exists or was renamed
- Issue claims a function does X but reading shows it does Y

In all cases: don't auto-skip. Verify, then either:

- Adjust the chunk to address the *actual* problem at the *current* location, or
- Mark `resolved-by-analysis` with the specific code reference that supersedes the audit claim.

---

## Verification + commit gating

- **Never push without explicit user OK.** `git push`, `--force`, force-push to main are user-only operations.
- **Watch out for IDE auto-sync.** VS Code's `git.autoSync`, JetBrains' "Push on commit", magit's auto-push — any of these can push commits automatically after each `git commit`. Local tip and `origin/<branch>` may show "up to date" right after committing without you running `push`. Flag this to the user the *first* time you observe it in a session; don't fight it silently.
- **Pre-commit hooks must run.** Frontend stacks: `lint-staged`, `prettier --write`, `tsc --noEmit`. Backend stacks: `ruff`, `black`, `mypy`, `golangci-lint`. Hook configs are usually in `.pre-commit-config.yaml`, `package.json` `lint-staged`, or `.husky/`.
- **Drive-by cleanups need explicit user OK.** If the linter surfaces a pre-existing issue in the file you're editing (e.g. unused import, deprecated API), call out to user with options: (a) bundle into this chunk, (b) separate micro-commit, (c) leave for later. Don't silently fold it in.

---

## What NOT to do

- **Don't bundle unrelated findings into one commit** to "save time". Three concerns in one commit makes future revert / bisect harder.
- **Don't `git add -A`** after a chunk. Stage explicitly by name — there's almost always stray whitespace or scratch file drift.
- **Don't `--no-verify`** to skip a failing hook. Fix the root cause.
- **Don't claim done without verification output.** If `tsc` / `ruff` / `cargo check` failed and you didn't fix it, the chunk is in_progress — say so explicitly.
- **Don't silently skip a finding.** Mark `resolved-by-analysis` with justification, or move it to deferred — never just delete the row.

---

## Out-of-scope for this skill

- Single-task changes that aren't part of a list — use [implement-feature](../implement-feature/SKILL.md).
- Diagnosing a specific runtime bug — use [debug-triage](../debug-triage/SKILL.md) or a `diagnose-*` skill.
- Reviewing a feature for the first time (producing the finding list) — use [review-slice](../review-slice/SKILL.md).
- Generic codebase exploration that isn't audit-driven.

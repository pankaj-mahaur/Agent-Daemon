---
name: bootstrap-daemon
description: Use when the user asks to "initialize daemon", "setup agent-daemon", "bootstrap daemon", "init daemon", "bootstrap the daemon memory", or "initialize agent-daemon in this project". Fully scaffolds and populates agent-daemon memory with real project context — not just empty templates.
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
disable-model-invocation: true
---

# Bootstrap agent-daemon in a project

Full end-to-end initialization: scaffold files, read the project, populate memory with real context, verify.

## Phase 0 — Scaffold

1. Run `ad init` in the project root. If `.agent-daemon/` already exists, it will report "already initialized."
2. Check if memory files contain `{{` placeholders:
   ```bash
   grep -l '{{' .agent-daemon/memory/*.md 2>/dev/null
   ```
3. If **no placeholders found** → memory is already populated. Report "already bootstrapped" and STOP.
4. If placeholders exist → proceed to Phase 1.

## Phase 1 — Read the project

Read ALL sources that exist. **Skip silently** those that don't. Do NOT ask the user for each one.

| Source | How to find | Feeds into |
|--------|-------------|------------|
| Package manifest | `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod` | techContext (stack), projectbrief (name/description) |
| `README.md` | Project root | projectbrief (what/who/why), techContext (dev setup) |
| `CLAUDE.md` | Project root | systemPatterns (architecture, patterns), techContext (gotchas, env vars) |
| `CONVENTIONS.md` | Project root | systemPatterns (patterns) |
| Directory structure | `ls` at root, then key subdirs (`src/`, `lib/`, `app/`, `backend/`, `frontend/`, etc.) | systemPatterns (key directories) |
| Git log | `git log --oneline -20` | progress (recent work), activeContext (current focus) |
| Git branches | `git branch -a` | activeContext (in-flight branches) |
| Git status | `git status --short` | activeContext (uncommitted work) |
| Env templates | `.env.example`, `.env.template`, `.env.sample` | techContext (env vars) |
| CI config | `.github/workflows/`, `Makefile`, `Dockerfile`, `docker-compose.yml` | techContext (dev setup, verification commands) |
| Package scripts | `scripts` field in `package.json` or equivalent | techContext (verification commands) |
| Cross-agent rules | `.cursor/rules/`, `.cline/rules/` | systemPatterns (patterns from other agents) |

**Collect all this into working notes before writing any files.**

## Phase 2 — Populate memory files

Write each file using extracted content. Replace the template entirely — don't patch placeholders.

### `projectbrief.md` (keep under 1KB)

Extract from manifest + README:
- **What this project is** — one paragraph from README or package description
- **Who uses it** — user roles inferred from README or codebase (routes, UI screens)
- **Core problem** — from README or infer from project purpose
- **Non-goals** — mark "TBD — will be refined over sessions" if not obvious
- **Stage** — infer: has CI + production config = "shipped"; few commits = "early-prototype"; else "beta"

### `techContext.md` (keep under 4KB)

Extract from manifest + README + CLAUDE.md + env files:
- **Stack table** — language, framework, DB, hosting from dependencies
- **Dev setup** — commands from README or package.json scripts
- **Env vars** — from `.env.example` or CLAUDE.md
- **Verification commands** — from package.json scripts or CI config (typecheck, lint, test, build)
- **Gotchas** — from CLAUDE.md "gotchas" or "important" sections. If none found: "No gotchas captured yet — the digest pipeline will populate from session learnings."
- **External services** — from README/CLAUDE.md or mark "TBD"

### `systemPatterns.md` (keep under 5KB)

Extract from directory structure + CLAUDE.md + code conventions:
- **Architecture** — from CLAUDE.md architecture section, or infer from directory layout
- **Key directories** — from `ls` output, describe what each contains
- **Reusable utilities** — scan for `lib/`, `utils/`, `helpers/`, `hooks/`, `shared/` directories. List key exports if found
- **Recurring patterns** — from CLAUDE.md conventions or code patterns
- **ADRs** — leave empty: "No ADRs recorded yet."

### `productContext.md` (keep under 2KB)

Extract from README + CLAUDE.md:
- **Before/after workflow** — from README or infer from project purpose. Mark "TBD" if unclear
- **Success metrics** — infer from README or mark "TBD"
- **Key product decisions** — from CLAUDE.md or README design rationale
- **Constraints** — from CLAUDE.md directives or compliance mentions
- **Stakeholders** — mark "TBD" unless explicitly stated

### `activeContext.md` (keep under 5KB)

Extract from git state:
- **Current focus** — from `git log -5` messages + `git status` (what's being worked on now)
- **Recent decisions** — leave empty: "Digest pipeline will populate from session learnings."
- **In-flight branches** — from `git branch -a`, list non-main branches with last commit subject
- **Active blockers** — leave empty
- **Known temporary state** — leave empty

### `progress.md` (keep under 5KB)

Extract from git history:
- **What works** — infer from git log: features that appear shipped (merged PRs, "feat:", "add:" commits)
- **In progress** — from active branches
- **Planned** — "Check issue tracker" or leave empty
- **Recently fixed** — from git log: commits with "fix:" in last 30 days
- **Known issues / tech debt** — leave empty: "Will be populated by review-slice and audit-runner skills."

## Phase 3 — User profile

Check if `~/.agent-daemon/user.md` exists and contains `{{` placeholders.

- If **already populated** (no placeholders) → skip entirely
- If **has placeholders** → ask the user these 3 questions in ONE message:
  1. "What's your name and role?" (e.g., "Pankaj, full-stack developer")
  2. "Any strong preferences for how I work?" (e.g., "be terse", "always show diffs", "Hindi-English mix is fine")
  3. "Anything I should never do?" (e.g., "don't auto-commit", "don't touch production files")

Then auto-detect installed tools:
```bash
node --version 2>/dev/null; python3 --version 2>/dev/null; go version 2>/dev/null; rustc --version 2>/dev/null; docker --version 2>/dev/null; gh --version 2>/dev/null
```

Write `~/.agent-daemon/user.md` with the user's answers + detected tools.

## Phase 4 — Verify

1. Run `ad doctor` — all checks should pass
2. Show a 3-line summary:
   ```
   Daemon bootstrapped for [project name]:
   - 6 memory files populated from [sources used]
   - User profile: [populated / already set / skipped]
   ```
3. Tell the user: "Memory is live. The digest pipeline will keep it updated as you work."

## What NOT to do

- Do NOT ask for confirmation before reading each source file — just read them all
- Do NOT exceed the size limits noted for each memory file
- Do NOT populate gotchas or tech debt speculatively — leave them for the digest pipeline
- Do NOT overwrite memory files that are already populated (no `{{` placeholders)
- Do NOT skip `ad init` — always run it first for idempotent scaffolding
- Do NOT put code samples in memory files — they're context docs, not code references

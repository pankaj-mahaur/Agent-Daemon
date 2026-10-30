---
name: orchestrate-team
description: Use when a task spans 2+ domains (backend + frontend, code + tests), subtasks can run in parallel, and estimated work exceeds 30 minutes. Triggers on phrases like "deploy a team", "use multiple agents", "split this across agents", "parallelize this work", or when the user gives a large cross-cutting task.
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "2.1"
allowed-tools: Bash
---

# Orchestrate a multi-agent team

## When to use

Use multi-agent when ALL of these are true:
- Task spans 2+ domains (backend + frontend, code + tests + review)
- Subtasks can genuinely run in parallel
- Estimated total work exceeds ~30 minutes

Stay single-agent for: quick fixes, single-file changes, questions, small reviews.

## Decision criteria

Ask yourself:
1. Can I break this into 2+ independent subtasks? → If no, stay single-agent.
2. Would a second agent save meaningful time? → If no, stay single-agent.
3. Are the subtask boundaries clean (different files/dirs)? → If no, stay single-agent.

## Protocol

### Step 1 — Analyze the task

Break the user's request into discrete subtasks. For each, identify:
- Domain (backend, frontend, testing, review, etc.)
- Dependencies (what must finish first)
- Estimated complexity (small / medium / large)

### Step 2 — Select a template

Check available templates:
```bash
ad tt
```

Built-in templates:
- **solo-with-qa** — 1 dev + 1 QA (simplest, good for most tasks)
- **full-stack-feature** — lead + backend + frontend + QA (parallel frontend/backend)
- **bug-triage-team** — lead + investigator + fixer + reviewer
- **code-review-team** — lead + security + performance reviewers

### Step 3 — MANDATORY: Ask the user for approval

**STOP. Do not proceed without approval.** Present the plan:

```
I'd like to use multi-agent orchestration for this:

Template: solo-with-qa
Roles:
  - dev: [specific task description]
  - qa: [verification task, blocked by dev]

This will spawn 1 background worker (ad's sandboxed engine) in an isolated worktree.
The agent's changes stay on a separate branch until you review and merge.

Should I proceed?
```

Wait for explicit "yes" / approval before continuing.

### Step 4 — Create team

```bash
ad tc --template <template-name> --task "<task description>"
```

Note the team ID from output.

### Step 5 — Spawn workers

For each non-leader role:
```bash
ad sp --team <team-id> --role <role> --task "<specific subtask>" --cwd . --verbose
```

Each spawned agent gets:
- Isolated git worktree (no merge conflicts)
- Role-specific instructions from the template
- Automatic completion reporting to leader inbox

Role and team names may use only letters, digits, `.`, `_` and `-` (max 64): they become the branch `team/<team>/<agent>`. Any text is fine in `--task`; it reaches the worker as data, never through a shell.

- **Which worker.** The default is an `ad` worker: sandboxed, no network, approvals never asked (on Windows it needs `ad sandbox setup`). `--engine claude` runs Claude Code with `--dangerously-skip-permissions` (any command as the user, network included): use it only for tasks the user would run themselves, and say so in the approval request. Claude workers need `claude` on PATH (or `AD_CLAUDE_BIN`) and a Claude Code that knows `--append-system-prompt-file`.
- **Which account.** `--account <provider>/<label>` (with `--model`) runs the worker on that account; without it, the project's or the default account.
- **When a limit runs out.** Without fallback the worker's task ends in error (with a hint when the user has a fallback order). With the team's fallback on (`ad team set <team> fallback on`, the user's own terminal; it refuses from the agent's shell) the worker moves to the next target, or pauses when it can't move safely and the board shows the task blocked with the reason. Report either with its reason; never turn fallback on yourself.

### Step 6 — Monitor

```bash
ad ts --team <team-id>
```
Shows kanban board. Tasks auto-unblock as dependencies complete.

Check inbox:
```bash
ad ti --team <team-id> --agent <leader-role>
```

### Step 7 — Merge and report

Once agents complete:
1. Review each agent's branch (`git log <branch>`, `git diff main..<branch>`)
2. Ask the user if the changes look good
3. Merge branches: `git merge <branch>`
4. Clean up: `ad td --team <team-id>`

## Key principles

- **Always ask before spawning** — Never create teams or spawn agents silently
- **Leader = your session** — You (Claude) are the team lead
- **Workers are background processes** — They run in worktrees, report via inbox
- **Review before merge** — Always let the user review agent output first
- **Fail gracefully** — If a worker fails, report the error and offer to retry or handle manually

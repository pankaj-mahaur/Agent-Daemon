---
name: orchestrate-team
description: Use when a task is too complex for a single agent session and would benefit from parallel work by multiple specialized agents.
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
allowed-tools: Bash
---

# Orchestrate a multi-agent team

## When to use

- The task spans multiple domains (backend + frontend, code + tests + review)
- Parallel work would significantly speed up delivery
- The task has natural subtask boundaries with clear handoff points
- A single agent would need to context-switch heavily between different concerns

## Protocol

### Step 1 — Analyze the task

Break the user's request into discrete subtasks. For each subtask identify:
- What domain it belongs to (backend, frontend, testing, review, etc.)
- What skills are needed
- Dependencies on other subtasks (what must finish first)

### Step 2 — Select or compose a team template

Check available templates:

```bash
agent-daemon team list-templates
```

Built-in templates:
- **full-stack-feature**: lead + backend + frontend + QA (parallel frontend/backend)
- **bug-triage-team**: lead + investigator + fixer + reviewer (sequential diagnosis → fix → review)
- **code-review-team**: lead + security reviewer + performance reviewer (parallel review perspectives)
- **solo-with-qa**: single dev + QA verifier (simplest useful team)

If no template fits, compose an ad-hoc team by specifying roles directly.

### Step 3 — Create the team

```bash
agent-daemon team create --template <template-name> --task "<task description>"
```

This creates the team directory with task dependency graph. Note the team ID from output.

### Step 4 — Spawn worker agents

For each non-leader role in the team:

```bash
agent-daemon spawn --team <team-id> --role <role-name> --task "<specific subtask>"
```

Each spawned agent gets:
- An isolated git worktree (no merge conflicts)
- Role-specific system prompt with instructions and recommended skills
- Automatic completion reporting to leader's inbox

### Step 5 — Monitor progress

```bash
agent-daemon team status --team <team-id>
```

Shows a kanban board with task statuses and agent states. Tasks auto-unblock as dependencies complete.

Check the leader's inbox for completion messages:

```bash
agent-daemon team inbox --team <team-id> --agent leader
```

### Step 6 — Handle completions and handoffs

When an agent completes, it writes a task-complete message to the leader's inbox with:
- Branch name and worktree path
- Summary of changes made
- Exit status

The watch daemon (if running) auto-triggers dependent tasks.

### Step 7 — Merge and finalize

Once all tasks are completed:
1. Review each agent's branch for quality
2. Merge branches in dependency order
3. Run final integration tests
4. Clean up worktrees

### Step 8 — Report results

Summarize what each agent accomplished, any issues encountered, and the final state of the codebase.

## Key principles

- **Leader stays in the user's session**: you (the current agent) act as team lead
- **Workers are background processes**: they run in isolated worktrees and report back via inbox
- **Dependencies are explicit**: tasks declare what they're blocked by; the system auto-unblocks
- **Communication is async**: use inbox messages, not real-time interaction
- **Fail gracefully**: if a worker fails, the team can reassign or the leader can handle it

# agent-daemon

A **self-improving runtime** for AI coding agents — with **multi-agent orchestration** built in. Wraps Claude Code (and any agent that writes a session transcript) with universal guardrails, persistent memory, and a digest pipeline that distills lessons from every session so the next one is automatically smarter.

Now ships with a full **team coordination layer**: spawn multiple Claude Code agents in isolated git worktrees, coordinate them through filesystem-based inboxes, and manage task dependencies with auto-unblocking — all without a central server, database, or API key.

Skills evolve too: [GEPA](runtime/src/digest/gepa/README.md) (Genetic-Pareto Prompt Evolution) reads execution traces and proposes Pareto-optimal skill refinements that you accept or reject via `agent-daemon review`.

> **v0.6 status (current):** Production-hardened multi-agent orchestration. Filesystem inboxes, git worktree isolation per agent, team templates, task dependency graphs with auto-unblocking, spawn timeout + kill escalation, atomic writes, concurrent agent limits. Plus the full self-improving loop from prior versions — zero API-key digest, SQLite episodic memory, cross-agent adapters, watch daemon, OS service registration.

## Quick start

```bash
# 1. Clone & install
git clone https://github.com/Pankaj-mobiux/Agent-Daemon.git
cd Agent-Daemon/runtime
npm install

# 2. Register the `ad` command globally
npm link              # now `ad` works from anywhere

# 3. Verify
ad doctor

# 4. Init in your project
cd /path/to/your/project
ad init               # scaffolds .agent-daemon/ + AGENTS.md

# 5. Open Claude Code — constitution + memory load automatically.
#    The agent emits a digest block before ending, the daemon parses it,
#    memory accumulates across sessions.
```

The `ad` command is the short alias for `agent-daemon` — both work interchangeably. No API key required for normal operation. Set `ANTHROPIC_API_KEY` only for `ad evolve` (GEPA batch evolution).

## Multi-agent orchestration

Spawn a team of specialized Claude Code agents that work in parallel on isolated branches, coordinate through filesystem inboxes, and auto-unblock dependent tasks on completion.

```bash
# List available team templates
ad tt                    # (team list-templates)

# Create a team from a template
ad tc --template full-stack-feature --task "Add user authentication with JWT"

# Spawn workers
ad sp --team <team-id> --role backend --task "Implement JWT auth endpoints"
ad sp --team <team-id> --role frontend --task "Build login/signup UI"

# Monitor progress
ad ts --team <team-id>   # (team status)
ad ti --team <team-id> --agent lead   # (team inbox)

# Cleanup when done
ad tu                    # (team cleanup)
ad td --team <team-id>   # (team delete)
```

### How it works

```
User gives complex task
        |
[Orchestrator Skill] analyzes task, selects template
        |
[ad tc] creates team dir + tasks.json + dependency graph
        |
[ad sp] for each role:
  - Creates isolated git worktree at ~/.agent-daemon/worktrees/
  - Spawns headless `claude` CLI with role-specific system prompt
  - Agent works independently on its branch
        |
[Filesystem Inboxes] coordination:
  - Agent writes completion message to leader's inbox
  - Watch daemon polls inboxes, auto-unblocks dependent tasks
  - Leader reads status via [ad ts] and inbox via [ad ti]
        |
[Merge & Report]
  - Each agent's work is on a separate branch
  - Leader merges worktree branches
  - Cleanup via [ad td]
```

### Team templates

| Template | Roles | Use case |
|---|---|---|
| `full-stack-feature` | lead, backend, frontend, qa | New features with parallel frontend/backend work |
| `bug-triage-team` | lead, investigator, fixer, reviewer | Complex bug diagnosis with handoff chain |
| `code-review-team` | lead-reviewer, security, performance | Multi-perspective code review in parallel |
| `solo-with-qa` | dev, qa | Simplest team — one worker + one verifier |

Templates live in `teams/templates/`. Add your own as JSON files in `~/.agent-daemon/teams/templates/`.

### Production safety

The orchestration layer is hardened for real use:

- **Spawn timeout** (15 min default) with SIGTERM → SIGKILL escalation
- **Concurrent agent limit** (max 8) prevents runaway process spawning
- **Stdout/stderr buffer caps** (512KB) prevent OOM on verbose agents
- **Atomic JSON writes** (tmp + rename) across all state files
- **Input validation** on team/role names — path traversal prevention
- **Message size cap** (64KB) and inbox limit (500 messages)
- **Race-safe file reads** with retry (3 attempts)
- **Git worktree isolation** — agents can't interfere with each other

## The self-improving loop

```
SessionStart hook
    |
Load constitution + project memory + recent learnings + active team context
    |
Session runs — agent uses skills, recalls past corrections
    |
SessionEnd hook
    |
agent-daemon digest pipeline:
    triage -> extract -> classify -> dedupe -> apply (or queue)
    |
Memory written, skill diffs queued for review
    |
Next session starts smarter
```

## What's in here

```
agent-daemon/
├── constitution/        # Universal guardrails — 12 cardinal rules every session loads
├── memory-templates/    # 6-file scaffold for project memory
├── runtime/             # Node CLI (agent-daemon) — digest, orchestration, self-improvement
│   └── src/
│       ├── orchestration/   # Multi-agent: inbox, spawn, team, templates
│       ├── daemon/          # Watch daemon with inbox polling
│       ├── digest/          # Extract → classify → apply pipeline + GEPA
│       └── memory/          # SQLite + FTS5 episodic store
├── teams/templates/     # Team blueprints (JSON) — 4 built-in
├── skills/              # 35 Claude Code skills (SKILL.md), stack-agnostic
├── playbooks/           # 5 reference docs — any agent or human can use
├── hooks/               # Pre-baked Claude Code hook configs
├── mcp/                 # MCP server configs (scaffolded)
├── plugins/             # Claude Code plugins (scaffolded)
├── tools/               # Standalone CLI tools (scaffolded)
├── adapters/            # SKILL.md → Cursor / AGENTS.md / Copilot (scaffolded)
├── examples/            # Settings + config templates
└── docs/                # Anatomy guides, install, customization
```

## CLI reference

All commands work with both `ad` (short) and `agent-daemon` (full). Short aliases are shown in parentheses.

```bash
# Core
ad doctor                              # Diagnose install — hooks, PATH, dirs
ad doctor --tokens                     # Token usage + cache stats from recent sessions
ad session-start                       # Inject context (called by SessionStart hook)
ad digest                              # Run digest pipeline (called by SessionEnd hook)
ad watch                               # Watch transcript dirs, fire digest on new sessions
ad evolve <skill>                      # GEPA self-evolution run for a skill
ad review                              # Accept/reject queued skill proposals
ad init                                # Scaffold .agent-daemon/ + AGENTS.md in project
ad status                              # Show queued proposals
ad query-retrieve                      # Keyword extraction + learning injection

# Multi-agent orchestration
ad team create   (tc)  --template <name> --task "..."
ad team status   (ts)  [--team <id>]
ad team list     (tl)
ad team list-templates (tt)
ad team inbox    (ti)  --team <id> [--agent <name>]
ad team cleanup  (tu)                  # Prune stale worktrees
ad team delete   (td)  --team <id>
ad spawn         (sp)  --team <id> --role <name> --task "..."
```

## Skill catalog (35 skills)

### Build & implement

| Skill | Description | Trigger |
|---|---|---|
| [implement-feature](skills/implement-feature/) | Search-for-existing-utility discipline + correctness checklist | Auto: "add", "implement", "build" |
| [seed-data](skills/seed-data/) | Idempotent database seed scripts with realistic data | Auto: "generate seed data" |
| [db-migrations](skills/db-migrations/) | Numbered migrations, never-edit-shipped, forward-compatible | Auto: schema changes |
| [merge-feature-branch](skills/merge-feature-branch/) | Pull a shared branch into a feature branch safely | Auto: merge/rebase requests |
| [multiplatform-parity](skills/multiplatform-parity/) | Keep web + mobile in lockstep on shared backend changes | Auto: cross-client changes |

### Diagnose & debug

| Skill | Description | Trigger |
|---|---|---|
| [debug-triage](skills/debug-triage/) | Triage ladder: services → data → cache → request → code | Auto: "broken", "blank screen" |
| [diagnose-fetch-failure](skills/diagnose-fetch-failure/) | CORS / network errors in frontend-backend setups | Auto: "CORS blocked" |
| [diagnose-intermittent-failure](skills/diagnose-intermittent-failure/) | Zombie watchers, env not re-read, port collisions | Auto: intermittent errors |

### Audit & review

| Skill | Description | Trigger |
|---|---|---|
| [review-slice](skills/review-slice/) | Deep-review any page using a 9-class bug checklist | `/review-slice` |
| [audit-runner](skills/audit-runner/) | Execute audit punch-list with severity sequencing | Auto: "work through findings" |
| [security-audit](skills/security-audit/) | Trust boundary mapping + security review | `/security-audit` |
| [production-readiness](skills/production-readiness/) | Launch readiness across all layers | `/production-readiness` |
| [optimization-audit](skills/optimization-audit/) | Frontend + backend performance review | `/optimization-audit` |
| [dead-code-review](skills/dead-code-review/) | Proof-based dead code cleanup | `/dead-code-review` |
| [docs-sync-audit](skills/docs-sync-audit/) | Detect and fix documentation drift | `/docs-sync-audit` |

### Operate & deploy

| Skill | Description | Trigger |
|---|---|---|
| [deploy-ops](skills/deploy-ops/) | Deploy contract, CI gates, rollback playbook | Auto: "deploy", "prod" |
| [llm-app-safety](skills/llm-app-safety/) | Model fallback, agent veto, deterministic safety | Auto: AI/prompt changes |

### Orchestration

| Skill | Description | Trigger |
|---|---|---|
| [orchestrate-team](skills/orchestrate-team/) | Multi-agent task decomposition + team spawning | Auto: complex multi-domain tasks |
| [agent-self-improve](skills/agent-self-improve/) | Teaches agents the self-improvement discipline | Auto: session reflection |

### Methodology (14 skills)

| Skill | Trigger |
|---|---|
| [methodology-tdd](skills/methodology-tdd/) | Auto: test-related work |
| [methodology-code-review](skills/methodology-code-review/) | `/code-review` |
| [methodology-systematic-debugging](skills/methodology-systematic-debugging/) | Auto: debugging |
| [methodology-refactoring](skills/methodology-refactoring/) | Auto: refactor requests |
| [methodology-api-design](skills/methodology-api-design/) | Auto: API work |
| [methodology-incremental-delivery](skills/methodology-incremental-delivery/) | Auto: large features |
| [methodology-error-handling](skills/methodology-error-handling/) | Auto: error handling |
| [methodology-performance-profiling](skills/methodology-performance-profiling/) | Auto: perf issues |
| [methodology-architectural-decision](skills/methodology-architectural-decision/) | Auto: architecture |
| [methodology-dependency-management](skills/methodology-dependency-management/) | Auto: deps |
| [methodology-documentation](skills/methodology-documentation/) | Auto: docs |
| [methodology-brainstorm](skills/methodology-brainstorm/) | `/brainstorm` |
| [methodology-pair-programming](skills/methodology-pair-programming/) | Auto: pair work |
| [methodology-writing-plan](skills/methodology-writing-plan/) | `/plan` |

### Tools

| Skill | Dependencies | Trigger |
|---|---|---|
| [graphify](skills/graphify/) | Python 3.9+, `pip install graphifyy` | `/graphify` |
| [qmd](skills/qmd/) | Node 18+, `npm install -g @tobilu/qmd` | `/qmd` |

## Playbooks

Standalone reference docs for any agent or human:

- [Bug Class Checklist](playbooks/bug-class-checklist.md) — 9 universal bug patterns
- [Security Checklist](playbooks/security-checklist.md) — Trust boundary + auth checklist
- [Production Readiness](playbooks/production-readiness.md) — Full launch checklist
- [CI/CD Practices](playbooks/ci-cd-practices.md) — Lint, format, type-check patterns
- [CSV Export Safety](playbooks/csv-export-safety.md) — Formula injection, BOM, CRLF

## Compatibility

- **agentskills.io standard** — all 35 SKILL.md files have compliant frontmatter. Works in Claude Code, Hermes Agent, OpenClaw, VS Code Copilot, OpenCode, Microsoft Agent Framework.
- **Hermes-compatible memory** — same SQLite + FTS5 shape so skills + traces travel.
- **Cross-agent awareness** — session-start reads rules from Cursor (`.cursor/rules/`), Cline (`.cline/rules/`), and Claude Code auto-memory.
- **Transcript adapters** — digests transcripts from Claude Code, Cursor, Cline, and Codex.

## Multi-agent usage

### Claude Code (native)

Skills auto-trigger from frontmatter or via `/skill-name`. The runtime fires hooks automatically.

```bash
cd Agent-Daemon/runtime && npm install && npm link   # global install — `ad` works everywhere
ad init                                              # in your project — scaffolds config + AGENTS.md
```

### Other agents

Open `skills/<name>/SKILL.md` directly — paste the content into your agent's system prompt or rules file. The frontmatter is informational; the body is plain markdown. Adapter scripts for Cursor/Copilot/AGENTS.md format are in development.

## Installation options

```bash
# Recommended: npm link (registers `ad` globally)
cd Agent-Daemon/runtime
npm install
npm link                     # now `ad` works from any directory

# Legacy: setup scripts (skills + hooks only, no `ad` command)
./setup.sh --all                          # Linux/macOS
./setup.ps1 -All                          # Windows

# Specific skills
./setup.sh --skills diagnose-fetch-failure,review-slice,seed-data

# Project-local
cd /path/to/your/project
/path/to/setup.sh --skills review-slice --project-local

# Manual
# Copy any skills/<name>/ folder to ~/.claude/skills/<name>/
```

## Architecture

```
                        +-----------------------+
                        |     User Session      |
                        |   (Claude Code CLI)   |
                        +-----------+-----------+
                                    |
                    SessionStart    |    SessionEnd
                    hook fires      |    hook fires
                        |           |        |
                        v           |        v
                +--------------+    |  +----------------+
                | session-start|    |  |    digest       |
                |  .mjs        |    |  |   pipeline      |
                +--------------+    |  +----------------+
                        |           |        |
          +-------------+           |        +----------+
          |             |           |        |          |
          v             v           |        v          v
    +-----------+ +-----------+     |  +---------+ +--------+
    |constitution| | memory   |     |  | extract | | GEPA   |
    | core.md   | | episodic |     |  | classify| | evolve |
    +-----------+ | SQLite   |     |  | apply   | +--------+
                  +-----------+     |  +---------+
                                    |
              +---------------------+---------------------+
              |           Multi-Agent Orchestration        |
              |                                            |
    +---------+---------+  +----------+  +----------------+
    |   team create     |  |  spawn   |  |  watch daemon  |
    | templates, tasks, |  | worktree |  | inbox polling, |
    | dependency graph  |  | + claude |  | auto-unblock   |
    +-------------------+  +----------+  +----------------+
              |                  |               |
              v                  v               v
    +-------------------+  +-----------+  +-----------+
    | ~/.agent-daemon/  |  | worktrees |  | inboxes   |
    | teams/{id}/       |  | per agent |  | msg-*.json|
    | tasks.json        |  | branches  |  | atomic    |
    +-------------------+  +-----------+  +-----------+
```

## Roadmap

**Shipped:**
- v0.3 — Full self-improving loop, SQLite episodic memory, GEPA, watch daemon, OS service registration
- v0.4 — Zero API-key digest via agent-emitted blocks
- v0.5 — Token efficiency, ecosystem interop, cross-agent coexistence
- v0.6 — Multi-agent orchestration with production hardening, `ad` short commands, AGENTS.md auto-generation

**Next:**
- Semantic task router — LLM-based auto template selection + role assignment
- Cross-agent conflict detection — warn on file modification overlap
- Auto-trigger evolve on repeated skill failures
- True trace replay for GEPA evaluate
- Cross-machine memory sync
- Web dashboard — kanban board for team tasks and agent status

## Examples

Copy-paste configuration templates:

- [Global settings](examples/settings-global.json) — `~/.claude/settings.json` with model, plugins, marketplace
- [Project settings](examples/settings-project.json) — `.claude/settings.json` with hooks and permissions
- [Graphify hook](examples/hooks-graphify.json) — PreToolUse hook for graph-aware exploration
- [CLAUDE.md template](examples/CLAUDE.md.example) — Project documentation template
- [AGENTS.md template](examples/AGENTS.md.example) — Multi-repo workspace template

## Docs

- [Skill Anatomy](docs/skill-anatomy.md) — How SKILL.md works, frontmatter fields, trigger system
- [Installation Guide](docs/installation-guide.md) — All install methods with OS-specific instructions
- [Customization Guide](docs/customization-guide.md) — Fork and adapt skills for your project
- [Ecosystem](docs/ecosystem.md) — Hermes interop, cross-agent awareness

## Design principles

- **Stack-agnostic.** No assumed stack — examples rotate across frameworks and databases.
- **Zero-dependency coordination.** No Redis, no HTTP server. Just JSON files + atomic renames.
- **Git-native isolation.** Each spawned agent gets its own worktree and branch.
- **Discipline over tooling.** Skills encode what to check and what to avoid, not just commands.
- **Improve over time.** Every recurring trap becomes a skill, playbook, or persisted learning.

## License

MIT

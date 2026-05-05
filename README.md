# agent-daemon

A **self-improving runtime** for AI coding agents. Wraps Claude Code (and any agent that writes a session transcript) with a constitution of universal guardrails, a six-file project memory, a [Honcho-style cross-project user profile](memory-templates/user.md.template), and a digest pipeline that distills lessons from each session and persists them — so the next session is automatically smarter than the last.

Skills evolve too: [GEPA](runtime/src/digest/gepa/README.md) (Genetic-Pareto Prompt Evolution, ICLR 2026) reads execution traces and proposes Pareto-optimal skill refinements that you accept or reject via `agent-daemon review`.

Plus the static side: 20 stack-agnostic skills (all [agentskills.io](https://agentskills.io/specification)-compliant), 5 playbooks, MCP / plugin / tool / adapter scaffolding for any AI coding agent.

> **v0.1 status (current):** constitution + memory templates + meta-skill + hook configs + Node CLI runtime (`agent-daemon`) with triage gate, transcript adapter, session-start context loader, SQLite + FTS5 schema, GEPA algorithm skeleton (Pareto selection working), Hermes interop documented. Headless `claude` extraction + LLM-driven GEPA stages + SQLite read/write land in v0.2.

### Compatibility & interop

- ✅ **agentskills.io standard** — all 20 SKILL.md files have compliant frontmatter. Works in [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Hermes Agent](https://github.com/nousresearch/hermes-agent), [OpenClaw](https://www.agensi.io/learn/openclaw-skills-guide-install-use), VS Code Copilot agent skills, OpenCode, Microsoft Agent Framework.
- ✅ **Hermes-compatible memory schema** — same SQLite + FTS5 shape so skills + traces travel. See [docs/hermes-interop.md](docs/hermes-interop.md) for full comparison.
- ✅ **GEPA self-evolution** — same algorithm Hermes uses; ours runs in Node, theirs in Python.

## Quick start

```bash
# 1. Clone
git clone https://github.com/YOUR_USERNAME/agent-daemon.git
cd agent-daemon

# 2. Install everything (skills + runtime + hook prompts)
./setup.sh --all                # Linux/macOS
./setup.ps1 -All                # Windows

# 3. Merge the printed hook snippets into ~/.claude/settings.json

# 4. Verify
agent-daemon doctor

# 5. Open a fresh Claude Code session — the constitution + project memory now load automatically
```

Skills are auto-triggered or invoked as `/skill-name`. The runtime fires automatically at SessionEnd to digest learnings.

For other agents (Cursor, Aider, Cline) see [Multi-agent usage](#multi-agent-usage).

## What's in here

```
agent-daemon/
├── constitution/     # Universal guardrails — 12 cardinal rules every session loads
├── memory-templates/ # 6-file Cline-style scaffold for project memory
├── runtime/          # Node CLI (`agent-daemon`) — the self-improving loop
├── hooks/            # Pre-baked Claude Code hook configs (SessionStart / SessionEnd / PreCompact)
├── skills/           # 19 Claude Code skills (SKILL.md), stack-agnostic
├── playbooks/        # Plain markdown — any agent or human can ingest
├── mcp/              # MCP server configs (scaffolded)
├── plugins/          # Claude Code plugins (scaffolded)
├── tools/            # Standalone CLI tools agents can invoke (scaffolded)
├── adapters/         # SKILL.md → Cursor / AGENTS.md / Copilot (scaffolded)
├── examples/         # Settings + config templates
└── docs/             # Anatomy guides, install, customization
```

## The self-improving loop

```
SessionStart hook
    │
    ▼
Load constitution + project memory + relevant past lessons
    │
    ▼
Session runs — agent uses skills, recalls past corrections
    │
    ▼
SessionEnd hook
    │
    ▼
agent-daemon digest pipeline:
    triage → extract → classify → dedupe → apply (or queue)
    │
    ▼
Memory written, skill diffs queued for review
    │
    ▼
Next session starts smarter
```

See [docs on the runtime](runtime/README.md) and the [meta-skill](skills/agent-self-improve/SKILL.md) that teaches agents the discipline.

## Skill catalog (19 skills, all stack-agnostic)

### Build & implement

| Skill | Description | Trigger |
|---|---|---|
| [implement-feature](skills/implement-feature/) | "Search-for-existing-utility" discipline + frontend/backend correctness checklist before writing | Auto: "add", "implement", "build", "wire up" |
| [seed-data](skills/seed-data/) | Generate idempotent database seed scripts with realistic data | Auto: "generate seed data" |
| [db-migrations](skills/db-migrations/) | Numbered migrations, never-edit-shipped, forward-compatible, payload preservation | Auto: schema/migration changes |
| [merge-feature-branch](skills/merge-feature-branch/) | Pull a shared branch into a long-lived feature branch safely | Auto: merge/rebase requests |
| [multiplatform-parity](skills/multiplatform-parity/) | Keep web + mobile (or any client pair) in lockstep on shared backend changes | Auto: change to a feature shared across clients |

### Diagnose & debug

| Skill | Description | Trigger |
|---|---|---|
| [debug-triage](skills/debug-triage/) | Triage ladder — services → data → cache → request → code | Auto: "X is broken", "showing zero", "blank screen" |
| [diagnose-fetch-failure](skills/diagnose-fetch-failure/) | Diagnose CORS / network errors in frontend-backend setups | Auto: "CORS blocked", "API not working" |
| [diagnose-intermittent-failure](skills/diagnose-intermittent-failure/) | "Sometimes works, sometimes doesn't" — zombie reload watchers, env not re-read, port collisions | Auto: flag-gated 503s that flap, intermittent local-backend errors |

### Audit & review

| Skill | Description | Trigger |
|---|---|---|
| [review-slice](skills/review-slice/) | Deep-review any page/feature using a 9-class bug checklist | `/review-slice` or auto |
| [audit-runner](skills/audit-runner/) | Execute an audit / review punch-list chunk-by-chunk with severity sequencing and progress trail | Auto: "work through findings", "address the audit list" |
| [security-audit](skills/security-audit/) | Security review with trust boundary mapping | `/security-audit` |
| [production-readiness](skills/production-readiness/) | Launch readiness checklist across all layers | `/production-readiness` |
| [optimization-audit](skills/optimization-audit/) | Frontend + backend performance review workflow | `/optimization-audit` |
| [dead-code-review](skills/dead-code-review/) | Proof-based dead code cleanup | `/dead-code-review` |
| [docs-sync-audit](skills/docs-sync-audit/) | Detect and fix documentation drift | `/docs-sync-audit` |

### Operate & deploy

| Skill | Description | Trigger |
|---|---|---|
| [deploy-ops](skills/deploy-ops/) | Deploy contract, CI gates, rollout cache invalidation, rollback playbook | Auto: "deploy", "prod", "CI", "rollout", env vars |
| [llm-app-safety](skills/llm-app-safety/) | Standards for LLM-powered features — model fallback, agent veto, deterministic safety, parallel guardian | Auto: changes to AI client, prompts, agents, safety layer |

### Tools

| Skill | Description | Dependencies | Trigger |
|---|---|---|---|
| [graphify](skills/graphify/) | Any input (code, docs, papers, images) to knowledge graph | Python 3.9+, `pip install graphifyy` | `/graphify` |
| [qmd](skills/qmd/) | Search markdown knowledge bases with hybrid BM25 + vector search | Node.js 18+, `npm install -g @tobilu/qmd` | `/qmd` |

## Playbooks

Standalone reference docs — useful with **any** agent, or for humans reading on a coffee break:

- [Bug Class Checklist](playbooks/bug-class-checklist.md) — 9 universal bug patterns with detection and fix strategies
- [Security Checklist](playbooks/security-checklist.md) — Trust boundary + auth checklist for web apps
- [Production Readiness](playbooks/production-readiness.md) — Full launch checklist with checkboxes
- [CI/CD Practices](playbooks/ci-cd-practices.md) — Lint, format, type-check, multi-repo commit patterns
- [CSV Export Safety](playbooks/csv-export-safety.md) — Formula injection, BOM, CRLF, URL lifecycle

## Multi-agent usage

The skill content is portable — only the wrapper format differs.

### Claude Code (native)

Skills auto-trigger from frontmatter or via `/skill-name`. Use the installer:

```bash
./setup.sh --all                                  # global (~/.claude/skills/)
./setup.sh --skills review-slice --project-local  # .claude/skills/ in current project
```

### Other agents (via adapters — coming)

Once `adapters/` is filled in, you'll be able to convert skills into the format your agent expects:

```bash
# Cursor
./adapters/cursor-rules/adapt.sh skills/debug-triage > .cursor/rules/debug-triage.mdc

# AGENTS.md (multi-agent emerging spec)
./adapters/agents-md/adapt.sh skills/implement-feature skills/debug-triage > AGENTS.md

# GitHub Copilot
./adapters/copilot-instructions/adapt.sh skills/* > .github/copilot-instructions.md

# Generic system-prompt paste (ChatGPT, Claude.ai, custom GPT)
./adapters/system-prompt/adapt.sh skills/audit-runner | pbcopy
```

### Right now (without adapters)

Open `skills/<name>/SKILL.md` directly — paste the content into your agent's system prompt or rules file. The frontmatter is informational; the body is plain markdown.

## Installation options

### Install all skills globally

```bash
./setup.sh --all                          # Linux/macOS
./setup.ps1 -All                          # Windows
```

### Install specific skills

```bash
./setup.sh --skills diagnose-fetch-failure,review-slice,seed-data
./setup.ps1 -Skills "diagnose-fetch-failure,review-slice,seed-data"
```

### Install as project-local skills

```bash
cd /path/to/your/project
/path/to/setup.sh --skills review-slice --project-local
```

### Manual install

Copy any `skills/<name>/` folder to `~/.claude/skills/<name>/` (global) or `.claude/skills/<name>/` (project-local).

## Roadmap

This repo grows over time.

**Runtime (v0.2):**
- Headless `claude` extraction step in the digest pipeline (replaces v0.1 stub)
- SQLite read/write wired to `better-sqlite3` (schema is already designed in [runtime/src/memory/sqlite.mjs](runtime/src/memory/sqlite.mjs))
- GEPA stages 1–4 wired to actual LLM calls (currently scaffolded; algorithm + Pareto selection work)
- Interactive `agent-daemon review` (accept / reject / edit each proposal)
- `agent-daemon watch` (chokidar fswatch — works for any agent that writes JSONL)
- Cline `TaskComplete` adapter, Cursor `stop` adapter, Codex `Stop` adapter

**Content categories being filled in:**
- **MCP servers** ([mcp/](mcp/)) — repomix, qmd, filesystem, postgres, github
- **Plugins** ([plugins/](plugins/)) — pre-commit-guard, audit-trail, claude-md-bootstrap
- **Tools** ([tools/](tools/)) — repo-summary, find-utility, migration-head, cache-keys, dead-export
- **Adapters** ([adapters/](adapters/)) — cursor-rules, agents-md, copilot-instructions, system-prompt
- **More skills** — every recurring discipline from real engineering work, generalized

If a category README starts with "Scaffolded — content coming", that's the active edge.

## Examples

Copy-paste configuration templates:

- [Global settings](examples/settings-global.json) — `~/.claude/settings.json` with model, plugins, marketplace
- [Project settings](examples/settings-project.json) — `.claude/settings.json` with hooks and permissions
- [Graphify hook](examples/hooks-graphify.json) — PreToolUse hook for graph-aware exploration
- [CLAUDE.md template](examples/CLAUDE.md.example) — Project documentation template
- [AGENTS.md template](examples/AGENTS.md.example) — Multi-repo workspace template

## Docs

- [Skill Anatomy](docs/skill-anatomy.md) — How SKILL.md works, frontmatter fields, trigger system
- [Installation Guide](docs/installation-guide.md) — All 3 install methods with OS-specific instructions
- [Customization Guide](docs/customization-guide.md) — Fork and adapt skills for your project

## Design principles

- **Stack-agnostic.** Examples rotate across React/Vue/Svelte, Django/FastAPI/Express/Rails, SQLite/Postgres/MySQL. No assumed stack.
- **Zero project-name leaks.** Skills are extracted from real codebases but every project-specific name is removed before publication.
- **Discipline over tooling.** Skills encode "what to check / what NOT to do / triage order" — not just "run this command".
- **Improve over time.** Every recurring trap from real engineering becomes a skill or playbook.

## License

MIT

# agent-daemon

[![test](https://github.com/Pankaj-mobiux/Agent-Daemon/actions/workflows/test.yml/badge.svg)](https://github.com/Pankaj-mobiux/Agent-Daemon/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.2.0-green.svg)](CHANGELOG.md)
[![harnesses](https://img.shields.io/badge/harnesses-Claude%20Code%20%7C%20Codex%20%7C%20Cursor-purple.svg)](#cross-harness-support)

A **self-improving runtime** for AI coding agents — with **multi-agent orchestration** built in. Wraps Claude Code (and any agent that writes a session transcript) with universal guardrails, persistent memory, and a digest pipeline that distills lessons from every session so the next one is automatically smarter.

Now ships with a full **team coordination layer**: spawn multiple Claude Code agents in isolated git worktrees, coordinate them through filesystem-based inboxes, and manage task dependencies with auto-unblocking — all without a central server, database, or API key.

Skills evolve too: [GEPA](runtime/src/digest/gepa/README.md) (Genetic-Pareto Prompt Evolution) reads execution traces and proposes Pareto-optimal skill refinements that you accept or reject via `agent-daemon review`.

> **v0.2.0 + Phase 5 (unreleased on `main`):** Cross-harness support for **Claude Code** (native), **Codex** (reference config + sub-agent TOML), and **Cursor** (hook bindings + skill→`.mdc` converter). 3 install profiles (`minimal` / `developer` / `security`) + 4 skill-install modes (`smart` / `all` / `minimal` / `manual`). 229 skills (43 curated + 186 vendored from [`everything-claude-code`](https://github.com/affaan-m/everything-claude-code)), 4 ported production hooks, audit-log rotation, GitHub Actions CI on Linux/macOS/Windows. **Phase 5** (see [CHANGELOG.md](CHANGELOG.md)) adds stack-detection-driven smart install, three new daemon skills (`skill-author`, `session-close`, `gepa-evolve-inline`), no-API-key GEPA via active session, 7 Hinglish extractor rules, multi-agent orchestration improvements, and weekly `activeContext.md` rotation. 141/141 tests pass.

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
ad init                              # default: developer profile + smart skill install
ad init --profile minimal            # memory + lifecycle hooks only
ad init --profile security           # default + intrusive guards (block --no-verify, MCP audit)
ad init --skills-mode all            # install ALL 229 skills (vs stack-detect-driven default)
ad init --skills-mode manual         # install only profile-listed skills (legacy behaviour)
ad init --plan                       # preview without applying

# 5. Open Claude Code — constitution + memory load automatically.
#    The agent emits a digest block before ending, the daemon parses it,
#    memory accumulates across sessions.
```

The `ad` command is the short alias for `agent-daemon` — both work interchangeably. No API key required for normal operation. Set `ANTHROPIC_API_KEY` only for `ad evolve` (GEPA batch evolution).

> **Verifying your install end-to-end?** Follow [docs/manual-test-v0.2.0.md](docs/manual-test-v0.2.0.md) — six sections, ~30 steps, each with expected output and the fix when it fails.

### Install profiles

| Profile | Hooks | Skills auto-installed | Best for |
|---|---|---|---|
| `minimal` | SessionStart + SessionEnd | none | Users who want explicit control |
| `developer` (default) | minimal + `console.log` warn on Edit, build/PR-URL log on Bash | 7 core (bootstrap-daemon, orchestrate-team, debug-triage, …) | Day-to-day coding |
| `security` | developer + blocks `git --no-verify`, blocks dev-server-without-tmux, audits every MCP call, warns on untrusted MCP servers | developer + 3 (security-audit, production-readiness, llm-app-safety) | High-stakes work, regulated repos |

Profile manifest: [runtime/profiles/profiles.json](runtime/profiles/profiles.json). Hook handlers under [runtime/src/hooks/](runtime/src/hooks/) are invoked via `ad hook <name>` and consume Claude Code's tool-use JSON on stdin. Profile shape adapted from [`everything-claude-code`](https://github.com/affaan-m/everything-claude-code) — see [ATTRIBUTION.md](ATTRIBUTION.md).

## Daily workflow

Two commands cover 99% of daily use. See [docs/workflow.md](docs/workflow.md) for the full guide.

### Bootstrap once (after `ad init`)

In your first Claude Code session, tell Claude:

> *"bootstrap the daemon memory using the bootstrap-daemon skill"*

Claude scans `package.json`, key folders, recent commits and populates `.agent-daemon/memory/*.md` with real project context (stack, conventions, gotchas). One-time, ~$0.05–0.10 in tokens. Without this, memory files stay as `{{PLACEHOLDER}}` templates until enough sessions accumulate to fill them organically.

### Session logs (`session-logs/`)

`ad init` also scaffolds a local-only (`.gitignored`) `session-logs/` directory. Claude updates this journal automatically when you say:

- *"log tokens"* (paste `/cost` output) — appends a token entry
- *"close session" / "end session" / "session khatam"* — fills the End-of-session block **and** emits the agent-daemon digest block in the same response
- *"new session"* — creates the next-numbered file

See `session-logs/README.md` (scaffolded into your project) for format details.

### Option A — `ad watch` (autopilot)

Leave it running in a background terminal:

```bash
ad watch --verbose --force
```

It monitors `~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/**/*.jsonl`. When a transcript settles (no writes for 30s, size stable), it auto-fires `ad digest` with the right `cwd` (read from inside the transcript). Set-and-forget.

### Option B — `ad digest-latest` (one-shot)

Run after a session ends:

```bash
cd /path/to/your/project
ad digest-latest --verbose
```

Auto-finds the newest transcript for the current directory, force-digests it. Idempotent — safe to run twice.

### Use both

`ad watch` and `ad digest-latest` are composable — SQLite dedupes already-digested sessions. Run watch as your default, fall back to `digest-latest` when you want immediate confirmation or when the watcher misses a session (Windows quirk — see [docs/troubleshooting.md](docs/troubleshooting.md)).

### The agent must emit a digest block

Both commands need Claude to emit a `<agent-daemon-digest>` block in its final response. The block format lives in [constitution/ending-protocol.md](constitution/ending-protocol.md) and is loaded into every session via SessionStart.

The agent doesn't always remember. To guarantee capture, ask Claude before ending:

> *"emit the agent-daemon digest block before ending"*

Alternative: pass `--fallback-to-llm` to either command to run an LLM extraction pass when no block is found (requires `claude` CLI on PATH, ~$0.005 per session).

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
├── skills/              # 36 Claude Code skills (SKILL.md), stack-agnostic
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
                                       #   --force            bypass triage threshold
                                       #   --fallback-to-llm  LLM extraction if no digest block
ad digest-latest                       # One-shot: find newest transcript for --cwd, force-digest
ad watch                               # Watch transcript dirs, fire digest on new sessions
                                       #   --verbose          log every file event
                                       #   --force            pass --force to each digest run
                                       #   --once-on-existing also digest existing transcripts
ad evolve <skill>                      # GEPA self-evolution run for a skill (needs auth)
                                       #   --list-candidates [--json]  list skills with ≥3 failures in 30d (no auth)
                                       #   --export-traces             export JSONL traces for inline GEPA (no auth)
ad review                              # Accept/reject queued skill proposals
ad init                                # Scaffold .agent-daemon/ + AGENTS.md in project
                                       #   --profile <name>     minimal | developer (default) | security
                                       #   --skills-mode <m>    smart (default — stack-detect) | all | minimal | manual
                                       #   --plan               print actions without applying
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
ad team retry    (tr)  --team <id> --task <task-id>   # Reset a failed task
ad spawn         (sp)  --team <id> --role <name> --task "..."
```

## Skill catalog (43 curated + 186 vendored = 229 total)

> The 43 curated skills below are documented; an additional 186 skills were imported from [`everything-claude-code`](https://github.com/affaan-m/everything-claude-code) (MIT) — each tagged with a `source:` frontmatter line. See [skills/README.md](skills/README.md) for the full vendored catalog and re-sync instructions.

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
| [bootstrap-daemon](skills/daemon/bootstrap-daemon/) | Full end-to-end daemon initialization + memory population | Auto: "initialize daemon", "bootstrap daemon" |
| [orchestrate-team](skills/daemon/orchestrate-team/) | Multi-agent task decomposition + team spawning | Auto: complex multi-domain tasks |
| [agent-self-improve](skills/productivity/agent-self-improve/) | Teaches agents the self-improvement discipline | Auto: session reflection |
| [skill-author](skills/daemon/skill-author/) | Dedup-first skill authoring (global vs project, ≥70% overlap → append) | Auto: "create a skill", "is se skill banao", "har baar yaad rakhna" / `/skill-author` |
| [session-close](skills/daemon/session-close/) | No-API session-end macro — session-log + digest + handoff + GEPA queue | Auto: "bye", "session khatam", "aaj ka kaam ho gaya", "done for today" |
| [gepa-evolve-inline](skills/daemon/gepa-evolve-inline/) | No-API-key GEPA — active Claude session does the reflection itself | Auto: "evolve skill", "skill ko better banao" |

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

- **agentskills.io standard** — all 36 of our curated SKILL.md files have compliant frontmatter. 181 additional skills imported from upstream follow their own conventions and are exempt from our strict linter.
- **Hermes-compatible memory** — same SQLite + FTS5 shape so skills + traces travel.
- **Cross-agent awareness** — session-start reads rules from Cursor (`.cursor/rules/`), Cline (`.cline/rules/`), and Claude Code auto-memory.
- **Transcript adapters** — digests transcripts from Claude Code, Cursor, Cline, and Codex.

## Cross-harness support

Three first-class harnesses. Adapters live under [adapters/](adapters/).

| Harness | Coverage | Install |
|---|---|---|
| **Claude Code** (primary) | Native — `ad init` writes to `~/.claude/`, hooks fire directly. | `ad init --profile <minimal\|developer\|security>` |
| **Codex** | Reference config + 2 sub-agent TOML files (explorer, reviewer). | `cp adapters/codex/config.example.toml ~/.codex/config.toml && cp adapters/codex/agents/*.toml ~/.codex/agents/` |
| **Cursor** | Hooks JSON wiring the same `ad hook` handlers + skill→`.mdc` converter. | `cp adapters/cursor/hooks.json .cursor/ && node adapters/cursor/adapt.mjs --core --out .cursor/rules` |

Other harnesses (Kiro / Trae / CodeBuddy / OpenCode / Gemini) are vendored-only for now — see [docs/future-harnesses.md](docs/future-harnesses.md).

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

## Per-session audit (`sessions.jsonl`)

Every time the digest pipeline runs, it appends one line to `<project>/.agent-daemon/sessions.jsonl`. This is your **"is the daemon actually doing anything?"** ledger.

Each line captures: timestamp, session id, adapter, duration, turns/tool-calls/edits, triage decision, learnings extracted/applied/queued, and extract source.

```sh
# Last 5 sessions:
tail -n 5 .agent-daemon/sessions.jsonl | jq .

# Anything land in memory this week?
git log --since="7 days ago" --oneline -- .agent-daemon/memory/

# Anything queued for your review?
ad status
```

Rotated at 5 MB (keeps `.1` + `.2`, discards older). Fully local — never shipped anywhere.

## Uninstall

agent-daemon has three install surfaces (global CLI, per-project files, user-level Claude settings). Remove them top-down for a clean wipe — no residue left behind.

### 1. Unlink the global `ad` command

```sh
npm unlink -g agent-daemon
```

After this, `ad --version` should say `command not found`.

### 2. (Optional) Delete the cloned repo

If you no longer want the source on disk, just delete the directory:

```sh
# Linux / macOS / Git Bash
rm -rf /path/to/Agent-Daemon

# PowerShell
Remove-Item -Recurse -Force "D:\path\to\Agent-Daemon"
```

This also drops every skill, hook config, constitution file, and the vendored snapshot. The CLI is already unlinked in step 1, so nothing references this directory anymore.

### 3. Remove agent-daemon from a specific project

If you ran `ad init` in a project and want to undo it without touching others:

```sh
cd /path/to/your-project

# Delete the per-project memory + agents guide
rm -rf .agent-daemon
rm -f AGENTS.md
```

Then open `CLAUDE.md` and remove the block between (and including) these two markers:

```
<!-- agent-daemon:start -->
... agent-daemon section ...
<!-- agent-daemon:end -->
```

Everything in `CLAUDE.md` outside those markers is your original content — leave it alone.

### 4. Clean `~/.claude/settings.json`

The hooks `ad init` injects look like this (commands all start with `ad`):

```json
{
  "hooks": {
    "SessionStart":  [ { "hooks": [{ "command": "ad session-start --output-json" }] } ],
    "SessionEnd":    [ { "hooks": [{ "command": "ad digest ..." }] } ],
    "PostToolUse":   [
      { "matcher": "Edit|Write|MultiEdit", "hooks": [{ "command": "ad hook edit-post" }] },
      { "matcher": "Bash",                 "hooks": [{ "command": "ad hook bash-post" }] }
    ],
    "PreToolUse":    [
      { "matcher": "Bash",     "hooks": [{ "command": "ad hook bash-pre" }] },
      { "matcher": "mcp__.*",  "hooks": [{ "command": "ad hook mcp-pre" }] }
    ]
  }
}
```

To remove them by hand: open `~/.claude/settings.json`, drop any hook entry whose `command` starts with `ad `. Keep any other entries (those belong to other tools).

Or do it programmatically:

```sh
node -e "
const fs = require('node:fs');
const path = require('node:path');
const p = path.join(process.env.HOME || process.env.USERPROFILE, '.claude/settings.json');
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
for (const ev of Object.keys(s.hooks || {})) {
  s.hooks[ev] = (s.hooks[ev] || [])
    .map(e => ({ ...e, hooks: (e.hooks || []).filter(h => !/^ad(\\s|\$)/.test(h.command || '')) }))
    .filter(e => (e.hooks || []).length > 0);
  if (s.hooks[ev].length === 0) delete s.hooks[ev];
}
fs.writeFileSync(p, JSON.stringify(s, null, 2));
console.log('cleaned');
"
```

### 5. Wipe daemon state

The daemon's local state (audit log, episodic memory DB) lives under `~/.agent-daemon/`:

```sh
# Linux / macOS / Git Bash
rm -rf ~/.agent-daemon

# PowerShell
Remove-Item -Recurse -Force "$env:USERPROFILE\.agent-daemon"
```

This deletes:
- `audit/mcp.jsonl` and its rotations — MCP audit trail
- `episodic.db` — SQLite episodic memory across all projects
- Any future state files

### 6. Verify

```sh
ad --version            # should say "command not found"
ls ~/.agent-daemon      # should say "no such file or directory"
```

Done. agent-daemon is fully removed.

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

**Start here:**
- [Onboarding deck](docs/onboarding-deck.md) — 28-slide zero-to-one walkthrough (Marp source — export PDF/PPTX/HTML via [docs/onboarding/README.md](docs/onboarding/README.md))
- [Workflow](docs/workflow.md) — `ad watch` vs `ad digest-latest`, the ending protocol, decision matrix
- [Troubleshooting](docs/troubleshooting.md) — 13 common failure modes with fixes (Windows watch, LLM fallback, hook misses, etc.)
- [Architecture](docs/architecture.md) — Three loops, components, data flow, file-system layout
- [Contributing](docs/contributing.md) — For new devs joining the project

**Reference:**
- [Installation Guide](docs/installation-guide.md) — All install methods with OS-specific instructions
- [Customization Guide](docs/customization-guide.md) — Fork and adapt skills for your project
- [Skill Anatomy](docs/skill-anatomy.md) — How SKILL.md works, frontmatter fields, trigger system
- [Manual test v0.2.0](docs/manual-test-v0.2.0.md) — End-to-end verification checklist
- [Ecosystem](docs/ecosystem.md) — Hermes interop, cross-agent awareness
- [Future harnesses](docs/future-harnesses.md) — Kiro/Trae/CodeBuddy/OpenCode/Gemini (vendored only)

**Top-level:**
- [SECURITY.md](SECURITY.md) — Threat model + responsible disclosure
- [CHANGELOG.md](CHANGELOG.md) — Release history
- [ATTRIBUTION.md](ATTRIBUTION.md) — Upstream credits
- [DEPENDENCIES.md](DEPENDENCIES.md) — Third-party deps and licenses

## Design principles

- **Stack-agnostic.** No assumed stack — examples rotate across frameworks and databases.
- **Zero-dependency coordination.** No Redis, no HTTP server. Just JSON files + atomic renames.
- **Git-native isolation.** Each spawned agent gets its own worktree and branch.
- **Discipline over tooling.** Skills encode what to check and what to avoid, not just commands.
- **Improve over time.** Every recurring trap becomes a skill, playbook, or persisted learning.

## License

MIT

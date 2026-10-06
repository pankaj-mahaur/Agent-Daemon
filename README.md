# agent-daemon

[![test](https://github.com/pankaj-mahaur/Agent-Daemon/actions/workflows/test.yml/badge.svg)](https://github.com/pankaj-mahaur/Agent-Daemon/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-2.0.2-green.svg)](CHANGELOG.md)
[![harnesses](https://img.shields.io/badge/harnesses-Claude%20Code%20%7C%20Codex%20%7C%20Cursor-purple.svg)](#cross-harness-support)

A **self-improving runtime** for AI coding agents — with **multi-agent orchestration** built in. Wraps Claude Code (and any agent that writes a session transcript) with universal guardrails, persistent memory, and a digest pipeline that distills lessons from every session so the next one is automatically smarter. Since v2 it also runs agents itself, on the OpenAI Codex engine.

Ships with a full **team coordination layer**: spawn worker agents (sandboxed Codex workers by default, Claude Code with `--engine claude`) in isolated git worktrees, coordinate them through filesystem-based inboxes, and manage task dependencies with auto-unblocking — all without a central server or database.

Skills evolve too: [GEPA](runtime/src/digest/gepa/README.md) (Genetic-Pareto Prompt Evolution) reads execution traces and proposes Pareto-optimal skill refinements that you accept or reject via `agent-daemon review`.

> **v1.0.0** is the stable Claude Code memory runtime (hooks, memory, skills, GEPA, teams). See [CHANGELOG.md](CHANGELOG.md).

> **v2.0.0 — Agent Daemon is now its own agent harness** on the OpenAI Codex engine: `ad chat`, `ad run`, `ad loop`, `ad schedule`, `ad web`, `ad acp`, with memory, hooks and skills wired in. See [Agent harness](#agent-harness-codex-engine). Want the Claude Code–only v1? See [Versions](#versions-v1-vs-v2).

## Quick start

**One-liner install** — clones, installs deps, and registers the `ad` command globally:

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/pankaj-mahaur/Agent-Daemon/main/install.ps1 | iex
```

```bash
# macOS / Linux / Git-Bash
curl -fsSL https://raw.githubusercontent.com/pankaj-mahaur/Agent-Daemon/main/install.sh | bash
```

Both are idempotent (re-run = `git pull` + relink) and clone to `~/.agent-daemon-src` (override with `AGENT_DAEMON_DIR`). They verify Node >=22 (on Windows they also warn below 22.17, which the coming terminal UI needs), skip test-only packages, run `ad doctor`, and print the next step. Pin a release with `AD_VERSION` (e.g. `AD_VERSION=v1.0.0`, see [Versions](#versions-v1-vs-v2)). Then, in any project:

```bash
cd /path/to/your/project
ad init                              # default: developer profile + smart skill install
ad init --profile minimal            # memory + lifecycle hooks only
ad init --profile security           # default + intrusive guards (block --no-verify, MCP audit)
ad init --skills-mode all            # install ALL bundled skills (vs stack-detect-driven default)
ad init --skills-mode manual         # install only profile-listed skills (legacy behaviour)
ad init --plan                       # preview without applying
```

Then open Claude Code — prioritized context and prompt-time retrieval load automatically. Explicit corrections are captured locally; session-close digest blocks add richer memory.

<details>
<summary><strong>Manual install</strong> (piping a script to a shell is sensitive — here's exactly what the one-liner does)</summary>

```bash
# 1. Clone & install
git clone https://github.com/pankaj-mahaur/Agent-Daemon.git
cd Agent-Daemon/runtime
npm install

# 2. Register the `ad` command globally
npm link              # now `ad` works from anywhere

# 3. Verify
ad doctor

# 4. Init in your project
cd /path/to/your/project
ad init
```

</details>

The `ad` command is the short alias for `agent-daemon` — both work interchangeably. No API key is required for local capture, retrieval, deterministic SessionEnd digest parsing, or inline skill evolution proposals. Claude Code itself must be authenticated for interactive sessions; authenticated batch/LLM fallback remains explicit opt-in behavior.

The harness commands (`ad tui`, `ad chat`, `ad run`, `ad loop`, `ad schedule`, `ad web`, `ad acp`) need a login first: `ad auth login chatgpt` (or `openai` / `openrouter`). See [Agent harness](#agent-harness-codex-engine).

### Windows team setup (Claude Code)

Use a clean clone or a clean pull of `main`; do not distribute another developer's linked runtime directory.

```powershell
# Install the CLI once per machine.
git clone https://github.com/pankaj-mahaur/Agent-Daemon.git 'D:\Program Files\Agent-Daemon'
Set-Location 'D:\Program Files\Agent-Daemon\runtime'
npm install
npm link

# Initialize each repository once.
$project = 'D:\path\to\your-project'
Set-Location $project
ad init --profile developer --skills-mode manual
ad doctor
```

If `ad doctor` reports memory placeholders or an oversized `activeContext.md`, open `claude` from the project root and ask it to bootstrap the daemon memory using verified repository facts and compact `activeContext.md` below the reported budget. Then run `ad doctor` again.

For a final no-API-key smoke test:

```powershell
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
claude -p "Reply with exactly CLAUDE_DAEMON_OK if you can see agent-daemon instructions and grounded project memory. Do not use tools or write files." `
  --output-format text `
  --tools '' `
  --permission-mode plan
```

Expected result: `CLAUDE_DAEMON_OK`, with no `SessionEnd hook failed` message after the response.

### Install profiles

| Profile | Hooks | Skills auto-installed | Best for |
|---|---|---|---|
| `minimal` | SessionStart + SessionEnd + prompt retrieval/extraction + skill telemetry | none | Users who want explicit control |
| `developer` (default) | minimal + `console.log` warn on Edit, build/PR-URL log on Bash | 7 core (bootstrap-daemon, orchestrate-team, debug-triage, …) | Day-to-day coding |
| `security` | developer + blocks `git --no-verify`, blocks dev-server-without-tmux, audits every MCP call, warns on untrusted MCP servers | developer + 3 (security-audit, production-readiness, llm-app-safety) | High-stakes work, regulated repos |

Profile manifest: [runtime/profiles/profiles.json](runtime/profiles/profiles.json). Hook handlers under [runtime/src/hooks/](runtime/src/hooks/) are invoked via `ad hook <name>` and consume Claude Code's tool-use JSON on stdin. Profile shape adapted from [`everything-claude-code`](https://github.com/affaan-m/everything-claude-code) — see [ATTRIBUTION.md](ATTRIBUTION.md).

## Agent harness (Codex engine)

Agent Daemon runs agents itself, with [OpenAI Codex](https://github.com/openai/codex) as the engine. It drives a pinned `codex app-server` (JSON-RPC over stdio) in its own `CODEX_HOME` (`~/.agent-daemon/codex-home`), so your own `~/.codex` is never touched. Every run gets the daemon's memory (SessionStart context, per-prompt recall, correction capture, the `agent-daemon-memory` MCP tools), guard hooks, skills and constitution.

```bash
ad auth login chatgpt            # ChatGPT Plus/Pro (browser; --device for a code)
ad auth login openai             # or an OpenAI API key (hidden prompt / stdin)
ad auth login openrouter --model anthropic/<model>   # Claude, Gemini, … via one OpenRouter key
ad auth status

ad tui                           # Codex-style terminal UI (early); docs/tui.md
ad codex                         # the stock Codex UI, on the harness home
ad chat                          # plain line mode; approve commands/edits with y / a / n
ad run "fix the failing test"    # one non-interactive turn (approvals declined)
ad loop "make the build green"   # autonomous loop with hard brakes (below)
ad schedule add "0 9 * * 1-5" run "summarize yesterday's commits"
ad web                           # local web UI (token-protected, loopback only)
ad acp                           # Agent Client Protocol agent for Zed / JetBrains
ad tools enable browser          # Playwright MCP; also: web-search
ad sandbox setup --elevated      # Windows: stronger command sandbox (one UAC prompt)
```

**Safety defaults.**
- **Interactive runs** (`ad tui`, `ad chat`, `ad web`, `ad acp`) use `workspace-write` + `on-request`: the agent writes only inside the project and asks before anything else.
- **`ad run`** is the same, but nobody can answer, so anything needing approval is declined.
- **Unattended runs** (`ad loop`, team workers, and `loop` schedule jobs) never ask. Instead, every turn is confined to the workspace with no network. MCP servers other than memory are off, and live web search is off. On Windows they refuse to start without a ready sandbox.
- **Team workers** can't write to `.git`. Their work is committed for them on their own branch, with repo hooks disabled for that commit.

**Keys.**
- OpenRouter keys are stored with DPAPI on Windows, libsecret on Linux (falling back to a 0600 file), and a 0600 file on macOS. They never go into config or argv, and `OPENROUTER_API_KEY` is stripped from the agent's shell.
- ChatGPT / OpenAI logins are kept by Codex in the harness home (`auth.json`). Your own environment variables (e.g. `GITHUB_TOKEN`) are passed through as in any Codex session.

**`ad loop` brakes:** dual exit (the agent must report `done` *and* `exit_signal`), a circuit breaker (no progress or the same error repeatedly), iteration / time / token budgets, and a STOP file (`.agent-daemon/STOP`) checked mid-turn.

**Subscriptions.** ChatGPT uses Codex's own login. Claude Pro/Max and Google AI Pro/Ultra logins are **never** reused by the harness, because their terms forbid it and it has been enforced. Use API keys or OpenRouter instead. `ad agy` can hand a prompt to *your own* Antigravity CLI (opt-in, `--accept-risk`).

**`ad tui`** is a Codex-style terminal UI on the same engine: history in your terminal's scrollback, approvals with the full command, steer and queue while a turn runs, `/undo` for the files a turn changed, and ad's memory, loops and schedules as slash commands. `/codex` (or `ad codex`) opens the stock Codex UI on the same conversation. Bare `ad` opens it with `AD_TUI=1`. Guide: [docs/tui.md](docs/tui.md).

Full guide: [docs/harness.md](docs/harness.md).

**Staying current with Codex.** The engine is pinned exactly.
- A committed protocol snapshot is checked by the test suite.
- The weekly [`codex-upgrade`](.github/workflows/codex-upgrade.yml) workflow bumps the pin, diffs the protocol (removals flagged as breaking) and opens a PR.
- That PR's CI runs the suite on Linux, macOS and Windows, including the real pinned Codex against a mock model (`runtime/test/engine-real.test.mjs`).
- CI has no real login and no Windows sandbox, so still do a live `ad run` smoke on Windows before merging.

Design and decisions: [docs/plans/codex-harness.md](docs/plans/codex-harness.md).

**Your own Codex stays yours.** The harness runs a separate pinned copy of Codex in its own home. It refuses to run in `~/.codex` (or a `CODEX_HOME` you set), and never passes your `CODEX_*` variables to its engine. The optional `ad watch` daemon reads `~/.codex/sessions` to learn from your own sessions, and writes nothing there.

## Versions: v1 vs v2

| | **v2** (`main`, 2.x) | **v1** (`release/v1`, 1.x) |
|---|---|---|
| What | Agent harness on the Codex engine **plus** everything in v1 | Claude Code memory runtime (hooks, memory, skills, GEPA, teams) |
| Status | Active development | Bug fixes only |
| Install | default one-liner | `AD_VERSION=v1.0.0` with the one-liner |

```bash
curl -fsSL https://raw.githubusercontent.com/pankaj-mahaur/Agent-Daemon/main/install.sh | AD_VERSION=v1.0.0 bash
```

```powershell
$env:AD_VERSION = 'v1.0.0'; irm https://raw.githubusercontent.com/pankaj-mahaur/Agent-Daemon/main/install.ps1 | iex
```

Re-run the one-liner without `AD_VERSION` to move back to `main`.

**Upgrading v1 → v2.** Claude Code mode is unchanged: `ad init`, the hooks, memory, skills and `/evolve` work as before. What changes:
- `ad sp` (spawn a team worker) now runs a **Codex** worker by default. Pass `--engine claude` for the v1 behaviour.
- New commands: `ad auth`, `ad tui` (terminal UI), `ad codex` (the stock Codex UI on the harness home), `ad chat`, `ad run`, `ad loop`, `ad schedule`, `ad web`, `ad acp`, `ad tools`, `ad sandbox`, `ad agy`. The ones that run the agent need a login first (`ad auth login chatgpt` / `openai` / `openrouter`).
- Digest/extract and GEPA LLM calls take `--llm claude|codex|auto` (`AD_LLM_BACKEND`). The default `auto` uses Claude and falls back to Codex when `claude` isn't installed.
- `ad doctor` adds Codex engine checks. The login, hook and sandbox checks are skipped until the harness home exists.

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

It monitors `~/.claude/projects/**/*.jsonl`, `~/.cursor/sessions`, `~/.codex/sessions` and the harness's own `~/.agent-daemon/codex-home/sessions` (opt out of the last with `"harnessSessions": false`). It also runs your `ad schedule` jobs. When a transcript settles (no writes for 30s, size stable), it auto-fires `ad digest` with the right `cwd` (read from inside the transcript). Set-and-forget.

### Option B — `ad digest-latest` (one-shot)

Run after a session ends:

```bash
cd /path/to/your/project
ad digest-latest --verbose
```

Auto-finds the newest transcript for the current directory, force-digests it. Idempotent — safe to run twice.

### Use both

`ad watch` and `ad digest-latest` are composable — SQLite dedupes already-digested sessions. Run watch as your default, fall back to `digest-latest` when you want immediate confirmation or when the watcher misses a session (Windows quirk — see [docs/troubleshooting.md](docs/troubleshooting.md)).

### Missed sessions self-heal (VS Code extension)

The VS Code extension never fires the SessionEnd hook, so its transcripts used to go undigested. Now every SessionStart spawns a detached, throttled (10-min) `ad digest-sweep` that digests any settled, undigested transcript for the project — skipping the live session and anything written in the last 2 minutes. You can also run it by hand:

```bash
ad digest-sweep --verbose
```

Set `AGENT_DAEMON_DISABLE_SWEEP=1` to opt out. `ad doctor` warns when the newest transcript is >24h ahead of the latest digest.

### Digest blocks improve memory quality

Prompt hooks capture explicit corrections and retrieve local SQLite learnings without an API key. A `<agent-daemon-digest>` block in Claude's final response adds a richer session summary for `ad digest` or `ad digest-latest`. The block format lives in [constitution/ending-protocol.md](constitution/ending-protocol.md).

To guarantee a full end-of-session summary, ask Claude before ending:

> *"emit the agent-daemon digest block before ending"*

Alternative: explicitly pass `--fallback-to-llm` to run an authenticated LLM extraction pass when no block is found. This is never installed as the default SessionEnd behavior.

## Multi-agent orchestration

Spawn a team of specialized agents that work in parallel on isolated branches, coordinate through filesystem inboxes, and auto-unblock dependent tasks on completion.

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
  - Starts a sandboxed Codex worker with a role-specific system prompt (no network, no `.git` writes; the daemon commits its work on its branch). `--engine claude` / `AD_AGENT_ENGINE=claude` spawns headless `claude` instead
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

- **Spawn timeout** (15 min default): Codex workers get a per-turn timeout; `claude` workers get SIGTERM → SIGKILL escalation
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
    triage -> extract -> sanitize -> classify -> dedupe -> apply (or quarantine / queue)
    |
Memory written, skill diffs queued for review
    |
Next session starts smarter
```

### Injection guardrails

Transcript text is untrusted input. Every extracted learning passes a deterministic screen (instruction-override, role-tag spoofing, digest-marker spoofing, exfiltration/coercion patterns — no LLM call). Suspicious entries are **quarantined as review proposals** — never silently dropped, never auto-applied. Everything re-injected at SessionStart is neutralized (control/zero-width/bidi characters stripped, markers defused) and framed as recorded observations, not instructions.

## Seamless skills — routing + on-demand install

```bash
ad skill search debug                  # find a bundled skill
ad skill install debug-triage          # bundled name — or a local path, or a git URL
ad skill install https://github.com/you/your-skills --skill review-helper
ad skill list                          # both lanes, with provenance
```

`ad skill install` lint-gates the frontmatter, records provenance (source + commit + sha256) in `~/.agent-daemon/skill-manifest.json`, and recompiles a **route map** from every installed skill's trigger phrases. A UserPromptSubmit hook matches each prompt against that map and injects a one-line skill recommendation — deterministic, fail-safe, and respectful of "do not use skills". Each recommendation is then correlated with what actually ran, so:

- `ad route stats` — advised / followed / diverged / ignored, per skill
- `ad route evolve` — telemetry-backed proposals to demote or rewire routes that don't work

Conversationally: tell Claude *"install this skill <url>"* — the bundled `skill-installer` skill drives the same CLI. Installs are copy-only (no code execution), and removal stays manifest-aware via `ad skill remove`.

## Memory evolution (Hermes-style)

Learnings live a lifecycle instead of accumulating forever:

- **Reinforce** — re-observing a known learning bumps confidence (+0.1, capped 0.95) and `observed_count` instead of being silently deduped away.
- **Decay** — search ranking multiplies BM25 relevance by a 90-day half-life on last-verified/last-retrieved time, so stale entries sink without being deleted.
- **Consolidate** — `ad memory consolidate` proposes near-duplicate merges (token Jaccard ≥ 0.8), stale archives, and contradiction candidates. Nothing applies without explicit acceptance (`--apply-merges` / `--apply-stale`).
- **User facts** — durable preferences observed across ≥2 projects promote into a cross-project profile injected at session start.
- **Typed observations** ([Honcho](https://github.com/plastic-labs/honcho)-inspired, deterministic) — each learning is tagged `explicit` (directly stated) vs `inferred` (generalized pattern); recall and the representation prefer stated facts. We keep the honest 2-way split — distinguishing deductive from inductive reliably needs an LLM, so we don't fake it.
- **User representation** — `buildUserRepresentation()` rolls facts + high-confidence stated learnings into a "how this user works" profile, surfaced at SessionStart and via the `memory_profile` MCP tool — the no-LLM analog of Honcho's dialectic.

Mid-session recall is pull-based too — a read-only **MCP memory server** with a token-cheap **progressive-disclosure** flow (index → context → detail, inspired by [claude-mem](https://github.com/thedotmack/claude-mem)):

- **Index (compact `[id …]` lines):** `memory_search`, `memory_recent`, `memory_files(path)`
- **Context:** `memory_timeline(id)` — the originating session + the sibling learnings around a hit
- **Detail:** `memory_get(ids)` — full text + evidence + provenance + derivation tier for the few ids you keep (write-back marks them retrieved)
- **Profile:** `memory_profile()` — a deterministic "how this user works" rollup (identity / prefers / tools / conventions / watch-out)
- Plus `memory_stats`, `user_facts_list`, and `memory_feedback`. Index tools cap at 5 results / 4 KB; `memory_get` at 8 KB.

```bash
claude mcp add agent-daemon-memory -- node /path/to/Agent-Daemon/runtime/src/mcp/memory-server.mjs
```

**File-aware memory** — the digest pipeline tags every learning with the files in play that session, so `memory_files("auth.ts")` recalls "what we learned about auth.ts", and SessionStart auto-boosts learnings tied to the files you're currently editing (from `git diff`/`status`).

**Privacy — `<private>…</private>`** — wrap any content in this tag and it's stripped before any extractor sees it; it never becomes a stored learning. A `screenLearning` backstop quarantines anything that slips through.

**Viewer** — `ad viewer --open` renders a single zero-dependency HTML snapshot (no server, no network) of sessions, learnings, proposals, routing stats, and retrieval telemetry. Defaults to `~/.agent-daemon/viewer.html`; `--out <path>` to redirect.

See [mcp/agent-daemon-memory/](mcp/agent-daemon-memory/) for config and the blast-radius statement, and `ad memory stats` for retrieval telemetry.

## What's in here

```
agent-daemon/
├── constitution/        # Universal guardrails — 12 cardinal rules every session loads
├── memory-templates/    # 6-file scaffold for project memory
├── runtime/             # Node CLI (agent-daemon) — digest, orchestration, self-improvement
│   └── src/
│       ├── engine/          # Codex app-server driver (pinned @openai/codex)
│       ├── harness/         # ad chat/run/loop/schedule/web/acp/auth/sandbox/agy
│       ├── auth/            # Provider keys + OS secret store
│       ├── orchestration/   # Multi-agent: inbox, spawn, team, templates, Codex workers
│       ├── daemon/          # Watch daemon + OS service registration
│       ├── digest/          # Extract → sanitize → classify → apply pipeline + GEPA
│       ├── memory/          # SQLite + FTS5 episodic store + consolidation
│       └── mcp/             # Read-only stdio MCP memory server
├── teams/templates/     # Team blueprints (JSON) — 4 built-in
├── skills/              # Bundled skills (curated + vendored)
├── playbooks/           # 5 reference docs — any agent or human can use
├── hooks/               # Pre-baked Claude Code hook configs
├── mcp/                 # MCP server config + docs (agent-daemon-memory)
├── plugins/             # Claude Code plugins (scaffolded)
├── tools/               # Standalone CLI tools (scaffolded)
├── adapters/            # Codex reference config + Cursor hooks / .mdc converter
├── examples/            # Settings + config templates
└── docs/                # Anatomy guides, install, customization
```

## CLI reference

All commands work with both `ad` (short) and `agent-daemon` (full). Short aliases are shown in parentheses.

```bash
# Harness (Codex engine) — see "Agent harness" above
ad auth login chatgpt|openai|openrouter   # ad auth use / status / logout
ad tui ["<prompt>"] [--last | --resume <id>]   # terminal UI (docs/tui.md); ad codex = stock Codex UI
ad chat | ad run "<prompt>" | ad loop "<objective>"
ad schedule add|list|remove|enable|disable|run|tick
ad web | ad acp | ad tools list|enable|disable | ad sandbox setup|status | ad agy "<prompt>"
ad spawn ... --engine codex|claude     # team workers (default: sandboxed Codex thread)
ad evolve <skill> --llm claude|codex|auto

# Core
ad doctor                              # Diagnose install — hooks, PATH, dirs, harness login/sandbox
ad doctor --tokens                     # Token usage + cache stats from recent sessions
ad session-start                       # Inject context (called by SessionStart hook)
ad digest                              # Run digest pipeline (called by SessionEnd hook)
                                       #   --force            bypass triage threshold
                                       #   --fallback-to-llm  LLM extraction if no digest block
ad digest-latest                       # One-shot: find newest transcript for --cwd, force-digest
ad digest-sweep                        # Digest every undigested transcript for --cwd
                                       #   (VS Code SessionEnd fallback — auto-fires from session-start)
                                       #   --exclude-session <id>  skip the live session
ad watch                               # Watch transcript dirs, fire digest on new sessions
                                       #   --verbose          log every file event
                                       #   --force            pass --force to each digest run
                                       #   --once-on-existing also digest existing transcripts
                                       #   --log-file <path>  tee to a rotating log (service mode)
ad service install                     # Register `ad watch` as a per-user login service
ad service uninstall                   #   (Scheduled Task / launchd / systemd-user)
ad service status
ad evolve <skill>                      # GEPA self-evolution run for a skill (needs auth)
                                       #   --list-candidates [--json]  list skills with ≥3 failures in 30d (no auth)
                                       #   --export-traces             export JSONL traces for inline GEPA (no auth)
ad review                              # Accept/reject queued skill proposals
ad init                                # Scaffold .agent-daemon/ + AD-INSTRUCTIONS.md in project
                                       #   --profile <name>     minimal | developer (default) | security
                                       #   --skills-mode <m>    smart (default — stack-detect) | all | minimal | manual
                                       #   --plan               print actions without applying
ad status                              # Show queued proposals
ad query-retrieve                      # Keyword extraction + learning injection

# Memory
ad memory stats                        # Row counts + retrieval telemetry (truncation rate, bytes)
ad memory consolidate                  # Evolution pass: near-dup merges, stale archive, contradictions
                                       #   proposals only — --apply-merges / --apply-stale execute
                                       #   --all-projects     span every project (default: --cwd only)
ad viewer                              # Render a zero-dep HTML snapshot of the episodic store
                                       #   --out <path>       output file (default ~/.agent-daemon/viewer.html)
                                       #   --open             open it in the default browser

# Skills — routing + on-demand install
ad skill install <name|path|git-url>   # Lint-gated install with provenance manifest
                                       #   --project   install to <cwd>/.claude/skills
                                       #   --skill <n> pick one from a multi-skill source
                                       #   --force / --dry-run
ad skill list [--available] [--json]   # Installed skills (both lanes) with provenance
ad skill remove <name> [--force]       # Manifest-aware removal
ad skill search <query>                # Search the bundled catalog
ad route stats [--days N] [--json]     # Advice effectiveness: advised/followed/diverged/ignored
ad route rebuild                       # Recompile route maps from installed skills
ad route show                          # Print the merged compiled route map
ad route evolve                        # Telemetry-backed routing-edit proposals

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

## Skill catalog

> The curated skills below are documented; an additional 112 skills are vendored from [`everything-claude-code`](https://github.com/affaan-m/everything-claude-code) (MIT) and friends — each tagged with a `source:` frontmatter line. Out-of-scope vendored skills were pruned from the bundle; see [skills/README.md](skills/README.md) for the full catalog and re-sync instructions.

### Build & implement

| Skill | Description | Trigger |
|---|---|---|
| [implement-feature](skills/engineering/implement-feature/) | Search-for-existing-utility discipline + correctness checklist | Auto: "add", "implement", "build" |
| [seed-data](skills/engineering/seed-data/) | Idempotent database seed scripts with realistic data | Auto: "generate seed data" |
| [db-migrations](skills/engineering/db-migrations/) | Numbered migrations, never-edit-shipped, forward-compatible | Auto: schema changes |
| [merge-feature-branch](skills/engineering/merge-feature-branch/) | Pull a shared branch into a feature branch safely | Auto: merge/rebase requests |
| [multiplatform-parity](skills/engineering/multiplatform-parity/) | Keep web + mobile in lockstep on shared backend changes | Auto: cross-client changes |

### Diagnose & debug

| Skill | Description | Trigger |
|---|---|---|
| [debug-triage](skills/engineering/debug-triage/) | Triage ladder: services → data → cache → request → code | Auto: "broken", "blank screen" |
| [diagnose-fetch-failure](skills/engineering/diagnose-fetch-failure/) | CORS / network errors in frontend-backend setups | Auto: "CORS blocked" |
| [diagnose-intermittent-failure](skills/engineering/diagnose-intermittent-failure/) | Zombie watchers, env not re-read, port collisions | Auto: intermittent errors |

### Audit & review

| Skill | Description | Trigger |
|---|---|---|
| [review-slice](skills/review-slice/) | Deep-review any page using a 9-class bug checklist | `/review-slice` |
| [audit-runner](skills/engineering/audit-runner/) | Execute audit punch-list with severity sequencing | Auto: "work through findings" |
| [security-audit](skills/engineering/security-audit/) | Trust boundary mapping + security review | `/security-audit` |
| [production-readiness](skills/engineering/production-readiness/) | Launch readiness across all layers | `/production-readiness` |
| [optimization-audit](skills/engineering/optimization-audit/) | Frontend + backend performance review | `/optimization-audit` |
| [dead-code-review](skills/engineering/dead-code-review/) | Proof-based dead code cleanup | `/dead-code-review` |
| [docs-sync-audit](skills/engineering/docs-sync-audit/) | Detect and fix documentation drift | `/docs-sync-audit` |

### Operate & deploy

| Skill | Description | Trigger |
|---|---|---|
| [deploy-ops](skills/engineering/deploy-ops/) | Deploy contract, CI gates, rollback playbook | Auto: "deploy", "prod" |
| [llm-app-safety](skills/engineering/llm-app-safety/) | Model fallback, agent veto, deterministic safety | Auto: AI/prompt changes |

### Orchestration

| Skill | Description | Trigger |
|---|---|---|
| [bootstrap-daemon](skills/daemon/bootstrap-daemon/) | Full end-to-end daemon initialization + memory population | Auto: "initialize daemon", "bootstrap daemon" |
| [orchestrate-team](skills/daemon/orchestrate-team/) | Multi-agent task decomposition + team spawning | Auto: complex multi-domain tasks |
| [agent-self-improve](skills/productivity/agent-self-improve/) | Teaches agents the self-improvement discipline | Auto: session reflection |
| [skill-author](skills/daemon/skill-author/) | Dedup-first skill authoring (global vs project, ≥70% overlap → append) | Auto: "create a skill", "is se skill banao", "har baar yaad rakhna" / `/skill-author` |
| [session-close](skills/daemon/session-close/) | No-API session-end macro — session-log + digest + handoff + GEPA queue | Auto: "bye", "session khatam", "aaj ka kaam ho gaya", "done for today" |
| [gepa-evolve-inline](skills/daemon/gepa-evolve-inline/) | No-API-key GEPA — active Claude session does the reflection itself | Auto: "evolve skill", "skill ko better banao" |
| [skill-installer](skills/daemon/skill-installer/) | Conversational skill install — drives `ad skill` (bundled / path / git URL) | Auto: "install this skill", "skill install karo", git-URL paste |
| [feature-flow](skills/daemon/feature-flow/) | Composite flow: plan → implement → verify → review, with checkpoints | Auto: "build the whole feature", "poora feature banao" |
| [bug-flow](skills/daemon/bug-flow/) | Composite flow: triage → fix root cause → prove by observation | Auto: "fix this bug properly", "root cause and fix" |
| [release-flow](skills/daemon/release-flow/) | Composite flow: changelog → verify → review diff → go/no-go | Auto: "cut a release", "release banao" |

### Methodology

| Skill | Trigger |
|---|---|
| [methodology-tdd](skills/engineering/methodology-tdd/) | Auto: test-related work |
| [methodology-code-review](skills/engineering/methodology-code-review/) | `/code-review` |
| [methodology-systematic-debugging](skills/engineering/methodology-systematic-debugging/) | Auto: debugging |
| [methodology-refactoring](skills/engineering/methodology-refactoring/) | Auto: refactor requests |
| [methodology-api-design](skills/engineering/methodology-api-design/) | Auto: API work |
| [methodology-incremental-delivery](skills/engineering/methodology-incremental-delivery/) | Auto: large features |
| [methodology-error-handling](skills/engineering/methodology-error-handling/) | Auto: error handling |
| [methodology-performance-profiling](skills/engineering/methodology-performance-profiling/) | Auto: perf issues |
| [methodology-architectural-decision](skills/engineering/methodology-architectural-decision/) | Auto: architecture |
| [methodology-dependency-management](skills/engineering/methodology-dependency-management/) | Auto: deps |
| [methodology-documentation](skills/engineering/methodology-documentation/) | Auto: docs |
| [methodology-brainstorm](skills/engineering/methodology-brainstorm/) | `/brainstorm` |
| [methodology-pair-programming](skills/engineering/methodology-pair-programming/) | Auto: pair work |
| [methodology-writing-plan](skills/engineering/methodology-writing-plan/) | `/plan` |

### Tools

| Skill | Dependencies | Trigger |
|---|---|---|
| [graphify](skills/productivity/graphify/) | Python 3.9+, `pip install graphifyy` | `/graphify` |
| [qmd](skills/productivity/qmd/) | Node 18+, `npm install -g @tobilu/qmd` | `/qmd` |

## Playbooks

Standalone reference docs for any agent or human:

- [Bug Class Checklist](playbooks/bug-class-checklist.md) — 9 universal bug patterns
- [Security Checklist](playbooks/security-checklist.md) — Trust boundary + auth checklist
- [Production Readiness](playbooks/production-readiness.md) — Full launch checklist
- [CI/CD Practices](playbooks/ci-cd-practices.md) — Lint, format, type-check patterns
- [CSV Export Safety](playbooks/csv-export-safety.md) — Formula injection, BOM, CRLF

## Compatibility

- **agentskills.io standard** — all our curated SKILL.md files have compliant frontmatter. Vendored skills follow their own conventions and are exempt from our strict linter.
- **Hermes-compatible memory** — same SQLite + FTS5 shape so skills + traces travel.
- **Cross-agent awareness** — session-start reads rules from Cursor (`.cursor/rules/`), Cline (`.cline/rules/`), and Claude Code auto-memory.
- **Transcript adapters** — digests transcripts from Claude Code, Cursor, Cline, and Codex.

## Cross-harness support

Three first-class harnesses. Adapters live under [adapters/](adapters/).

| Harness | Coverage | Install |
|---|---|---|
| **Claude Code** (primary) | Native — `ad init` writes to `~/.claude/`, hooks fire directly. | `ad init --profile <minimal\|developer\|security>` |
| **Codex** | **Engine of the Agent Daemon harness** (`ad chat` / `run` / `loop`, [above](#agent-harness-codex-engine)); rollout transcripts are digested. Reference config for your own `codex` CLI too. | `ad auth login chatgpt && ad chat` — or `cp adapters/codex/config.example.toml ~/.codex/config.toml` |
| **Cursor** | Hooks JSON wiring the same `ad hook` handlers + skill→`.mdc` converter. | `cp adapters/cursor/hooks.json .cursor/ && node adapters/cursor/adapt.mjs --core --out .cursor/rules` |

Other harnesses (Kiro / Trae / CodeBuddy / OpenCode / Gemini) are vendored-only for now — see [docs/future-harnesses.md](docs/future-harnesses.md).

## Multi-agent usage

### Claude Code (native)

Skills auto-trigger from frontmatter or via `/skill-name`. The runtime fires hooks automatically.

```bash
cd Agent-Daemon/runtime && npm install && npm link   # global install — `ad` works everywhere
ad init                                              # in your project — scaffolds memory + managed CLAUDE.md instructions
```

### Other agents

Open `skills/<name>/SKILL.md` directly — paste the content into your agent's system prompt or rules file. The frontmatter is informational; the body is plain markdown. Cursor has an adapter (`adapters/cursor/`), and the Codex harness writes its own `AGENTS.md`.

## Installation options

```bash
# Recommended: the one-liner in Quick start (AD_VERSION=vX.Y.Z to pin a release)

# From a clone: npm link (registers `ad` globally)
cd Agent-Daemon/runtime
npm install                  # also installs the pinned @openai/codex engine
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

Stop background work first: `ad service uninstall` (otherwise the login task keeps running `ad watch` and schedules) and `ad auth logout openrouter` (on Linux the key lives in libsecret, outside `~/.agent-daemon`).

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
rm -f AD-INSTRUCTIONS.md
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
    "UserPromptSubmit": [ { "hooks": [
      { "command": "ad hook user-prompt-extract" },
      { "command": "ad query-retrieve ..." }
    ] } ],
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
- `codex-home/` — the harness's Codex home (ChatGPT/OpenAI login `auth.json`, session rollouts)
- `secrets/`, `schedules.json`, `schedule-logs/` — provider keys, scheduled jobs and their logs
- Any future state files

The one-liner's clone lives at `~/.agent-daemon-src` (delete it in step 2).

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
- v0.6 — Multi-agent orchestration with production hardening, `ad` short commands, AD-INSTRUCTIONS.md auto-generation
- v1.0.0 — VS Code digest-sweep fallback, injection quarantine guardrails, on-demand `ad skill install` + data-driven routing with follow/diverge telemetry, Hermes-style memory evolution (reinforce → decay → consolidate), cross-project user facts, MCP memory server, `ad service` registration, composite flow skills, routing self-evolution proposals; **claude-mem-inspired:** progressive-disclosure MCP recall (`memory_get`/`memory_timeline`/`memory_files`), file-aware memory + SessionStart working-set boost, `<private>` exclusion tag, and `ad viewer` (zero-dep HTML snapshot)
- v2.0.0 — Agent harness on the Codex engine (`ad chat/run/loop/schedule/web/acp`), Codex team workers, `AD_VERSION` installer pinning

**Next:**
- Semantic task router — LLM-based auto template selection + role assignment
- True trace replay for GEPA evaluate
- Cross-machine memory sync
- Team kanban (tasks + agent status) in `ad web`

## Examples

Copy-paste configuration templates:

- [Global settings](examples/settings-global.json) — `~/.claude/settings.json` with model, plugins, marketplace
- [Project settings](examples/settings-project.json) — `.claude/settings.json` with hooks and permissions
- [Graphify hook](examples/hooks-graphify.json) — PreToolUse hook for graph-aware exploration
- [CLAUDE.md template](examples/CLAUDE.md.example) — Project documentation template
- [AGENTS.md template](examples/AGENTS.md.example) — Multi-repo workspace template

## Docs

**Start here:**
- [Agent harness guide](docs/harness.md) — `ad auth`, `ad chat/run/loop/schedule/web/acp`, safety model, Windows notes
- [Workflow](docs/workflow.md) — `ad watch` vs `ad digest-latest`, the ending protocol, decision matrix
- [Troubleshooting](docs/troubleshooting.md) — Common failure modes with fixes (Windows watch, LLM fallback, hook misses, etc.)
- [Architecture](docs/architecture.md) — Three loops, components, data flow, file-system layout
- [Contributing](docs/contributing.md) — For new devs joining the project

**Reference:**
- [Installation Guide](docs/installation-guide.md) — All install methods with OS-specific instructions
- [Customization Guide](docs/customization-guide.md) — Fork and adapt skills for your project
- [Skill Anatomy](docs/skill-anatomy.md) — How SKILL.md works, frontmatter fields, trigger system
- [Codex harness plan](docs/plans/codex-harness.md) — Design and decisions behind v2
- [Terminal UI plan](docs/plans/ad-tui.md) — The coming `ad` terminal UI: decisions, parts, progress
- [Research](docs/research/) — The Codex TUI and app-server, terminal engineering, how other harnesses are built
- [Backlog](docs/plans/backlog.md) — Ideas not yet planned
- [Manual test](docs/manual-test.md) — End-to-end checklist (Claude Code mode + harness)
- [Manual test v0.2.0](docs/manual-test-v0.2.0.md) — Historical v0.2.0-era checklist
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

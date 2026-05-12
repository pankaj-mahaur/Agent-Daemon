# Architecture

How agent-daemon works under the hood. Read this if you're contributing, debugging weird behavior, or evaluating whether to adopt the daemon for your team.

---

## The three loops

agent-daemon is best understood as three nested loops:

```
┌─ Outer loop: cross-session learning ─────────────────────────────┐
│                                                                  │
│  ┌─ Middle loop: single session ────────────────────────────┐    │
│  │                                                          │    │
│  │  ┌─ Inner loop: single turn (Claude's tool use) ───┐    │    │
│  │  │                                                  │    │    │
│  │  │   PreToolUse → tool runs → PostToolUse           │    │    │
│  │  │   (block / allow / log / lint)                   │    │    │
│  │  │                                                  │    │    │
│  │  └──────────────────────────────────────────────────┘    │    │
│  │                                                          │    │
│  │   SessionStart  →  ... turns ...  →  SessionEnd          │    │
│  │   (inject memory)                    (run digest)        │    │
│  │                                                          │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
│   memory/*.md  ←  digest  ←  many sessions                       │
│   (learnings persist across sessions)                            │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Inner loop** — hooks gate each tool call. Fast (< 200 ms), fail-safe.
**Middle loop** — one chat session. SessionStart loads context; SessionEnd digests.
**Outer loop** — accumulated learnings make every future session smarter.

---

## Components

### 1. CLI (`runtime/src/cli.mjs`)

Single entry point. Subcommand dispatcher. Roughly:

| Command | Module |
|---|---|
| `session-start` | `runtime/src/session-start.mjs` |
| `digest`, `digest-latest` | `runtime/src/digest/digest.mjs` |
| `watch` | `runtime/src/daemon/watch.mjs` |
| `hook <name>` | `runtime/src/hooks/*.mjs` |
| `init`, `doctor`, `status`, `review` | `runtime/src/cli.mjs` directly |
| `team *`, `spawn` | `runtime/src/orchestration/*.mjs` |
| `evolve` | `runtime/src/digest/gepa/*.mjs` |
| `checkpoint` | `runtime/src/cli.mjs` directly |

### 2. Hooks (`runtime/src/hooks/`)

Each hook is a small handler that reads JSON from stdin (the harness sends tool-call details) and writes a decision to stdout. Hooks must:

- **Finish in < 200 ms** for `PreToolUse` and `Stop`
- **Fail-safe to approve** — any thrown error → `{"decision":"approve"}`
- **Log warnings to stderr only**, prefixed with `[agent-daemon]`
- **Wrap persistence in try/catch** — disk-full / permission errors must not block

See [`hooks/README.md`](../hooks/README.md) for the full list.

### 3. Digest pipeline (`runtime/src/digest/`)

Runs on `SessionEnd` or on demand via `ad digest` / `ad digest-latest`.

```
transcript.jsonl
    │
    ▼
┌─────────────────────────────────────────────┐
│ 1. summarize() (adapters/*.mjs)             │  Parse JSONL, count turns,
│    → TranscriptSummary                       │  collect events, detect adapter
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│ 2. triage(summary)                           │  Should we digest this at all?
│    → { shouldDigest, reason }                │  (duration ≥ 5min OR edits ≥ 1
│                                              │   OR tools ≥ 5)
└─────────────────────────────────────────────┘
    │
    ▼ (or --force)
┌─────────────────────────────────────────────┐
│ 3. extractLearnings(summary)                 │  Look for <agent-daemon-digest>
│    → { learnings, sessionSummary, source }   │  block in agent's text.
│                                              │  Fallback: LLM extraction.
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│ 4. classify(learnings, availableSkills)      │  Route each learning to a target:
│    → ClassifiedLearning[]                    │  activeContext.md | proposals/
│                                              │  | constitution/ | skills/
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│ 5. applyLearnings(classified)                │  Write to memory or queue:
│    → { memoryProjectAppended, ... }          │  - Auto-append low-risk to .md
│                                              │  - Insert into SQLite
│                                              │  - Queue high-risk to proposals/
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│ 6. appendSessionLog(entry)                   │  One JSONL line to
│                                              │  .agent-daemon/sessions.jsonl
└─────────────────────────────────────────────┘
```

### 4. Memory (`.agent-daemon/memory/` + SQLite)

**Per-project markdown** (`.agent-daemon/memory/`):
- `projectbrief.md` — high-level goals + scope
- `productContext.md` — user-facing features + decisions
- `activeContext.md` — current focus, recent decisions, in-flight branches
- `systemPatterns.md` — architecture, recurring patterns, ADRs
- `techContext.md` — stack, dev setup, env vars, gotchas
- `progress.md` — what's done, what's queued
- `user.md` — collaborator-specific notes

**Global SQLite** (`~/.agent-daemon/episodic.db`):
- `sessions` — one row per digested session
- `learnings` — one row per extracted learning, queryable by tag / scope / confidence
- `skill_failures` — feedback signal for the GEPA evolve loop

### 5. Watch daemon (`runtime/src/daemon/watch.mjs`)

Foreground process. Uses `chokidar` (with Windows polling fallback) to watch transcript directories. For each file:

1. Detect change (`add` / `change`)
2. Debounce — wait 30 sec for the file to be stable
3. Stability check — poll size across two 5-sec intervals
4. Extract cwd from the transcript itself (Claude Code embeds it)
5. Fire `runDigest({ transcript, cwd, ... })`

Also polls team inboxes every 10 sec for multi-agent orchestration.

### 6. Constitution (`constitution/`)

Plain markdown files loaded into every session via `SessionStart`. Defines:

- `core.md` — identity, scope, what the agent is for
- `safety.md` — destructive-op guardrails, secret handling
- `verification.md` — how to confirm work is done
- `communication.md` — output style, when to ask vs proceed
- `ending-protocol.md` — the `<agent-daemon-digest>` block format

Constitution changes propagate to all future sessions on the next start. **No agent restart needed.**

### 7. Skills (`skills/`)

`SKILL.md` files with YAML frontmatter. Each is a self-contained "how to do X" instruction loaded on-demand. The classifier in the digest pipeline can route learnings to extend existing skills (via proposals).

### 8. Team orchestration (`runtime/src/orchestration/`)

Optional multi-agent layer. `ad team create` spins up a coordinator + workers, each in its own git worktree. `ad spawn` adds workers to an existing team. `ad team inbox` reads cross-agent messages.

Out of scope for daily solo workflow — see [`skills/orchestrate-team/SKILL.md`](../skills/orchestrate-team/SKILL.md) when you need it.

---

## Data flow — a single session, start to finish

```
[ User opens Claude Code ]
        │
        ▼
SessionStart hook fires
   → ad session-start
   → reads constitution/*.md + memory/*.md + queries SQLite for relevant past learnings
   → emits JSON {"hookSpecificOutput": {"additionalContext": "..."}}
   → Claude Code injects as a system-prompt addendum
        │
        ▼
[ User asks Claude to do something ]
        │
        ▼
PreToolUse hooks fire on each tool call
   → ad hook bash-pre  (e.g. block `--no-verify`)
   → ad hook edit-pre  (no-op by default)
        │
        ▼
[ Tool runs, e.g. Edit creates file.ts ]
        │
        ▼
PostToolUse hooks fire
   → ad hook edit-post (warn on console.log)
   → ad hook bash-post (tag PR URLs)
        │
        ▼
[ ... many turns ... ]
        │
        ▼
[ Agent emits <agent-daemon-digest> block in final message ]
        │
        ▼
[ User closes chat ]
        │
        ▼
SessionEnd hook fires (terminal CLI) OR
ad watch detects file settled OR
user runs `ad digest-latest`
   → ad digest --transcript X --cwd Y
   → triage → extract → classify → apply
   → memory/*.md grows, SQLite inserts, sessions.jsonl appends
        │
        ▼
[ Next session — SessionStart picks up the new memory ]
```

---

## File-system layout

```
Agent-Daemon/                       # The cloned repo
├── README.md
├── CHANGELOG.md
├── SECURITY.md
├── ATTRIBUTION.md
├── DEPENDENCIES.md
├── docs/
│   ├── workflow.md                 # ← this stream of docs
│   ├── troubleshooting.md
│   ├── architecture.md             # ← you are here
│   ├── installation-guide.md
│   ├── customization-guide.md
│   ├── manual-test-v0.2.0.md
│   ├── skill-anatomy.md
│   ├── ecosystem.md
│   └── future-harnesses.md
├── constitution/                   # Loaded into every session
├── memory-templates/               # Scaffolded into projects on `ad init`
├── skills/                         # Skills library
├── hooks/                          # Hook JSON snippets for settings.json
├── teams/                          # Multi-agent team templates
├── adapters/
│   ├── claude-code/
│   ├── codex/
│   └── cursor/
├── runtime/                        # Node implementation
│   ├── src/
│   │   ├── cli.mjs                 # Entry point
│   │   ├── digest/                 # Pipeline modules
│   │   ├── hooks/                  # Hook handlers
│   │   ├── memory/
│   │   ├── orchestration/
│   │   ├── adapters/
│   │   ├── daemon/                 # Watcher
│   │   └── ...
│   ├── test/                       # Node --test suite
│   ├── profiles/profiles.json      # Install profile manifest
│   └── package.json
├── vendored/                       # Upstream snapshots (gitignored)
└── setup.sh / setup.ps1            # Convenience installers

~/.agent-daemon/                    # User-level state (per-machine)
├── episodic.db                     # SQLite — learnings, sessions
├── audit/mcp.jsonl                 # MCP call audit (security profile)
├── logs/                           # Digest failure reports
└── watch.json                      # Watcher config

<project>/.agent-daemon/            # Per-project state (per-codebase)
├── memory/                         # 7 markdown files
├── proposals/                      # Queued diffs for review
├── sessions.jsonl                  # Per-session audit ledger
└── checkpoints/                    # Pre-compact memory snapshots

~/.claude/settings.json             # Where hooks are registered
~/.claude/projects/<encoded>/*.jsonl  # Transcripts (input to digest)
```

---

## Why this design

A few load-bearing decisions:

### Fail-safe to approve
A daemon bug must never block the user's tool execution. Trade-off: an adversary who controls the hook's stdin could bypass it. But the stdin comes from the Claude Code host, which is the user's own machine — out of scope.

### Zero-LLM digest (with optional fallback)
Default extraction is parse-only — the agent emits a structured block during the session. Cheap, deterministic, no API key needed. LLM fallback exists for sessions where the agent didn't follow protocol.

### Per-project memory, global SQLite
Per-project markdown means each codebase has its own brain. Global SQLite means queries can span all projects ("what have I learned about React in any project?").

### Profile-based install
`minimal`, `developer`, `security` — different audiences want different intrusiveness levels. The `developer` default is "useful but never blocks." The `security` profile adds shell-exec blocks for `--no-verify` etc.

### Idempotent everywhere
`ad init`, `ad digest-latest`, `npm link`, `ad watch` restart — all safe to run twice. This is core to the daemon being trustworthy.

---

## See also

- [Workflow](./workflow.md) — daily use
- [Troubleshooting](./troubleshooting.md) — common issues
- [Contributing](./contributing.md) — for new devs
- [SECURITY.md](../SECURITY.md) — threat model
- [Manual test](./manual-test-v0.2.0.md) — end-to-end verification

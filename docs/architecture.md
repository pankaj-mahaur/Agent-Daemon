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

### 1. CLI (`runtime/src/cli.mjs` + `runtime/src/cli-full.mjs`)

`runtime/src/cli.mjs` is the entry point the `ad` / `agent-daemon` bin shims and hook commands call. It is a small launcher: it routes the terminal UI (bare `ad`, `ad --last`, `ad tui`) itself, and hands every other command to `runtime/src/cli-full.mjs`, which holds the help text and the subcommand dispatcher. Roughly:

| Command | Module |
|---|---|
| bare `ad`, `ad --last`, `tui` | `runtime/src/tui/main.mjs` (`tui --preview`: `runtime/src/tui/preview.mjs`); whether bare `ad` can open it: `tui/flip.mjs`, `tui/preflight.mjs` |
| `session-start` | `runtime/src/session-start.mjs` |
| `digest`, `digest-latest`, `digest-sweep` | `runtime/src/digest/digest.mjs` |
| `watch`, `service` | `runtime/src/daemon/` |
| `hook <name>` | `runtime/src/hooks/*.mjs` |
| `init`, `doctor`, `status`, `review`, `checkpoint` | `runtime/src/cli-full.mjs` directly |
| `memory`, `route`, `skill`, `viewer` | `runtime/src/memory/`, `route-map.mjs`, `skill-install.mjs`, `viewer.mjs` |
| `team *`, `spawn` | `runtime/src/orchestration/*.mjs` |
| `evolve` | `runtime/src/digest/gepa/*.mjs` |
| `auth`, `chat`, `run`, `loop`, `schedule`, `web`, `acp`, `tools`, `sandbox`, `agy` | `runtime/src/harness/*.mjs` (engine: `runtime/src/engine/codex/`) |

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
│    → ClassifiedLearning[]                    │  activeContext.md | proposed/
│                                              │  | constitution/ | skills/
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│ 5. applyLearnings(classified)                │  Write to memory or queue:
│    → { memoryProjectAppended, ... }          │  - Auto-append low-risk to .md
│                                              │  - Insert into SQLite
│                                              │  - Queue high-risk to .agent-daemon/proposed/
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
- `injections`, `correction_events`, `feedback` — what each session was shown, each correction and whether it repeated a lesson, and memory_feedback verdicts; read by `ad memory report` ([Memory metrics](memory/metrics.md))

### 5. Watch daemon (`runtime/src/daemon/watch.mjs`)

Foreground process. Uses `chokidar` (with Windows polling fallback) to watch transcript directories. For each file:

1. Detect change (`add` / `change`)
2. Debounce — wait 30 sec for the file to be stable
3. Stability check — poll size across two 5-sec intervals
4. Extract cwd from the transcript itself (Claude Code embeds it)
5. Fire `runDigest({ transcript, cwd, ... })`

Watched directories: `~/.claude/projects`, `~/.cursor/sessions`, `~/.codex/sessions`, and the harness's `~/.agent-daemon/codex-home/sessions` (opt out with `"harnessSessions": false`).

Also polls team inboxes every 10 sec for multi-agent orchestration, and runs scheduled harness jobs (`ad schedule`).

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

Workers default to sandboxed engine threads: they can't reach the network or write `.git`, and the daemon commits their work on their branch. `--engine claude` (or `AD_AGENT_ENGINE=claude`) spawns headless `claude` as in v1.

Out of scope for daily solo workflow — see [`skills/orchestrate-team/SKILL.md`](../skills/daemon/orchestrate-team/SKILL.md) when you need it.

### 9. Agent harness (`runtime/src/harness/`, `runtime/src/engine/`)

ad's own agent runs on a pinned app-server, driven over JSON-RPC on stdio in ad's own engine home. `engine/index.mjs` is the engine API the rest of ad uses; `engine/codex/` is the only code that knows the engine's protocol and the only code that starts it. `harness/` holds the front ends (`chat`, `run`, `loop`, `schedule`, `web`, `acp`, `auth`, `sandbox`, `tools`, `agy`), the harness-home setup (`setup.mjs`: hooks, memory MCP server, skills, Windows sandbox), the session controller the terminal UI drives (`session.mjs`) and the `/undo` checkpoints (`checkpoints.mjs`). See [harness-design.md](harness-design.md).

### 10. Terminal UI (`runtime/src/tui/`)

Bare `ad` / `ad tui`: an inline terminal UI on the session controller. `terminal/` is the terminal layer (input decoding, sanitizing, widths, the inline renderer), `view/` the components (composer, markdown, cells, chrome, approval prompts), `app.mjs` the slash commands and keys, `main.mjs` the startup (sign-in, folder trust, header), `ad-layer.mjs` ad's own features (memory, loops, schedules, teams) and `undo.mjs` the `/undo` wiring. See [tui-architecture.md](tui-architecture.md) and [tui.md](tui.md).

---

### The provider gateway (P3.3)

API keys live in the secret store and in one place at run time: ad's gateway, a child process (`runtime/src/gateway/`) listening on `127.0.0.1`. The engine gets a per-run token and, per ready API account, a `-c model_providers.<entry>={ base_url = "http://127.0.0.1:<port>/p/<entry>/v1", env_key = "AD_GATEWAY_TOKEN" }`; the gateway swaps the token for the account's key, forwards `POST responses` and `GET models`, decodes a body the provider compressed anyway, and emits one observation per request (status, limits, usage, the error's class) for ad's own use. ad 3.0's provider name `openrouter` is pointed at the same route, so 3.0 conversations resume. Nothing about it is written to `config.toml`.

### Chat translation in the gateway (P6.1)

Some providers speak only Chat Completions; the engine speaks only the Responses API. A route whose preset says `mode: "chat"` is translated inside the gateway (`runtime/src/gateway/translate/`), so keys, the token check, the address allowlist and the redirect refusal stay the gateway's:

- **Request.** The engine's Responses request becomes a Chat body (`responses-in.mjs`). Namespaced and custom tools get flat names that map back exactly (`tools.mjs`). Anything with content ad can't carry is refused with HTTP 400 naming the field, never dropped. The engine's default cached web search is left out: it only works on OpenAI's own servers.
- **Answer.** The Chat stream becomes the engine's Responses events in its exact item shapes (`responses-out.mjs`). A tool call is handed over only whole, with its arguments parsed and its namespace or custom shape restored. A stream cut off mid-call, a length stop or an unmappable call runs nothing.
- **Failures.** Only codes the engine knows reach it (`errors.mjs`): a used-up daily or monthly limit is `insufficient_quota` (asked once, never retried), a per-minute limit `rate_limit_exceeded` with its wait, a too-long context the stream form of `context_length_exceeded`, a cut-off an unknown code (exactly one retry). The provider's real reason goes to the gateway's observation, and the TUI's failed-turn line and `ad run` show it instead of the engine's generic words.
- **Hidden reasoning** a provider wants back (DeepSeek's) travels in the engine's `encrypted_content` as an AES-256-GCM envelope bound to provider and model, under a per-install key in the secret store (`gateway-seal`).
- **Contract.** `scripts/record-engine-requests.mjs` records what the pinned engine sends into `test/fixtures/gateway/engine-<version>/`; `translate-contract.test.mjs` translates every recorded request. An engine upgrade that changes the wire fails there first.
- `AD_TRANSLATE=0` turns translated routes off (they answer 502 with the reason).

### Accounts, engines and switching (P3.4)

- **Target** (`runtime/src/auth/accounts/target.mjs`). Which account and model a conversation starts on is resolved before any engine starts, in this order:
  1. a flag or command;
  2. this window's choice;
  3. `AD_ACCOUNT`/`AD_MODEL`;
  4. the project's `.agent-daemon/config.json` `target`, read only in a trusted folder;
  5. the registry's default;
  6. 3.0's settings.

  The level that names the account also bounds the model. A target is fixed when its thread starts.
- **Engines** (`runtime/src/engine/manager.mjs`).

  | Engine id | Home | Serves |
  |---|---|---|
  | `api` | `@default` (no ChatGPT sign-in there) or `api/` | every API-key account, through the gateway |
  | an account id | that account's own home | a ChatGPT account (or an OpenAI key the engine keeps) |

  The EngineManager runs one process per engine id per ad process:
  - Leases are in-process. An unleased engine stops after an idle period unless it was pinned.
  - An acquire during that stop waits for it, so there are never two processes on one id.
  - When the gateway entries change, `restartIfStale` restarts the engine, and only when no turn runs.
- **Launch** (`runtime/src/harness/engines.mjs`). Every entry point (the terminal UI, `ad run`/`chat`/`loop`, `ad web`, `ad acp`, workers) calls `launchHarness`:
  1. adopt 3.0's key as an account;
  2. resolve the target;
  3. acquire the engine of the home that serves it (`@default`, `api`, `a/<id>`) from the process's EngineManager;
  4. start threads with that account's provider entry.

  A home a command or test chose (`--home`-style options) runs as before, with no accounts. `--resume`/`--last` look in the other homes too.
- **Settings record** (`runtime/src/harness/settings-sync.mjs`). The default home is the record for `[tui]` and folder trust. It is read through the engine's `config/read` (no TOML parser) into `accounts/settings-record.json`, mirrored into `api/` and `a/<id>` at each engine start, and edits made elsewhere wait as `pending` for the default home's next start.
- **Switching** (`runtime/src/engine/switch.mjs`). A loaded, subscribed or running thread keeps its provider on `thread/resume` even though the answer says success. So:
  - `resumeThread` with a provider or model first refuses a running thread, or one whose background terminals the caller names (`RETARGET_BUSY`). Otherwise it unsubscribes, waits for the unload, and checks the answer (`RETARGET_IGNORED`). A fork that names a provider or model is checked the same way.
  - Switching to another account of the same provider forks:
    1. pause the goal;
    2. confirm the thread is idle;
    3. fork with `deferGoalContinuation` and check the fork took the target;
    4. move the goal to the fork: an active goal is paused there, any other status is kept.

    If any step fails, the goal ad paused is active again, and a fork that ignored the target is archived.
  - After the fork, the old thread is unsubscribed. If background terminals still run in it, it stays subscribed and watched until they end, because unloading would kill them. A turn the engine starts on it is stopped and reported.

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
│   ├── harness.md, harness-design.md       # the agent harness: use, design
│   ├── tui.md, tui-architecture.md         # the terminal UI: use, design
│   ├── testing.md, manual-test.md          # test layers and CI, end-to-end checklist
│   ├── contributing.md
│   ├── installation-guide.md
│   ├── customization-guide.md
│   ├── skill-anatomy.md
│   ├── ecosystem.md
│   └── future-harnesses.md
├── constitution/                   # Loaded into every session
├── memory-templates/               # Scaffolded into projects on `ad init`
├── skills/                         # Skills library
├── hooks/                          # Hook JSON snippets for settings.json
├── teams/                          # Multi-agent team templates
├── adapters/                     # per-agent reference configs (your own install, cursor)
├── runtime/                        # Node implementation
│   ├── src/
│   │   ├── cli.mjs                 # Launcher: terminal UI; the rest → cli-full.mjs
│   │   ├── cli-full.mjs            # Help text + dispatcher for every other command
│   │   ├── digest/                 # Pipeline modules
│   │   ├── hooks/                  # Hook handlers
│   │   ├── memory/
│   │   ├── mcp/                    # MCP memory server (reads + usefulness feedback)
│   │   ├── engine/                 # The engine adapter and façade
│   │   ├── harness/                # chat/run/loop/schedule/web/acp/auth/sandbox/agy, session controller, /undo checkpoints
│   │   ├── tui/                    # Terminal UI: terminal/ layer, view/ components, app, /undo wiring
│   │   ├── auth/                   # Provider keys + secret store
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
├── logs/                           # Digest failure reports, tui-probe logs
├── checkpoints/                    # Pre-compact memory markers (ad checkpoint; not /undo)
├── watch.json                      # Watcher config
├── codex-home/                     # Engine home (login, config, rollouts, skills mirror)
├── secrets/                        # Provider keys (file backends)
├── schedules.json, schedule-logs/  # ad schedule jobs + output
├── tui/                            # Terminal UI: prompt history (0600), per-folder state
├── locks/                          # Conversation locks (one ad per conversation); a holder is judged by its process start time, so a reused pid is free at once and a suspended session keeps its lock
├── skill-manifest.json             # Provenance of skills installed with ad skill install
├── skills/<name>/                  # Accepted skill versions: current/, versions/<n>/, meta.json (ad review, ad skill undo)
├── projects.json                   # Project ids: paths, slugs, git remote (memory/projects.mjs); memory rows carry project_id
├── projects/<project id>/          # Capture files of a project without ad init (journals, proposals, memory)
├── teams/                          # Team state + inboxes
└── worktrees/                      # Worker git worktrees

<project>/.agent-daemon/            # Per-project state (per-codebase)
├── memory/                         # Project memory markdown files
├── proposed/                       # Queued proposals for review (ad status / ad review)
├── applied/, rejected/             # Proposals after review, kept as a record
├── sessions.jsonl                  # Per-session audit ledger
├── loops/                          # ad loop iteration logs
├── loop-tui.log                    # Output of a /loop started from ad tui
└── STOP                            # Create to stop a running ad loop

<repo>/.git/                        # Per repo where ad tui ran (/undo)
├── ad-checkpoint-index             # Private index for snapshots (never your index)
└── refs/ad/checkpoints/            # Snapshot trees, before and after each turn

~/.claude/settings.json             # Where hooks are registered
~/.claude/projects/<encoded>/*.jsonl  # Transcripts (input to digest)
~/.agent-daemon/engine/sessions/**/rollout-*.jsonl  # Harness transcripts
```

### Harness mode

The same hooks from `runtime/profiles/profiles.json` are rendered into the engine home's `hooks.json`, so `ad tui` (bare `ad`), `ad chat`, `ad run` and `ad loop` get memory injection, correction capture and guards. The engine caps SessionEnd at 3 s, so that hook spawns a detached `ad digest` instead of digesting inline. Memory is also exposed to the agent as the `agent-daemon-memory` MCP server, whose tools run without an approval prompt (`default_tools_approval_mode = "approve"`, unless the user set a mode). Design: [harness-design.md](harness-design.md).

**Isolation from the user's own install.** `runtime/src/engine/codex/` is the only code that starts the engine, and every spawn goes through `codexEnv()` in `home.mjs`:

- It runs only the pinned binary from `runtime/node_modules` (or `AD_ENGINE_BIN`), never a global or PATH install.
- Its home must be ad's own. `~/.codex`, a `CODEX_HOME` set by the user's shell, and any path that resolves to one of them are refused. Paths are compared by real path, which collapses junctions, symlinks, `\\?\`, 8.3 names and case. On Windows, trailing dots and spaces and UNC paths are refused too.
- Every `CODEX_HOME`, `CODEX_API_KEY` and similar variable is dropped, because those override config; `CODEX_CA_CERTIFICATE` is kept.
- `AD_INTERNAL_ENGINE_HOME` is stamped on the child, so hooks that the engine runs for ad recognise the home as ad's.
- `ad doctor` and the protocol-schema generator run the engine in throwaway temp homes.
- On Windows, `withoutStoreAliases()` in `app-server.mjs` drops every PATH entry with a `WindowsApps` segment at each spawn: the sandbox can't start PowerShell 7 from the Microsoft Store, so the engine uses an MSI PowerShell 7 or Windows PowerShell 5.1.

**Testing against the engine.** Three layers sit under the unit tests:
- the scripted fake app-server (`runtime/testkit/fake-codex-app-server.mjs`) for crashes and edge traffic;
- the real pinned binary against a mock Responses server (`runtime/test/engine-real.test.mjs` with `runtime/testkit/mock-responses.mjs`, opt-in `AD_REAL_ENGINE=1`), for behaviour a protocol snapshot can't catch;
- the real `ad tui` in a pseudo-terminal on the real binary and the mock model (`runtime/test/tui-live.test.mjs`, same opt-in).

CI's real-engine job runs the last two on Linux, macOS and Windows; it is non-blocking (`continue-on-error`), so read its result. Details: [testing.md](testing.md).

The terminal UI (`ad tui`, bare `ad`) builds on the same engine: [tui-architecture.md](tui-architecture.md).

---

## Why this design

A few load-bearing decisions:

### Fail-safe to approve
A daemon bug must never block the user's tool execution. Trade-off: an adversary who controls the hook's stdin could bypass it. But the stdin comes from the Claude Code host, which is the user's own machine — out of scope.

### Zero-LLM digest (with optional fallback)
Default extraction is parse-only — the agent emits a structured block during the session. Cheap, deterministic, no API key needed. LLM fallback exists for sessions where the agent didn't follow protocol; it runs on `claude` or ad's engine (`--llm claude|ad|auto`).

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
- [Harness design](./harness-design.md) and [terminal UI architecture](./tui-architecture.md) — the agent harness and `ad tui` in depth
- [Testing](./testing.md) — test layers and CI
- [Manual test](./manual-test.md) — end-to-end checklist (Claude Code mode + harness + terminal UI)

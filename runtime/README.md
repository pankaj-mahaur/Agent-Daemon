# runtime/

The `ad` (alias `agent-daemon`) Node CLI. It runs two things:

- **Claude Code mode:** hooks that capture learnings, a digest pipeline, SQLite + markdown memory, skill evolution (GEPA) and team orchestration.
- **The agent harness:** agents run on a pinned OpenAI Codex engine, with the same memory, hooks and skills wired in: the terminal UI (bare `ad`, `ad tui`), `ad chat`, `ad run`, `ad loop`, `ad schedule`, `ad web`, `ad acp`, plus `ad codex` (the stock Codex UI on ad's home), `ad auth`, `ad tools`, `ad sandbox` and `ad agy`.

User-facing docs: the [README](../README.md), [docs/tui.md](../docs/tui.md), [docs/harness.md](../docs/harness.md) and [docs/architecture.md](../docs/architecture.md). Tests: [docs/testing.md](../docs/testing.md).

## Install

The one-liner in the [README](../README.md#quick-start) does this for you. From a clone:

```bash
cd runtime
npm install --omit=dev && npm link --omit=dev   # users; contributors drop --omit=dev
ad doctor
```

- **Node:** 22 or later. On Windows the terminal UI needs 22.17+ or 24.2+.
- **Dependencies:**
  - `@openai/codex`, pinned exactly: the harness engine;
  - `better-sqlite3`: memory store;
  - `chokidar`: the `ad watch` daemon.
- No API key is needed for normal Claude Code use. The harness logs in with `ad auth login chatgpt | openai | openrouter`.

## Layout

```
src/
├── cli.mjs                 # launcher: the terminal UI (bare ad, ad tui) and ad codex; loads cli-full.mjs for the rest
├── cli-full.mjs            # help text + dispatcher for every other `ad` command
├── session-start.mjs       # SessionStart context (memory, learnings, guidance)
├── query-retrieve.mjs      # per-prompt recall
├── adapters/               # transcript parsers: claude-code, codex, cursor, cline
├── digest/                 # triage → extract → classify → apply; GEPA under digest/gepa
├── memory/                 # SQLite store, episodic memory, consolidation
├── hooks/                  # hook handlers (Claude Code, and Codex via --host codex)
├── mcp/memory-server.mjs   # agent-daemon-memory MCP server
├── daemon/                 # `ad watch` + OS service install
├── orchestration/          # teams, spawn, worktrees, Codex workers
├── auth/                   # provider keys, OS secret store
├── engine/
│   ├── index.mjs           # Engine: threads, turns, approvals, complete()
│   └── codex/              # the ONLY code that knows the app-server protocol
│       ├── app-server.mjs  # JSON-RPC client over stdio; Windows PATH without WindowsApps (withoutStoreAliases)
│       ├── home.mjs        # harness CODEX_HOME + isolation guard (codexEnv)
│       ├── events.mjs      # every Codex notification mapped to ad's events, or ignored with a reason
│       ├── approvals.mjs, hooks-config.mjs, doctor.mjs, surface.mjs
│       ├── compat.json     # the pinned and tested Codex versions, and what changed
│       └── protocol-snapshot.{mjs,json}, protocol-notifications.json   # tracked protocol surface for upgrades
├── harness/                # front ends: chat, run, loop, schedule, web, acp, auth, sandbox, tools, agy, codex-ui;
│                           #   setup.mjs (harness home), session.mjs (session controller), checkpoints.mjs (/undo)
└── tui/                    # the terminal UI: main.mjs (startup), app.mjs (keys, slash commands), undo.mjs,
                            #   ad-layer.mjs (ad's features), terminal/ (input, renderer, sanitize, widths), view/
testkit/
├── fake-codex-app-server.mjs   # scripted fake engine for most harness tests
├── mock-responses.mjs          # mock Responses API for real-engine tests
├── protocol-check.mjs          # checks the fake's messages against the protocol snapshot
├── golden.mjs, screen.mjs      # golden files; headless terminals for renderer tests
├── tui-fake.mjs, tui-preview-fake.mjs
└── wait.mjs
scripts/
├── codex-schema-snapshot.mjs   # regenerate / --check the protocol snapshot
├── codex-slash.mjs, codex-notifications.mjs   # regenerate Codex's slash-command names; its notification list
├── tui-probe.mjs               # what a terminal sends and how it wraps (keys | screen)
├── tui-demo.mjs                # the terminal layer on its own, with no engine
├── gen-width-tables.mjs        # regenerate the Unicode width table
├── check-doc-links.mjs         # every relative doc link points at a tracked file
├── lint-skills.mjs, skills-diff.mjs, sync-constitution-to-cursor.mjs
└── install-service-*.{sh,ps1}
```

## Your own Codex is never touched

The engine is a separate pinned Codex with its own home (`~/.agent-daemon/codex-home`). Every spawn goes through `codexEnv()` in `src/engine/codex/home.mjs`:

- It refuses `~/.codex`, a `CODEX_HOME` your shell sets, and any path that resolves to one of them.
- It drops your `CODEX_*` variables (`CODEX_CA_CERTIFICATE` is kept).
- It never runs your global `codex`.

On Windows, each spawn also drops every `WindowsApps` entry from the engine's PATH (`withoutStoreAliases()` in `app-server.mjs`): the sandbox can't start PowerShell 7 from the Microsoft Store.

Details: [docs/harness.md](../docs/harness.md).

## Tests

```bash
npm test                                   # node --test: unit tests + the fake engine
node --test test/<name>.test.mjs           # one file
AD_REAL_ENGINE=1 node --test --test-concurrency=1 --test-force-exit test/engine-real.test.mjs test/tui-live.test.mjs
                                           # the real pinned Codex vs a mock model (no login), and the live ad tui
node scripts/codex-schema-snapshot.mjs --check   # protocol snapshot matches the pinned Codex
```

The tests need the devDependencies (`npm install` without `--omit=dev`). CI runs `npm test` on Linux, macOS and Windows, plus the real-engine job (non-blocking: read its result). See [docs/testing.md](../docs/testing.md) for the layers and CI, and [docs/contributing.md](../docs/contributing.md) for conventions.

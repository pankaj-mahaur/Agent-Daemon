# runtime/

The `ad` (alias `agent-daemon`) Node CLI. It runs two things:

- **Claude Code mode:** hooks that capture learnings, a digest pipeline, SQLite + markdown memory, skill evolution (GEPA) and team orchestration.
- **The agent harness:** agents run on a pinned OpenAI Codex engine (`ad chat`, `ad run`, `ad loop`, `ad schedule`, `ad web`, `ad acp`), with the same memory, hooks and skills wired in.

User-facing docs: the [README](../README.md), [docs/harness.md](../docs/harness.md) and [docs/architecture.md](../docs/architecture.md).

## Install

The one-liner in the [README](../README.md#quick-start) does this for you. From a clone:

```bash
cd runtime
npm install --omit=dev && npm link --omit=dev   # users; contributors drop --omit=dev
ad doctor
```

- **Node:** 22 or later. On Windows the coming terminal UI needs 22.17+ or 24.2+.
- **Dependencies:**
  - `@openai/codex`, pinned exactly: the harness engine;
  - `better-sqlite3`: memory store;
  - `chokidar`: the `ad watch` daemon.
- No API key is needed for normal Claude Code use. The harness logs in with `ad auth login chatgpt | openai | openrouter`.

## Layout

```
src/
├── cli.mjs                 # dispatcher for every `ad` command
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
│       ├── app-server.mjs  # JSON-RPC client over stdio
│       ├── home.mjs        # harness CODEX_HOME + isolation guard (codexEnv)
│       ├── approvals.mjs, hooks-config.mjs, doctor.mjs
│       └── protocol-snapshot.{mjs,json}   # tracked protocol surface for upgrades
└── harness/                # front ends: chat, run, loop, schedule, web, acp, auth, sandbox, tools, agy
testkit/
├── fake-codex-app-server.mjs   # scripted fake engine for most harness tests
├── mock-responses.mjs          # mock Responses API for real-engine tests
└── wait.mjs
scripts/
├── codex-schema-snapshot.mjs   # regenerate / --check the protocol snapshot
├── tui-probe.mjs               # what a terminal sends and how it wraps (keys | screen)
├── lint-skills.mjs, skills-diff.mjs, sync-constitution-to-cursor.mjs
└── install-service-*.{sh,ps1}
```

## Your own Codex is never touched

The engine is a separate pinned Codex with its own home (`~/.agent-daemon/codex-home`). Every spawn goes through `codexEnv()` in `src/engine/codex/home.mjs`:

- It refuses `~/.codex`, a `CODEX_HOME` your shell sets, and any path that resolves to one of them.
- It drops your `CODEX_*` variables.
- It never runs your global `codex`.

Details: [docs/harness.md](../docs/harness.md).

## Tests

```bash
npm test                                   # node --test: unit tests + the fake engine
node --test test/<name>.test.mjs           # one file
AD_REAL_ENGINE=1 node --test --test-concurrency=1 --test-force-exit test/engine-real.test.mjs
                                           # the real pinned Codex vs a mock model (no login)
node scripts/codex-schema-snapshot.mjs --check   # protocol snapshot matches the pinned Codex
```

CI runs `npm test` on Linux, macOS and Windows, plus the real-engine job. See [docs/contributing.md](../docs/contributing.md) for conventions.

# Plan — Agent Daemon as a Codex-based agent harness

Status: IMPLEMENTED (Parts 0–14) · approved 2026-09-30 · built 2026-10-01 · branch `feat/codex-harness`

## Implementation status

| # | Part | Status | Where |
|---|---|---|---|
| 0 | Foundation & spike | ✅ | `runtime/src/engine/codex/app-server.mjs`, `runtime/testkit/` |
| 1 | Engine API + Codex engine | ✅ | `engine/index.mjs`, `engine/codex/home.mjs`, `approvals.mjs`, `ad run` |
| 2 | Upstream tracking | ✅ | `protocol-snapshot.{mjs,json}`, `scripts/codex-schema-snapshot.mjs`, `.github/workflows/codex-upgrade.yml` |
| 3 | Auth broker | ✅ (macOS: 0600 file — Keychain backend not built: `security` only takes the secret in argv) | `harness/auth.mjs`, `auth/secrets.mjs`, `auth/providers.mjs` |
| 4 | Memory/hooks/skills/AGENTS.md in Codex | ✅ | `harness/setup.mjs`, `engine/codex/hooks-config.mjs`, `hooks/io.mjs` (host adaptation), `hooks/codex-session-end.mjs` |
| 5 | `ad chat` | ✅ | `harness/chat.mjs` |
| 6 | Transcript + digest | ✅ | `adapters/codex.mjs` (real rollouts), `daemon/config.mjs` |
| 7 | Internal LLM calls via engine | ✅ | `llm.mjs` (`--llm claude|codex|auto`), isolated `engine.complete()` |
| 8 | Multi-agent on Codex | ✅ | `orchestration/codex-worker.mjs` (`ad spawn --engine`) |
| 9 | `ad loop` | ✅ | `harness/loop.mjs` |
| 10 | Agent tools | ✅ | `harness/tools.mjs` (browser, web-search) |
| 11 | `ad schedule` | ✅ | `harness/schedule.mjs`, run by `ad watch` |
| 12 | More providers | ✅ `ad agy` · ⏸ translator | `harness/agy.mjs`; the native-key Responses translator was **not built** — its condition ("only if OpenRouter is not enough") isn't met |
| 13 | Web UI + ACP | ✅ | `harness/web.mjs`, `harness/acp.mjs` |
| 14 | Docs, doctor, cleanup | ✅ | `engine/codex/doctor.mjs` (live checks), README, adapters/codex, `.out-of-scope/no-codex-runtime.md` (superseded) |

Every part went through implement → test → independent review → fix; the
reviews' confirmed findings are fixed in the same commits.

**Verified live on Windows (codex 0.159.2):** app-server turns with ChatGPT
login; hooks.json in the harness home (PowerShell `commandWindows`), hook
trust via `config/value/write`, SessionStart / UserPromptSubmit / SessionEnd
payloads and context injection, memory MCP startup, detached SessionEnd
digest reading a real rollout, config batch writes (null deletes), thread
config overrides (`features.hooks`, `mcp_servers.<id>.enabled`), Windows
sandbox setup + readiness, protocol-snapshot diff 0.155.1 → 0.159.2.
**Not verifiable here without the user's own login/keys:** a full coding turn
in the harness home (needs `ad auth login chatgpt` once), OpenRouter
(needs a key), `agy` (uses the user's Google subscription), Playwright MCP
download, ACP inside a real editor.

## Context

Agent Daemon today is a memory/skills/learning layer that rides inside Claude Code via hooks.
Goal: make it a **harness of its own** — coding + general agentic work — with **OpenAI Codex
(`codex app-server`) as the only engine**, while keeping today's Claude Code hooks mode.

Decided: Codex only (no OpenCode) · ChatGPT subscription + API keys · Claude/Gemini models via
OpenRouter first · keep Claude Code mode · reverse `.out-of-scope/no-codex-runtime.md`.

Already proven (Part 0 spike): Node client `runtime/src/engine/codex/app-server.mjs` ran a real
turn on Windows via ChatGPT login (`gpt-5.6-terra`, ~20 s).

## Hard rules (from research)

- **Never fork Codex.** Drive the pinned binary over stdio JSON-RPC. Use only the stable surface
  (no `experimentalApi`, no `chatgptAuthTokens` — schema says "OpenAI internal only").
- **Never reuse Claude or Google subscription OAuth** (ToS-banned, enforced in 2026).
  Gemini subscription only by delegating to the user's own `agy` binary.
- **ChatGPT login is owned by app-server** (`account/login/start` chatgpt / device code).
  Not the SIWC devkit — it's a private package under a noncommercial license.
- **Minimal deps stay.** Codex is a pinned engine binary; our code stays zero-dep Node.

## Architecture

```
ad chat / ad run / ad loop / ad schedule      ← our UX (terminal first, web later)
  └─ Agent Daemon core: memory · skills · learning · teams · loops · scheduler
      ├─ auth broker     (ad auth …, secret store)
      ├─ engine API      runtime/src/engine/index.mjs   ← only thing core talks to
      │    └─ codex      runtime/src/engine/codex/*     ← only thing that knows the protocol
      └─ harness home    ~/.agent-daemon/codex-home  (CODEX_HOME: config.toml, hooks.json,
                          AGENTS.md, sessions) — isolated from the user's ~/.codex
```

## Parts

| # | Part | Depends on | MVP? |
|---|---|---|---|
| 0 | Foundation & spike | — | ✅ (mostly done) |
| 1 | Engine API + Codex engine | 0 | ✅ |
| 2 | Upstream tracking (pin + schema diff + upgrade bot) | 1 | ✅ |
| 3 | Auth broker | 1 | ✅ |
| 4 | Memory, hooks, skills, AGENTS.md inside Codex | 1 | ✅ |
| 5 | `ad chat` terminal UI | 1, 3 | ✅ |
| 6 | Transcript + digest for Codex threads | 1 | ✅ |
| 7 | Internal LLM calls via engine (GEPA, extract) | 1 | |
| 8 | Multi-agent teams on Codex threads | 1, 4 | |
| 9 | Autonomous loops (`ad loop`) | 5 | |
| 10 | General agent tools (browser, web, files) | 4 | |
| 11 | Scheduler (`ad schedule`) | 9 | |
| 12 | More providers (native keys translator, `agy` delegate) | 3 | |
| 13 | Web UI + ACP agent mode | 5 | |
| 14 | Docs, doctor, out-of-scope cleanup | all | ✅ (rolling) |

Build order: 0 → 1 → 2 → 3 → 4 → 5 → 6 (= MVP), then 7 → 8 → 9 → 10 → 11 → 12 → 13.

---

### Part 0 — Foundation & spike
- ✅ Branch `feat/codex-harness` (no upstream to main).
- ✅ `runtime/src/engine/codex/app-server.mjs`: JSON-RPC client, Windows spawn via `node codex.js`,
  approvals declined by default, `runTurn()` helper.
- ✅ Live spike: initialize → account/read → thread/start → turn/start → turn/completed.
- TODO: fake app-server script `runtime/test/fixtures/fake-codex-app-server.mjs` + unit tests
  (handshake, request/response, notifications, server-request reply, crash → pending rejected).
- **Done when:** `node --test` green incl. new client tests, no network.

### Part 1 — Engine API + Codex engine
- `runtime/src/engine/index.mjs`: `createEngine(opts)` → `{ startThread, resumeThread, runTurn,
  interrupt, steer, complete({system,user,schema,model}), close }` + event stream
  (normalized: `delta`, `item`, `approval`, `turnDone`, `error`).
- `complete()` uses `turn/start.outputSchema` + ephemeral thread → replaces `callHeadlessClaude` shape
  (`runtime/src/claude.mjs:43`).
- Harness home bootstrap `runtime/src/engine/codex/home.mjs`: create `~/.agent-daemon/codex-home`
  (short path — Windows socket limit 108 B), write `config.toml` (`cli_auth_credentials_store="file"`,
  default sandbox `workspace-write`, approvals `on-request`), spawn with `CODEX_HOME` set.
- Pin `@openai/codex` **exact** version in `runtime/package.json` (binaries come as optional deps);
  resolve bin from `node_modules` first, then `AD_CODEX_BIN`, then global.
- **Done when:** `ad run "…"` does one non-interactive turn end-to-end; tests use the fake server.

### Part 2 — Upstream tracking (start early, runs forever)
- `runtime/src/engine/codex/protocol-snapshot.json`: method lists + key param/response shapes,
  generated by `scripts/codex-schema-snapshot.mjs` from `codex app-server generate-json-schema`.
- Test: live-generated snapshot == committed snapshot for the pinned version (skips if no codex).
- `.github/workflows/codex-upgrade.yml` (weekly): read npm `latest` (not alpha) → bump pin on a branch →
  regenerate snapshot → `git diff` → run tests + recorded-replay tests → open PR with schema diff + release notes link.
- `ad doctor`: warn when installed codex ≠ pinned.
- **Done when:** a dry run of the workflow against 0.155.1 → 0.159.2 opens a PR with a readable diff.

### Part 3 — Auth broker
- `ad auth login chatgpt [--device]` → `account/login/start` (browser or device code), wait for
  `account/login/completed`. Tokens live in harness `CODEX_HOME` (Codex refreshes them).
- `ad auth login openai --key` → `account/login/start {type:"apiKey"}`.
- `ad auth login openrouter --key` → secret store + `model_providers.openrouter`
  (`base_url=https://openrouter.ai/api/v1`, `env_key=OPENROUTER_API_KEY`, `supports_websockets=false`);
  key injected as env at spawn, never written to config.
- `ad auth status | logout`.
- Secret store `runtime/src/auth/secrets.mjs` (zero-dep): Windows Credential Manager via PowerShell,
  macOS `security`, Linux `secret-tool`, fallback 0600 file. Keys never logged or put in argv.
- **Done when:** all three logins work on Windows; `ad auth status` shows provider + plan, no secrets.

### Part 4 — Memory, hooks, skills, AGENTS.md inside Codex
- Write `CODEX_HOME/hooks.json` calling `ad hook <name>` (SessionStart, UserPromptSubmit, PreToolUse,
  PostToolUse, Stop, SessionEnd). Pre-trust our own hooks: `hooks/list` → `config/value/write`
  `hooks.state."<key>".trusted_hash = currentHash`.
- Host normalizer `runtime/src/hooks/host.mjs`: map Codex fields/tool names (`shell`, `apply_patch`)
  to what hooks expect; output as `hookSpecificOutput.additionalContext` (Codex accepts it).
  Hooks in `runtime/src/hooks/*` stay shared.
- Register memory MCP: `[mcp_servers.agent-daemon-memory] command="node" args=[…/memory-server.mjs]`.
- Skills: `skills/extraRoots/set` → our installed skills dir (per process, not persisted).
- Global instructions: `CODEX_HOME/AGENTS.md` = constitution + operating manual (managed markers).
- **Done when:** a Codex turn shows SessionStart memory context, a correction in chat lands in SQLite,
  and the model can call `memory_search`.

### Part 5 — `ad chat` terminal UI (zero-dep: readline + ANSI)
- Streaming text, tool/command items, diffs summary, approval prompt (accept / session / decline),
  Ctrl+C = `turn/interrupt`, `/resume`, `/model`, `/goal`, `/compact`, `/exit`.
- Thread list/resume from `thread/list`.
- **Done when:** a real multi-turn coding task (edit a file with approval) works on Windows.

### Part 6 — Transcript + digest for Codex threads
- Rewrite `runtime/src/adapters/codex.mjs` for real rollouts (`session_meta`, `response_item`,
  `event_msg`, `turn_context`); prefer `thread/items/list` when a live server exists (rollout format
  is officially unstable). Replace fake fixture `runtime/test/fixtures/codex-session.jsonl` with a
  sanitized real one. Detection must not collide with other adapters (`adapters/index.mjs:47,81`).
- Watcher already covers `~/.codex/sessions` (`daemon/config.mjs:25`); add harness `CODEX_HOME/sessions`.
- **Done when:** `ad digest` on a real Codex rollout yields correct turns/tool calls/edits.

### Part 7 — Internal LLM calls via engine
- Route `digest/extract.mjs:602`, `gepa/reflect.mjs:80`, `gepa/generate.mjs:67`, `gepa/evaluate.mjs:147`
  through `engine.complete()`; keep `claude` as a selectable backend (`--llm codex|claude`).
- Fix existing bug: `extract.mjs:602` passes no `jsonSchema` → fallback always fails.

### Part 8 — Multi-agent teams on Codex
- `orchestration/spawn.mjs`: worker = Codex thread with `cwd` = worktree, explicit sandbox/approval,
  instead of `claude --print --dangerously-skip-permissions` with `shell:true` (arg-mangling bug).
- Keep worktree create/cleanup as is. Cross-process active-agent count (current one is in-process only).

### Part 9 — Autonomous loops (`ad loop`)
- Ralph-style: `thread/goal/set` + repeated turns + `turn/steer` + `thread/compact/start`.
- Brakes in our code: dual exit (completion signals + explicit `EXIT_SIGNAL`), circuit breaker
  (3 no-progress loops / 5 same errors), call/token/$ budgets, wall-clock cap, STOP file
  (`.agent-daemon/STOP`). Resume by thread id, never "latest".

### Part 10 — General agent tools
- Default MCP set in harness config: Playwright MCP (browser), memory; `web_search = "live"` opt-in.
- Output folder for generated files/docs per task. Windows computer-use MCP = later, approval-gated.

### Part 11 — Scheduler (`ad schedule`)
- SQLite job table (cron, next_run, missed-run policy, lock) run by the existing daemon/service
  (`runtime/src/daemon/service.mjs`). Jobs = `ad run` or `ad loop` invocations.

### Part 12 — More providers
- Native Anthropic/Gemini keys: small Node Responses→Messages/Gemini translator on localhost as a
  `model_providers` entry (only if OpenRouter is not enough).
- Gemini subscription: `agy -p --output-format stream-json` delegate, opt-in with a ToS warning.

### Part 13 — Web UI + ACP (later)
- `node:http` + SSE dashboard: tasks, approvals inbox, schedules, memory viewer.
- ACP agent mode (pattern: `agentclientprotocol/codex-acp`) → Zed/JetBrains UIs for free.

### Part 14 — Docs, doctor, cleanup (rolling)
- `ad doctor`: codex binary + version pin, harness home, auth status, hooks trusted.
- Reverse `.out-of-scope/no-codex-runtime.md`; fix `adapters/codex/README.md` (wrong AGENTS.md claim),
  `adapters/codex/config.example.toml` (unverified keys); update README + `docs/future-harnesses.md`.

## Verification (every part)
- `node --test` in `runtime/` stays green; new code tested against the fake app-server.
- Each part ends with one real run on Windows against the pinned Codex, recorded as a replay fixture.
- No secrets in logs, argv, fixtures, or committed files.

## Risks
- Codex churn (≈3 stable releases/week) → Part 2 catches breaks before users do.
- OpenRouter Responses API is **beta**, stateless only → fine for Codex (stateless), watch for drift.
- Windows sandbox needs one-time setup (`windowsSandbox/setupStart`, may prompt UAC).
- Anthropic/Google policy changes → subscription paths stay delegate-only.

## Open decisions
1. Harness `CODEX_HOME` isolated from `~/.codex` (recommended) — means one extra ChatGPT login.
2. Pin `@openai/codex` as an npm dependency of `runtime` (recommended) vs require a global install.
3. Default safety: sandbox `workspace-write` + approvals `on-request` (recommended).

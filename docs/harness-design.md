# Harness design: Agent Daemon on the Codex engine

Since v2, agent-daemon runs agents itself. This page explains how and why: the engine boundary, isolation from your own Codex, the safety model, and how memory, hooks and skills get into every run. For using the commands, read [harness.md](harness.md). For the terminal UI on top, read [tui-architecture.md](tui-architecture.md).

## The shape

```
ad (tui) · ad chat · ad run · ad loop · ad schedule · ad web · ad acp · ad codex   ← ad's front ends
  └─ agent-daemon core: memory · skills · learning · teams · loops · scheduler
      ├─ auth broker      ad auth …  (ChatGPT login, OpenAI / OpenRouter keys)
      ├─ engine API       runtime/src/engine/index.mjs      ← the only thing core talks to
      │    └─ codex       runtime/src/engine/codex/*        ← the only thing that knows Codex's protocol
      └─ harness home     ~/.agent-daemon/codex-home        (CODEX_HOME: config.toml, hooks.json,
                           AGENTS.md, sessions) — never your ~/.codex
```

ad drives a pinned `codex app-server` over JSON-RPC on stdio. Codex owns the agent loop, the model calls, the sandbox and the ChatGPT login; ad owns everything around it.

## Hard rules

- **Never fork Codex.** Drive the pinned binary over its app-server protocol, stable surface only (no experimental methods or fields).
- **Never reuse Claude or Google subscription logins.** Their terms forbid it and it has been enforced. ChatGPT uses Codex's own login; other models go through API keys or OpenRouter. `ad agy` only hands a prompt to the user's own Antigravity CLI (opt-in).
- **Minimal dependencies.** Codex is a pinned engine binary (`@openai/codex` in `runtime/package.json`); ad's own code stays Node built-ins plus a handful of packages.

## Isolation

The user's own Codex (a global install, `~/.codex`, its daemon) must never be affected.

- ad's Codex runs with `CODEX_HOME=~/.agent-daemon/codex-home` (`AD_CODEX_HOME` overrides it for tests). `runtime/src/engine/codex/home.mjs` refuses `~/.codex`, a `CODEX_HOME` set by the user's shell, and network (UNC) paths, however the path is spelled.
- The engine never sees the user's `CODEX_*` environment variables.
- Only the pinned binary is used, never a `codex` on PATH.
- Credentials stay in the harness home (`cli_auth_credentials_store = "file"`), so ad's login never collides with the user's own.
- `ad codex` / `/codex` open the stock Codex UI on ad's home with `--no-daemon`.

**Windows note.** The engine's environment is otherwise the user's, with one exception: on Windows, every PATH entry with a `WindowsApps` segment is left out, at every Codex spawn (`withoutStoreAliases()` in `runtime/src/engine/codex/app-server.mjs`, also used by `ad codex`). That covers the per-user app-alias folder (`…\Microsoft\WindowsApps`) and the Store package folders (`C:\Program Files\WindowsApps\Microsoft.PowerShell_…`, which PowerShell 7 puts first on its children's PATH). Codex runs commands in the first `pwsh` on PATH, and the Windows sandbox can't start a Store (MSIX) app, so with those entries every sandboxed command failed. Without them Codex uses an MSI-installed PowerShell 7 or Windows PowerShell 5.1, inside the sandbox. Store app aliases (`winget`, the `python` stub) are not on the agent's PATH either.

## Safety model

| Run | Sandbox | Approvals | Network |
|---|---|---|---|
| `ad tui`, `ad chat`, `ad web`, `ad acp` | `workspace-write` (writes only inside the project) | asks first (`on-request`) | as Codex's sandbox allows |
| `ad run` | same | nobody can answer, so anything needing approval is declined | same |
| `ad loop`, team workers, `loop` schedule jobs | workspace only | never asks | **off**; MCP servers other than memory off; live web search off |

- On Windows, unattended runs refuse to start without a ready sandbox (`ad sandbox setup`; `--elevated` for the stronger, machine-wide variant, which needs one UAC prompt).
- Team workers can't write to `.git`; their work is committed for them on their own branch, with repo hooks disabled for that commit.
- `ad loop` stops on a dual exit signal, a circuit breaker (no progress, repeated errors), iteration/time/token budgets, and a STOP file checked mid-turn.
- Provider keys (`OPENROUTER_API_KEY`, …) are stored with DPAPI on Windows, libsecret on Linux (else a 0600 file), a 0600 file on macOS, and are excluded from the agent's shell environment.

## Memory, hooks and skills inside every run

`ensureHarnessSetup` (`runtime/src/harness/setup.mjs`) prepares the harness home before each run:

- **Hooks.** The same hook handlers as the Claude Code install (`runtime/profiles/profiles.json`) are rendered into `CODEX_HOME/hooks.json`: SessionStart context, per-prompt recall and correction capture, edit and bash post-hooks. Only hooks from that file are trusted. On Windows they run through PowerShell.
- **Memory MCP.** The `agent-daemon-memory` server is registered, with its tools approved by default (`default_tools_approval_mode = "approve"`; a mode the user set is kept): its tools read ad's memory and record feedback into it.
- **AGENTS.md.** A managed block in the harness home's `AGENTS.md` tells the agent about memory, skills and the constitution.
- **Skills.** Skill roots (the user's and the project's) are passed to Codex.
- **Learning.** Hooks append corrections and notes to the project's learning journal during a session; the next session start folds them into memory. `ad tui` shows them as "Learned:" rows right away.

## Front ends

- **`ad tui`** (and bare `ad`): the Codex-style terminal UI on a session controller with steer, queue, approvals, `/undo` and recovery. See [tui-architecture.md](tui-architecture.md).
- **`ad chat`**: a plain line mode (works in any terminal, scripts, pipes).
- **`ad run`**: one non-interactive turn.
- **`ad web`**: a local web UI, loopback only, token-protected, with a strict content security policy.
- **`ad acp`**: an Agent Client Protocol agent for Zed and JetBrains: several sessions on one engine, permission requests forwarded to the editor.
- **`ad loop`, `ad schedule`, `ad sp` (team workers)**: unattended runs under the stricter sandbox above.
- **`ad codex`**: the pinned stock Codex UI on ad's home, for a Codex feature ad doesn't have yet.

## Staying current with Codex

Codex ships several releases a week, with no protocol changelog and no deprecation window.

1. The engine is **pinned exactly**.
2. A committed **protocol snapshot** (`runtime/src/engine/codex/protocol-snapshot.json`) lists the methods, notifications and parameter types ad relies on; the fake app-server used in tests is checked against it.
3. The weekly **`codex-upgrade` workflow** (`.github/workflows/codex-upgrade.yml`) bumps the pin, regenerates the snapshot, Codex's slash-command names (`runtime/src/tui/codex-slash.json`) and `runtime/src/engine/codex/compat.json`, and flags removals as breaking. In its own Linux job it runs the suite and the real pinned Codex against a mock model (`engine-real` and the live terminal UI tests), then opens a PR with the results. The PR's own CI (the suite and the real-engine job on Linux, macOS and Windows) runs only when the repo has a `CODEX_UPGRADE_TOKEN` secret, because PRs opened with the default token don't trigger other workflows.
4. Unknown items and notifications degrade to plain rows or are ignored; they never crash a front end. `/warnings` in `ad tui` lists the ones this ad doesn't know.
5. CI has no real login and no working Windows sandbox, so before merging an upgrade, run the live `ad run` and `ad tui` smokes on Windows in a scratch folder (the `codex-upgrade` skill has the steps; see also [manual-test.md](manual-test.md)).

The `codex-upgrade` skill walks through an upgrade by hand.

## Decisions

| Decision | Reason |
|---|---|
| Codex app-server as the only engine | It brings a maintained agent loop, sandbox, approvals and ChatGPT login; ad stays a client and adds memory, skills, teams and loops. |
| An isolated harness home | Never disturbs the user's own Codex; costs one extra ChatGPT sign-in. |
| Pin Codex as an npm dependency | Every user runs the version the tests ran; upgrades are deliberate PRs. |
| `workspace-write` + `on-request` by default | Safe for interactive work without constant prompts; unattended runs get no network and never ask. |
| Keep the Claude Code mode | v1 users keep hooks, memory and skills in Claude Code; the harness is additive. |

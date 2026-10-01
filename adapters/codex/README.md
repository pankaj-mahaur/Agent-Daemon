# Codex Adapter

Two ways to use Agent Daemon with [OpenAI Codex](https://developers.openai.com/codex):

1. **The Agent Daemon harness (recommended).** `ad chat`, `ad run`, `ad loop` drive Codex through `codex app-server` with memory, hooks, skills and the constitution wired in automatically, in the harness's own `CODEX_HOME` (`~/.agent-daemon/codex-home`). Nothing in your own `~/.codex` is touched. Start with `ad auth login chatgpt`, then `ad chat`. See the plan and design notes in [docs/plans/codex-harness.md](../../docs/plans/codex-harness.md).
2. **Your own `codex` CLI** with the reference config in this folder — copy and edit by hand.

Structured after the [`everything-claude-code`](https://github.com/affaan-m/everything-claude-code) Codex pack (MIT) — see [ATTRIBUTION.md](../../ATTRIBUTION.md).

## What's here

- [`config.example.toml`](config.example.toml) — drop-in `~/.codex/config.toml` (or `.codex/config.toml` per project). Wires the daemon's MCP servers (qmd, graphify) plus a small standard set (github, context7, playwright). Defines `minimal` / `developer` / `security` profiles that mirror our `ad init --profile` matrix.
- [`agents/explorer.toml`](agents/explorer.toml) — read-only codebase-exploration sub-agent referenced from `config.example.toml`.
- [`agents/reviewer.toml`](agents/reviewer.toml) — PR reviewer sub-agent. Mirrors the lead/security/performance composition in [teams/templates/code-review-team.json](../../teams/templates/code-review-team.json) but as a single Codex agent thread.

## Install (option 2)

```sh
# Global (recommended for solo use)
mkdir -p ~/.codex/agents
cp adapters/codex/config.example.toml ~/.codex/config.toml
cp adapters/codex/agents/*.toml ~/.codex/agents/

# Or per-project
mkdir -p .codex/agents
cp adapters/codex/config.example.toml .codex/config.toml
cp adapters/codex/agents/*.toml .codex/agents/
```

Codex reads `AGENTS.md` files from the repo root down to the working folder. `ad init` writes `CLAUDE.md` + `AD-INSTRUCTIONS.md`, not `AGENTS.md`; for option 2 add an `AGENTS.md` yourself (for example one line pointing at `AD-INSTRUCTIONS.md`). The harness (option 1) writes its own global `AGENTS.md` block into its `CODEX_HOME`.

## Caveats

- Codex's `model_instructions_file` *replaces* the built-in instructions; leave it unset.
- The `notify` array in the example uses macOS `terminal-notifier`. Comment it out on Linux/Windows or substitute `notify-send` / `BurntToast`.
- Option 2 uses your own `codex login` / `OPENAI_API_KEY`. The harness has its own login (`ad auth …`).
- The `playwright` entry uses `--extension` (drives your Chrome via the Playwright extension); drop the flag for a separate browser. The harness equivalent is `ad tools enable browser`.

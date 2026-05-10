# Codex Adapter

Reference configuration for running [OpenAI Codex CLI](https://developers.openai.com/codex) against an agent-daemon project. Stuctured after the [`everything-claude-code`](https://github.com/affaan-m/everything-claude-code) Codex pack (MIT) — see [ATTRIBUTION.md](../../ATTRIBUTION.md).

## What's here

- [`config.example.toml`](config.example.toml) — drop-in `~/.codex/config.toml` (or `.codex/config.toml` per project). Wires the daemon's MCP servers (qmd, graphify) plus the small standard set (github, context7, exa, memory, playwright). Defines `strict` / `yolo` profiles that mirror our `ad init --profile` matrix.

## Install

```sh
# Global (recommended for solo use)
mkdir -p ~/.codex
cp adapters/codex/config.example.toml ~/.codex/config.toml

# Or per-project
mkdir -p .codex
cp adapters/codex/config.example.toml .codex/config.toml
```

Codex picks up `AGENTS.md` automatically. Our `ad init` writes `AGENTS.md` at repo root, so Codex sees it without extra wiring.

## Caveats

- Codex's `model_instructions_file` *replaces* `AGENTS.md`, so leave it unset.
- The `notify` array in the example uses macOS `terminal-notifier`. Comment it out on Linux/Windows or substitute `notify-send` / `BurntToast`.
- Codex is OpenAI's tool — set `OPENAI_API_KEY` (or run `codex auth`). Our daemon doesn't proxy credentials.

## Status

Reference-grade. We don't yet emit Codex configs from skills programmatically (the `adapt.{sh,ps1}` script per `adapters/README.md` is still TODO). Treat this as a starter — copy and edit, don't expect it to round-trip.

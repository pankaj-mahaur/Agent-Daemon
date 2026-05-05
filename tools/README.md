# Tools

Standalone CLI tools and scripts that augment AI-agent workflows — used either by you directly or invoked by agents/skills.

Different from MCP servers (which the agent calls as functions): tools here are run from your shell, output structured data the agent can read, or operate on files the agent will edit.

## What goes here

Each tool lives in its own folder:

```
tools/<tool-name>/
├── README.md           # what it does, install, usage, examples
├── <tool>.sh / .ps1 / .py / .ts   # the tool itself
└── examples/           # sample inputs / outputs
```

## Conventions

- **One concern per tool.** A tool that does too much is hard for an agent to invoke correctly.
- **Stdin → stdout, exit code is the truth.** Tools should be pipeable. `0` = success, non-zero = failure with a useful stderr message.
- **No interactive prompts.** Tools must run non-interactively (agents can't answer prompts mid-execution).
- **Document the JSON schema** if the output is structured — so an agent can parse it reliably.
- **Cross-platform when reasonable** — provide both `.sh` and `.ps1` if the tool is shell-flavored, or use Node/Python/Go for portability.

## Status

Scaffolded — content coming in subsequent passes. Initial candidates:

- `repo-summary` — one-shot repo introspection (lang/framework detection, key files list, commit summary). Output: JSON for agent consumption.
- `find-utility` — grep-based "does this project already have a `<concept>` helper?" search. Used by [skills/implement-feature](../skills/implement-feature/SKILL.md) Phase 0.
- `migration-head` — print the current and pending migration heads across Alembic / Django / Prisma / Knex / Flyway in one command.
- `cache-keys` — list all `cache.set` / `cache.get` call sites grouped by key prefix.
- `dead-export` — find exported symbols with zero importers (TypeScript / Python / Go).

## Install (when content lands)

```bash
# Bash
./setup.sh --tools repo-summary,find-utility

# PowerShell
./setup.ps1 -Tools "repo-summary,find-utility"
```

Tools install to `~/.local/bin/` (global, Linux/macOS) or `~/AppData/Local/agent-daemon/bin/` (Windows). Add the install dir to your `PATH`.
